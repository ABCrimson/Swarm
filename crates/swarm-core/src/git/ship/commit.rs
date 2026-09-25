//! [`stage_and_commit`]: deny-list enforcement, staging, and the commit
//! itself, with SWARM's trailers.

use std::collections::HashSet;
use std::path::Path;

use serde::{Deserialize, Serialize};

use super::deny::{self, SkippedFile};
use super::status::{self, DiffStat, NUMSTAT_ARGS, StatusSnapshot};
use super::{
    RepoLocks, ShipError, ShipErrorKind, ShipRemedy, guard_not_primary_checkout, literal_pathspecs,
    mutate, worktree_info_for_worker,
};
use crate::error::AppError;
use crate::git::cli::{GitOutput, MUTATE_TIMEOUT};
use crate::git::repo::{self, args_in};
use crate::worker::registry::{WorkerId, WorkerRegistry};

/// Staging strategy for [`stage_and_commit`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StagingMode {
    /// Stage every changed file except the deny list's (`git add` of an
    /// explicit path list, never `-A`) — the default.
    All,
    /// Commit exactly what's already in the index, minus the deny
    /// list's; nothing new is staged. Offered when preflight detects a
    /// pre-staged index.
    Staged,
}

/// What [`stage_and_commit`] commits.
#[derive(Debug, Clone)]
pub struct CommitRequest {
    /// The commit message, as the user or the AI wrote it.
    pub message: String,
    /// What to stage.
    pub mode: StagingMode,
    /// Exclusive start of the event-log seq range this commit covers
    /// (`0` with `seq_to == 0` means unknown).
    pub seq_from: u64,
    /// Inclusive end of that range.
    pub seq_to: u64,
    /// The configured `Co-Authored-By` identity, if any.
    pub co_authored_by: Option<String>,
}

/// A commit [`stage_and_commit`] made. Serialized over IPC and read
/// back by the desktop shell's thin command wrapper, hence
/// `Deserialize` too.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitOutcome {
    /// The new commit.
    pub sha: String,
    /// Files the commit changed (`git show --numstat --no-renames`).
    pub files_changed: u32,
    /// Lines the commit added.
    pub insertions: u32,
    /// Lines the commit removed.
    pub deletions: u32,
    /// The request's `seq_from`, echoed.
    pub seq_from: u64,
    /// The request's `seq_to`, echoed.
    pub seq_to: u64,
    /// Files the deny list kept out of the commit.
    pub skipped: Vec<SkippedFile>,
}

/// Deduplicated union of path lists, first occurrence first — the
/// candidate set of [`StagingMode::All`].
pub(super) fn union_paths(lists: [&[String]; 3]) -> Vec<String> {
    let mut seen = HashSet::new();
    lists
        .into_iter()
        .flatten()
        .filter(|path| seen.insert(path.as_str()))
        .cloned()
        .collect()
}

/// Argv for `git add --pathspec-from-file=- --pathspec-file-nul` — the
/// explicit, deny-filtered path list arrives on stdin (see
/// `literal_pathspecs`); never `-A`/`--all`.
fn add_args(worktree: &Path) -> Vec<String> {
    args_in(
        worktree,
        &["add", "--pathspec-from-file=-", "--pathspec-file-nul"],
    )
}

/// Argv for `git restore --staged` over a stdin path list — unstages
/// denied paths without touching their working-tree copies.
fn restore_staged_args(worktree: &Path) -> Vec<String> {
    args_in(
        worktree,
        &[
            "restore",
            "--staged",
            "--pathspec-from-file=-",
            "--pathspec-file-nul",
        ],
    )
}

/// Argv for `git commit --file=- --trailer=…` — the message arrives on
/// stdin; `--trailer` merges SWARM's trailers into any trailer block the
/// message already ends with (and honors `trailer.*` config) instead of
/// starting a second one. Structurally incapable of carrying
/// `--no-verify`/`-n`: hooks always run, pinned by
/// `test_commit_args_never_contains_no_verify`.
fn commit_args(worktree: &Path, trailers: &[String]) -> Vec<String> {
    let mut args = args_in(worktree, &["commit", "--file=-"]);
    args.extend(
        trailers
            .iter()
            .map(|trailer| format!("--trailer={trailer}")),
    );
    args
}

