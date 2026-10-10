//! The `git` runner every git invocation in SWARM goes through, and the
//! startup capability probe.
//!
//! [`run`] and [`run_with_stdin`] are the single choke point that:
//!
//! - Spawns `git` with an argument **vector**, never a shell string, so
//!   no argument can be reinterpreted as shell syntax (the argv
//!   builders in [`super::worktree`] and [`super::ship`] are
//!   unit-tested directly).
//! - Applies an environment-hygiene block: `GIT_TERMINAL_PROMPT=0` (no
//!   terminal credential prompt), `GCM_INTERACTIVE=never` (Git
//!   Credential Manager's own prompt, a second path on Windows that
//!   `GIT_TERMINAL_PROMPT` alone does not cover), `GIT_OPTIONAL_LOCKS=0`
//!   (read-side commands such as `status` skip the optional index
//!   refresh lock, so they cannot contend with a concurrent mutation),
//!   and `LC_ALL=C` (unlocalized stderr: [`super::ship`]'s error
//!   classification matches English phrases such as `non-fast-forward`).
//!   It also **removes** every inherited repository-location variable
//!   (`REPO_LOCAL_ENV_VARS`, the list `git rev-parse --local-env-vars`
//!   prints): when SWARM itself runs inside a git hook, `GIT_DIR`,
//!   `GIT_INDEX_FILE` and friends would otherwise silently redirect every
//!   `git -C <dir> …` call to the hook's repository. Honest scope: an
//!   `ssh` passphrase or host-key prompt is not suppressed — `ssh` reads
//!   those from the controlling terminal, so on Unix, under a SWARM
//!   launched from a terminal, such a prompt stops `git` (its process
//!   group is not the terminal's foreground group) until the call's
//!   budget expires.
//! - Feeds stdin from the null device, or — for `--pathspec-from-file=-`
//!   and `commit --file=-` — from a caller-supplied payload written on
//!   its own thread, so a large payload can never deadlock against a
//!   full stdout pipe.
//! - On Windows, sets `CREATE_NO_WINDOW` so the GUI never flashes a
//!   console window. On Unix, starts `git` in its own process group so
//!   a timeout can signal `git` *and* every hook or helper it started.
//! - Enforces a wall-clock budget. On expiry it terminates the whole
//!   process tree: on Unix a `SIGTERM` to the group first — `git`'s
//!   signal handlers delete the `index.lock`/ref locks it holds — then
//!   `SIGKILL` after `TERM_GRACE`; on Windows `taskkill /T /F`, which
//!   cannot let `git` clean up, so a killed mutation there can leave a
//!   stale `index.lock` behind. The budgets below are sized so that only
//!   a genuinely hung call ever reaches that path.
//! - Returns stdout **raw** — porcelain records, NUL-separated paths,
//!   numstat rows and shas are data, and redacting or truncating them
//!   corrupts what callers parse. stderr is only ever used for messages
//!   and classification, so [`GitOutput::stderr`] is the redacted and
//!   size-capped copy (see [`super::redact`]) every error message, log
//!   line and event payload is built from; [`GitOutput::raw_stderr`]
//!   keeps the full text for pattern classification only.
//! - Bounds the post-exit pipe drain to `DRAIN_GRACE`: a grandchild
//!   that inherited the pipes (an `ssh` `ControlPersist` master, a
//!   daemon a hook forked) keeps them open after `git` exits, and must
//!   not hang the caller.
//!
//! Every function here blocks the calling thread; async callers run
//! them inside `tokio::task::spawn_blocking`.

use std::ffi::OsStr;
use std::io::{Read, Write};
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::mpsc::{self, RecvTimeoutError, Sender};
use std::time::{Duration, Instant};

use super::redact;
use crate::error::AppError;

