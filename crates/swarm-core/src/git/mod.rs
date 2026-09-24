//! Git facade: the argv runner and capability probe ([`cli`]), secret
//! redaction for surfaced text ([`redact`]), repo discovery ([`repo`]),
//! worktree lifecycle ([`worktree`]), remote URL parsing and
//! compare-URL construction ([`remote`]), the ship chain — preflight,
//! staged commit, push ([`ship`]) — and the causal record behind a
//! ship's PR body ([`causal`]). See [`ship`]'s module doc for the
//! worktree/ship ownership split: [`worktree`] (driven by
//! `worker::lifecycle`) owns worktree creation and removal, [`ship`]
//! owns commit and push, and they meet at
//! [`ship::worktree_info_for_worker`], the one accessor between them.
//!
//! `swarm-core` stays Tauri-free here too: everything shells out to the
//! system `git` binary through [`cli::run`] (argument vectors only,
//! never a shell string), and the only filesystem root this module
//! assumes is the user's home directory ([`home_dir`]).
//!
//! ## Why shell out to `git` instead of a Rust git library
//!
//! `gix` (gitoxide) does not implement creating or removing linked
//! worktrees, and `git2`/libgit2 vendors a C build and checks out
//! through a different code path than the user's own hooks, LFS
//! filters and attributes. Shelling out to the user's real `git` reuses
//! exactly the behavior they already trust — including the hooks a
//! ship's `git commit`/`git push` must run.

pub mod causal;
pub mod cli;
pub mod redact;
pub mod remote;
pub mod repo;
pub mod ship;
#[cfg(test)]
pub(crate) mod test_support;
pub mod worktree;

pub use causal::{CausalCommit, CausalToolCall, CausalTurn, ShipContext, build_ship_context};
pub use cli::{GitCapability, MIN_GIT_VERSION, probe_capability};
pub use ship::{
    CommitOutcome, CommitRequest, PushOutcome, ShipError, ShipErrorKind, ShipPreflight, ShipRemedy,
    ShipWorktreeInfo, StagingMode,
};
pub use worktree::RemoveOutcome;

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

/// Longest [`slugify`] output. A branch `swarm/<slug>-<id8>` is stored
/// as the loose-ref file `refs/heads/swarm/<slug>-<id8>`, and a file
/// name over `NAME_MAX` (255 bytes) makes `git worktree add -b` fail.
const MAX_SLUG_LEN: usize = 48;

/// Per-repo serialization for mutating git operations, plus one retry
/// with backoff when a failure looks like transient lock contention.
///
/// Callers wrap exactly **one** git call per [`Self::run_serialized`]
/// invocation (e.g. just `worktree::add`, or just the ship chain's
/// `git commit`) rather than a multi-step sequence — retrying one git
/// subcommand whose failure left nothing behind is safe; retrying "add,
/// then lock" as one unit is not, since a contention failure in the
/// second step would replay the first against a worktree or branch
/// that already exists.
///
/// Serializing by repo root (not globally) lets two different repos'
/// operations run fully in parallel; only operations against the
/// *same* repo queue behind each other, matching git's own
/// per-repository locking granularity (the index and ref locks this
/// guards against live in the shared `.git` directory).
///
/// Keying is by `repo_root: &Path` exactly as given — callers must
/// already hold the *canonical* toplevel path (the output of
/// [`repo::discover_toplevel`]), not an arbitrary spelling of the same
/// directory: `RepoLocks` does no normalization of its own, so two
/// spellings of one repo (a trailing slash, a symlink, mixed
/// separators) would hash to different keys and defeat serialization.
/// Both call sites hold the canonical path: `worker::lifecycle` routes
/// through `discover_toplevel` before its first lock, and [`ship`] keys
/// by the `repo_root` lifecycle recorded on the worker at spawn.
#[derive(Clone, Default)]
pub struct RepoLocks {
    locks: Arc<DashMap<PathBuf, Arc<Mutex<()>>>>,
}