/// SWARM's trailers for `request`: `Swarm-Seq-Range: <from>..<to>` and
/// `Co-Authored-By: <identity>`.
fn trailers(request: &CommitRequest) -> Vec<String> {
    let mut trailers = Vec::with_capacity(2);
    let (from, to) = (request.seq_from, request.seq_to);
    // DIRECTIVE (F10): never a degenerate range — `0..0` means "no seq
    // data", and `to < from` can only be a caller-side resolution bug. A
    // trailer that lies about the range is worse than none.
    if (from, to) != (0, 0) && to >= from {
        trailers.push(format!("Swarm-Seq-Range: {from}..{to}"));
    }
    // Single-line only: an embedded newline could forge extra
    // trailer-shaped lines, so such a value is dropped, not sanitized
    // into something the user never configured.
    if let Some(co_author) = request.co_authored_by.as_deref().map(str::trim)
        && !co_author.is_empty()
        && !co_author.contains(['\n', '\r'])
    {
        trailers.push(format!("Co-Authored-By: {co_author}"));
    }
    trailers
}

/// Maps a failed `git commit` to a [`ShipError`]. Hook output reaches
/// git's stderr; "nothing to commit" is printed on stdout, so both are
/// matched. The message carries the redacted stderr (or stdout, when
/// stderr is empty).
fn classify_commit_error(output: &GitOutput) -> ShipError {
    let stdout = String::from_utf8_lossy(&output.stdout);
    let detail = if output.stderr.trim().is_empty() {
        crate::git::redact::sanitize(stdout.trim())
    } else {
        output.stderr.trim().to_owned()
    };
    classify_commit_failure(&format!("{}\n{stdout}", output.raw_stderr()), &detail)
}

/// [`classify_commit_error`]'s decision: `output` is git's raw text,
/// `detail` the redacted excerpt a hook rejection shows.
fn classify_commit_failure(output: &str, detail: &str) -> ShipError {
    let text = output.to_lowercase();
    if text.contains("nothing to commit") || text.contains("no changes added to commit") {
        return ShipError::new(
            ShipErrorKind::NothingToCommit,
            "Nothing To Commit — The Working Tree Matches HEAD.",
        );
    }
    if text.contains("please tell me who you are")
        || text.contains("unable to auto-detect email address")
        || text.contains("empty ident name")
    {
        return ShipError::new(
            ShipErrorKind::IdentityMissing,
            "Git Identity Not Configured — Set `user.name` And `user.email` Before Shipping.",
        )
        .with_remedy(ShipRemedy::ConfigureIdentity);
    }
    ShipError::new(
        ShipErrorKind::HookFailed,
        format!("Commit Was Rejected: {detail}"),
    )
}

