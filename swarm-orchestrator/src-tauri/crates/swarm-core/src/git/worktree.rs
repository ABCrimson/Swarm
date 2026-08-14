//! `git worktree` add/lock/unlock/remove/list/prune.
//!
//! # The no-`--force` guarantee
//!
//! [`remove_args`] is the only place a `git worktree remove` argv is
//! built, and it never appends `--force`/`-f`. That is load-bearing:
//! without `--force`, git itself refuses to remove a worktree with
//! uncommitted changes or untracked files, which is exactly the
//! "preserve on dirty" guarantee — SWARM never deletes work, it only
//! ever asks git, and git says no when it would lose something.
//! [`tests::test_remove_args_never_contains_force`] pins this down at
//! the argv level (not just "we don't call it with --force today").

use std::path::{Path, PathBuf};

use super::cli::{self, CREATE_TIMEOUT, READ_TIMEOUT};
use super::repo::base_args;
use crate::error::AppError;

// ── Argv builders ───────────────────────────────────────────────────
//
// Every builder starts from `base_args(repo_root)` (`-C <repo_root> -c
// core.longpaths=true`), so every invocation is scoped to the target
// repo without ever touching the calling process's own cwd, and long
// checkout paths under `~/.swarm/worktrees/**` survive Windows'
// legacy `MAX_PATH` limit.

fn add_args(repo_root: &Path, worktree_path: &Path, branch: &str, base_sha: &str) -> Vec<String> {
    let mut args = base_args(repo_root);
    args.push("worktree".to_string());
    args.push("add".to_string());
    args.push("-b".to_string());
    args.push(branch.to_string());
    args.push(worktree_path.display().to_string());
    args.push(base_sha.to_string());
    args
}

fn lock_args(repo_root: &Path, worktree_path: &Path, reason: &str) -> Vec<String> {
    let mut args = base_args(repo_root);
    args.push("worktree".to_string());
    args.push("lock".to_string());
    args.push("--reason".to_string());
    args.push(reason.to_string());
    args.push(worktree_path.display().to_string());
    args
}

fn unlock_args(repo_root: &Path, worktree_path: &Path) -> Vec<String> {
    let mut args = base_args(repo_root);
    args.push("worktree".to_string());
    args.push("unlock".to_string());
    args.push(worktree_path.display().to_string());
    args
}

/// Argv for `git worktree remove <path>` — deliberately incapable of
/// ever carrying `--force`/`-f`. See the module doc.
fn remove_args(repo_root: &Path, worktree_path: &Path) -> Vec<String> {
    let mut args = base_args(repo_root);
    args.push("worktree".to_string());
    args.push("remove".to_string());
    args.push(worktree_path.display().to_string());
    args
}

fn list_porcelain_args(repo_root: &Path) -> Vec<String> {
    let mut args = base_args(repo_root);
    args.push("worktree".to_string());
    args.push("list".to_string());
    args.push("--porcelain".to_string());
    args
}

fn prune_args(repo_root: &Path) -> Vec<String> {
    let mut args = base_args(repo_root);
    args.push("worktree".to_string());
    args.push("prune".to_string());
    args.push("-v".to_string());
    args
}

// ── Porcelain parsing ───────────────────────────────────────────────

/// One record from `git worktree list --porcelain`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorktreeEntry {
    pub path: PathBuf,
    pub head: Option<String>,
    pub branch: Option<String>,
    pub bare: bool,
    pub detached: bool,
    pub locked: bool,
    pub lock_reason: Option<String>,
    pub prunable: bool,
    pub prunable_reason: Option<String>,
}

