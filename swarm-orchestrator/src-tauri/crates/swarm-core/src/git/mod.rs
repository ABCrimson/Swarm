//! Git facade: binary discovery + arg-vector runner ([`cli`]), repo
//! discovery ([`repo`]), and worktree lifecycle ([`worktree`]) — the
//! whole surface `swarm-core` needs to give each worker its own git
//! worktree.
//!
//! `swarm-core` stays tauri-free here too: everything shells out to
//! the system `git` binary via `std::process::Command` (arg vectors
//! only, never a shell string — see [`cli::run`]), and the only
//! filesystem root this module assumes is the user's home directory
//! ([`home_dir`]), resolved from `$HOME`/`%USERPROFILE%` rather than a
//! Tauri-provided path.
//!
//! ## Why shell out to `git` instead of a Rust git library
//!
//! `gix` (gitoxide) can read worktree metadata but does not yet
//! implement creating/removing them; `git2`/libgit2 can, but vendors a
//! C build and checks out through a different code path than the
//! user's own hooks/LFS/attributes. Shelling out to the user's real
//! `git` reuses exactly the checkout behavior they already trust.

pub mod cli;
pub mod repo;
pub mod worktree;

pub use cli::{GitCapability, MIN_GIT_VERSION, probe_capability};
pub use worktree::{RemoveOutcome, WorktreeEntry};

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use dashmap::DashMap;
use parking_lot::Mutex;

use crate::error::AppError;

/// Backoff before the single retry on lock contention (e.g. a
/// concurrent git process — SWARM's own or the user's — briefly
/// holding `index.lock` or a ref lock).
const CONTENTION_RETRY_BACKOFF: Duration = Duration::from_millis(200);

/// Per-repo serialization for mutating git operations, plus one retry
/// with backoff when a failure looks like transient lock contention.
///
/// Callers wrap exactly **one** git call per [`Self::run_serialized`]
/// invocation (e.g. just `worktree::add`, or just `worktree::remove`)
/// rather than a multi-step sequence — retrying a single idempotent
/// git subcommand is safe; retrying "add, then lock" as one unit is
/// not, since a contention failure in the second step would replay
/// the first against a worktree/branch that already exists.
///
/// Serializing by repo root (not globally) lets two different repos'
/// worktree operations run fully in parallel; only operations against
/// the *same* repo queue behind each other, matching git's own
/// per-repository locking granularity (the index and ref locks this
/// guards against are per-`.git` directory).
///
/// Keying is by `repo_root: &Path` exactly as given — callers are
/// expected to already hold the *canonical* toplevel path (i.e. the
/// output of [`repo::discover_toplevel`], which shells out to `git
/// rev-parse --show-toplevel`), not an arbitrary caller-supplied
/// spelling of the same directory. `RepoLocks` does no normalization
/// of its own; two different spellings of the same repo (a trailing
/// slash, a symlink, mixed path separators) would silently defeat
/// serialization by hashing to different map keys. Every call site in
/// this codebase (`worker::lifecycle`) already routes through
/// `discover_toplevel` before ever touching a `RepoLocks`, so this is
/// documentation of an invariant that already holds, not a TODO.
#[derive(Clone, Default)]
pub struct RepoLocks {
    locks: Arc<DashMap<PathBuf, Arc<Mutex<()>>>>,
}

impl RepoLocks {
    pub fn new() -> Self {
        Self::default()
    }

    fn lock_for(&self, repo_root: &Path) -> Arc<Mutex<()>> {
        self.locks
            .entry(repo_root.to_path_buf())
            .or_insert_with(|| Arc::new(Mutex::new(())))
            .clone()
    }

    /// Runs `op` while holding the per-repo mutex for `repo_root`. If
    /// `op` fails with what looks like transient index/ref-lock
    /// contention, retries exactly once after
    /// [`CONTENTION_RETRY_BACKOFF`] — still under the same held lock,
    /// so a concurrent SWARM-issued op against the same repo can't
    /// interleave with the retry either.
    pub fn run_serialized<T>(
        &self,
        repo_root: &Path,
        mut op: impl FnMut() -> Result<T, AppError>,
    ) -> Result<T, AppError> {
        let guard = self.lock_for(repo_root);
        let _held = guard.lock();
        match op() {
            Ok(value) => Ok(value),
            Err(err) if is_lock_contention(&err) => {
                std::thread::sleep(CONTENTION_RETRY_BACKOFF);
                op()
            }
            Err(err) => Err(err),
        }
    }
}

/// Heuristic: does this error's message look like transient
/// index/ref-lock contention (as opposed to e.g. a genuinely dirty
/// worktree, a missing repo, or a real git bug)?
fn is_lock_contention(err: &AppError) -> bool {
    let AppError::Git(msg) = err else {
        return false;
    };
    let lower = msg.to_lowercase();
    lower.contains("index.lock")
        || lower.contains("cannot lock ref")
        || lower.contains("unable to create")
        || lower.contains("another git process")
}

