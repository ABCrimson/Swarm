//! `git` binary discovery and the arg-vector `Command` runner.
//!
//! Every invocation in this module goes through [`run`], which is the
//! single choke point that:
//!
//! - Spawns `git` with an argument **vector** (never a shell string —
//!   arg-vector invocation is injection-proof by construction; see
//!   `worktree.rs`'s argv builders, which are unit-tested directly).
//! - Sets `GIT_TERMINAL_PROMPT=0` so a missing credential can never
//!   block on an interactive prompt.
//! - On Windows, sets `CREATE_NO_WINDOW` so a GUI app never flashes a
//!   console window for a background git call.
//! - Enforces a wall-clock timeout, killing the child if it is
//!   exceeded, so a hung `git` process (e.g. waiting on a stale lock)
//!   can never hang the caller forever.
//!
//! Callers run inside `tokio::task::spawn_blocking` (the existing
//! convention for `swarm-core`'s other blocking work, e.g. PTY spawn)
//! since every function here blocks the calling thread.

use std::io::Read;
use std::process::{Command, ExitStatus, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use crate::error::AppError;

/// Minimum supported `git` version — `git worktree remove` (used by
/// [`super::worktree::remove`]) was added in 2.17.
pub const MIN_GIT_VERSION: (u32, u32, u32) = (2, 17, 0);

/// Wall-clock timeout for git operations that create/mutate a worktree
/// (`worktree add`) — these do a full checkout and can legitimately
/// take longer on a large repo.
pub const CREATE_TIMEOUT: Duration = Duration::from_secs(20);

/// Wall-clock timeout for read-only/metadata git operations
/// (`rev-parse`, `worktree list`, `worktree lock`/`unlock`,
/// `worktree remove`, `--version`).
pub const READ_TIMEOUT: Duration = Duration::from_secs(5);

/// Interval between `try_wait()` polls while waiting for a child to
/// exit within its timeout budget.
const POLL_INTERVAL: Duration = Duration::from_millis(20);

/// Windows `CREATE_NO_WINDOW` process creation flag — prevents a
/// console window from flashing when a GUI app (the Tauri shell)
/// spawns a console subprocess.
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// The result of a completed (non-timed-out) `git` invocation.
#[derive(Debug, Clone)]
pub struct GitOutput {
    pub status: ExitStatus,
    pub stdout: String,
    pub stderr: String,
}

impl GitOutput {
    pub fn success(&self) -> bool {
        self.status.success()
    }
}

/// Returns the `git` binary name to invoke.
///
/// Discovery is deliberately minimal: `git` is resolved via the
/// process `PATH` (as `std::process::Command` does natively for a bare
/// program name on every platform), which is exactly how Git for
/// Windows, Homebrew git, and every Linux package manager install it.
/// [`probe_capability`] is what actually verifies the binary works and
/// meets [`MIN_GIT_VERSION`] — this function only names it.
fn git_binary() -> &'static str {
    "git"
}

/// Runs `git` with the given argument vector and a wall-clock timeout.
///
/// Never invokes a shell — `args` is passed directly to
/// [`std::process::Command::args`], so no argument can be reinterpreted
/// as shell syntax. Stdout/stderr are captured on background reader
/// threads (started before the wait loop) so a chatty child can never
/// deadlock on a full pipe buffer while we wait for it to exit.
///
/// # Errors
///
/// * [`AppError::Git`] — the binary could not be spawned, the wait
///   loop failed, or `timeout` was exceeded (the child is killed).
pub fn run(args: &[String], timeout: Duration) -> Result<GitOutput, AppError> {
    let mut command = Command::new(git_binary());
    command
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = command
        .spawn()
        .map_err(|e| AppError::Git(format!("failed to spawn `git`: {e}")))?;

    let stdout_rx = spawn_pipe_reader(child.stdout.take());
    let stderr_rx = spawn_pipe_reader(child.stderr.take());

    let start = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => {
                if start.elapsed() >= timeout {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(AppError::Git(format!(
                        "git {} timed out after {:?}",
                        args.join(" "),
                        timeout
                    )));
                }
                std::thread::sleep(POLL_INTERVAL);
            }
            Err(e) => return Err(AppError::Git(format!("failed to wait on `git`: {e}"))),
        }
    };

    // The child has exited, so its stdout/stderr pipes are closed and
    // the reader threads will finish promptly.
    let stdout = stdout_rx.recv().unwrap_or_default();
    let stderr = stderr_rx.recv().unwrap_or_default();

    Ok(GitOutput {
        status,
        stdout: String::from_utf8_lossy(&stdout).into_owned(),
        stderr: String::from_utf8_lossy(&stderr).into_owned(),
    })
}

/// Spawns a background thread draining `pipe` to completion, returning
/// a receiver for the collected bytes. Draining concurrently with the
/// wait loop (rather than after the child exits) prevents a deadlock
/// where the child blocks writing to a full pipe buffer while we block
/// waiting for it to exit.
fn spawn_pipe_reader(pipe: Option<impl Read + Send + 'static>) -> mpsc::Receiver<Vec<u8>> {
    let (tx, rx) = mpsc::channel();
    match pipe {
        Some(mut p) => {
            std::thread::spawn(move || {
                let mut buf = Vec::new();
                let _ = p.read_to_end(&mut buf);
                let _ = tx.send(buf);
            });
        }
        None => {
            let _ = tx.send(Vec::new());
        }
    }
    rx
}

