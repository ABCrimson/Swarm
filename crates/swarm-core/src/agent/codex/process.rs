//! The child process: program resolution, the stdin writer thread, reaping, the
//! probe subprocesses and the `initialize` + thread-open handshake.

use std::io::Write;
use std::process::Stdio;
use std::time::{Duration, Instant};

use serde::Serialize;
use tokio::sync::{mpsc, oneshot};
use uuid::Uuid;

use super::protocol::{
    ClientInfo, InitializeCapabilities, InitializeParams, InitializeResponse,
    OPTED_OUT_NOTIFICATIONS, ThreadOpened, ThreadResumeParams, ThreadStartParams,
    VERIFIED_CODEX_VERSION, method,
};
use super::state::{RequestFailure, Shared};
use super::tier::{CodexTrustTier, NO_CWD_EXE_LOOKUP_ENV, verify_effective_policy};
use super::{CLIENT_NAME, CLIENT_TITLE};

use crate::agent::adapter::AgentSpawnSpec;
use crate::agent::stderr_snippet;
use crate::error::AppError;
use crate::worker::proc::write_to_piped;

/// `CREATE_NO_WINDOW`: keeps the probe's console subprocesses from
/// flashing a window from the GUI app.
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Resolves a bare program name the way a Windows shell would: the first
/// `PATH` directory holding `program` + a `PATHEXT` extension. Rust's
/// `Command` only appends `.exe`, but an npm install of Codex puts
/// `codex.cmd` on `PATH`. Names with an extension or a directory are left
/// alone (`None`), and the current directory is never searched. Nor is it
/// searched by the shim's own `node` lookup: [`super::tier::child_env`] sets
/// `NoDefaultCurrentDirectoryInExePath`.
#[cfg(any(windows, test))]
pub(super) fn resolve_with_pathext(
    program: &str,
    path: Option<&std::ffi::OsStr>,
    pathext: Option<&str>,
) -> Option<std::path::PathBuf> {
    let bare = std::path::Path::new(program);
    if bare.extension().is_some() || bare.components().count() != 1 {
        return None;
    }
    let extensions: Vec<&str> = pathext
        .filter(|value| !value.trim().is_empty())
        .unwrap_or(".COM;.EXE;.BAT;.CMD")
        .split(';')
        .map(str::trim)
        .filter(|ext| !ext.is_empty())
        .collect();
    std::env::split_paths(path?).find_map(|dir| {
        extensions
            .iter()
            .map(|ext| dir.join(format!("{program}{ext}")))
            .find(|candidate| candidate.is_file())
    })
}

/// The program to run for `binary` — see [`resolve_with_pathext`]. The
/// `PATH` scan touches the file system, so it runs on the blocking pool.
#[cfg(windows)]
pub(super) async fn resolve_program(binary: String) -> String {
    let fallback = binary.clone();
    tokio::task::spawn_blocking(move || {
        resolve_with_pathext(
            &binary,
            std::env::var_os("PATH").as_deref(),
            std::env::var("PATHEXT").ok().as_deref(),
        )
        .map_or(binary, |path| path.to_string_lossy().into_owned())
    })
    .await
    .unwrap_or(fallback)
}

/// The program to run for `binary`: outside Windows, `Command`'s own
/// `PATH` search already finds it.
#[cfg(not(windows))]
pub(super) async fn resolve_program(binary: String) -> String {
    binary
}

/// One line for the child's stdin. `done`, when present, receives the
/// write's outcome.
pub(super) struct WriteJob {
    pub(super) line: String,
    pub(super) done: Option<oneshot::Sender<Result<(), String>>>,
}

/// Moves the child's blocking stdin onto a dedicated thread fed by a
/// channel, so no async task ever blocks on a pipe write (a full pipe
/// blocks until the child reads). Lines are written in queue order. The
/// thread ends when the channel closes or a write fails; dropping the
/// writer then closes the pipe, which app-server treats as a request to
/// exit.
pub(super) fn start_stdin_writer(
    worker_id: Uuid,
    mut stdin: Box<dyn Write + Send>,
) -> std::io::Result<mpsc::UnboundedSender<WriteJob>> {
    let (jobs, mut queue) = mpsc::unbounded_channel::<WriteJob>();
    std::thread::Builder::new()
        .name("codex-stdin".to_string())
        .spawn(move || {
            while let Some(WriteJob { line, done }) = queue.blocking_recv() {
                let outcome =
                    write_to_piped(stdin.as_mut(), line.as_bytes()).map_err(|e| format!("{e:#}"));
                let failed = outcome.is_err();
                match done {
                    Some(done) => {
                        // The requester may have given up waiting.
                        let _ = done.send(outcome);
                    }
                    None => {
                        if let Err(error) = &outcome {
                            tracing::warn!(%worker_id, %error, "codex adapter: stdin write failed");
                        }
                    }
                }
                if failed {
                    break;
                }
            }
        })?;
    Ok(jobs)
}