/// Minimum supported `git` version. Each floor below is a feature SWARM
/// actually uses:
///
/// | Version | Feature                                                  |
/// |---------|----------------------------------------------------------|
/// | 2.17    | `git worktree remove`                                    |
/// | 2.23    | `git restore --staged`                                   |
/// | 2.25    | `git add --pathspec-from-file`                           |
/// | 2.26    | `git restore --pathspec-from-file`                       |
/// | 2.30    | `git rev-parse --end-of-options`                         |
/// | 2.31    | `git rev-parse --path-format=absolute`                   |
/// | 2.32    | `git commit --trailer`                                   |
pub const MIN_GIT_VERSION: (u32, u32, u32) = (2, 32, 0);

/// Budget for cheap metadata queries: `rev-parse`, `symbolic-ref`,
/// `config`, `remote get-url`, `worktree lock`/`unlock`/`prune`,
/// `branch -d`, `--version`.
pub const READ_TIMEOUT: Duration = Duration::from_secs(15);

/// Budget for queries that walk the whole working tree or history:
/// `status --untracked-files=all`, `diff --numstat`, `show --numstat`,
/// `rev-list --count`. A cold file cache on a large checkout makes
/// these legitimately slow.
pub const SCAN_TIMEOUT: Duration = Duration::from_secs(60);

/// Budget for `git worktree add`, which performs a full checkout
/// (including any smudge filters such as Git LFS).
pub const CREATE_TIMEOUT: Duration = Duration::from_secs(120);

/// Budget for the ship chain's index mutations — `add`, `restore
/// --staged`, `commit`. `commit` runs the user's `pre-commit` and
/// `commit-msg` hooks (lint-staged, `tsc`, `cargo clippy` …), which
/// routinely take minutes; `add` runs clean filters.
pub const MUTATE_TIMEOUT: Duration = Duration::from_secs(600);

/// Budget for `git push`: network transfer plus the `pre-push` hook.
pub const PUSH_TIMEOUT: Duration = Duration::from_secs(600);

/// Budget for `git worktree remove`, which recursively deletes the
/// worktree — including ignored build output (`node_modules`,
/// `target`) an agent produced inside it.
pub const REMOVE_TIMEOUT: Duration = Duration::from_secs(600);

/// Upper bound between exit checks while waiting on a child. The wait
/// loop wakes as soon as output arrives, so a fast command returns
/// without paying this interval.
const POLL_INTERVAL: Duration = Duration::from_millis(20);

/// How long the output drain may keep reading after `git` has exited.
/// Pipes still open at that point belong to a grandchild that inherited
/// them; its output is abandoned rather than waited for.
const DRAIN_GRACE: Duration = Duration::from_millis(500);

/// How long a timed-out process group gets to exit on `SIGTERM` before
/// it is `SIGKILL`ed (Unix only).
#[cfg(unix)]
const TERM_GRACE: Duration = Duration::from_secs(3);

/// Read size for the stdout/stderr reader threads.
const READ_CHUNK: usize = 64 * 1024;

/// Windows `CREATE_NO_WINDOW` process-creation flag: a console
/// subprocess spawned by the GUI must not flash a console window.
/// (`CommandExt::show_window` only sets `wShowWindow`, which does not
/// stop a console being allocated, so it is not a substitute.)
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Repository-location variables `git rev-parse --local-env-vars`
/// lists. Each one would override the `-C <dir>` scoping of every call
/// if SWARM inherited it (it does whenever it is started from a git
/// hook), so [`run`] removes them all from the child environment.
const REPO_LOCAL_ENV_VARS: &[&str] = &[
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_CONFIG",
    "GIT_CONFIG_PARAMETERS",
    "GIT_CONFIG_COUNT",
    "GIT_OBJECT_DIRECTORY",
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_IMPLICIT_WORK_TREE",
    "GIT_GRAFT_FILE",
    "GIT_INDEX_FILE",
    "GIT_NO_REPLACE_OBJECTS",
    "GIT_REPLACE_REF_BASE",
    "GIT_PREFIX",
    "GIT_SHALLOW_FILE",
    "GIT_COMMON_DIR",
];