impl RepoLocks {
    /// An empty lock table.
    #[must_use]
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
    /// contention (see [`is_lock_contention_message`]), retries exactly
    /// once after [`CONTENTION_RETRY_BACKOFF`] — still under the same
    /// held lock, so a concurrent SWARM-issued op against the same repo
    /// cannot interleave with the retry either.
    ///
    /// Blocks the calling thread (on the mutex and on `op`); async
    /// callers run it inside `tokio::task::spawn_blocking`.
    ///
    /// # Errors
    ///
    /// Whatever `op` returns on its last attempt.
    pub fn run_serialized<T>(
        &self,
        repo_root: &Path,
        mut op: impl FnMut() -> Result<T, AppError>,
    ) -> Result<T, AppError> {
        let lock = self.lock_for(repo_root);
        let _held = lock.lock();
        match op() {
            Err(AppError::Git(msg)) if is_lock_contention_message(&msg) => {
                std::thread::sleep(CONTENTION_RETRY_BACKOFF);
                op()
            }
            result => result,
        }
    }
}

/// Whether a git error message is transient index/ref-lock contention —
/// another git process holding `index.lock` or a ref's `.lock` file —
/// as opposed to a dirty worktree, a missing repo, a checkout failure
/// or a real git bug. Deliberately narrow: git's generic "unable to
/// create file …" checkout errors must never trigger a retry, because a
/// retried `worktree add -b` would then fail on the branch its first
/// attempt already created and hide the real error.
#[must_use]
pub(crate) fn is_lock_contention_message(message: &str) -> bool {
    let lower = message.to_lowercase();
    lower.contains("index.lock")
        || lower.contains(".lock': file exists")
        || lower.contains("cannot lock ref")
        || lower.contains("another git process")
}

/// Resolves the user's home directory with [`std::env::home_dir`]: `$HOME`
/// (then the password database) on Unix, the profile folder on Windows
/// — the same folder Tauri resolves the `$HOME/.swarm/**` capability
/// scope to (see `src-tauri/capabilities/default.json`). This is the
/// root of `~/.swarm/worktrees/**`.
///
/// # Errors
///
/// * [`AppError::Git`] — the platform reports no home directory.
pub fn home_dir() -> Result<PathBuf, AppError> {
    std::env::home_dir()
        .filter(|home| !home.as_os_str().is_empty())
        .ok_or_else(|| AppError::Git("could not resolve the home directory".to_owned()))
}

/// Deterministic 8-hex-character tag derived from `input` (FNV-1a
/// 64-bit, truncated to its low 32 bits). Disambiguates same-named
/// repos under `~/.swarm/worktrees/<repo>-<hash8>/` without a hashing
/// crate dependency. The output is part of every worktree's on-disk
/// path, so the algorithm must never change.
#[must_use]
pub fn short_hash8(input: &str) -> String {
    const FNV_OFFSET: u64 = 0xcbf2_9ce4_8422_2325;
    const FNV_PRIME: u64 = 0x0000_0100_0000_01b3;
    let hash = input.bytes().fold(FNV_OFFSET, |hash, byte| {
        (hash ^ u64::from(byte)).wrapping_mul(FNV_PRIME)
    });
    format!("{:08x}", hash & 0xFFFF_FFFF)
}

