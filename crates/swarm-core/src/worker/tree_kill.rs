//! Ending a child process and everything it started, with std only.
//!
//! A provider CLI rarely runs alone: an npm install of Codex is a
//! `codex.cmd` shim that std runs through `cmd.exe /c`, with `node` and
//! the native binary beneath it, and a Bash tool call leaves a shell
//! under any provider. Killing only the child Swarm holds leaves the rest
//! writing in the worktree. A timed-out `git` call (`git::cli`) and the
//! hooks and helpers it started are ended the same way.
//!
//! | Platform | Group a child into | Terminate request | Forced kill |
//! |----------|--------------------|-------------------|-------------|
//! | Unix     | its own process group ([`lead_own_group`]) | `SIGTERM` + `SIGCONT` to the group | `SIGKILL` to the group |
//! | Windows  | (the parent-pid tree) | none | `taskkill /T /F` |
//!
//! Signals go through `kill(1)`: std only exposes `SIGKILL` for the child
//! itself (`ChildExt::send_signal` is still unstable,
//! rust-lang/rust#141975) and the workspace denies `unsafe_code`, so the
//! POSIX utility is the std-only route to a group. On Windows a Job
//! Object would need the same `unsafe`, and `taskkill /T` without `/F`
//! posts `WM_CLOSE`, which a windowless console child never receives, so
//! there is no graceful tree request there: a caller's graceful step is
//! closing the child's stdin.
//!
//! [`terminate`] and [`kill`] first ask `try_wait` whether the child still
//! runs. An unreaped child keeps its pid (and, on Unix, its group id)
//! reserved; once `try_wait` has reaped it, the number can belong to an
//! unrelated process, so nothing is signalled after that. A grandchild
//! that outlives a provider which exited on its own is therefore not
//! reached.
//!
//! [`terminate`] and [`kill`] run a short-lived helper process and wait for
//! it: call them off the async runtime's worker threads.

use std::process::{Child, Command, Stdio};

/// Windows `CREATE_NO_WINDOW`: `taskkill` itself must not open a console
/// window from the windowless desktop app.
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Makes the child `cmd` starts the leader of a new process group (Unix),
/// so [`terminate`] and [`kill`] reach everything it starts unless a
/// descendant moves itself to another group or session. A no-op on
/// Windows, where the tree is the parent-pid chain `taskkill /T` walks.
pub(crate) fn lead_own_group(cmd: &mut Command) {
    #[cfg(unix)]
    std::os::unix::process::CommandExt::process_group(cmd, 0);
    #[cfg(windows)]
    let _ = cmd;
}

/// Whether `child` is still running (unreaped). An error from `try_wait`
/// counts as running: the child has not been reaped, so its pid is still
/// its own.
fn running(child: &mut Child) -> bool {
    match child.try_wait() {
        Ok(Some(_)) => false,
        Ok(None) => true,
        Err(error) => {
            tracing::warn!(pid = child.id(), %error, "polling a child before signalling its tree failed");
            true
        }
    }
}

/// Asks the group `child` leads to terminate: `SIGTERM`, then `SIGCONT`
/// so a member stopped by job control (a `SIGTTIN` from reading the
/// terminal outside the foreground group) acts on it. Does nothing on
/// Windows (see the module doc) or once the child has exited.
pub(crate) fn terminate(child: &mut Child) {
    if !running(child) {
        return;
    }
    #[cfg(unix)]
    {
        let pgid = child.id();
        signal_group(pgid, "TERM");
        signal_group(pgid, "CONT");
    }
}

/// Force-kills `child` and everything in its tree, unless the child has
/// already exited: `SIGKILL` to its group (Unix), `taskkill /T /F`
/// (Windows), then `Child::kill` on the child itself in case the helper
/// could not run. Does not reap the child.
pub(crate) fn kill(child: &mut Child) {
    if !running(child) {
        return;
    }
    #[cfg(unix)]
    signal_group(child.id(), "KILL");
    #[cfg(windows)]
    kill_tree(child.id());
    if let Err(error) = child.kill() {
        tracing::debug!(pid = child.id(), %error, "killing the child after its tree failed");
    }
}

/// Sends `SIG<signal>` to process group `pgid` through `kill(1)`.
#[cfg(unix)]
fn signal_group(pgid: u32, signal: &str) {
    let status = Command::new("kill")
        .args(["-s", signal, "--", &format!("-{pgid}")])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
    if let Err(error) = status {
        tracing::warn!(pgid, signal, %error, "could not run kill(1) for a process group");
    }
}

/// Force-terminates the process tree rooted at `pid` with
/// `taskkill /T /F`.
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
    if let Err(error) = status {
        tracing::warn!(pid, %error, "could not run taskkill for a process tree");
    }
}

#[cfg(test)]
mod tests {
    use std::time::{Duration, Instant};

    use super::*;

    /// A child that sleeps until it is killed.
    fn sleeper() -> Command {
        let mut cmd = if cfg!(windows) {
            let mut cmd = Command::new("powershell.exe");
            cmd.args([
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "Start-Sleep 600",
            ]);
            cmd
        } else {
            let mut cmd = Command::new("/bin/sh");
            cmd.args(["-c", "sleep 600"]);
            cmd
        };
        cmd.stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        lead_own_group(&mut cmd);
        cmd
    }

    fn wait_with_deadline(child: &mut Child) -> std::process::ExitStatus {
        let deadline = Instant::now() + Duration::from_secs(30);
        loop {
            if let Some(status) = child.try_wait().expect("try_wait") {
                return status;
            }
            assert!(Instant::now() < deadline, "the child outlived its kill");
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    #[test]
    fn test_kill_ends_a_running_child() {
        let mut child = sleeper().spawn().expect("the sleeper spawns");
        kill(&mut child);
        assert!(!wait_with_deadline(&mut child).success());
    }

    /// Once reaped, a child is left alone: a second kill (and a
    /// terminate) signal nothing and leave the status as it was.
    #[test]
    fn test_kill_and_terminate_after_the_child_was_reaped_are_no_ops() {
        let mut child = sleeper().spawn().expect("the sleeper spawns");
        kill(&mut child);
        let status = wait_with_deadline(&mut child);
        kill(&mut child);
        terminate(&mut child);
        assert_eq!(child.try_wait().expect("try_wait"), Some(status));
    }

    #[cfg(unix)]
    #[test]
    fn test_terminate_ends_a_child_by_sigterm() {
        use std::os::unix::process::ExitStatusExt;

        let mut child = sleeper().spawn().expect("the sleeper spawns");
        terminate(&mut child);
        assert_eq!(wait_with_deadline(&mut child).signal(), Some(15));
    }
}
