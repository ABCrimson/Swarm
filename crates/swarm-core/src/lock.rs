//! Single-instance lock.
//!
//! Two engines opening the same `swarm-events.db` would both resume
//! `seq` from `max_seq()` and collide on the `PRIMARY KEY`: appends
//! would fail while live emission kept handing out duplicate `seq`
//! values. Every shell that embeds `swarm-core` (`swarm-desktop` and
//! `swarmd` alike) therefore takes this lock first, before the event log
//! is opened, and whichever starts second refuses to touch the data
//! directory at all.
//!
//! Two files under [`crate::Paths::data_dir`]:
//!
//! - `daemon.lock` — the actual mutex: opened with shared access, then
//!   locked exclusively for the life of the process (the lock, not the
//!   open, is exclusive). Never read for content; the mere fact of
//!   holding the lock IS the lock. OS-native via std's
//!   [`File::try_lock`]: an advisory `flock(LOCK_EX | LOCK_NB)` on Unix,
//!   a mandatory `LockFileEx` byte-range lock with
//!   `LOCKFILE_EXCLUSIVE_LOCK | LOCKFILE_FAIL_IMMEDIATELY` on Windows.
//!   Dropping the guard unlocks it explicitly ([`File::unlock`]), and the
//!   OS releases it anyway on process exit OR crash — no stale-lock
//!   cleanup, no PID-liveness polling, no `unsafe`. The explicit unlock
//!   matters on Unix: a `flock` belongs to the open file description, and
//!   every child forked while the lock is held (a PTY, git or agent CLI
//!   process) shares that description until its exec closes the
//!   `O_CLOEXEC` copy, so closing our fd alone could leave the lock held
//!   past the drop.
//! - `daemon.lock.json` — informational only (pid, which shell, bind
//!   address if any, start time), overwritten after every successful
//!   acquire. A losing contender reads it (best-effort — a missing or
//!   unreadable info file still yields an honest "already running,
//!   details unknown" message rather than failing to report at all) to
//!   build the "SWARM Is Already Running" message. Its content can go
//!   stale between a crash and the next successful acquire; that is
//!   expected and harmless, since it is never consulted to decide
//!   whether the lock is held — only to describe who holds it.

use std::fs::{File, OpenOptions, TryLockError};
use std::io;
use std::path::Path;

use serde::{Deserialize, Serialize};

const LOCK_FILE: &str = "daemon.lock";
const INFO_FILE: &str = "daemon.lock.json";

/// Informational snapshot of who holds (or last held) the lock.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LockInfo {
    /// OS process id of the holder.
    pub pid: u32,
    /// Which shell acquired the lock: `"swarm-desktop"` or `"swarmd"`.
    pub shell: String,
    /// The daemon's listen address (`swarmd` only; `None` for the
    /// desktop shell, which has no network listener).
    pub bind: Option<String>,
    /// Unix timestamp (ms) when the lock was acquired.
    pub started_at: i64,
}

impl Default for LockInfo {
    fn default() -> Self {
        Self {
            pid: 0,
            shell: "unknown".to_string(),
            bind: None,
            started_at: 0,
        }
    }
}

