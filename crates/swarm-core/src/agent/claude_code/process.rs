//! The `claude` child process: binary resolution, stdin writer, spawn,
//! reap and the `initialize` handshake.

use std::collections::VecDeque;
use std::ffi::OsStr;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Child, ExitStatus};
use std::sync::Arc;

use serde_json::Value;
use tokio::sync::{mpsc, oneshot};
use uuid::Uuid;

use super::tier::child_env;
use super::wire::{self, ControlResponse, Inbound, InitializeResponse};
use super::{EXIT_POLL_INTERVAL, SHUTDOWN_GRACE};
use crate::error::AppError;
use crate::worker::proc::{PipedHandle, spawn_piped, write_to_piped};

// ── Binary resolution ────────────────────────────────────────────────

/// Where an npm install of `@anthropic-ai/claude-code` keeps the real
/// executable, relative to the directory holding its `claude.cmd` shim:
/// the package's `bin` entry is `"claude": "bin/claude.exe"`.
const NPM_CLAUDE_EXE: [&str; 5] = [
    "node_modules",
    "@anthropic-ai",
    "claude-code",
    "bin",
    "claude.exe",
];

/// The executable to start for `program`. An absolute `program` is used
/// as given; any other name with a directory in it is refused (`None`).
/// A bare name is looked up in the ABSOLUTE entries of `path` only, in
/// order: a relative or empty entry would resolve against the child's
/// working directory, the repo, once the spawn changes into it (Unix
/// changes directory before its `PATH` search). The current directory is
/// never searched.
///
/// With `windows`, a directory matches on `<program>.exe`, or, for
/// `claude`, on an npm `claude.cmd` shim whose package executable
/// ([`NPM_CLAUDE_EXE`]) exists, which is returned instead of the shim.
/// Otherwise a directory matches on an executable file named `program`.
/// Touches the file system: call it off the async threads.
pub(super) fn resolve_program(
    program: &str,
    path: Option<&OsStr>,
    windows: bool,
) -> Option<PathBuf> {
    let given = Path::new(program);
    if given.is_absolute() {
        return Some(given.to_path_buf());
    }
    if given.components().count() != 1 {
        return None;
    }
    std::env::split_paths(path?)
        .filter(|dir| dir.is_absolute())
        .find_map(|dir| program_in(&dir, program, windows))
}

/// `program` in `dir` under [`resolve_program`]'s matching rules.
fn program_in(dir: &Path, program: &str, windows: bool) -> Option<PathBuf> {
    if !windows {
        let candidate = dir.join(program);
        return is_executable_file(&candidate).then_some(candidate);
    }
    let exe = dir.join(format!("{program}.exe"));
    if exe.is_file() {
        return Some(exe);
    }
    let npm_exe = NPM_CLAUDE_EXE
        .iter()
        .fold(dir.to_path_buf(), |path, part| path.join(part));
    (program == "claude" && dir.join("claude.cmd").is_file() && npm_exe.is_file())
        .then_some(npm_exe)
}

#[cfg(unix)]
fn is_executable_file(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(path)
        .is_ok_and(|meta| meta.is_file() && meta.permissions().mode() & 0o111 != 0)
}

#[cfg(not(unix))]
fn is_executable_file(path: &Path) -> bool {
    path.is_file()
}

// ── Child process plumbing ───────────────────────────────────────────

/// One line bound for the child's stdin, with an optional completion
/// signal for callers that need to know the write landed.
struct StdinFrame {
    line: String,
    ack: Option<oneshot::Sender<Result<(), String>>>,
}

/// Owns the child's stdin on a dedicated OS thread. Writes are blocking
/// syscalls that can stall for as long as the child leaves its pipe
/// full, so none of them ever runs on a Tokio worker; callers only queue
/// lines. Closing the queue ([`Self::close`]) lets the thread write what
/// is left and drop stdin, which the CLI reads as EOF. Killing the child
/// unblocks a stuck write with a broken-pipe error, which ends the thread.
pub(super) struct StdinWriter {
    queue: parking_lot::Mutex<Option<mpsc::UnboundedSender<StdinFrame>>>,
}

