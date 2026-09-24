//! `git worktree` add/lock/unlock/remove/prune, plus the safe delete of
//! a worker's isolation branch. `worker::lifecycle` drives all of it,
//! one call per `RepoLocks::run_serialized`.
//!
//! # The no-`--force` guarantee
//!
//! [`remove_args`] is the only place a `git worktree remove` argv is
//! built, and it never appends `--force`/`-f`. That is load-bearing:
//! without `--force`, git itself refuses to remove a worktree with
//! uncommitted changes or untracked files, which is exactly the
//! "preserve on dirty" guarantee — SWARM never deletes work, it only
//! ever asks git, and git says no when it would lose something. The
//! test `test_remove_args_never_contains_force` pins this at the argv
//! level (not just "no caller passes --force today").

use std::path::Path;

use super::cli::{self, CREATE_TIMEOUT, READ_TIMEOUT, REMOVE_TIMEOUT};
use super::repo::args_in;
use crate::error::AppError;

// ── Argv builders ───────────────────────────────────────────────────
//
// Every builder starts from `args_in(repo_root, …)` — the shared
// `-C <repo_root> -c core.longpaths=true` prefix — so every invocation
// is scoped to the target repo without touching the calling process's
// own cwd, and long checkout paths under `~/.swarm/worktrees/**`
// survive Windows' legacy `MAX_PATH` limit.

fn add_args(repo_root: &Path, worktree_path: &Path, branch: &str, base_sha: &str) -> Vec<String> {
    let path = worktree_path.display().to_string();
    args_in(
        repo_root,
        &["worktree", "add", "-b", branch, &path, base_sha],
    )
}

fn lock_args(repo_root: &Path, worktree_path: &Path, reason: &str) -> Vec<String> {
    let path = worktree_path.display().to_string();
    args_in(repo_root, &["worktree", "lock", "--reason", reason, &path])
}

fn unlock_args(repo_root: &Path, worktree_path: &Path) -> Vec<String> {
    let path = worktree_path.display().to_string();
    args_in(repo_root, &["worktree", "unlock", &path])
}

/// Argv for `git worktree remove <path>` — deliberately incapable of
/// ever carrying `--force`/`-f`. See the module doc.
fn remove_args(repo_root: &Path, worktree_path: &Path) -> Vec<String> {
    let path = worktree_path.display().to_string();
    args_in(repo_root, &["worktree", "remove", &path])
}

fn prune_args(repo_root: &Path) -> Vec<String> {
    args_in(repo_root, &["worktree", "prune", "--verbose"])
}

/// Argv for `git branch -d <branch>` — deliberately incapable of ever
/// carrying `-D`/`--delete --force`. `-d` (lowercase) is git's own
/// safe delete: it refuses if `branch` isn't fully merged. SWARM's own
/// caller (`worker::lifecycle::do_kill_worker`) additionally checks
/// the branch tip against the worktree's recorded base commit before
/// even attempting this, so the two checks are redundant defense in
/// depth, not a substitute for one another.
fn branch_delete_args(repo_root: &Path, branch: &str) -> Vec<String> {
    args_in(repo_root, &["branch", "-d", branch])
}

// ── Operations ──────────────────────────────────────────────────────

/// Creates `worktree_path` as a new worktree of the repo rooted at
/// `repo_root`, on a fresh branch `branch` starting at `base_sha`.
/// Creates `worktree_path`'s parent directory first (git creates the
/// leaf directory itself, but not arbitrarily deep missing parents).
///
/// # Errors
///
/// * [`AppError::Git`] — the parent directory could not be created, or
///   `git worktree add` failed (bad `base_sha`, branch already exists…).
/// * [`AppError::GitTimeout`] — the checkout exceeded
///   [`CREATE_TIMEOUT`].
pub fn add(
    repo_root: &Path,
    worktree_path: &Path,
    branch: &str,
    base_sha: &str,
) -> Result<(), AppError> {
    if let Some(parent) = worktree_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| {
            AppError::Git(format!(
                "failed to create worktree parent dir {}: {e}",
                parent.display()
            ))
        })?;
    }
    let output = cli::run(
        &add_args(repo_root, worktree_path, branch, base_sha),
        CREATE_TIMEOUT,
    )?;
    if !output.success() {
        return Err(AppError::Git(format!(
            "git worktree add failed for branch `{branch}` at {}: {}",
            worktree_path.display(),
            output.stderr.trim()
        )));
    }
    Ok(())
}

