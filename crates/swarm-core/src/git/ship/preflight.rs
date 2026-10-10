//! [`preflight`]: everything the Ship tab shows before anything is
//! staged, and whether shipping is allowed at all.

use std::collections::HashSet;
use std::path::Path;

use serde::Serialize;
use uuid::Uuid;

use super::commit::{StagingMode, staging_candidates};
use super::deny::{self, SkippedFile};
use super::status::{self, DiffStat, NUMSTAT_ARGS, StatusSnapshot};
use super::{
    NOT_A_WORKTREE, PRIMARY_CHECKOUT, ShipError, git, is_protected_branch, remote_url,
    resolve_base_branch, single_value, worktree_info_for_worker,
};
use crate::error::AppError;
use crate::git::cli::SCAN_TIMEOUT;
use crate::git::{redact, remote, repo};
use crate::worker::registry::{WorkerId, WorkerRegistry};

/// The ship preflight for one worker — `git_ship_preflight`'s IPC result,
/// which the frontend validates with `ShipPreflightSchema`
/// (`src/store/types.ts`).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShipPreflight {
    /// The worker.
    pub worker_id: Uuid,
    /// The branch checked out now (the recorded isolation branch when
    /// `HEAD` is detached).
    pub branch: String,
    /// The branch a compare page targets — see `resolve_base_branch`.
    pub base_branch: String,
    /// `origin`'s URL, credentials redacted.
    pub remote: Option<String>,
    /// `origin`'s host.
    pub host: Option<String>,
    /// `true` when `host` looks like GitHub/GHES, so
    /// [`super::compare_url`] can succeed. The UI disables *only* the
    /// "Open Compare Page" action on `false`, leaving Commit Only and
    /// Commit + Push available (see [`remote::looks_like_github_host`]).
    pub host_supports_compare: bool,
    /// The upstream branch, once the branch has been pushed.
    pub upstream: Option<String>,
    /// Commits not yet on the upstream — or, before the first push,
    /// commits since the worktree's base commit.
    pub ahead: u32,
    /// Upstream commits the branch doesn't have (`0` without one).
    pub behind: u32,
    /// Paths with staged changes.
    pub staged: Vec<String>,
    /// Tracked paths with unstaged changes.
    pub unstaged: Vec<String>,
    /// Untracked files.
    pub untracked: Vec<String>,
    /// Files the deny list will keep out of the commit, for `mode`.
    pub skipped: Vec<SkippedFile>,
    /// What the commit would change, for `mode`.
    pub diff_stat: DiffStat,
    /// `true` only when `blockers` is empty.
    pub can_ship: bool,
    /// Title Case reasons shipping is refused.
    pub blockers: Vec<String>,
}

