//! Single-instance lock.
//!
//! Two engines opening the same `swarm-events.db` both resume `seq` from
//! `max_seq()` and collide on the `PRIMARY KEY` — appends silently fail
//! while live emission continues assigning duplicate `seq` values (see
//! the headless-daemon plan's Phase 2 item 1 and "Risks &
//! kill-criteria"). This lock is acquired FIRST, before the event log is
//! opened, by every shell that embeds `swarm-core` (`swarm-desktop` and
//! `swarmd` alike) — whichever one starts second must refuse to touch
//! the data directory at all.
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
//!   Either way it releases itself
//!   automatically when the handle closes, including on process exit OR
//!   crash — no stale-lock cleanup, no PID-liveness polling, no `unsafe`.
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
use std::path::{Path, PathBuf};

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

/// Failure to acquire the single-instance lock.
#[derive(Debug)]
pub enum LockError {
    /// Another process already holds the lock. Carries the
    /// best-effort [`LockInfo`] describing it (pid `0`/`shell:
    /// "unknown"` when the info file itself couldn't be read — the lock
    /// contention is still real even when the description isn't).
    AlreadyRunning(LockInfo),
    /// Any other I/O failure acquiring the lock (permission denied on
    /// the data dir, disk full, etc.) — distinct from contention.
    Io(io::Error),
}

impl std::fmt::Display for LockError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            LockError::AlreadyRunning(info) => {
                // security-review FIX-7: name the holding shell — a
                // Title Case message that only said "SWARM Is Already
                // Running (Pid N)" left the reader unable to tell
                // whether that pid was another swarm-desktop window or
                // a swarmd instance, which matters for what to do next
                // (close the window vs. kill the daemon).
                write!(
                    f,
                    "SWARM Is Already Running ({}, Pid {})",
                    shell_display_name(&info.shell),
                    info.pid
                )?;
                if let Some(bind) = &info.bind {
                    write!(f, " — Connect At {bind}")?;
                }
                Ok(())
            }
            LockError::Io(e) => write!(f, "Failed To Acquire The SWARM Instance Lock: {e}"),
        }
    }
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

impl std::error::Error for LockError {}

impl From<io::Error> for LockError {
    fn from(e: io::Error) -> Self {
        LockError::Io(e)
    }
}

/// RAII handle to the held lock. Dropping it (including on process
/// exit/crash) releases the underlying OS lock — no explicit `release()`
/// needed or provided.
#[derive(Debug)]
pub struct SingleInstanceLock {
    // Held only to keep the OS lock alive for `Self`'s lifetime; never
    // read/written after acquisition.
    _file: File,
}

fn read_info(info_path: &Path) -> LockInfo {
    std::fs::read_to_string(info_path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn write_info(info_path: &Path, info: &LockInfo) -> io::Result<()> {
    let json = serde_json::to_string_pretty(info).map_err(io::Error::other)?;
    let tmp_path = PathBuf::from(format!("{}.tmp", info_path.display()));
    std::fs::write(&tmp_path, json)?;
    std::fs::rename(&tmp_path, info_path)
}

/// Opens (creating if needed) `daemon.lock` and takes a non-blocking
/// exclusive OS lock on it with [`File::try_lock`]. One code path for
/// every platform: the lock is tied to the open handle, so the OS drops
/// it when the handle closes (on drop, exit or crash).
///
/// On Windows this replaced an exclusive open (`share_mode(0)`), which
/// failed with a sharing violation whenever any other handle was open —
/// including an antivirus/EDR scanner briefly opening the new file. The
/// file is now opened with std's default sharing and locked with
/// `LockFileEx`, so a scanner's handle (opened with the usual sharing
/// flags) no longer turns a legitimate first acquire into a false
/// "already running".
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

        Ok(Self { _file: file })
    }
}

#[cfg(test)]
mod tests {
    use std::mem::DropGuard;

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
        // A second attempt against the same dir while the first guard is
        // still alive must fail as AlreadyRunning — this is the core
        // guarantee: two engines can never both hold the lock, even
        // within a single process. This test proves the IN-PROCESS
        // primitive; the realistic cross-process case (two actual OS
        // processes, the scenario that matters — an in-process double
        // acquire proves nothing about whether the OS-level advisory
        // lock survives being held by a genuinely different process) is
        // exercised for real by
        // `swarmd::tests::test_second_daemon_on_the_same_data_dir_is_refused_by_the_single_instance_lock`,
        // which spawns two actual compiled `swarmd` binaries via
        // `std::process::Command` and runs as an ordinary `cargo test`
        // in CI (security-review FIX-5 — a prior version of this
        // comment claimed that test already existed; it did not).
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

    /// DIRECTIVE (security-review FIX-7): the message names WHICH shell
    /// holds the lock — a bare pid alone doesn't tell the reader whether
    /// to close a desktop window or stop a daemon.
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