/// Locks `worktree_path` so `git worktree prune` (and a casual `git
/// worktree remove`) leaves it alone. `reason` should identify the
/// owning worker (e.g. `"swarm worker <uuid>"`), so anyone running `git
/// worktree list` can attribute the lock.
///
/// # Errors
///
/// * [`AppError::Git`] — `git worktree lock` failed.
/// * [`AppError::GitTimeout`] — it exceeded [`READ_TIMEOUT`].
pub fn lock(repo_root: &Path, worktree_path: &Path, reason: &str) -> Result<(), AppError> {
    let output = cli::run(&lock_args(repo_root, worktree_path, reason), READ_TIMEOUT)?;
    if !output.success() {
        return Err(AppError::Git(format!(
            "git worktree lock failed for {}: {}",
            worktree_path.display(),
            output.stderr.trim()
        )));
    }
    Ok(())
}

/// Unlocks a previously-[`lock`]ed worktree so it becomes eligible for
/// [`remove`].
///
/// # Errors
///
/// * [`AppError::Git`] — `git worktree unlock` failed (including "not
///   locked", which git itself treats as an error).
/// * [`AppError::GitTimeout`] — it exceeded [`READ_TIMEOUT`].
pub fn unlock(repo_root: &Path, worktree_path: &Path) -> Result<(), AppError> {
    let output = cli::run(&unlock_args(repo_root, worktree_path), READ_TIMEOUT)?;
    if !output.success() {
        return Err(AppError::Git(format!(
            "git worktree unlock failed for {}: {}",
            worktree_path.display(),
            output.stderr.trim()
        )));
    }
    Ok(())
}

/// Outcome of a [`remove`] call.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RemoveOutcome {
    /// `git worktree remove` succeeded — the directory is gone.
    Removed,
    /// git refused specifically because the worktree has uncommitted
    /// changes or untracked files. This IS the preserve-on-dirty
    /// guarantee: SWARM never overrides this refusal with `--force`
    /// (see the module doc). Any *other* refusal (still locked,
    /// permission error, missing path) is an [`AppError::Git`] from
    /// [`remove`], not this variant.
    Preserved {
        /// git's own refusal, redacted and trimmed.
        reason: String,
    },
}

/// Removes `worktree_path` from the repo rooted at `repo_root` —
/// **never** with `--force` (see the module doc).
///
/// Classification is deliberately narrow: only git's specific refusal
/// for a dirty/untracked working tree (`"contains modified or
/// untracked files"`) becomes [`RemoveOutcome::Preserved`] — the one
/// case that is a *safe, expected* outcome of the no-`--force`
/// guarantee, not a failure. Every other non-zero exit (a still-locked
/// worktree, a permission error mid-delete, an already-missing path,
/// or any unrecognized stderr) is an [`AppError::Git`] — it must never
/// be laundered into "preserved", which would tell a caller "your work
/// is safe on disk" when the truth might be "half-deleted" or "still
/// locked and untouched". Callers map this `Err` to `disposition:
/// "failed"` and surface the message as `reason`.
///
/// The budget, [`REMOVE_TIMEOUT`], is sized for a recursive delete of
/// ignored build output (`node_modules`, `target`) so a slow delete is
/// never cut off halfway.
///
/// # Errors
///
/// * [`AppError::Git`] — anything other than success or the dirty-tree
///   refusal: `"cannot remove a locked working tree"` (unlock did not
///   actually take), a permission error (a process that outlived the
///   worker still has the directory open — see
///   `worker::lifecycle::do_kill_worker`), a path that isn't a valid
///   worktree, or `git` could not be spawned.
/// * [`AppError::GitTimeout`] — the delete exceeded [`REMOVE_TIMEOUT`].
pub fn remove(repo_root: &Path, worktree_path: &Path) -> Result<RemoveOutcome, AppError> {
    let output = cli::run(&remove_args(repo_root, worktree_path), REMOVE_TIMEOUT)?;
    if output.success() {
        return Ok(RemoveOutcome::Removed);
    }
    let stderr = output.stderr.trim().to_owned();
    if is_dirty_tree_refusal(output.raw_stderr()) {
        return Ok(RemoveOutcome::Preserved { reason: stderr });
    }
    Err(AppError::Git(format!(
        "git worktree remove refused for {}: {stderr}",
        worktree_path.display()
    )))
}