/// Sanitizes `input` into a filesystem- and git-ref-safe slug:
/// lowercase ASCII alphanumerics with runs of anything else collapsed
/// to a single `-`, trimmed of leading/trailing `-`, and capped at
/// [`MAX_SLUG_LEN`] bytes. Falls back to `"worker"` when nothing
/// survives (an all-emoji or all-punctuation name), so a branch name is
/// always constructible.
#[must_use]
pub fn slugify(input: &str) -> String {
    let mut slug = String::with_capacity(input.len().min(MAX_SLUG_LEN));
    for ch in input.chars() {
        if ch.is_ascii_alphanumeric() {
            slug.push(ch.to_ascii_lowercase());
        } else if !slug.is_empty() && !slug.ends_with('-') {
            slug.push('-');
        }
    }
    // Every char pushed is ASCII, so any byte offset is a char boundary.
    slug.truncate(MAX_SLUG_LEN);
    slug.truncate(slug.trim_end_matches('-').len());
    if slug.is_empty() {
        "worker".to_owned()
    } else {
        slug
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicU32, Ordering};

    use super::*;

    #[test]
    fn test_short_hash8_is_deterministic_and_8_hex_chars() {
        let a = short_hash8("/home/user/repo");
        let b = short_hash8("/home/user/repo");
        assert_eq!(a, b);
        assert_eq!(a.len(), 8);
        assert!(a.chars().all(|c| c.is_ascii_hexdigit()));
    }

    /// The tag is baked into every existing worktree path, so its value
    /// for a known input is pinned, not just its shape.
    #[test]
    fn test_short_hash8_value_is_stable() {
        // FNV-1a 64 test vectors: "" = 0xcbf29ce484222325,
        // "a" = 0xaf63dc4c8601ec8c.
        assert_eq!(short_hash8(""), "84222325");
        assert_eq!(short_hash8("a"), "8601ec8c");
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
    fn test_slugify_caps_length_without_a_trailing_dash() {
        let slug = slugify(&"word ".repeat(200));
        assert!(slug.len() <= MAX_SLUG_LEN, "{slug}");
        assert!(!slug.ends_with('-'), "{slug}");
        assert!(slug.starts_with("word-word"));
    }

    #[test]
    fn test_home_dir_resolves() {
        let home = home_dir().expect("the test environment has a home directory");
        assert!(!home.as_os_str().is_empty());
    }

    #[test]
    fn test_is_lock_contention_matches_index_and_ref_locks() {
        for message in [
            "fatal: Unable to create '/repo/.git/index.lock': File exists.",
            "fatal: Unable to create '/repo/.git/refs/heads/x.lock': File exists.",
            "error: cannot lock ref 'refs/heads/swarm/x': is at abc but expected def",
            "Another git process seems to be running in this repository",
        ] {
            assert!(is_lock_contention_message(message), "{message}");
        }
    }

    /// A checkout failure is not contention: retrying a `worktree add
    /// -b` after it would only fail again on the branch the first
    /// attempt created.
    #[test]
    fn test_is_lock_contention_false_for_checkout_and_dirty_tree_errors() {
        for message in [
            "error: unable to create file src/very/long/name.rs: Filename too long",
            "error: unable to create temporary file: Permission denied",
            "fatal: '/wt' contains modified or untracked files, use --force to delete it",
        ] {
            assert!(!is_lock_contention_message(message), "{message}");
        }
    }

    #[test]
    fn test_repo_locks_serializes_and_retries_on_contention() {
        let locks = RepoLocks::new();
        let repo = PathBuf::from("/tmp/some-repo");
        let attempts = AtomicU32::new(0);

        let result = locks.run_serialized(&repo, || {
            if attempts.fetch_add(1, Ordering::SeqCst) == 0 {
                Err(AppError::Git(
                    "Unable to create '.git/index.lock': File exists.".to_owned(),
                ))
            } else {
                Ok(42)
            }
        });

        assert_eq!(result.unwrap(), 42);
        assert_eq!(attempts.load(Ordering::SeqCst), 2);
    }

    #[test]
    fn test_repo_locks_does_not_retry_non_contention_errors() {
        let locks = RepoLocks::new();
        let repo = PathBuf::from("/tmp/some-other-repo");
        let attempts = AtomicU32::new(0);

        let result: Result<(), AppError> = locks.run_serialized(&repo, || {
            attempts.fetch_add(1, Ordering::SeqCst);
            Err(AppError::Git("not a git repository".to_owned()))
        });

        assert!(result.is_err());
        assert_eq!(attempts.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn test_repo_locks_scoped_per_repo_not_global() {
        // Two different repo roots must not share a mutex: the second
        // call runs while the first repo's lock is held.
        let locks = RepoLocks::new();
        let nested = locks.run_serialized(Path::new("/tmp/repo-a"), || {
            locks.run_serialized(Path::new("/tmp/repo-b"), || Ok::<_, AppError>(2))
        });
        assert_eq!(nested.unwrap(), 2);
    }
}