/// Parses `git worktree list --porcelain` output into structured
/// entries. Records are separated by a blank line; each record starts
/// with a `worktree <path>` line followed by attribute lines (`HEAD
/// <sha>`, `branch <ref>`, `bare`, `detached`, `locked[ <reason>]`,
/// `prunable[ <reason>]`).
fn parse_porcelain(text: &str) -> Vec<WorktreeEntry> {
    let mut entries = Vec::new();
    let mut current: Option<WorktreeEntry> = None;

    for line in text.lines() {
        if line.is_empty() {
            if let Some(entry) = current.take() {
                entries.push(entry);
            }
            continue;
        }
        if let Some(path) = line.strip_prefix("worktree ") {
            if let Some(entry) = current.take() {
                entries.push(entry);
            }
            current = Some(WorktreeEntry {
                path: PathBuf::from(path),
                head: None,
                branch: None,
                bare: false,
                detached: false,
                locked: false,
                lock_reason: None,
                prunable: false,
                prunable_reason: None,
            });
            continue;
        }
        let Some(entry) = current.as_mut() else {
            continue;
        };
        if let Some(head) = line.strip_prefix("HEAD ") {
            entry.head = Some(head.to_string());
        } else if let Some(branch) = line.strip_prefix("branch ") {
            entry.branch = Some(branch.to_string());
        } else if line == "bare" {
            entry.bare = true;
        } else if line == "detached" {
            entry.detached = true;
        } else if line == "locked" {
            entry.locked = true;
        } else if let Some(reason) = line.strip_prefix("locked ") {
            entry.locked = true;
            entry.lock_reason = Some(reason.to_string());
        } else if line == "prunable" {
            entry.prunable = true;
        } else if let Some(reason) = line.strip_prefix("prunable ") {
            entry.prunable = true;
            entry.prunable_reason = Some(reason.to_string());
        }
    }
    if let Some(entry) = current.take() {
        entries.push(entry);
    }
    entries
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
///   `git worktree add` failed (bad `base_sha`, branch already exists,
///   timeout, etc).
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
/// owning worker (e.g. `"swarm worker <uuid>"`) so a crash-orphan scan
/// (Phase 4) can recognize and attribute it.
///
/// # Errors
///
/// * [`AppError::Git`] — `git worktree lock` failed or timed out.
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
/// * [`AppError::Git`] — `git worktree unlock` failed or timed out
///   (including "not locked", which git itself treats as an error).
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
    /// git refused to remove the worktree (dirty/untracked files,
    /// still locked, etc). `reason` is git's own stderr, trimmed. This
    /// IS the preserve-on-dirty guarantee: SWARM never overrides this
    /// refusal with `--force` (see the module doc).
    Preserved { reason: String },
}

/// Removes `worktree_path` from the repo rooted at `repo_root` —
/// **never** with `--force` (see the module doc). git's own refusal
/// on a dirty/untracked/still-locked worktree becomes
/// [`RemoveOutcome::Preserved`] rather than an error, since it is the
/// expected, safe outcome of the guarantee, not a failure of the
/// operation.
///
/// # Errors
///
/// * [`AppError::Git`] — the worktree path doesn't correspond to a
///   real worktree at all (a genuine failure, distinct from a
///   dirty-tree refusal), `git` could not be spawned, or the
///   operation timed out.
pub fn remove(repo_root: &Path, worktree_path: &Path) -> Result<RemoveOutcome, AppError> {
    let output = cli::run(&remove_args(repo_root, worktree_path), READ_TIMEOUT)?;
    if output.success() {
        return Ok(RemoveOutcome::Removed);
    }
    let stderr = output.stderr.trim().to_string();
    let lower = stderr.to_lowercase();
    if lower.contains("is not a working tree") || lower.contains("no such file or directory") {
        return Err(AppError::Git(format!(
            "git worktree remove failed for {} (not a valid worktree): {stderr}",
            worktree_path.display()
        )));
    }
    Ok(RemoveOutcome::Preserved { reason: stderr })
}

/// Lists all worktrees registered against the repo rooted at
/// `repo_root`.
///
/// # Errors
///
/// * [`AppError::Git`] — `git worktree list` failed or timed out.
pub fn list(repo_root: &Path) -> Result<Vec<WorktreeEntry>, AppError> {
    let output = cli::run(&list_porcelain_args(repo_root), READ_TIMEOUT)?;
    if !output.success() {
        return Err(AppError::Git(format!(
            "git worktree list failed for {}: {}",
            repo_root.display(),
            output.stderr.trim()
        )));
    }
    Ok(parse_porcelain(&output.stdout))
}

/// Prunes stale worktree administrative files (e.g. ones whose
/// directory was deleted out-of-band) for the repo rooted at
/// `repo_root`. Returns the number of entries pruned, for startup
/// logging.
///
/// # Errors
///
/// * [`AppError::Git`] — `git worktree prune` failed or timed out.
pub fn prune(repo_root: &Path) -> Result<usize, AppError> {
    let output = cli::run(&prune_args(repo_root), READ_TIMEOUT)?;
    if !output.success() {
        return Err(AppError::Git(format!(
            "git worktree prune failed for {}: {}",
            repo_root.display(),
            output.stderr.trim()
        )));
    }
    Ok(output
        .stdout
        .lines()
        .filter(|l| !l.trim().is_empty())
        .count())
}