/// Whether `stderr` from a failed `git worktree remove` is git's
/// specific refusal for a dirty/untracked working tree — the *only*
/// refusal [`remove`] classifies as [`RemoveOutcome::Preserved`]. A
/// pure predicate so the classification boundary is unit-testable
/// against realistic git stderr without reproducing every failure mode
/// against a live process.
fn is_dirty_tree_refusal(stderr: &str) -> bool {
    stderr
        .to_lowercase()
        .contains("contains modified or untracked files")
}

/// Prunes stale worktree administrative files (e.g. ones whose
/// directory was deleted out-of-band) for the repo rooted at
/// `repo_root`. Returns the number of entries pruned, for startup
/// logging.
///
/// # Errors
///
/// * [`AppError::Git`] — `git worktree prune` failed.
/// * [`AppError::GitTimeout`] — it exceeded [`READ_TIMEOUT`].
pub fn prune(repo_root: &Path) -> Result<usize, AppError> {
    let output = cli::run(&prune_args(repo_root), READ_TIMEOUT)?;
    if !output.success() {
        return Err(AppError::Git(format!(
            "git worktree prune failed for {}: {}",
            repo_root.display(),
            output.stderr.trim()
        )));
    }
    Ok(count_pruned(output.raw_stderr()))
}

/// Counts the `Removing worktrees/<name>: <why>` lines `git worktree
/// prune --verbose` reports — on **stderr**; its stdout is empty.
fn count_pruned(stderr: &str) -> usize {
    stderr
        .lines()
        .filter(|line| line.starts_with("Removing "))
        .count()
}