impl StdinWriter {
    pub(super) fn start(mut stdin: Box<dyn Write + Send>) -> std::io::Result<Self> {
        let (queue, mut frames) = mpsc::unbounded_channel::<StdinFrame>();
        std::thread::Builder::new()
            .name("claude-code-stdin".to_owned())
            .spawn(move || {
                while let Some(StdinFrame { line, ack }) = frames.blocking_recv() {
                    let written = write_to_piped(stdin.as_mut(), line.as_bytes())
                        .map_err(|error| format!("{error:#}"));
                    let failed = written.is_err();
                    if let Some(ack) = ack {
                        // The caller may have stopped waiting; the write
                        // happened (or failed) either way.
                        ack.send(written).ok();
                    }
                    if failed {
                        break;
                    }
                }
            })?;
        Ok(Self {
            queue: parking_lot::Mutex::new(Some(queue)),
        })
    }

    fn enqueue(&self, frame: StdinFrame) -> bool {
        self.queue
            .lock()
            .as_ref()
            .is_some_and(|queue| queue.send(frame).is_ok())
    }

    /// Queues `line` without waiting for the write. The reader task uses
    /// only this: it must never wait on stdin, or a child blocked writing
    /// stdout while not reading stdin would deadlock the pair.
    pub(super) fn send(&self, line: String) -> bool {
        self.enqueue(StdinFrame { line, ack: None })
    }

    /// Queues `line` and resolves once it has been written and flushed.
    pub(super) async fn write(&self, line: String) -> Result<(), String> {
        let (ack, written) = oneshot::channel();
        if !self.enqueue(StdinFrame {
            line,
            ack: Some(ack),
        }) {
            return Err("Stdin Is Closed".to_owned());
        }
        written
            .await
            .unwrap_or_else(|_| Err("The Stdin Writer Stopped".to_owned()))
    }

    /// Closes stdin once every queued line has been written.
    pub(super) fn close(&self) {
        drop(self.queue.lock().take());
    }
}

/// A started `claude` child before it becomes a session.
pub(super) struct Process {
    pub(super) child: Child,
    pub(super) stdin: StdinWriter,
    pub(super) lines: mpsc::Receiver<String>,
    pub(super) framer_errors: mpsc::UnboundedReceiver<AppError>,
    pub(super) stderr_tail: Arc<parking_lot::Mutex<VecDeque<u8>>>,
}

impl Process {
    pub(super) async fn start(binary: &str, argv: &[String], cwd: &str) -> anyhow::Result<Self> {
        // Process creation is a blocking syscall; keep it off the async
        // worker threads.
        let (binary, argv, cwd) = (binary.to_owned(), argv.to_vec(), cwd.to_owned());
        let PipedHandle {
            stdin,
            child,
            lines,
            framer_errors,
            stderr_tail,
        } = tokio::task::spawn_blocking(move || spawn_piped(&binary, &argv, &cwd, &child_env()))
            .await
            .map_err(|e| anyhow::anyhow!("the claude spawn task failed: {e}"))??;
        match StdinWriter::start(stdin) {
            Ok(stdin) => Ok(Self {
                child,
                stdin,
                lines,
                framer_errors,
                stderr_tail,
            }),
            Err(error) => {
                reap(child, false).await;
                Err(error.into())
            }
        }
    }

    /// Closes stdin and stops the child — a clean exit when `graceful`
    /// and the CLI takes it, a kill otherwise — and returns the last
    /// stderr it wrote.
    pub(super) async fn finish(self, graceful: bool) -> String {
        self.stdin.close();
        reap(self.child, graceful).await;
        crate::agent::drained_stderr_snippet(&self.stderr_tail).await
    }
}