#[cfg(test)]
mod tests {
    use super::*;
    use uuid::Uuid;

    // ── Argv builder unit tests (DIRECTIVE: no-force proof) ─────────

    #[test]
    fn test_remove_args_never_contains_force() {
        let repo = PathBuf::from("/tmp/repo");
        let wt = PathBuf::from("/tmp/repo-wt");
        let args = remove_args(&repo, &wt);
        assert!(
            !args.iter().any(|a| a == "--force" || a == "-f"),
            "remove_args must never construct a --force/-f token: {args:?}"
        );
        assert_eq!(
            args,
            vec![
                "-C".to_string(),
                repo.display().to_string(),
                "-c".to_string(),
                "core.longpaths=true".to_string(),
                "worktree".to_string(),
                "remove".to_string(),
                wt.display().to_string(),
            ]
        );
    }

    #[test]
    fn test_every_builder_carries_dash_c() {
        let repo = PathBuf::from("/tmp/repo");
        let wt = PathBuf::from("/tmp/repo-wt");
        let builders: Vec<Vec<String>> = vec![
            add_args(&repo, &wt, "swarm/x-abcd1234", "deadbeef"),
            lock_args(&repo, &wt, "swarm worker abcd"),
            unlock_args(&repo, &wt),
            remove_args(&repo, &wt),
            list_porcelain_args(&repo),
            prune_args(&repo),
        ];
        for args in builders {
            assert_eq!(args[0], "-C", "builder output must start with -C: {args:?}");
            assert_eq!(args[1], repo.display().to_string());
            assert_eq!(args[2], "-c");
            assert_eq!(args[3], "core.longpaths=true");
        }
    }

    #[test]
    fn test_add_args_never_contains_force() {
        let repo = PathBuf::from("/tmp/repo");
        let wt = PathBuf::from("/tmp/repo-wt");
        let args = add_args(&repo, &wt, "swarm/x-abcd1234", "deadbeef");
        assert!(!args.iter().any(|a| a == "--force" || a == "-f"));
        assert!(args.contains(&"-b".to_string()));
    }

    // ── Porcelain parser unit tests ──────────────────────────────────