/// The result of a `git` invocation that ran to completion (any exit
/// code; a timeout is an [`AppError::GitTimeout`] instead).
#[derive(Debug, Clone)]
pub struct GitOutput {
    /// The child's exit status.
    pub status: ExitStatus,
    /// Raw stdout, byte for byte. This is **data** (porcelain records,
    /// NUL-separated paths, shas): never truncated or redacted, and
    /// never to be placed in a message without [`redact::sanitize`].
    pub stdout: Vec<u8>,
    /// stderr redacted and size-capped by [`redact::sanitize`] — the
    /// only form of stderr that may reach an error message, a log line
    /// or an event payload.
    pub stderr: String,
    /// The full, unredacted stderr, kept for pattern classification
    /// (a truncated copy could lose the one line that names the
    /// failure). Never surfaced.
    raw_stderr: String,
}

impl GitOutput {
    fn new(status: ExitStatus, stdout: Vec<u8>, stderr: Vec<u8>) -> Self {
        let raw_stderr = String::from_utf8_lossy_owned(stderr);
        Self {
            status,
            stdout,
            stderr: redact::sanitize(&raw_stderr),
            raw_stderr,
        }
    }

    /// Whether `git` exited with status 0.
    #[must_use = "the exit status is the only signal that git succeeded"]
    pub fn success(&self) -> bool {
        self.status.success()
    }

    /// stdout decoded as UTF-8 (lossily) and trimmed — for commands
    /// whose whole output is one value: a sha, a branch name, a URL, a
    /// path.
    #[must_use = "the decoded output is the only result of this call"]
    pub fn stdout_trimmed(&self) -> String {
        String::from_utf8_lossy(&self.stdout).trim().to_owned()
    }

    /// The full, unredacted stderr. For matching failure phrases only —
    /// build every surfaced string from [`Self::stderr`] instead.
    #[must_use = "the raw stderr exists only to be matched against failure phrases"]
    pub fn raw_stderr(&self) -> &str {
        &self.raw_stderr
    }
}

/// Runs `git args…` with stdin connected to the null device.
///
/// # Errors
///
/// * [`AppError::Git`] — `git` could not be spawned or waited on.
/// * [`AppError::GitTimeout`] — `timeout` elapsed; the process tree was
///   terminated (see the module doc).
pub fn run(args: &[impl AsRef<OsStr>], timeout: Duration) -> Result<GitOutput, AppError> {
    execute(args, None, timeout)
}

/// Runs `git args…`, writing `stdin` to the child's standard input and
/// then closing it — the transport for `--pathspec-from-file=-` and
/// `commit --file=-`, which keep arbitrarily long path lists and commit
/// messages off the command line.
///
/// # Errors
///
/// Same as [`run`].
pub fn run_with_stdin(
    args: &[impl AsRef<OsStr>],
    stdin: &[u8],
    timeout: Duration,
) -> Result<GitOutput, AppError> {
    execute(args, Some(stdin.to_vec()), timeout)
}

/// Builds the hygienic `git` command (see the module doc) without
/// spawning it. Split out so the environment block is unit-testable
/// through [`Command::get_envs`].
fn command(args: &[impl AsRef<OsStr>]) -> Command {
    let mut command = Command::new("git");
    command
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GCM_INTERACTIVE", "never")
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env("LC_ALL", "C")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    for var in REPO_LOCAL_ENV_VARS {
        command.env_remove(var);
    }

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    command
}

/// The git subcommand in `args` (the first argument after the global
/// `-C <dir>`/`-c <key=value>` pairs), for error messages that must
/// never echo the full argv — a commit's argv carries its message.
fn subcommand(args: &[impl AsRef<OsStr>]) -> String {
    let mut iter = args.iter().map(AsRef::as_ref);
    while let Some(arg) = iter.next() {
        if arg == "-C" || arg == "-c" {
            iter.next();
            continue;
        }
        return arg.to_string_lossy().into_owned();
    }
    String::new()
}

/// Which pipe a [`Chunk`] came from.
#[derive(Clone, Copy)]
enum Stream {
    Stdout,
    Stderr,
}