/// Failure to acquire the single-instance lock. Its `Display` is the
/// Title Case message a shell shows the user.
#[derive(Debug, thiserror::Error)]
pub enum LockError {
    /// Another process already holds the lock. Carries the
    /// best-effort [`LockInfo`] describing it (pid `0`/`shell:
    /// "unknown"` when the info file itself couldn't be read — the lock
    /// contention is still real even when the description isn't).
    #[error("{}", already_running_message(.0))]
    AlreadyRunning(LockInfo),
    /// Any other I/O failure acquiring the lock (permission denied on
    /// the data dir, disk full, etc.) — distinct from contention.
    #[error("Failed To Acquire The SWARM Instance Lock: {0}")]
    Io(#[from] io::Error),
}

/// "SWARM Is Already Running (<shell>, Pid <pid>)", plus where to
/// connect when the holder is a daemon. Naming the shell tells the reader
/// what to do next: close a desktop window or stop a daemon.
fn already_running_message(info: &LockInfo) -> String {
    let connect = info
        .bind
        .as_ref()
        .map(|bind| format!(" — Connect At {bind}"))
        .unwrap_or_default();
    format!(
        "SWARM Is Already Running ({}, Pid {}){connect}",
        shell_display_name(&info.shell),
        info.pid
    )
}

/// Human-readable name for a lock-holder's `shell` identifier —
/// `"swarmd"` stays lowercase (a program name, not prose); anything
/// else falls back to the raw identifier verbatim so a future third
/// shell (or a value from an old/foreign build) is never displayed as
/// an empty or garbled string.
fn shell_display_name(shell: &str) -> &str {
    match shell {
        "swarm-desktop" => "SWARM Desktop",
        other => other,
    }
}

/// RAII handle to the held lock. Dropping it unlocks the underlying OS
/// lock (and process exit or crash releases it too) — no explicit
/// `release()` needed or provided.
#[derive(Debug)]
pub struct SingleInstanceLock {
    // Held to keep the OS lock alive for `Self`'s lifetime; its content
    // is never read or written after acquisition.
    file: File,
}

fn read_info(info_path: &Path) -> LockInfo {
    std::fs::read_to_string(info_path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn write_info(info_path: &Path, info: &LockInfo) -> io::Result<()> {
    let json = serde_json::to_string_pretty(info).map_err(io::Error::other)?;
    let tmp_path = info_path.with_added_extension("tmp");
    std::fs::write(&tmp_path, json)?;
    std::fs::rename(&tmp_path, info_path)
}

/// Opens (creating if needed) `daemon.lock` and takes a non-blocking
/// exclusive OS lock on it with [`File::try_lock`]. One code path for
/// every platform: the lock is tied to the open handle (on Unix, to its
/// open file description), released by [`SingleInstanceLock`]'s `Drop`
/// or by the OS on exit or crash.
///
/// The file is opened with std's default sharing, so another handle on
/// it (an antivirus or EDR scanner inspecting the new file, say) never
/// turns a first acquire into a false "already running"; only a held
/// lock does.
fn try_lock(lock_path: &Path, info_path: &Path) -> Result<File, LockError> {
    // `truncate(false)`: this file's CONTENT is never read or written —
    // only the OS-level lock on the open handle matters — so opening it
    // must not destroy whatever (irrelevant) bytes a prior run left
    // behind.
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(lock_path)?;
    match file.try_lock() {
        Ok(()) => Ok(file),
        Err(TryLockError::WouldBlock) => Err(LockError::AlreadyRunning(read_info(info_path))),
        Err(TryLockError::Error(e)) => Err(LockError::Io(e)),
    }
}

impl SingleInstanceLock {
    /// Attempts to acquire the single-instance lock under `data_dir`.
    ///
    /// `shell` identifies the caller (`"swarm-desktop"` or `"swarmd"`)
    /// and `bind` is the daemon's listen address when applicable — both
    /// are purely informational, written into `daemon.lock.json` for a
    /// losing contender to report.
    ///
    /// # Errors
    ///
    /// [`LockError::AlreadyRunning`] if another process already holds
    /// the lock; [`LockError::Io`] for any other failure (e.g. the data
    /// directory cannot be created).
    pub fn acquire(data_dir: &Path, shell: &str, bind: Option<String>) -> Result<Self, LockError> {
        std::fs::create_dir_all(data_dir)?;
        let lock_path = data_dir.join(LOCK_FILE);
        let info_path = data_dir.join(INFO_FILE);

        let file = try_lock(&lock_path, &info_path)?;

        // Best-effort: a failure to write the info file must not undo an
        // already-acquired real lock — the OS-level lock is what
        // matters for correctness, this is only for a future
        // contender's error message.
        if let Err(e) = write_info(
            &info_path,
            &LockInfo {
                pid: std::process::id(),
                shell: shell.to_string(),
                bind,
                started_at: crate::clock::unix_millis(),
            },
        ) {
            tracing::warn!(error = %e, "failed to write daemon.lock.json (lock itself is still held)");
        }

        Ok(Self { file })
    }
}

impl Drop for SingleInstanceLock {
    /// Unlocks explicitly rather than relying on the fd closing: on Unix
    /// a child forked while the lock is held shares its open file
    /// description (until that child execs, or for its whole life if it
    /// inherited the fd), and `flock(LOCK_UN)` releases the lock even
    /// then, where a plain close would not. On Windows this is
    /// `UnlockFile`. Best-effort: on failure the close that follows still
    /// releases the lock once no process holds the description.
    fn drop(&mut self) {
        if let Err(e) = self.file.unlock() {
            tracing::warn!(error = %e, "failed to unlock daemon.lock on drop");
        }
    }
}

#[cfg(test)]
mod tests {
    use std::mem::DropGuard;
    use std::path::PathBuf;

    use super::*;

    /// Recursively removes `dir` when the guard drops, so a failing
    /// assertion still cleans up.
    fn remove_on_drop(dir: PathBuf) -> DropGuard<PathBuf, impl FnOnce(PathBuf)> {
        DropGuard::new(dir, |dir| {
            let _ = std::fs::remove_dir_all(dir);
        })
    }

    #[test]
    fn test_acquire_succeeds_on_a_fresh_data_dir() {
        let dir = std::env::temp_dir().join(format!("swarm-lock-test-{}", uuid::Uuid::new_v4()));
        let _cleanup = remove_on_drop(dir.clone());
        let lock = SingleInstanceLock::acquire(&dir, "swarmd", Some("127.0.0.1:8787".to_string()));
        assert!(lock.is_ok());
    }

    #[test]
    fn test_second_acquire_in_the_same_process_is_rejected() {
        // A second attempt while the first guard is alive fails as
        // AlreadyRunning, even within one process. The cross-process case
        // (two real `swarmd` binaries on one data dir) is covered by
        // crates/swarmd/tests/integration.rs's
        // `test_second_daemon_on_the_same_data_dir_exits_75`.
        let dir = std::env::temp_dir().join(format!("swarm-lock-test-{}", uuid::Uuid::new_v4()));
        let _cleanup = remove_on_drop(dir.clone());
        let first = SingleInstanceLock::acquire(&dir, "swarm-desktop", None).unwrap();

        let second =
            SingleInstanceLock::acquire(&dir, "swarmd", Some("127.0.0.1:8787".to_string()));
        match second {
            Err(LockError::AlreadyRunning(info)) => {
                assert_eq!(info.pid, std::process::id());
                assert_eq!(info.shell, "swarm-desktop");
            }
            other => panic!("expected AlreadyRunning, got {other:?}"),
        }
        drop(first);
    }

    #[test]
    fn test_lock_released_on_drop_allows_reacquire() {
        let dir = std::env::temp_dir().join(format!("swarm-lock-test-{}", uuid::Uuid::new_v4()));
        let _cleanup = remove_on_drop(dir.clone());
        {
            let _first = SingleInstanceLock::acquire(&dir, "swarmd", None).unwrap();
        } // dropped here — OS lock released
        let second = SingleInstanceLock::acquire(&dir, "swarmd", None);
        assert!(second.is_ok(), "expected reacquire to succeed after drop");
    }

    /// Regression (Unix): a child process that shares the lock's open
    /// file description must not keep the lock alive past `drop`. Every
    /// process forked while the lock is held shares it (a PTY, git or
    /// agent CLI child, until its exec closes the `O_CLOEXEC` copy), and
    /// a `flock` belongs to the open file description, not to one fd, so
    /// closing our fd alone left it held. Here the child's stdin IS the
    /// lock file, which holds that window open for the child's lifetime
    /// and makes the race deterministic.
    #[cfg(unix)]
    #[test]
    fn test_drop_releases_the_lock_while_a_child_shares_its_file_description() {
        let dir = std::env::temp_dir().join(format!("swarm-lock-test-{}", uuid::Uuid::new_v4()));
        let _cleanup = remove_on_drop(dir.clone());
        let first = SingleInstanceLock::acquire(&dir, "swarmd", None).unwrap();

        let shared = first.file.try_clone().unwrap();
        let child = std::process::Command::new("sleep")
            .arg("30")
            .stdin(shared)
            .spawn()
            .unwrap();
        let _reap = DropGuard::new(child, |mut child| {
            let _ = child.kill();
            let _ = child.wait();
        });

        drop(first);
        let second = SingleInstanceLock::acquire(&dir, "swarmd", None);
        assert!(
            second.is_ok(),
            "expected reacquire after drop while a child shares the lock's file description, got {second:?}"
        );
    }

    /// Regression (Unix): the info file's temp path was built from the
    /// lossy `Display` of the data dir, so a non-UTF-8 directory name
    /// became a different, nonexistent directory and the info file was
    /// never written.
    #[cfg(unix)]
    #[test]
    fn test_info_file_is_written_under_a_non_utf8_data_dir() {
        use std::os::unix::ffi::OsStrExt;

        let name = std::ffi::OsStr::from_bytes(b"swarm-lock-test-\xFF-");
        let mut dir = std::env::temp_dir().join(name);
        dir.as_mut_os_string()
            .push(uuid::Uuid::new_v4().to_string());
        let _cleanup = remove_on_drop(dir.clone());

        let _lock = SingleInstanceLock::acquire(&dir, "swarmd", None).unwrap();
        let info = read_info(&dir.join(INFO_FILE));
        assert_eq!(
            (info.pid, info.shell.as_str()),
            (std::process::id(), "swarmd")
        );
    }

    #[test]
    fn test_already_running_message_is_title_case_and_carries_pid() {
        let info = LockInfo {
            pid: 4242,
            shell: "swarmd".to_string(),
            bind: Some("http://127.0.0.1:8787".to_string()),
            started_at: 0,
        };
        let msg = LockError::AlreadyRunning(info).to_string();
        assert!(msg.contains("SWARM Is Already Running"));
        assert!(msg.contains("4242"));
        assert!(msg.contains("http://127.0.0.1:8787"));
    }

    /// The message names which shell holds the lock: a bare pid does not
    /// tell the reader whether to close a desktop window or stop a
    /// daemon.
    #[test]
    fn test_already_running_message_names_the_holding_shell() {
        let swarmd_msg = LockError::AlreadyRunning(LockInfo {
            pid: 1,
            shell: "swarmd".to_string(),
            bind: None,
            started_at: 0,
        })
        .to_string();
        assert!(swarmd_msg.contains("swarmd"));

        let desktop_msg = LockError::AlreadyRunning(LockInfo {
            pid: 2,
            shell: "swarm-desktop".to_string(),
            bind: None,
            started_at: 0,
        })
        .to_string();
        assert!(desktop_msg.contains("SWARM Desktop"));
    }
}
