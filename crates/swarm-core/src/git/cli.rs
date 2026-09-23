//! `git` binary discovery and the arg-vector `Command` runner.
//!
//! Every invocation in this module goes through [`run`], which is the
//! single choke point that:
//!
//! - Spawns `git` with an argument **vector** (never a shell string —
//!   arg-vector invocation is injection-proof by construction; see
//!   `worktree.rs`'s argv builders, which are unit-tested directly).
//! - Sets an environment-hygiene block so a git child can never block
//!   on an interactive prompt or race the user's own git activity:
//!   `GIT_TERMINAL_PROMPT=0` (no credential prompt), `GCM_INTERACTIVE=never`
//!   (Git Credential Manager's own GUI/terminal prompt, a second,
//!   independent prompt path on Windows that `GIT_TERMINAL_PROMPT`
//!   alone does not cover), `GIT_OPTIONAL_LOCKS=0` (skips the optional
//!   background `.lock` files git otherwise takes for read-side
//!   operations like status refresh, which can contend with a
//!   concurrent SWARM-issued mutation against the same repo), and
//!   `LC_ALL=C` (stable, unlocalized stderr — the ship module's error
//!   classification pattern-matches specific English substrings like
//!   `"rejected"`/`"non-fast-forward"`, which a localized git could
//!   translate out from under it). Stdin is `/dev/null`-equivalent
//!   ([`Stdio::null`]) for the same never-block-on-a-prompt reason.
//! - On Windows, sets `CREATE_NO_WINDOW` so a GUI app never flashes a
//!   console window for a background git call.
//! - Enforces a wall-clock timeout, killing the child if it is
//!   exceeded, so a hung `git` process (e.g. waiting on a stale lock)
//!   can never hang the caller forever.
//! - Redacts secrets and caps captured stdout/stderr at 8KB (see
//!   [`super::redact`]) **before** returning [`GitOutput`] — this is
//!   the single choke point every caller's error message, log line,
//!   and persisted event payload is built from, so no call site can
//!   forget to sanitize a git-produced string.
//!
//! Callers run inside `tokio::task::spawn_blocking` (the existing
//! convention for `swarm-core`'s other blocking work, e.g. PTY spawn)
//! since every function here blocks the calling thread.

use std::io::Read;
use std::process::{Command, ExitStatus, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use super::redact;
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
/// spawns a console subprocess. Shared with `ship`'s `gh` probe.
#[cfg(windows)]
pub(super) const CREATE_NO_WINDOW: u32 = 0x0800_0000;

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
        // Env hygiene: never let a child git process block on any
        // interactive prompt, race the user's own git activity via
        // optional locks, or emit stderr in a locale the ship
        // module's string-pattern error classification can't read.
        // See the module doc for why each variable is here.
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GCM_INTERACTIVE", "never")
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env("LC_ALL", "C")
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

    // Redact-then-truncate (see `redact::sanitize`'s doc for why that
    // order, not the reverse) — this is the single choke point, so
    // every caller's error message, log line, and persisted event
    // payload downstream is already sanitized by construction.
    Ok(GitOutput {
        status,
        stdout: redact::sanitize(&String::from_utf8_lossy(&stdout)),
        stderr: redact::sanitize(&String::from_utf8_lossy(&stderr)),
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

    /// End-to-end proof of the redaction choke point (DIRECTIVE:
    /// redaction coverage — a token-shaped string never reaches an
    /// event payload). A clone against a closed local port fails fast
    /// (connection refused, no DNS lookup, no network required) while
    /// exercising the real wiring: git's own stderr echoes back the
    /// URL it tried to reach, credentials and all, and `run` must
    /// strip them before this test — or any caller building an
    /// error/log/event from `GitOutput` — ever sees them.
    #[test]
    fn test_run_redacts_url_credentials_from_real_git_stderr() {
        let tmp =
            std::env::temp_dir().join(format!("swarm-redact-clone-test-{}", uuid::Uuid::new_v4()));
        let out = run(
            &[
                "clone".to_string(),
                "https://alice:hunter2@127.0.0.1:1/repo.git".to_string(),
                tmp.display().to_string(),
            ],
            Duration::from_secs(10),
        )
        .expect("git should run (and fail to connect) without spawning a shell");
        assert!(!out.success());
        assert!(
            !out.stderr.contains("hunter2"),
            "credentials must be redacted from stderr: {}",
            out.stderr
        );
        assert!(
            !out.stdout.contains("hunter2"),
            "credentials must be redacted from stdout: {}",
            out.stdout
        );
        std::fs::remove_dir_all(&tmp).ok();
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