/// One message from a pipe-reader thread.
enum Chunk {
    Data(Stream, Vec<u8>),
    Eof,
}

/// Output collected so far from both pipes.
#[derive(Default)]
struct Collected {
    stdout: Vec<u8>,
    stderr: Vec<u8>,
    open_pipes: u8,
}

impl Collected {
    fn accept(&mut self, chunk: Chunk) {
        match chunk {
            Chunk::Data(Stream::Stdout, bytes) => self.stdout.extend_from_slice(&bytes),
            Chunk::Data(Stream::Stderr, bytes) => self.stderr.extend_from_slice(&bytes),
            Chunk::Eof => self.open_pipes = self.open_pipes.saturating_sub(1),
        }
    }
}

fn execute(
    args: &[impl AsRef<OsStr>],
    stdin: Option<Vec<u8>>,
    timeout: Duration,
) -> Result<GitOutput, AppError> {
    let name = subcommand(args);
    let mut command = command(args);
    command.stdin(if stdin.is_some() {
        Stdio::piped()
    } else {
        Stdio::null()
    });
    let mut child = command
        .spawn()
        .map_err(|e| AppError::Git(format!("failed to spawn `git {name}`: {e}")))?;

    if let (Some(bytes), Some(mut pipe)) = (stdin, child.stdin.take()) {
        // A write error means git exited without reading everything
        // (e.g. it rejected an option first); its exit status and
        // stderr carry the real failure, so the error is dropped.
        std::thread::spawn(move || {
            let _ = pipe.write_all(&bytes);
        });
    }

    let (tx, rx) = mpsc::channel();
    let mut collected = Collected::default();
    if let Some(pipe) = child.stdout.take() {
        spawn_reader(pipe, Stream::Stdout, tx.clone());
        collected.open_pipes += 1;
    }
    if let Some(pipe) = child.stderr.take() {
        spawn_reader(pipe, Stream::Stderr, tx);
        collected.open_pipes += 1;
    }

    let deadline = Instant::now() + timeout;
    let mut idle_backoff = Duration::from_millis(1);
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => {}
            Err(e) => {
                terminate(&mut child);
                return Err(AppError::Git(format!(
                    "failed to wait on `git {name}`: {e}"
                )));
            }
        }
        let now = Instant::now();
        if now >= deadline {
            terminate(&mut child);
            return Err(AppError::GitTimeout {
                command: name,
                timeout,
            });
        }
        let slice = (deadline - now).min(POLL_INTERVAL);
        if collected.open_pipes > 0 {
            match rx.recv_timeout(slice) {
                Ok(chunk) => collected.accept(chunk),
                Err(RecvTimeoutError::Timeout) => {}
                Err(RecvTimeoutError::Disconnected) => collected.open_pipes = 0,
            }
        } else {
            // Both pipes are closed, so exit is imminent: back off from
            // 1 ms instead of sleeping a full poll interval.
            std::thread::sleep(idle_backoff.min(slice));
            idle_backoff = (idle_backoff * 2).min(POLL_INTERVAL);
        }
    };

    let drain_deadline = Instant::now() + DRAIN_GRACE;
    while collected.open_pipes > 0 {
        let remaining = drain_deadline.saturating_duration_since(Instant::now());
        match rx.recv_timeout(remaining) {
            Ok(chunk) => collected.accept(chunk),
            Err(RecvTimeoutError::Disconnected) => break,
            Err(RecvTimeoutError::Timeout) => {
                tracing::debug!(
                    command = %name,
                    "git exited but a descendant still holds its output pipes; abandoning the rest of the output"
                );
                break;
            }
        }
    }

    Ok(GitOutput::new(status, collected.stdout, collected.stderr))
}

