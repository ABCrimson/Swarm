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
//! - `daemon.lock` — the actual mutex: opened and held exclusively for
//!   the life of the process. Never read for content; the mere fact of
//!   holding an OS-exclusive handle to it IS the lock. Advisory and
//!   OS-native (`flock(2)` on Unix, a deny-all share mode on Windows),
//!   so it releases itself automatically on process exit OR crash — no
//!   stale-lock cleanup, no PID-liveness polling.
//! - `daemon.lock.json` — informational only (pid, which shell, bind
//!   address if any, start time), overwritten after every successful
//!   acquire. A losing contender reads it (best-effort — a missing or
//!   unreadable info file still yields an honest "already running,
//!   details unknown" message rather than failing to report at all) to
//!   build the "SWARM Is Already Running" message. Its content can go
//!   stale between a crash and the next successful acquire; that is
//!   expected and harmless, since it is never consulted to decide
//!   whether the lock is held — only to describe who holds it.

use std::fs::{File, OpenOptions};
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
                write!(f, "SWARM Is Already Running (Pid {})", info.pid)?;
                if let Some(bind) = &info.bind {
                    write!(f, " — Connect At {bind}")?;
                }
                Ok(())
            }
            LockError::Io(e) => write!(f, "Failed To Acquire The SWARM Instance Lock: {e}"),
        }
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

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
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

#[cfg(unix)]
fn try_lock(lock_path: &Path, info_path: &Path) -> Result<File, LockError> {
    use std::os::unix::io::AsRawFd;

    // `truncate(false)`: this file's CONTENT is never read or written —
    // only the OS-level `flock` on the open handle matters — so opening
    // it must not destroy whatever (irrelevant) bytes a prior run left
    // behind.
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(lock_path)?;
    let fd = file.as_raw_fd();
    // SAFETY: fd is a valid, open file descriptor owned by `file` for
    // the duration of this call; flock only mutates kernel-side lock
    // state, no memory safety concerns.
    let rc = unsafe { libc::flock(fd, libc::LOCK_EX | libc::LOCK_NB) };
    if rc != 0 {
        let err = io::Error::last_os_error();
        if err.kind() == io::ErrorKind::WouldBlock || err.raw_os_error() == Some(libc::EWOULDBLOCK)
        {
            return Err(LockError::AlreadyRunning(read_info(info_path)));
        }
        return Err(LockError::Io(err));
    }
    Ok(file)
}

#[cfg(windows)]
fn try_lock(lock_path: &Path, info_path: &Path) -> Result<File, LockError> {
    use std::os::windows::fs::OpenOptionsExt;

    // share_mode(0) denies ANY other open (read or write) while this
    // handle is alive — the OS itself refuses a second opener rather
    // than us implementing locking semantics by hand.
    // `truncate(false)` — see the Unix `try_lock`'s matching comment:
    // this file's content is never meaningful, only the exclusive
    // handle itself.
    match OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .share_mode(0)
        .open(lock_path)
    {
        Ok(f) => Ok(f),
        Err(e) => {
            // ERROR_SHARING_VIOLATION = 32, ERROR_LOCK_VIOLATION = 33 —
            // the two codes Windows returns for "someone else has this
            // open exclusively already."
            if matches!(e.raw_os_error(), Some(32) | Some(33)) {
                Err(LockError::AlreadyRunning(read_info(info_path)))
            } else {
                Err(LockError::Io(e))
            }
        }
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
                started_at: now_ms(),
            },
        ) {
            tracing::warn!(error = %e, "failed to write daemon.lock.json (lock itself is still held)");
        }

        Ok(Self { _file: file })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_acquire_succeeds_on_a_fresh_data_dir() {
        let dir = std::env::temp_dir().join(format!("swarm-lock-test-{}", uuid::Uuid::new_v4()));
        let _cleanup = TempDir(dir.clone());
        let lock = SingleInstanceLock::acquire(&dir, "swarmd", Some("127.0.0.1:8787".to_string()));
        assert!(lock.is_ok());
    }

    #[test]
    fn test_second_acquire_in_the_same_process_is_rejected() {
        // A second attempt against the same dir while the first guard is
        // still alive must fail as AlreadyRunning — this is the core
        // guarantee: two engines can never both hold the lock, even
        // within a single process (the realistic cross-process case is
        // exercised by CI via two real binary invocations, not
        // reproducible in a unit test without spawning a subprocess).
        let dir = std::env::temp_dir().join(format!("swarm-lock-test-{}", uuid::Uuid::new_v4()));
        let _cleanup = TempDir(dir.clone());
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
        let _cleanup = TempDir(dir.clone());
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

    struct TempDir(PathBuf);
    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
}