/// Deletes `branch` from the repo rooted at `repo_root` with `git
/// branch -d` (**never** `-D`) — see [`branch_delete_args`]. Intended
/// for the one narrow case where it's safe: a `swarm/*` isolation
/// branch whose tip the caller has already confirmed equals the
/// commit the worktree was created from (i.e. the agent made no
/// commits). git's own `-d` safety check (refuses an unmerged branch)
/// is a second, independent guard on top of that caller-side check.
///
/// # Errors
///
/// * [`AppError::Git`] — `git branch -d` refused (not fully merged,
///   already deleted, checked out elsewhere…).
/// * [`AppError::GitTimeout`] — it exceeded [`READ_TIMEOUT`].
pub fn delete_branch(repo_root: &Path, branch: &str) -> Result<(), AppError> {
    let output = cli::run(&branch_delete_args(repo_root, branch), READ_TIMEOUT)?;
    if !output.success() {
        return Err(AppError::Git(format!(
            "git branch -d failed for {branch}: {}",
            output.stderr.trim()
        )));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::assert_matches;
    use std::path::PathBuf;

    use super::*;
    use crate::git::repo::base_args;
    use crate::git::test_support::{TempRepo, write_file};

    // ── Argv builders (DIRECTIVE: no-force proof) ────────────────────

    #[test]
    fn test_remove_args_never_contains_force() {
        let repo = PathBuf::from("/tmp/repo");
        let wt = PathBuf::from("/tmp/repo-wt");
        let args = remove_args(&repo, &wt);
        assert!(
            !args.iter().any(|a| a == "--force" || a == "-f"),
            "remove_args must never construct a --force/-f token: {args:?}"
        );
        let wt_arg = wt.display().to_string();
        assert_eq!(args[..4], base_args(&repo)[..]);
        assert_eq!(args[4..], ["worktree", "remove", wt_arg.as_str()]);
    }

    #[test]
    fn test_every_builder_carries_the_shared_prefix() {
        let repo = PathBuf::from("/tmp/repo");
        let wt = PathBuf::from("/tmp/repo-wt");
        for args in [
            add_args(&repo, &wt, "swarm/x-abcd1234", "deadbeef"),
            lock_args(&repo, &wt, "swarm worker abcd"),
            unlock_args(&repo, &wt),
            remove_args(&repo, &wt),
            prune_args(&repo),
            branch_delete_args(&repo, "swarm/x-abcd1234"),
        ] {
            assert_eq!(args[..4], base_args(&repo)[..], "{args:?}");
        }
    }

    #[test]
    fn test_add_args_never_contains_force() {
        let repo = PathBuf::from("/tmp/repo");
        let wt = PathBuf::from("/tmp/repo-wt");
        let args = add_args(&repo, &wt, "swarm/x-abcd1234", "deadbeef");
        assert!(!args.iter().any(|a| a == "--force" || a == "-f"));
        assert!(args.iter().any(|a| a == "-b"));
    }

    /// DIRECTIVE (B3): -D is not constructible for branch deletion —
    /// same style as `test_remove_args_never_contains_force`.
    #[test]
    fn test_branch_delete_args_never_contains_capital_d() {
        let repo = PathBuf::from("/tmp/repo");
        let args = branch_delete_args(&repo, "swarm/x-abcd1234");
        assert!(
            !args.iter().any(|a| a == "-D" || a == "--delete"),
            "branch_delete_args must never construct -D/--delete: {args:?}"
        );
        assert_eq!(args[4..], ["branch", "-d", "swarm/x-abcd1234"]);
    }

    // ── remove() classification (no real git needed) ─────────────────

    #[test]
    fn test_remove_outcome_variants_are_distinguishable() {
        let preserved = RemoveOutcome::Preserved {
            reason: "contains modified or untracked files".to_owned(),
        };
        assert_ne!(RemoveOutcome::Removed, preserved);
        assert_matches!(preserved, RemoveOutcome::Preserved { .. });
    }

    /// DIRECTIVE (B2): "preserved_dirty" is reserved strictly for
    /// git's dirty/untracked-files refusal.
    #[test]
    fn test_is_dirty_tree_refusal_matches_real_git_message() {
        assert!(is_dirty_tree_refusal(
            "fatal: 'C:\\wt' contains modified or untracked files, use --force to delete it"
        ));
    }

    /// DIRECTIVE (B2): a still-locked worktree is a genuine failure,
    /// never "preserved_dirty".
    #[test]
    fn test_is_dirty_tree_refusal_false_for_locked_working_tree() {
        assert!(!is_dirty_tree_refusal(
            "fatal: 'C:\\wt' is a locked working tree\nuse 'remove -f -f' to override or unlock first"
        ));
    }

    /// DIRECTIVE (B2): a permission error mid-delete (a process that
    /// outlived the worker holds the directory) may already have
    /// half-deleted the tree, so reporting "preserved" would be a lie.
    #[test]
    fn test_is_dirty_tree_refusal_false_for_permission_denied() {
        assert!(!is_dirty_tree_refusal(
            "error: failed to delete 'C:\\wt\\some\\file': Permission denied"
        ));
    }

    /// DIRECTIVE (B2): any unrecognized stderr is a genuine failure,
    /// never a silent "preserved".
    #[test]
    fn test_is_dirty_tree_refusal_false_for_unrecognized_message() {
        assert!(!is_dirty_tree_refusal(
            "fatal: some entirely unrecognized git error"
        ));
    }

    #[test]
    fn test_count_pruned_counts_removing_lines() {
        let stderr = "Removing worktrees/a: gitdir file points to non-existent location\n\
                      Removing worktrees/b: gitdir file points to non-existent location\n";
        assert_eq!(count_pruned(stderr), 2);
        assert_eq!(count_pruned(""), 0);
    }

    // ── Real-git integration ──────────────────────────────────────────

    /// End to end against a real repo: `add` checks the branch out,
    /// `lock` shows in `git worktree list`, an untracked file makes
    /// `remove` preserve the tree, and a clean tree is removed.
    #[test]
    fn test_worktree_lifecycle_against_real_git_repo() {
        let repo = TempRepo::new("wt-lifecycle");
        let head = crate::git::repo::head_sha(repo.root()).unwrap();
        let worktree = repo.base().join("wt");

        add(repo.root(), &worktree, "swarm/lifecycle-test", &head).unwrap();
        assert!(worktree.join("README.md").exists());

        lock(repo.root(), &worktree, "swarm worker test-lifecycle").unwrap();
        let listing = repo.git(&["worktree", "list", "--porcelain"]);
        assert!(
            String::from_utf8_lossy(&listing.stdout).contains("locked swarm worker test-lifecycle"),
            "lock must be visible to `git worktree list`"
        );
        unlock(repo.root(), &worktree).unwrap();

        write_file(&worktree, "scratch.txt", "untracked");
        let outcome = remove(repo.root(), &worktree).unwrap();
        assert_matches!(outcome, RemoveOutcome::Preserved { .. });
        assert!(worktree.exists(), "a preserved worktree stays on disk");

        std::fs::remove_file(worktree.join("scratch.txt")).unwrap();
        assert_eq!(
            remove(repo.root(), &worktree).unwrap(),
            RemoveOutcome::Removed
        );
        assert!(!worktree.exists(), "a removed worktree is gone from disk");
    }

    /// DIRECTIVE (B2), against real git: a still-locked worktree makes
    /// `remove()` return `Err`, never `Ok(Preserved)`.
    #[test]
    fn test_remove_returns_err_not_preserved_for_still_locked_worktree() {
        let repo = TempRepo::new("wt-locked");
        let worktree = repo.add_worktree("wt", "swarm/locked-test");
        lock(repo.root(), &worktree, "swarm worker locked-test").unwrap();

        let result = remove(repo.root(), &worktree);
        assert!(result.is_err(), "expected Err, got {result:?}");
        assert!(worktree.exists(), "a locked worktree stays untouched");

        unlock(repo.root(), &worktree).unwrap();
    }

    /// `git worktree prune --verbose` reports on stderr; the count must
    /// come from there.
    #[test]
    fn test_prune_counts_what_it_removed() {
        let repo = TempRepo::new("wt-prune");
        let worktree = repo.add_worktree("gone", "swarm/prune-test");
        std::fs::remove_dir_all(&worktree).unwrap();

        assert_eq!(prune(repo.root()).unwrap(), 1);
        assert_eq!(prune(repo.root()).unwrap(), 0);
    }

    #[test]
    fn test_delete_branch_refuses_an_unmerged_branch() {
        let repo = TempRepo::new("wt-branch-d");
        let worktree = repo.add_worktree("wt", "swarm/unmerged-test");
        write_file(&worktree, "work.txt", "work");
        crate::git::test_support::git_in(&worktree, &["add", "work.txt"]);
        crate::git::test_support::git_in(&worktree, &["commit", "-m", "work"]);
        assert_eq!(
            remove(repo.root(), &worktree).unwrap(),
            RemoveOutcome::Removed
        );

        assert!(delete_branch(repo.root(), "swarm/unmerged-test").is_err());
        assert!(crate::git::repo::rev_parse(repo.root(), "swarm/unmerged-test").is_ok());
    }
}