/// Drains `pipe` on a background thread, forwarding each chunk as it
/// arrives. Draining concurrently with the wait loop keeps a chatty
/// child from blocking on a full pipe buffer; forwarding chunks (rather
/// than one buffer at EOF) lets the caller keep partial output when a
/// grandchild holds the pipe open past `git`'s exit.
fn spawn_reader<R: Read + Send + 'static>(mut pipe: R, stream: Stream, tx: Sender<Chunk>) {
    std::thread::spawn(move || {
        let mut buf = vec![0; READ_CHUNK];
        loop {
            match pipe.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    if tx.send(Chunk::Data(stream, buf[..n].to_vec())).is_err() {
                        return;
                    }
                }
                Err(e) if e.kind() == std::io::ErrorKind::Interrupted => {}
                Err(_) => break,
            }
        }
        // The receiver may already be gone (drain grace elapsed).
        let _ = tx.send(Chunk::Eof);
    });
}

/// Terminates a timed-out `git` and everything it started — see the
/// module doc for the per-platform semantics.
fn terminate(child: &mut Child) {
    #[cfg(unix)]
    {
        // `git` leads its own process group (`process_group(0)`), so its
        // pid is the group id — and stays reserved while `git` is
        // unreaped, which is why the group is only signalled while
        // `try_wait` still reports it running.
        let pgid = child.id();
        signal_group(pgid, "TERM");
        // A member stopped by SIGTTIN (an `ssh` prompt read from the
        // terminal outside the foreground group) only acts on the
        // pending SIGTERM once continued.
        signal_group(pgid, "CONT");
        let grace_deadline = Instant::now() + TERM_GRACE;
        loop {
            if matches!(child.try_wait(), Ok(Some(_))) {
                return;
            }
            if Instant::now() >= grace_deadline {
                signal_group(pgid, "KILL");
                break;
            }
            std::thread::sleep(POLL_INTERVAL);
        }
    }
    #[cfg(windows)]
    kill_tree(child.id());

    // Fallback for when the helper above could not run.
    let _ = child.kill();
    let _ = child.wait();
}

/// Sends `SIG<signal>` to process group `pgid` through `kill(1)`: std
/// only exposes `SIGKILL` for the child itself (`ChildExt::send_signal`
/// is still unstable, rust-lang/rust#141975) and the workspace denies
/// `unsafe_code`, so the POSIX utility is the std-only route to a group.
#[cfg(unix)]
fn signal_group(pgid: u32, signal: &str) {
    let status = Command::new("kill")
        .args(["-s", signal, "--", &format!("-{pgid}")])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
    if let Err(e) = status {
        tracing::warn!(pgid, signal, error = %e, "could not run kill(1) for a timed-out git");
    }
}

/// Force-terminates the process tree rooted at `pid` (`git` plus any
/// hook it is running) with `taskkill /T /F`.
#[cfg(windows)]
fn kill_tree(pid: u32) {
    use std::os::windows::process::CommandExt;
    let status = Command::new("taskkill")
        .args(["/T", "/F", "/PID", &pid.to_string()])
        .creation_flags(CREATE_NO_WINDOW)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
    if let Err(e) = status {
        tracing::warn!(pid, error = %e, "could not run taskkill for a timed-out git");
    }
}

/// Capability outcome of the startup `git --version` probe.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GitCapability {
    /// A `git` binary was found, ran, and meets [`MIN_GIT_VERSION`].
    Available {
        /// The parsed `(major, minor, patch)` version.
        version: (u32, u32, u32),
    },
    /// `git` is missing, unrunnable, or below [`MIN_GIT_VERSION`].
    Unavailable {
        /// A human-readable, log-safe explanation.
        reason: String,
    },
}