    #[test]
    fn test_parse_porcelain_single_entry() {
        let text = "worktree /repo\nHEAD abc123\nbranch refs/heads/main\n\n";
        let entries = parse_porcelain(text);
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].path, PathBuf::from("/repo"));
        assert_eq!(entries[0].head.as_deref(), Some("abc123"));
        assert_eq!(entries[0].branch.as_deref(), Some("refs/heads/main"));
        assert!(!entries[0].locked);
        assert!(!entries[0].detached);
    }

    #[test]
    fn test_parse_porcelain_multiple_entries_locked_and_detached() {
        let text = "worktree /repo\nHEAD abc123\nbranch refs/heads/main\n\n\
                     worktree /repo-wt\nHEAD def456\ndetached\n\n\
                     worktree /repo-locked\nHEAD ghi789\nbranch refs/heads/swarm/x-1\nlocked swarm worker abcd\n\n";
        let entries = parse_porcelain(text);
        assert_eq!(entries.len(), 3);
        assert!(entries[1].detached);
        assert!(entries[1].branch.is_none());
        assert!(entries[2].locked);
        assert_eq!(entries[2].lock_reason.as_deref(), Some("swarm worker abcd"));
    }

    #[test]
    fn test_parse_porcelain_prunable() {
        let text = "worktree /repo-gone\nHEAD abc123\nbranch refs/heads/old\nprunable gitdir file points to non-existent location\n\n";
        let entries = parse_porcelain(text);
        assert_eq!(entries.len(), 1);
        assert!(entries[0].prunable);
        assert!(entries[0].prunable_reason.is_some());
    }

    #[test]
    fn test_parse_porcelain_empty_input() {
        assert!(parse_porcelain("").is_empty());
    }

    // ── remove() classification unit test (no real git needed) ──────

    #[test]
    fn test_remove_outcome_variants_are_distinguishable() {
        let removed = RemoveOutcome::Removed;
        let preserved = RemoveOutcome::Preserved {
            reason: "contains modified or untracked files".to_string(),
        };
        assert_ne!(removed, preserved);
        assert!(matches!(preserved, RemoveOutcome::Preserved { .. }));
    }

    // ── Temp-repo integration test ───────────────────────────────────

    /// End-to-end proof against a real, disposable git repo: init a
    /// repo, commit a file, `worktree add`, confirm the checkout and
    /// `worktree list --porcelain` both see it, dirty it with an
    /// untracked file, confirm `remove` refuses (the preserve-on-dirty
    /// path), clean it up, then confirm `remove` succeeds.
    ///
    /// Requires a real `git` binary on PATH (present in every dev
    /// environment and both GitHub-hosted CI runner images).
    #[test]
    fn test_worktree_lifecycle_against_real_git_repo() {
        let base = std::env::temp_dir().join(format!("swarm-wt-lifecycle-{}", Uuid::new_v4()));
        let repo_root = base.join("repo");
        std::fs::create_dir_all(&repo_root).unwrap();

        // init + identity (a bare CI runner has no global user.* set)
        run_setup(&["init".to_string(), repo_root.display().to_string()]);
        run_setup_in(
            &repo_root,
            &["config", "user.email", "swarm-test@example.com"],
        );
        run_setup_in(&repo_root, &["config", "user.name", "Swarm Test"]);

        // one commit so HEAD resolves
        std::fs::write(repo_root.join("README.md"), "hello").unwrap();
        run_setup_in(&repo_root, &["add", "-A"]);
        run_setup_in(&repo_root, &["commit", "-m", "initial"]);

        let head = super::super::repo::head_sha(&repo_root).expect("HEAD should resolve");

        let worktree_path = base.join("wt");
        add(&repo_root, &worktree_path, "swarm/lifecycle-test", &head)
            .expect("worktree add should succeed");

        // Checked out and populated from HEAD.
        assert!(worktree_path.join("README.md").exists());

        // git worktree list --porcelain sees it.
        let entries = list(&repo_root).expect("worktree list should succeed");
        let canonical_wt = std::fs::canonicalize(&worktree_path).unwrap();
        assert!(
            entries.iter().any(|e| {
                std::fs::canonicalize(&e.path)
                    .map(|p| p == canonical_wt)
                    .unwrap_or(false)
            }),
            "expected {:?} among worktree list entries: {entries:?}",
            worktree_path
        );

        lock(&repo_root, &worktree_path, "swarm worker test-lifecycle")
            .expect("lock should succeed");
        let locked_entries = list(&repo_root).unwrap();
        assert!(
            locked_entries.iter().any(|e| e.locked),
            "expected a locked entry after lock(): {locked_entries:?}"
        );

        unlock(&repo_root, &worktree_path).expect("unlock should succeed");

        // Dirty it with an untracked file — remove must refuse.
        std::fs::write(worktree_path.join("scratch.txt"), "untracked").unwrap();
        let outcome =
            remove(&repo_root, &worktree_path).expect("remove call itself should not error");
        assert!(
            matches!(outcome, RemoveOutcome::Preserved { .. }),
            "expected Preserved for a dirty worktree, got {outcome:?}"
        );
        assert!(
            worktree_path.exists(),
            "preserved worktree must remain on disk"
        );

        // Clean it up — remove must now succeed.
        std::fs::remove_file(worktree_path.join("scratch.txt")).unwrap();
        let outcome =
            remove(&repo_root, &worktree_path).expect("remove call itself should not error");
        assert_eq!(outcome, RemoveOutcome::Removed);
        assert!(
            !worktree_path.exists(),
            "removed worktree must be gone from disk"
        );

        std::fs::remove_dir_all(&base).ok();
    }

    fn run_setup(args: &[String]) {
        let out = cli::run(args, CREATE_TIMEOUT).expect("git setup command should run");
        assert!(
            out.success(),
            "git setup command failed: {} ({args:?})",
            out.stderr
        );
    }

    fn run_setup_in(dir: &Path, args: &[&str]) {
        let mut full = base_args(dir);
        full.extend(args.iter().map(|s| s.to_string()));
        let out = cli::run(&full, CREATE_TIMEOUT).expect("git setup command should run");
        assert!(
            out.success(),
            "git setup command failed: {} ({full:?})",
            out.stderr
        );
    }
}
