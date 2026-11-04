//! `PipedHandle::stop` ends a provider and everything it started.
//!
//! The fixtures under `tests/fixtures/proc/` reproduce the two ways a
//! plain `Child::kill` leaves a provider running:
//!
//! - **The npm shim.** An npm install of Codex puts `codex.cmd` on `PATH`,
//!   and std runs a `.cmd` through `cmd.exe /c`, so the child Swarm holds
//!   is `cmd.exe` and the `node` beneath it survives a kill of the child.
//!   `codex.cmd` runs the fake Codex app-server the same way; on Unix its
//!   twin `codex.sh` is a shell that runs node as its child.
//! - **A grandchild.** `grandchild.mjs` starts a sleeping process the way
//!   a Bash tool call does.
//!
//! Every test needs `node` on `PATH`, as the adapter tests do.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::ExitStatus;
use std::time::{Duration, Instant};

use swarm_core::worker::proc::{ExitSequence, PipedHandle, spawn_piped};
use uuid::Uuid;

/// Grace a hung fixture is given before the tree kill.
const GRACE: Duration = Duration::from_millis(500);
/// Upper bound for a fixture to start (node's cold start on a fresh CI
/// runner included) or for a killed process to disappear.
const WAIT: Duration = Duration::from_secs(60);

fn fixture(dir: &str, name: &str) -> String {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("fixtures")
        .join(dir)
        .join(name)
        .display()
        .to_string()
}

/// A per-test temporary directory, removed on drop.
struct Scratch(PathBuf);