/// Runs `git --version` and checks it against [`MIN_GIT_VERSION`].
///
/// The startup capability probe: it never panics and never hides an
/// unavailable or too-old `git` — the caller surfaces
/// [`GitCapability::Unavailable`] to the user (a `system_log` event)
/// rather than letting worktree isolation fail mysteriously on the
/// first spawn.
#[must_use = "an unavailable git must be surfaced to the user, not ignored"]
pub fn probe_capability() -> GitCapability {
    let output = match run(&["--version"], READ_TIMEOUT) {
        Ok(output) => output,
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

    let text = String::from_utf8_lossy(&output.stdout);
    match parse_version(&text) {
        Some(version) if version >= MIN_GIT_VERSION => GitCapability::Available { version },
        Some((major, minor, patch)) => {
            let (min_major, min_minor, min_patch) = MIN_GIT_VERSION;
            GitCapability::Unavailable {
                reason: format!(
                    "git {major}.{minor}.{patch} is older than the required {min_major}.{min_minor}.{min_patch}"
                ),
            }
        }
        None => GitCapability::Unavailable {
            reason: format!(
                "could not parse `git --version` output: {:?}",
                redact::sanitize(&text)
            ),
        },
    }
}

/// Parses `git --version` output into `(major, minor, patch)`. Each
/// component is its leading ASCII digits, so vendor suffixes parse:
/// `2.43.0.windows.1`, `2.39.5 (Apple Git-154)`, `2.47.0.rc1`. A
/// missing patch component reads as `0`.
fn parse_version(text: &str) -> Option<(u32, u32, u32)> {
    let rest = text.trim().strip_prefix("git version ")?;
    let mut components = rest.split('.').map(|segment| {
        let digits = segment
            .find(|c: char| !c.is_ascii_digit())
            .map_or(segment, |end| &segment[..end]);
        digits.parse::<u32>().ok()
    });
    let major = components.next()??;
    let minor = components.next()??;
    let patch = components.next().flatten().unwrap_or(0);
    Some((major, minor, patch))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::repo::args_in;
    use crate::git::test_support::TempRepo;

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
    fn test_parse_version_apple_git_suffix() {
        assert_eq!(
            parse_version("git version 2.39.5 (Apple Git-154)\n"),
            Some((2, 39, 5))
        );
    }

    #[test]
    fn test_parse_version_release_candidate_and_missing_patch() {
        assert_eq!(parse_version("git version 2.47.0.rc1"), Some((2, 47, 0)));
        assert_eq!(parse_version("git version 2.47"), Some((2, 47, 0)));
    }

    #[test]
    fn test_parse_version_rejects_garbage() {
        assert_eq!(parse_version("not git at all"), None);
        assert_eq!(parse_version(""), None);
        assert_eq!(parse_version("git version x.y"), None);
    }

    #[test]
    fn test_min_version_ordering() {
        assert!((2, 32, 0) >= MIN_GIT_VERSION);
        assert!((2, 31, 9) < MIN_GIT_VERSION);
        assert!((3, 0, 0) >= MIN_GIT_VERSION);
    }

    #[test]
    fn test_subcommand_skips_global_dash_c_pairs() {
        let args = [
            "-C",
            "/repo",
            "-c",
            "core.longpaths=true",
            "commit",
            "-m",
            "a secret message",
        ];
        assert_eq!(subcommand(&args), "commit");
        assert_eq!(subcommand(&["--version"]), "--version");
    }

    #[test]
    fn test_command_sets_env_hygiene_and_removes_repo_location_vars() {
        let command = command(&["status"]);
        let envs: Vec<_> = command.get_envs().collect();
        for var in [
            "GIT_DIR",
            "GIT_WORK_TREE",
            "GIT_INDEX_FILE",
            "GIT_COMMON_DIR",
        ] {
            assert!(
                envs.contains(&(OsStr::new(var), None)),
                "{var} must be removed from the child environment: {envs:?}"
            );
        }
        for (key, value) in [
            ("GIT_TERMINAL_PROMPT", "0"),
            ("GCM_INTERACTIVE", "never"),
            ("GIT_OPTIONAL_LOCKS", "0"),
            ("LC_ALL", "C"),
        ] {
            assert!(
                envs.contains(&(OsStr::new(key), Some(OsStr::new(value)))),
                "{key}={value} must be set on the child: {envs:?}"
            );
        }
    }

    /// The hard-coded list must match what the installed git reports, so
    /// a git release that adds a repo-location variable fails this test
    /// instead of silently escaping the hygiene block.
    #[test]
    fn test_repo_local_env_vars_cover_what_git_reports() {
        let out = run(&["rev-parse", "--local-env-vars"], READ_TIMEOUT).unwrap();
        assert!(out.success(), "{}", out.stderr);
        let text = String::from_utf8_lossy_owned(out.stdout);
        for var in text.lines().filter(|l| !l.is_empty()) {
            assert!(
                REPO_LOCAL_ENV_VARS.contains(&var),
                "git reports {var} but REPO_LOCAL_ENV_VARS does not remove it"
            );
        }
    }

    /// Requires a real `git` binary on PATH, as every CI runner image
    /// provides.
    #[test]
    fn test_probe_capability_against_real_git() {
        match probe_capability() {
            GitCapability::Available { version } => assert!(version >= MIN_GIT_VERSION),
            GitCapability::Unavailable { reason } => {
                panic!("expected git to be available in the test environment: {reason}")
            }
        }
    }

    #[test]
    fn test_run_passes_shell_metacharacters_as_literal_args() {
        // A string that would be dangerous on a shell command line is
        // an inert argument to git, which rejects it as an unknown
        // revision instead of executing anything.
        let repo = TempRepo::new("cli-metacharacters");
        let out = run(
            &args_in(repo.root(), &["rev-parse", "; rm -rf / #"]),
            READ_TIMEOUT,
        )
        .expect("git should run (and fail) without spawning a shell");
        assert!(!out.success());
        assert!(
            out.raw_stderr().contains("unknown revision"),
            "{}",
            out.stderr
        );
    }

    /// stdout is data: nothing may truncate or rewrite it. A 20 KB,
    /// token-shaped payload piped through `git stripspace` (which echoes
    /// its stdin plus a final newline) must come back byte-for-byte.
    #[test]
    fn test_run_returns_stdout_raw_untruncated_and_unredacted() {
        let token = format!("ghp_{}", "a".repeat(36));
        let payload = format!("{token} {}", "x".repeat(20_000));
        let out = run_with_stdin(&["stripspace"], payload.as_bytes(), READ_TIMEOUT).unwrap();
        assert!(out.success(), "{}", out.stderr);
        assert_eq!(
            String::from_utf8(out.stdout).unwrap(),
            format!("{payload}\n")
        );
    }

    /// The redaction choke point, exercised with output git does not
    /// anonymize itself: `git config --get` echoes a credentialed URL
    /// verbatim. On stdout (data) it stays raw; once it becomes an
    /// error message through stderr it must be redacted.
    #[test]
    fn test_run_redacts_credentials_on_stderr_but_not_stdout() {
        let repo = TempRepo::new("cli-redaction");
        let url = "https://alice:hunter2@example.invalid/repo.git";
        let config = format!("remote.origin.url={url}");
        let out = run(
            &args_in(
                repo.root(),
                &["-c", &config, "config", "--get", "remote.origin.url"],
            ),
            READ_TIMEOUT,
        )
        .unwrap();
        assert!(out.success(), "{}", out.stderr);
        assert_eq!(out.stdout_trimmed(), url, "stdout is data and stays raw");

        // `git check-ref-format` echoes its argument on stderr when it
        // rejects it ("fatal: '<arg>' is not a valid branch name").
        let bad = "https://alice:hunter2@example.invalid/x..y";
        let out = run(
            &args_in(repo.root(), &["check-ref-format", "--branch", bad]),
            READ_TIMEOUT,
        )
        .unwrap();
        assert!(!out.success());
        assert!(out.raw_stderr().contains("hunter2"), "{}", out.raw_stderr());
        assert!(
            !out.stderr.contains("hunter2"),
            "credentials must be redacted from surfaced stderr: {}",
            out.stderr
        );
    }

    /// A git that outlives its budget fails with a typed error naming only
    /// the subcommand, without waiting out the process it started.
    #[test]
    fn test_run_timeout_terminates_and_reports_a_typed_error() {
        let repo = TempRepo::new("cli-timeout");
        let started = Instant::now();
        let result = run(
            &args_in(repo.root(), &["-c", "alias.hang=!sleep 60", "hang"]),
            Duration::from_millis(300),
        );
        let elapsed = started.elapsed();
        match result {
            Err(AppError::GitTimeout { command, timeout }) => {
                assert_eq!(command, "hang");
                assert_eq!(timeout, Duration::from_millis(300));
            }
            other => panic!("expected GitTimeout, got {other:?}"),
        }
        assert!(
            elapsed < Duration::from_secs(20),
            "termination must not wait for the 60 s sleep: {elapsed:?}"
        );
    }

    /// A timeout signals the group with `SIGTERM` first, so git's own
    /// handler deletes the locks it holds instead of leaving `index.lock`
    /// behind to wedge the checkout. `commit -a` holds `index.lock` for as
    /// long as its `pre-commit` hook runs (a `SIGKILL` at that point
    /// leaves the lock on disk), which makes it a deterministic lock
    /// holder to time out.
    #[cfg(unix)]
    #[test]
    fn test_timeout_mid_commit_leaves_no_index_lock() {
        let repo = TempRepo::new("cli-timeout-lock");
        let hooks = repo.base().join("hooks");
        std::fs::create_dir_all(&hooks).unwrap();
        let hook = hooks.join("pre-commit");
        std::fs::write(&hook, "#!/bin/sh\nsleep 60\n").unwrap();
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        repo.write("README.md", "changed\n");

        let hooks_path = format!("core.hooksPath={}", hooks.display());
        let result = run(
            &args_in(
                repo.root(),
                &["-c", &hooks_path, "commit", "-a", "-m", "never lands"],
            ),
            Duration::from_secs(2),
        );

        assert!(
            matches!(result, Err(AppError::GitTimeout { .. })),
            "{result:?}"
        );
        let index_lock = repo.root().join(".git").join("index.lock");
        assert!(
            !index_lock.exists(),
            "a terminated commit must not leave {} behind",
            index_lock.display()
        );
    }

    /// A timeout signals git's whole process group, so a process an
    /// alias backgrounded dies with git.
    #[cfg(unix)]
    #[test]
    fn test_timeout_terminates_backgrounded_descendants() {
        let repo = TempRepo::new("cli-timeout-descendant");
        let pid_file = repo.root().join("sleep.pid");
        let alias = format!(
            "alias.hang=!sleep 60 & echo $! > '{}'; wait",
            pid_file.display()
        );
        let result = run(
            &args_in(repo.root(), &["-c", &alias, "hang"]),
            Duration::from_secs(2),
        );
        assert!(
            matches!(result, Err(AppError::GitTimeout { .. })),
            "{result:?}"
        );
        let pid = std::fs::read_to_string(&pid_file)
            .unwrap()
            .trim()
            .to_owned();
        let deadline = Instant::now() + Duration::from_secs(5);
        while Command::new("kill")
            .args(["-0", &pid])
            .stderr(Stdio::null())
            .status()
            .unwrap()
            .success()
        {
            assert!(Instant::now() < deadline, "sleep {pid} outlived git");
            std::thread::sleep(Duration::from_millis(50));
        }
    }

    /// A descendant that inherits git's pipes and outlives it (an ssh
    /// ControlPersist master, a daemonizing hook) must not hold the
    /// caller hostage: output is collected up to the drain grace.
    #[test]
    fn test_run_does_not_wait_for_a_grandchild_holding_the_pipes() {
        let repo = TempRepo::new("cli-grandchild");
        let started = Instant::now();
        let out = run(
            &args_in(
                repo.root(),
                &["-c", "alias.bg=!sleep 10 & echo started", "bg"],
            ),
            READ_TIMEOUT,
        )
        .unwrap();
        let elapsed = started.elapsed();
        assert!(out.success(), "{}", out.stderr);
        assert!(
            String::from_utf8_lossy(&out.stdout).contains("started"),
            "output written before exit must be kept"
        );
        assert!(
            elapsed < Duration::from_secs(5),
            "the drain must be bounded, not wait for the 10 s sleep: {elapsed:?}"
        );
    }
}