/// Stages (per `request.mode`) and commits, with SWARM's trailers (see
/// `trailers`). In order:
///
/// 1. The primary-checkout guard — before anything touches the tree.
/// 2. One status snapshot; refuses unresolved merge conflicts ("all"
///    mode would otherwise stage conflict markers as resolved).
/// 3. The deny list over the mode's candidates. A denied path that is
///    already staged is unstaged (`git restore --staged`) in **either**
///    mode; if that fails, nothing is committed.
/// 4. "all" mode stages the survivors (`git add`).
/// 5. A second snapshot: an empty index is
///    [`ShipErrorKind::NothingToCommit`], and a denied path still in the
///    index aborts the commit.
/// 6. `git commit`, hooks and all.
///
/// Each mutating call (`restore`, `add`, `commit`) runs under
/// `repo_locks` — per-repo serialization with one retry when git
/// reports lock contention; read-only queries don't take the lock.
/// Pathspecs are literal (`:(top,literal)`) and travel on stdin.
///
/// # Errors
///
/// * [`ShipErrorKind::WorkerNotFound`] / [`ShipErrorKind::NoWorktree`] —
///   as [`super::worktree_info_for_worker`].
/// * [`ShipErrorKind::PrimaryCheckout`] — the guard fired.
/// * [`ShipErrorKind::NothingToCommit`] — every candidate was denied,
///   or there are no changes.
/// * [`ShipErrorKind::IdentityMissing`] / [`ShipErrorKind::HookFailed`]
///   — `git commit` itself failed.
/// * [`ShipErrorKind::Timeout`] — a git call exceeded its budget.
/// * [`ShipErrorKind::Unknown`] — merge conflicts, a failed unstage or
///   stage, a denied file still staged, or any other git failure.
pub fn stage_and_commit(
    registry: &WorkerRegistry,
    repo_locks: &RepoLocks,
    id: WorkerId,
    request: &CommitRequest,
) -> Result<CommitOutcome, ShipError> {
    let info = worktree_info_for_worker(registry, id)?;
    let wt = info.worktree_path.as_path();
    let repo_root = info.repo_root.as_path();

    guard_not_primary_checkout(wt)?;

    let before = StatusSnapshot::read(wt)?;
    if before.unmerged().next().is_some() {
        return Err(ShipError::new(
            ShipErrorKind::Unknown,
            "The Worktree Has Unresolved Merge Conflicts — Resolve Them Before Shipping.",
        ));
    }
    let classified = before.classify();
    let untracked: HashSet<&str> = classified.untracked.iter().map(String::as_str).collect();
    let candidates = match request.mode {
        StagingMode::All => union_paths([
            &classified.staged,
            &classified.unstaged,
            &classified.untracked,
        ]),
        StagingMode::Staged => classified.staged.clone(),
    };
    let (survivors, skipped) = deny::partition(wt, candidates, &untracked);

    // DIRECTIVE (B3), in both modes: a denied path already in the index
    // (a human's or the agent's own `git add`) is unstaged — the
    // "Skipped" label must never be a lie.
    let staged: HashSet<&str> = classified.staged.iter().map(String::as_str).collect();
    let denied_staged: Vec<&str> = skipped
        .iter()
        .map(|file| file.path.as_str())
        .filter(|path| staged.contains(path))
        .collect();
    if !denied_staged.is_empty() {
        let output = mutate(
            repo_locks,
            repo_root,
            &restore_staged_args(wt),
            Some(&literal_pathspecs(denied_staged)),
            MUTATE_TIMEOUT,
        )?;
        if !output.success() {
            return Err(ShipError::new(
                ShipErrorKind::Unknown,
                format!(
                    "Failed To Unstage Denied Files Before Commit — Refusing To Ship: {}",
                    output.stderr.trim()
                ),
            ));
        }
    }

    if request.mode == StagingMode::All && !survivors.is_empty() {
        let output = mutate(
            repo_locks,
            repo_root,
            &add_args(wt),
            Some(&literal_pathspecs(survivors.iter().map(String::as_str))),
            MUTATE_TIMEOUT,
        )?;
        if !output.success() {
            return Err(ShipError::new(
                ShipErrorKind::Unknown,
                format!("`git add` Failed: {}", output.stderr.trim()),
            ));
        }
    }

    let staged_now = StatusSnapshot::read(wt)?.classify().staged;
    if staged_now.is_empty() {
        return Err(ShipError::new(
            ShipErrorKind::NothingToCommit,
            "Nothing To Commit — Every Changed File Was Skipped Or There Are No Changes.",
        ));
    }
    let still_denied: Vec<&str> = staged_now
        .iter()
        .map(String::as_str)
        .filter(|path| deny::deny_reason(wt, path, false).is_some())
        .collect();
    if !still_denied.is_empty() {
        return Err(ShipError::new(
            ShipErrorKind::Unknown,
            format!(
                "Refusing To Commit — Denied Files Are Still Staged: {}",
                still_denied.join(", ")
            ),
        ));
    }

    let output = mutate(
        repo_locks,
        repo_root,
        &commit_args(wt, &trailers(request)),
        Some(request.message.as_bytes()),
        MUTATE_TIMEOUT,
    )?;
    if !output.success() {
        return Err(classify_commit_error(&output));
    }

    let sha = repo::head_sha(wt)?;
    let diff = commit_diff_stat(wt, &sha).unwrap_or_else(|err| {
        tracing::warn!(%sha, error = %err, "ship: could not read the new commit's diff stat");
        DiffStat::default()
    });

    Ok(CommitOutcome {
        sha,
        files_changed: diff.files_changed,
        insertions: diff.insertions,
        deletions: diff.deletions,
        seq_from: request.seq_from,
        seq_to: request.seq_to,
        skipped,
    })
}