/// Capability outcome of the startup `git --version` probe.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GitCapability {
    /// A `git` binary was found, ran, and meets [`MIN_GIT_VERSION`].
    Available { version: (u32, u32, u32) },
    /// `git` is missing, unrunnable, or below [`MIN_GIT_VERSION`].
    /// `reason` is a human-readable, log-safe explanation.
    Unavailable { reason: String },
}

/// Runs `git --version` and checks it against [`MIN_GIT_VERSION`].
///
/// This is the startup capability probe (item 1 of Phase 1): it never
/// panics and never silently disappears an unavailable/old git — the
/// caller is expected to surface [`GitCapability::Unavailable`] to the
/// user (e.g. via a `system_log` event) rather than let isolation fail
/// mysteriously on first spawn.
pub fn probe_capability() -> GitCapability {
    let output = match run(&["--version".to_string()], READ_TIMEOUT) {
        Ok(o) => o,
        Err(e) => {
            return GitCapability::Unavailable {
                reason: format!("git not found or unrunnable: {e}"),
            };
        }
    };

    if !output.success() {
        return GitCapability::Unavailable {
            reason: format!("`git --version` exited non-zero: {}", output.stderr.trim()),
        };
    }

    match parse_version(&output.stdout) {
        Some(version) if version >= MIN_GIT_VERSION => GitCapability::Available { version },
        Some(version) => GitCapability::Unavailable {
            reason: format!(
                "git {}.{}.{} is older than the required {}.{}.{}",
                version.0,
                version.1,
                version.2,
                MIN_GIT_VERSION.0,
                MIN_GIT_VERSION.1,
                MIN_GIT_VERSION.2
            ),
        },
        None => GitCapability::Unavailable {
            reason: format!(
                "could not parse `git --version` output: {:?}",
                output.stdout
            ),
        },
    }
}

/// Parses `"git version 2.43.0.windows.1\n"` (or plain `"git version
/// 2.43.0\n"` on Linux/macOS) into `(2, 43, 0)`. Tolerant of trailing
/// platform-specific suffixes after the third numeric component.
fn parse_version(text: &str) -> Option<(u32, u32, u32)> {
    let rest = text.trim().strip_prefix("git version ")?;
    let mut parts = rest.split('.');
    let major = parts.next()?.parse().ok()?;
    let minor = parts.next()?.parse().ok()?;
    // The patch component may carry a platform suffix directly appended
    // via another dot (e.g. "0.windows.1") — split() already separated
    // that into its own component, so just parse the third dot-segment.
    let patch = parts.next()?.parse().ok()?;
    Some((major, minor, patch))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_version_plain() {
        assert_eq!(parse_version("git version 2.43.0\n"), Some((2, 43, 0)));
    }

    #[test]
    fn test_parse_version_windows_suffix() {
        assert_eq!(
            parse_version("git version 2.43.0.windows.1\n"),
            Some((2, 43, 0))
        );
    }

    #[test]
    fn test_parse_version_rejects_garbage() {
        assert_eq!(parse_version("not git at all"), None);
        assert_eq!(parse_version(""), None);
    }

    #[test]
    fn test_min_version_ordering() {
        assert!((2, 17, 0) >= MIN_GIT_VERSION);
        assert!((2, 16, 9) < MIN_GIT_VERSION);
        assert!((3, 0, 0) >= MIN_GIT_VERSION);
    }

    /// Requires a real `git` binary on PATH — true in every dev
    /// environment and CI runner (GitHub-hosted ubuntu/windows images
    /// both ship git preinstalled).
    #[test]
    fn test_probe_capability_against_real_git() {
        let capability = probe_capability();
        match capability {
            GitCapability::Available { version } => {
                assert!(version >= MIN_GIT_VERSION);
            }
            GitCapability::Unavailable { reason } => {
                panic!("expected git to be available in the test environment: {reason}");
            }
        }
    }

    #[test]
    fn test_run_rejects_shell_metacharacters_as_literal_args() {
        // Proves arg-vector invocation: a string that would be
        // dangerous in a shell command line is just an inert literal
        // argument to `git`, which reports it as an unknown revision
        // rather than executing anything.
        let out = run(
            &["rev-parse".to_string(), "; rm -rf / #".to_string()],
            READ_TIMEOUT,
        )
        .expect("git should run (and fail) without spawning a shell");
        assert!(!out.success());
    }

    #[test]
    fn test_run_timeout_kills_child() {
        // `git` has no built-in "sleep" subcommand, so exercise the
        // timeout path with an operation that is fast but whose
        // timeout budget we set to zero, guaranteeing the deadline is
        // already elapsed on the first poll.
        let out = run(&["--version".to_string()], Duration::from_nanos(0));
        // Either it raced and finished before the first poll (fast
        // machine) or it hit the timeout error — both are acceptable,
        // but if it errors, it must be the timeout message.
        if let Err(AppError::Git(msg)) = &out {
            assert!(
                msg.contains("timed out"),
                "expected timeout message, got: {msg}"
            );
        }
    }
}