/// Computes the ship preflight for `id`, evaluated for staging `mode`
/// (the deny-list preview and diff stat mirror what [`super::stage_and_commit`]
/// would commit in that mode): branch, remote and tracking state,
/// working-tree status, and eight refusal conditions as Title Case
/// `blockers` — the path is not the worktree's toplevel, the primary
/// checkout, a detached `HEAD`, `branch == baseBranch`, a protected
/// branch, no `origin` remote, unresolved merge conflicts, and nothing
/// to ship at all. None of them makes this function fail; `canShip` is
/// `true` only when `blockers` is empty.
///
/// # Errors
///
/// * [`super::ShipErrorKind::WorkerNotFound`] /
///   [`super::ShipErrorKind::NoWorktree`] — as
///   [`super::worktree_info_for_worker`].
/// * [`super::ShipErrorKind::Unknown`] / [`super::ShipErrorKind::Timeout`]
///   — `git status` itself failed (e.g. the worktree was deleted).
/// * [`super::ShipErrorKind::Unknown`] / [`super::ShipErrorKind::Timeout`]
///   — with no upstream, the commit count since the base commit failed
///   (e.g. that commit no longer exists).
/// * [`super::ShipErrorKind::Unknown`] / [`super::ShipErrorKind::Timeout`]
///   — `git remote get-url origin` failed other than for a missing remote.
pub fn preflight(
    registry: &WorkerRegistry,
    id: WorkerId,
    mode: StagingMode,
) -> Result<ShipPreflight, ShipError> {
    let info = worktree_info_for_worker(registry, id)?;
    let wt = info.worktree_path.as_path();

    let mut blockers = Vec::new();

    match repo::locate(wt) {
        Ok(location) => {
            if !location.is_toplevel(wt) {
                blockers.push(NOT_A_WORKTREE.to_owned());
            }
            if location.is_primary_checkout() {
                blockers.push(PRIMARY_CHECKOUT.to_owned());
            }
        }
        // Unverifiable counts as both: never assume safe.
        Err(_) => blockers.extend([NOT_A_WORKTREE.to_owned(), PRIMARY_CHECKOUT.to_owned()]),
    }

    let snapshot = StatusSnapshot::read(wt)?;

    let branch = snapshot.head.clone().unwrap_or_else(|| {
        blockers.push("Worktree Is In A Detached HEAD State — Nothing To Ship From.".to_owned());
        info.branch.clone()
    });
    let base_branch = resolve_base_branch(&info.repo_root);
    if branch == base_branch {
        blockers.push(format!(
            "Branch `{branch}` Is The Same As The Base Branch — Nothing To Compare."
        ));
    }
    if is_protected_branch(&branch) {
        blockers.push(format!(
            "Branch `{branch}` Is Protected — Ship Refuses To Push Directly To It."
        ));
    }

    let remote_raw = remote_url(wt, "origin")?;
    if remote_raw.is_none() {
        blockers.push("No `origin` Remote Configured — Add One Before Shipping.".to_owned());
    }
    let remote = remote_raw.as_deref().map(redact::redact);
    let host = remote_raw
        .as_deref()
        .and_then(remote::parse)
        .map(|parsed| parsed.host);
    let host_supports_compare = host.as_deref().is_some_and(remote::looks_like_github_host);

    // `branch.ab` is absent before the first push, and when the
    // upstream branch was deleted: count from the base commit then.
    let upstream = snapshot.upstream.clone();
    let (ahead, behind) = match snapshot.ahead_behind {
        Some(counts) => counts,
        None => (ahead_since_base(wt, &info.base_commit)?, 0),
    };

    let conflicts = snapshot.unmerged().count();
    if conflicts > 0 {
        blockers.push(format!(
            "{conflicts} File(s) Have Unresolved Merge Conflicts — Resolve Them Before Shipping."
        ));
    }

    let classified = snapshot.classify();
    if classified.staged.is_empty()
        && classified.unstaged.is_empty()
        && classified.untracked.is_empty()
        && ahead == 0
    {
        blockers.push(
            "Nothing To Ship — The Working Tree Is Clean And There's Nothing To Push.".to_owned(),
        );
    }

    // Mode-aware through `staging_candidates`, the set `stage_and_commit`
    // acts on: "all" previews the full union it would stage; "staged"
    // previews only the index.
    let untracked: HashSet<&str> = classified.untracked.iter().map(String::as_str).collect();
    let candidates = staging_candidates(&classified, mode);
    let (survivors, skipped) = deny::partition(wt, candidates, &untracked);
    let diff_stat = preview_diff_stat(wt, mode, &snapshot, &survivors, &untracked);

    Ok(ShipPreflight {
        worker_id: id,
        branch,
        base_branch,
        remote,
        host,
        host_supports_compare,
        upstream,
        ahead,
        behind,
        staged: classified.staged,
        unstaged: classified.unstaged,
        untracked: classified.untracked,
        skipped,
        diff_stat,
        can_ship: blockers.is_empty(),
        blockers,
    })
}

/// Commits reachable from `HEAD` but not from `base_commit` — the
/// `ahead` count of a branch with no (live) upstream. A failed count is
/// an error, never a `0` that would claim "Nothing To Ship".
fn ahead_since_base(worktree: &Path, base_commit: &str) -> Result<u32, AppError> {
    let range = format!("{base_commit}..HEAD");
    let output = git(worktree, &["rev-list", "--count", &range], SCAN_TIMEOUT)?;
    single_value(&output)
        .and_then(|count| count.parse().ok())
        .ok_or_else(|| {
            AppError::Git(format!(
                "`git rev-list --count {range}` failed: {}",
                output.stderr.trim()
            ))
        })
}

/// The diff stat of what [`super::stage_and_commit`] would commit:
/// tracked survivors from one numstat query — `diff HEAD` (index and
/// working tree) in "all" mode, `diff --cached` (the index alone) in
/// "staged" mode — plus each untracked survivor counted from disk.
/// Best effort: a failed query logs a warning and leaves the tracked part at zero.
fn preview_diff_stat(
    worktree: &Path,
    mode: StagingMode,
    snapshot: &StatusSnapshot,
    survivors: &[String],
    untracked: &HashSet<&str>,
) -> DiffStat {
    let (untracked_survivors, tracked_survivors): (Vec<&str>, Vec<&str>) = survivors
        .iter()
        .map(String::as_str)
        .partition(|path| untracked.contains(path));
    let mut counted: HashSet<&str> = tracked_survivors.into_iter().collect();
    let rename_sources: Vec<&str> = snapshot.rename_sources_of(&counted).collect();
    counted.extend(rename_sources);

    let mut args = vec![
        "diff",
        match mode {
            StagingMode::All => "HEAD",
            StagingMode::Staged => "--cached",
        },
    ];
    args.extend(NUMSTAT_ARGS);
    let mut stat = if counted.is_empty() {
        DiffStat::default()
    } else {
        status::numstat(worktree, &args, |path| counted.contains(path)).unwrap_or_else(|err| {
            tracing::warn!(error = %err, "ship: preflight could not read the tracked diff stat");
            DiffStat::default()
        })
    };
    for path in untracked_survivors {
        status::add_untracked(&mut stat, worktree, path);
    }
    stat
}