/// The diff stat of commit `sha`, counted like the preview's.
fn commit_diff_stat(worktree: &Path, sha: &str) -> Result<DiffStat, AppError> {
    let mut args = vec!["show", "--format="];
    args.extend(NUMSTAT_ARGS);
    args.push(sha);
    status::numstat(worktree, &args, |_| true)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(seq_from: u64, seq_to: u64, co_authored_by: Option<&str>) -> CommitRequest {
        CommitRequest {
            message: "feat: thing".to_owned(),
            mode: StagingMode::All,
            seq_from,
            seq_to,
            co_authored_by: co_authored_by.map(str::to_owned),
        }
    }

    #[test]
    fn test_commit_args_never_contains_no_verify() {
        let wt = Path::new("/tmp/wt");
        let args = commit_args(wt, &["Swarm-Seq-Range: 1..2".to_owned()]);
        assert!(
            !args.iter().any(|a| a == "--no-verify" || a == "-n"),
            "commit_args must never construct --no-verify/-n: {args:?}"
        );
        assert_eq!(
            args[4..],
            ["commit", "--file=-", "--trailer=Swarm-Seq-Range: 1..2"]
        );
    }

    #[test]
    fn test_add_args_never_stage_everything() {
        let wt = Path::new("/tmp/wt");
        let args = add_args(wt);
        assert!(!args.iter().any(|a| a == "-A" || a == "--all" || a == "."));
        assert_eq!(
            args[4..],
            ["add", "--pathspec-from-file=-", "--pathspec-file-nul"]
        );
    }

    #[test]
    fn test_trailers_omit_an_unknown_or_inverted_range() {
        assert!(trailers(&request(0, 0, None)).is_empty());
        assert!(trailers(&request(9, 3, None)).is_empty());
        assert_eq!(trailers(&request(5, 12, None)), ["Swarm-Seq-Range: 5..12"]);
        assert_eq!(trailers(&request(0, 7, None)), ["Swarm-Seq-Range: 0..7"]);
    }

    #[test]
    fn test_trailers_trim_and_reject_multiline_co_authors() {
        assert_eq!(
            trailers(&request(0, 0, Some("  SWARM <noreply@example.com> "))),
            ["Co-Authored-By: SWARM <noreply@example.com>"]
        );
        assert!(trailers(&request(0, 0, Some("   "))).is_empty());
        assert!(
            trailers(&request(
                0,
                0,
                Some("Evil <e@example.com>\nSwarm-Seq-Range: 999..999")
            ))
            .is_empty()
        );
    }

    #[test]
    fn test_classify_commit_failure_kinds() {
        let classify = |text: &str| classify_commit_failure(text, text).kind;
        assert_eq!(
            classify("On branch x\nnothing to commit, working tree clean"),
            ShipErrorKind::NothingToCommit
        );
        assert_eq!(
            classify("Author identity unknown\n\n*** Please tell me who you are.\n"),
            ShipErrorKind::IdentityMissing
        );
        assert_eq!(
            classify("fatal: unable to auto-detect email address (got 'u@h.(none)')"),
            ShipErrorKind::IdentityMissing
        );
        assert_eq!(
            classify("husky - pre-commit hook exited with code 1 (error)"),
            ShipErrorKind::HookFailed
        );
        // A hook that merely mentions a config key is still a hook
        // failure, not a missing identity.
        assert_eq!(
            classify("commit-msg: user.email must be a company address"),
            ShipErrorKind::HookFailed
        );
    }

    #[test]
    fn test_union_paths_dedupes_and_preserves_order() {
        let staged = ["a.rs".to_owned(), "b.rs".to_owned()];
        let unstaged = ["b.rs".to_owned(), "c.rs".to_owned()];
        let untracked = ["d.rs".to_owned()];
        assert_eq!(
            union_paths([&staged, &unstaged, &untracked]),
            ["a.rs", "b.rs", "c.rs", "d.rs"]
        );
    }
}