/// Stops `child` and waits for it, off the async threads. With
/// `graceful`, the child first gets [`SHUTDOWN_GRACE`] to exit on its own
/// (stdin must already be closed for that to happen).
pub(super) async fn reap(mut child: Child, graceful: bool) -> Option<ExitStatus> {
    if graceful {
        let deadline = tokio::time::Instant::now() + SHUTDOWN_GRACE;
        loop {
            match child.try_wait() {
                Ok(Some(status)) => return Some(status),
                Ok(None) if tokio::time::Instant::now() < deadline => {
                    tokio::time::sleep(EXIT_POLL_INTERVAL).await;
                }
                Ok(None) | Err(_) => break,
            }
        }
    }
    tokio::task::spawn_blocking(move || {
        // Killing a process that already exited is not an error worth
        // reporting: the end state is the same.
        child.kill().ok();
        child.wait().ok()
    })
    .await
    .ok()
    .flatten()
}

/// Why the `initialize` handshake failed.
#[derive(Debug)]
pub(super) enum HandshakeError {
    /// The CLI answered `initialize` with an error response, or with a
    /// success payload the adapter cannot read.
    Rejected(String),
    /// The CLI wrote a `result` instead (e.g. `--resume` of an unknown
    /// session: "No conversation found with session ID: ...").
    StartupFailure(String),
    /// Stdout closed before an answer arrived.
    Exited,
}

/// Sends `initialize` (and, for the probe, `get_binary_version`) and
/// reads frames until every answer is in. Pre-turn frames (hook
/// notices) are skipped: nothing turn-scoped can arrive before the first
/// user message.
pub(super) async fn handshake(
    process: &mut Process,
    want_version: bool,
) -> Result<(InitializeResponse, Option<String>), HandshakeError> {
    let init_id = format!("swarm-initialize-{}", Uuid::new_v4());
    let version_id = format!("swarm-version-{}", Uuid::new_v4());
    if !process.stdin.send(wire::initialize_request(&init_id))
        || (want_version
            && !process
                .stdin
                .send(wire::binary_version_request(&version_id)))
    {
        return Err(HandshakeError::Exited);
    }
    let mut init: Option<InitializeResponse> = None;
    let mut version = None;
    let mut version_pending = want_version;
    while let Some(line) = process.lines.recv().await {
        match serde_json::from_str::<Inbound>(&line) {
            Ok(Inbound::ControlResponse(frame)) if frame.response.request_id() == init_id => {
                match frame.response {
                    // An answer the adapter cannot read is no answer: a
                    // default would skip the spawn's permission-mode check
                    // and report the probe as signed out.
                    ControlResponse::Success { response, .. } => {
                        let payload = response.unwrap_or(Value::Null);
                        init = Some(serde_json::from_value(payload).map_err(|error| {
                            HandshakeError::Rejected(format!(
                                "Unreadable Initialize Response ({error})"
                            ))
                        })?);
                    }
                    ControlResponse::Error { error, .. } => {
                        return Err(HandshakeError::Rejected(error));
                    }
                }
            }
            Ok(Inbound::ControlResponse(frame)) if frame.response.request_id() == version_id => {
                version_pending = false;
                if let ControlResponse::Success {
                    response: Some(value),
                    ..
                } = frame.response
                {
                    version = serde_json::from_value::<wire::BinaryVersion>(value)
                        .ok()
                        .map(|answer| answer.version);
                }
            }
            Ok(Inbound::Result(result)) => {
                return Err(HandshakeError::StartupFailure(
                    result
                        .failure_text()
                        .unwrap_or_else(|| format!("Ended With {}", result.subtype)),
                ));
            }
            Ok(_) => {}
            Err(error) => {
                tracing::warn!(%error, "claude code: unreadable ndjson line during the handshake, skipping");
            }
        }
        if !version_pending && let Some(init) = init.take() {
            return Ok((init, version));
        }
    }
    Err(HandshakeError::Exited)
}