/// Serializes `message` as one newline-terminated JSON line.
pub(super) fn encode_line(message: &impl Serialize) -> Result<String, String> {
    let mut line = serde_json::to_string(message).map_err(|e| e.to_string())?;
    line.push('\n');
    Ok(line)
}

/// Waits up to `grace` for `child` to exit on its own (its stdin is
/// already closed), then kills it; reaps it either way. Blocking — run it
/// on the blocking pool.
pub(super) fn reap(
    mut child: std::process::Child,
    grace: Duration,
) -> Option<std::process::ExitStatus> {
    let deadline = Instant::now() + grace;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return Some(status),
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(20)),
            Ok(None) => break,
            Err(error) => {
                tracing::warn!(%error, "codex adapter: polling the child's exit failed");
                break;
            }
        }
    }
    if let Err(error) = child.kill() {
        tracing::debug!(%error, "codex adapter: kill failed (the child may have just exited)");
    }
    child
        .wait()
        .inspect_err(|error| tracing::warn!(%error, "codex adapter: reaping the child failed"))
        .ok()
}

/// Why a probe subprocess produced no output.
pub(super) enum ProbeFailure {
    Spawn(std::io::Error),
    TimedOut,
}

/// Runs `program prefix... args...` with no stdin, bounded by `limit`;
/// the child is killed if the wait is abandoned.
pub(super) async fn run_cli(
    program: &str,
    prefix: &[String],
    args: &[&str],
    limit: Duration,
) -> Result<std::process::Output, ProbeFailure> {
    let mut command = tokio::process::Command::new(program);
    command
        .args(prefix)
        .args(args)
        .env(NO_CWD_EXE_LOOKUP_ENV, "1")
        .stdin(Stdio::null())
        .kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);
    match tokio::time::timeout(limit, command.output()).await {
        Ok(Ok(output)) => Ok(output),
        Ok(Err(error)) => Err(ProbeFailure::Spawn(error)),
        Err(_) => Err(ProbeFailure::TimedOut),
    }
}

/// The first non-empty output line (stdout, else stderr).
pub(super) fn first_line(output: &std::process::Output) -> Option<String> {
    [&output.stdout, &output.stderr]
        .into_iter()
        .find_map(|bytes| {
            String::from_utf8_lossy(bytes)
                .lines()
                .map(str::trim)
                .find(|line| !line.is_empty())
                .map(str::to_owned)
        })
}

/// The handshake: `initialize`, `initialized`, then `thread/start` — or
/// `thread/resume` when `spec.resume` names a thread — under the tier's
/// policy, verified against what the server applied.
pub(super) async fn open_thread(
    shared: &Shared,
    spec: &AgentSpawnSpec,
    tier: CodexTrustTier,
    model: Option<&str>,
) -> Result<ThreadOpened, AppError> {
    let closed = |failure: RequestFailure, what: &str| match failure {
        RequestFailure::Closed => AppError::Ai(format!(
            "codex exited before answering {what} ({})",
            stderr_snippet(&shared.stderr_tail)
        )),
        other => other.into_app_error(what),
    };

    let initialized = shared
        .request(
            method::INITIALIZE,
            InitializeParams {
                client_info: ClientInfo {
                    name: CLIENT_NAME,
                    title: CLIENT_TITLE,
                    version: env!("CARGO_PKG_VERSION"),
                },
                capabilities: InitializeCapabilities {
                    experimental_api: false,
                    request_attestation: false,
                    opt_out_notification_methods: OPTED_OUT_NOTIFICATIONS,
                },
            },
        )
        .await
        .map_err(|failure| closed(failure, method::INITIALIZE))?;
    if let Ok(response) = serde_json::from_value::<InitializeResponse>(initialized) {
        tracing::info!(
            worker_id = %shared.worker_id,
            user_agent = %response.user_agent,
            verified_against = VERIFIED_CODEX_VERSION,
            "codex app-server initialized"
        );
    }
    shared.notify(method::INITIALIZED);

    let (approval_policy, sandbox) = tier.policy();
    let opened = match spec.resume.as_deref() {
        Some(thread_id) => shared
            .request(
                method::THREAD_RESUME,
                ThreadResumeParams {
                    thread_id,
                    cwd: &spec.cwd,
                    model,
                    approval_policy,
                    sandbox,
                    exclude_turns: true,
                },
            )
            .await
            .map_err(|failure| closed(failure, method::THREAD_RESUME))?,
        None => shared
            .request(
                method::THREAD_START,
                ThreadStartParams {
                    cwd: &spec.cwd,
                    model,
                    approval_policy,
                    sandbox,
                },
            )
            .await
            .map_err(|failure| closed(failure, method::THREAD_START))?,
    };
    let opened: ThreadOpened = serde_json::from_value(opened).map_err(|e| {
        AppError::Ai(format!(
            "codex answered the thread open with an unexpected shape: {e}"
        ))
    })?;
    verify_effective_policy(&opened, approval_policy, sandbox)?;
    Ok(opened)
}