/// Resolves the user's home directory without a dedicated crate
/// dependency: checks `$HOME` first (set on every Unix, and by Git
/// Bash/MSYS on Windows), then `%USERPROFILE%` (native Windows). This
/// is the root of `~/.swarm/worktrees/**`, already reserved as SWARM's
/// writable scope (see `src-tauri/capabilities/default.json`).
///
/// # Errors
///
/// * [`AppError::Git`] — neither environment variable is set.
pub fn home_dir() -> Result<PathBuf, AppError> {
    for var in ["HOME", "USERPROFILE"] {
        if let Ok(value) = std::env::var(var)
            && !value.is_empty()
        {
            return Ok(PathBuf::from(value));
        }
    }
    Err(AppError::Git(
        "could not resolve home directory (neither HOME nor USERPROFILE is set)".to_string(),
    ))
}

/// Deterministic 8-hex-character tag derived from `input` (FNV-1a
/// 64-bit, truncated to 32 bits). Used to disambiguate same-named
/// repos under `~/.swarm/worktrees/<repo>-<hash8>/` without adding a
/// hashing crate dependency.
pub fn short_hash8(input: &str) -> String {
    const FNV_OFFSET: u64 = 0xcbf2_9ce4_8422_2325;
    const FNV_PRIME: u64 = 0x0000_0100_0000_01b3;
    let mut hash = FNV_OFFSET;
    for byte in input.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(FNV_PRIME);
    }
    format!("{:08x}", (hash & 0xFFFF_FFFF) as u32)
}

/// Sanitizes `input` into a filesystem- and git-ref-safe slug:
/// lowercase ASCII alphanumerics with runs of anything else collapsed
/// to a single `-`, trimmed of leading/trailing `-`. Falls back to
/// `"worker"` if the result would be empty (e.g. an all-emoji or
/// all-punctuation name), so a branch name is always constructible.
pub fn slugify(input: &str) -> String {
    let mut slug = String::with_capacity(input.len());
    let mut last_was_dash = false;
    for ch in input.chars() {
        if ch.is_ascii_alphanumeric() {
            slug.push(ch.to_ascii_lowercase());
            last_was_dash = false;
        } else if !last_was_dash && !slug.is_empty() {
            slug.push('-');
            last_was_dash = true;
        }
    }
    while slug.ends_with('-') {
        slug.pop();
    }
    if slug.is_empty() {
        "worker".to_string()
    } else {
        slug
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_short_hash8_is_deterministic_and_8_hex_chars() {
        let a = short_hash8("/home/user/repo");
        let b = short_hash8("/home/user/repo");
        assert_eq!(a, b);
        assert_eq!(a.len(), 8);
        assert!(a.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn test_short_hash8_differs_for_different_input() {
        assert_ne!(short_hash8("/repo/a"), short_hash8("/repo/b"));
    }

    #[test]
    fn test_slugify_basic() {
        assert_eq!(slugify("Research Agent"), "research-agent");
        assert_eq!(slugify("  weird   Name!! "), "weird-name");
        assert_eq!(slugify(""), "worker");
        assert_eq!(slugify("###"), "worker");
    }

    #[test]
    fn test_slugify_never_has_leading_or_trailing_dash() {
        let slug = slugify("-leading and trailing-");
        assert!(!slug.starts_with('-'));
        assert!(!slug.ends_with('-'));
    }

    #[test]
    fn test_is_lock_contention_matches_index_lock() {
        let err = AppError::Git(
            "fatal: Unable to create '/repo/.git/index.lock': File exists.".to_string(),
        );
        assert!(is_lock_contention(&err));
    }

    #[test]
    fn test_is_lock_contention_false_for_dirty_worktree_message() {
        let err = AppError::Git(
            "fatal: '/wt' contains modified or untracked files, use --force to delete it"
                .to_string(),
        );
        assert!(!is_lock_contention(&err));
    }

    #[test]
    fn test_repo_locks_serializes_and_retries_on_contention() {
        let locks = RepoLocks::new();
        let repo = PathBuf::from("/tmp/some-repo");
        let attempts = std::sync::atomic::AtomicU32::new(0);

        let result = locks.run_serialized(&repo, || {
            let n = attempts.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            if n == 0 {
                Err(AppError::Git(
                    "Unable to create '.git/index.lock': File exists.".to_string(),
                ))
            } else {
                Ok(42)
            }
        });

        assert_eq!(result.unwrap(), 42);
        assert_eq!(attempts.load(std::sync::atomic::Ordering::SeqCst), 2);
    }

    #[test]
    fn test_repo_locks_does_not_retry_non_contention_errors() {
        let locks = RepoLocks::new();
        let repo = PathBuf::from("/tmp/some-other-repo");
        let attempts = std::sync::atomic::AtomicU32::new(0);

        let result: Result<(), AppError> = locks.run_serialized(&repo, || {
            attempts.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            Err(AppError::Git("not a git repository".to_string()))
        });

        assert!(result.is_err());
        assert_eq!(attempts.load(std::sync::atomic::Ordering::SeqCst), 1);
    }

    #[test]
    fn test_repo_locks_scoped_per_repo_not_global() {
        // Two different repo roots must not share a mutex — proven by
        // both closures being callable without deadlocking when run
        // sequentially against the same RepoLocks instance.
        let locks = RepoLocks::new();
        let a = locks.run_serialized(&PathBuf::from("/tmp/repo-a"), || Ok::<_, AppError>(1));
        let b = locks.run_serialized(&PathBuf::from("/tmp/repo-b"), || Ok::<_, AppError>(2));
        assert_eq!(a.unwrap(), 1);
        assert_eq!(b.unwrap(), 2);
    }
}