impl Scratch {
    fn new() -> Self {
        let dir = std::env::temp_dir().join(format!("swarm-proc-test-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&dir).expect("create the scratch dir");
        Self(dir)
    }

    fn file(&self, name: &str) -> String {
        self.0.join(name).display().to_string()
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// The fake Codex app-server started through its shim with `script`,
/// recording to `record`: `codex.cmd` on Windows (std runs it through
/// `cmd.exe /c`), `/bin/sh codex.sh` elsewhere.
fn spawn_codex_shim(script: &str, record: &str) -> PipedHandle {
    let fake_args = [
        "--script".to_owned(),
        script.to_owned(),
        "--record".to_owned(),
        record.to_owned(),
        "app-server".to_owned(),
    ];
    let (program, args) = if cfg!(windows) {
        (fixture("proc", "codex.cmd"), fake_args.to_vec())
    } else {
        let mut args = vec![fixture("proc", "codex.sh")];
        args.extend(fake_args);
        ("/bin/sh".to_owned(), args)
    };
    spawn_piped(&program, &args, "", &HashMap::new()).expect("the codex shim spawns")
}

/// Polls until `path` holds a line `parse` accepts, or panics after
/// [`WAIT`].
async fn wait_for<T>(path: &str, parse: impl Fn(&str) -> Option<T>) -> T {
    let deadline = Instant::now() + WAIT;
    loop {
        if let Some(found) = std::fs::read_to_string(path)
            .ok()
            .and_then(|text| text.lines().find_map(&parse))
        {
            return found;
        }
        assert!(
            Instant::now() < deadline,
            "{path} never got the expected line"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

/// The pid the fake Codex app-server records when it starts.
async fn app_server_pid(record: &str) -> u32 {
    wait_for(record, |line| {
        let entry: serde_json::Value = serde_json::from_str(line).ok()?;
        if entry["fake"] != "started" {
            return None;
        }
        u32::try_from(entry["pid"].as_u64()?).ok()
    })
    .await
}

/// The `(pid, grandchild)` pair `grandchild.mjs` writes.
async fn grandchild_pids(pidfile: &str) -> (u32, u32) {
    wait_for(pidfile, |line| {
        let entry: serde_json::Value = serde_json::from_str(line).ok()?;
        let pid = |key: &str| u32::try_from(entry[key].as_u64()?).ok();
        Some((pid("pid")?, pid("grandchild")?))
    })
    .await
}

/// Whether `pid` names a live process. A zombie (Unix) counts as gone:
/// it has exited and only waits for its reaper.
fn is_running(pid: u32) -> bool {
    if cfg!(windows) {
        let output = std::process::Command::new("tasklist")
            .args(["/FI", &format!("PID eq {pid}"), "/NH", "/FO", "CSV"])
            .output()
            .expect("tasklist runs");
        String::from_utf8_lossy(&output.stdout).contains(&format!("\"{pid}\""))
    } else {
        let output = std::process::Command::new("ps")
            .args(["-o", "stat=", "-p", &pid.to_string()])
            .output()
            .expect("ps runs");
        let stat = String::from_utf8_lossy(&output.stdout);
        output.status.success() && !stat.trim().is_empty() && !stat.trim_start().starts_with('Z')
    }
}

/// Polls until `pid` is gone, or panics after [`WAIT`].
async fn assert_gone(pid: u32, what: &str) {
    let deadline = Instant::now() + WAIT;
    while is_running(pid) {
        assert!(
            Instant::now() < deadline,
            "{what} (pid {pid}) still runs after stop"
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

/// Runs the blocking [`PipedHandle::stop`] on the blocking pool and
/// returns its status and how long it took.
async fn stop(
    mut handle: PipedHandle,
    sequence: ExitSequence,
    grace: Duration,
) -> (ExitStatus, Duration) {
    tokio::task::spawn_blocking(move || {
        let started = Instant::now();
        let status = handle.stop(sequence, grace).expect("stop reaps the child");
        (status, started.elapsed())
    })
    .await
    .expect("the stop task completes")
}

/// The Windows premise of F-08: a hung app-server behind its shim ends
/// with the shim, `node` included.
#[tokio::test]
async fn test_stop_ends_a_hung_app_server_beneath_its_shim() {
    let scratch = Scratch::new();
    let record = scratch.file("wire.jsonl");
    let handle = spawn_codex_shim(&fixture("proc", "hung_app_server.script"), &record);
    let node = app_server_pid(&record).await;
    assert!(is_running(node), "the app-server runs before stop");

    let (status, _) = stop(handle, ExitSequence::CloseStdinThenWait, GRACE).await;

    assert!(!status.success(), "a hung app-server is killed: {status}");
    assert_gone(node, "the node beneath the shim").await;
}

/// An app-server that honours stdin EOF exits on its own within the
/// grace: no kill, its own exit status.
#[tokio::test]
async fn test_stop_lets_an_app_server_exit_cleanly_on_stdin_eof() {
    let scratch = Scratch::new();
    let record = scratch.file("wire.jsonl");
    let handle = spawn_codex_shim(&fixture("codex", "handshake.script"), &record);
    let node = app_server_pid(&record).await;

    let grace = Duration::from_secs(30);
    let (status, elapsed) = stop(handle, ExitSequence::CloseStdinThenWait, grace).await;

    assert!(status.success(), "a clean exit keeps its status: {status}");
    assert!(
        elapsed < grace,
        "the clean exit came within the grace: {elapsed:?}"
    );
    assert_gone(node, "the app-server").await;
}

/// A hung provider's grandchild ends with it.
#[tokio::test]
async fn test_stop_ends_a_sleeping_grandchild() {
    let scratch = Scratch::new();
    let pidfile = scratch.file("pids.json");
    let handle = spawn_piped(
        "node",
        &[fixture("proc", "grandchild.mjs"), pidfile.clone()],
        "",
        &HashMap::new(),
    )
    .expect("node spawns");
    let (provider, grandchild) = grandchild_pids(&pidfile).await;
    assert!(is_running(grandchild), "the grandchild runs before stop");

    let (status, _) = stop(handle, ExitSequence::CloseStdinThenWait, GRACE).await;

    assert!(!status.success(), "a hung provider is killed: {status}");
    assert_gone(provider, "the provider").await;
    assert_gone(grandchild, "the grandchild").await;
}

/// `SignalThenCloseStdin` asks the whole group to terminate first, so a
/// provider that ignores stdin EOF but honours SIGTERM ends long before
/// the grace runs out, by that signal, with its grandchild. Unix only: on
/// Windows the graceful step is closing stdin.
#[cfg(unix)]
#[tokio::test]
async fn test_signal_then_close_stdin_terminates_the_group_before_the_grace() {
    use std::os::unix::process::ExitStatusExt;

    let scratch = Scratch::new();
    let pidfile = scratch.file("pids.json");
    let handle = spawn_piped(
        "node",
        &[fixture("proc", "grandchild.mjs"), pidfile.clone()],
        "",
        &HashMap::new(),
    )
    .expect("node spawns");
    let (provider, grandchild) = grandchild_pids(&pidfile).await;

    let grace = Duration::from_secs(30);
    let (status, elapsed) = stop(handle, ExitSequence::SignalThenCloseStdin, grace).await;

    assert_eq!(status.signal(), Some(15), "SIGTERM ended it: {status}");
    assert!(elapsed < grace, "it ended within the grace: {elapsed:?}");
    assert_gone(provider, "the provider").await;
    assert_gone(grandchild, "the grandchild").await;
}

/// A child that already exited is only reaped: its status comes back and
/// nothing is signalled (its pid may already belong to another process).
#[tokio::test]
async fn test_stop_after_the_child_exited_returns_its_status() {
    let mut handle = spawn_piped(
        "node",
        &["-e".to_owned(), "process.exit(7)".to_owned()],
        "",
        &HashMap::new(),
    )
    .expect("node spawns");
    let deadline = Instant::now() + WAIT;
    while handle.child.try_wait().expect("try_wait").is_none() {
        assert!(Instant::now() < deadline, "node -e never exited");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }

    let (status, _) = stop(handle, ExitSequence::SignalThenCloseStdin, GRACE).await;

    assert_eq!(status.code(), Some(7));
}

/// A zero grace is a forced stop: the tree is killed while stdin is still
/// open, so a provider that exits 0 the moment its stdin ends is killed
/// rather than left to end its work cleanly (a busy Claude Code session's
/// teardown). The `close_stdin` here returns only once the child is gone
/// (its stdout reaches EOF): that is how a fast stdin-EOF exit looks to a
/// stop that runs on a loaded runner, where the kill helper starts slowly.
#[test]
fn test_a_zero_grace_kills_the_tree_before_closing_stdin() {
    use std::io::{BufRead, BufReader};
    use std::process::{Command, Stdio};

    use swarm_core::worker::proc::stop_tree;

    let mut command = Command::new("node");
    command
        .args([
            "-e",
            "process.stdin.on('end', () => process.exit(0)).resume(); console.log('ready');",
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    #[cfg(unix)]
    std::os::unix::process::CommandExt::process_group(&mut command, 0);
    let mut child = command.spawn().expect("node spawns");
    let stdin = child.stdin.take().expect("piped stdin");
    let mut stdout = BufReader::new(child.stdout.take().expect("piped stdout"));
    let mut ready = String::new();
    stdout.read_line(&mut ready).expect("node reports ready");
    assert_eq!(ready.trim_end(), "ready");

    stop_tree(
        &mut child,
        || {
            drop(stdin);
            std::io::copy(&mut stdout, &mut std::io::sink()).expect("stdout drains to EOF");
        },
        ExitSequence::CloseStdinThenWait,
        Duration::ZERO,
    );
    let status = child.wait().expect("the child is reaped");

    assert!(
        !status.success(),
        "the child was killed, not ended by stdin EOF: {status}"
    );
    #[cfg(unix)]
    assert_eq!(
        std::os::unix::process::ExitStatusExt::signal(&status),
        Some(9),
        "SIGKILL ended it: {status}"
    );
}
