//! Ship chain: preflight, staged commit, and push for a worker's
//! worktree — the Rust half of "commit → push → prefilled compare
//! page".
//!
//! # Ownership split
//!
//! The worktree feature ([`super::worktree`], driven by
//! `worker::lifecycle`) owns worktree **creation**, **branch naming**
//! and **removal**: every field of [`ShipWorktreeInfo`] except
//! `last_shipped_seq`/`last_shipped_commit` is set exactly once, at
//! spawn, by `worker::lifecycle::do_spawn_worker`. Ship owns **commit**
//! and **push**, and its `git_push` handler (`commands::git`) is the
//! only writer of `last_shipped_seq`/`last_shipped_commit` (through
//! [`WorkerRegistry::set_last_shipped`]). Ship never runs `git worktree
//! add`/`remove`; the worktree feature never runs `git add`/`commit`/
//! `push`.
//!
//! There is no separate worktree registry — the registry IS
//! [`WorkerRegistry`] plus [`crate::worker::handle::WorkerHandle`].
//! [`worktree_info_for_worker`] is the accessor ship reads it through.
//!
//! `created_seq` is deliberately **not** part of that accessor: the
//! single-writer [`crate::orchestration::OrchestrationEngine`] assigns
//! `worktree_created` its `seq` asynchronously, after `emit()` returns,
//! so `do_spawn_worker` cannot know it. When [`stage_and_commit`] needs
//! a starting seq for a worker that has never shipped, its caller (the
//! `git_stage_commit` handler, which can read the event log) resolves
//! it from that worker's `worktree_created` row.
//!
//! # Defense in depth: the primary-checkout guard
//!
//! [`preflight`] reports "primary checkout" (and seven other
//! conditions) as non-fatal `blockers` so the UI can explain *why*
//! shipping is disabled. [`stage_and_commit`] and [`push`] do **not**
//! trust that a caller checked `canShip` first: each runs the
//! primary-checkout guard before touching the working tree, so a stale
//! preflight (or a caller that skips it) can never turn into a commit
//! or push against the repository's primary checkout.
//!
//! # The deny list
//!
//! Secret-shaped and oversized files (see [`SkippedFile`]) never reach
//! a commit SWARM makes, in either [`StagingMode`]: a denied path
//! already in the index is unstaged first, and the index is checked
//! again right before `git commit` runs. Honest scope: the list governs
//! what [`stage_and_commit`] commits — commits the agent made on its
//! own are pushed as they are — and a process that stages a file in
//! the worktree between that final check and `git commit` is not seen.
//!
//! Every function here blocks on `git`; async callers run them inside
//! `tokio::task::spawn_blocking`.

mod commit;
mod deny;
mod error;
mod preflight;
mod push;
mod status;
#[cfg(test)]
mod tests;

use std::path::{Path, PathBuf};
use std::time::Duration;

use uuid::Uuid;

pub use self::commit::{CommitOutcome, CommitRequest, StagingMode, stage_and_commit};
pub use self::deny::SkippedFile;
pub use self::error::{ShipError, ShipErrorKind, ShipRemedy};
pub use self::preflight::{ShipPreflight, preflight};
pub use self::push::{PushOutcome, compare_url, push};
pub use self::status::DiffStat;
use super::cli::{self, GitOutput, READ_TIMEOUT};
use super::repo::{self, args_in};
use super::{RepoLocks, is_lock_contention_message};
use crate::error::AppError;
use crate::worker::registry::{WorkerId, WorkerRegistry};

/// Ship's read-only view of a worker's worktree — see the module doc's
/// ownership split.
#[derive(Debug, Clone)]
pub struct ShipWorktreeInfo {
    /// The worker.
    pub worker_id: Uuid,
    /// The repository toplevel the worktree belongs to, as recorded at
    /// spawn — the canonical [`RepoLocks`] key.
    pub repo_root: PathBuf,
    /// The worktree's toplevel.
    pub worktree_path: PathBuf,
    /// The isolation branch recorded at spawn. Actions resolve the
    /// branch checked out *now* instead (see [`push`]).
    pub branch: String,
    /// The commit the worktree was created from.
    pub base_commit: String,
    /// The event-log seq recorded by the last successful push.
    pub last_shipped_seq: Option<u64>,
    /// The commit sha recorded by the last successful push.
    pub last_shipped_commit: Option<String>,
}

/// Resolves [`ShipWorktreeInfo`] for `id` from `registry`. A pure
/// registry read — no `git` runs, and the registry shard is released
/// before this returns — so it is safe on an async thread.
///
/// # Errors
///
/// * [`ShipErrorKind::WorkerNotFound`] — no worker with `id` exists.
/// * [`ShipErrorKind::NoWorktree`] — the worker exists but was spawned
///   without worktree isolation (no `repoRoot` at spawn, or
///   `isolation: "none"`).
pub fn worktree_info_for_worker(
    registry: &WorkerRegistry,
    id: WorkerId,
) -> Result<ShipWorktreeInfo, ShipError> {
    // Clone the fields out in a block so the shard guard drops here.
    let (worktree_path, repo_root, branch, base_commit, last_shipped_seq, last_shipped_commit) = {
        let handle = registry
            .workers
            .get(&id)
            .ok_or_else(|| ShipError::worker_not_found(id))?;
        (
            handle.worktree_path.clone(),
            handle.repo_root.clone(),
            handle.branch.clone(),
            handle.base_commit.clone(),
            handle.last_shipped_seq,
            handle.last_shipped_commit.clone(),
        )
    };
    let (Some(worktree_path), Some(repo_root), Some(branch), Some(base_commit)) =
        (worktree_path, repo_root, branch, base_commit)
    else {
        return Err(ShipError::no_worktree(id));
    };
    Ok(ShipWorktreeInfo {
        worker_id: id,
        repo_root: repo_root.into(),
        worktree_path: worktree_path.into(),
        branch,
        base_commit,
        last_shipped_seq,
        last_shipped_commit,
    })
}

// ── git plumbing (argv vectors, `-C`-scoped) ─────────────────────────

/// Runs `git -C <worktree> args…`.
fn git(worktree: &Path, args: &[&str], timeout: Duration) -> Result<GitOutput, AppError> {
    cli::run(&args_in(worktree, args), timeout)
}

/// stdout of a successful single-value query (a branch name, a URL),
/// or `None` when the query failed or printed nothing.
fn single_value(output: &GitOutput) -> Option<String> {
    output
        .success()
        .then(|| output.stdout_trimmed())
        .filter(|value| !value.is_empty())
}

/// Runs one mutating git call under `repo_root`'s [`RepoLocks`] entry.
/// A failure that is lock contention (another git process holding
/// `index.lock` or a ref lock) becomes `Err`, which `RepoLocks` retries
/// once; any other exit comes back as `Ok` for the caller to classify.
fn mutate(
    repo_locks: &RepoLocks,
    repo_root: &Path,
    args: &[String],
    stdin: Option<&[u8]>,
    timeout: Duration,
) -> Result<GitOutput, AppError> {
    repo_locks.run_serialized(repo_root, || {
        let output = match stdin {
            Some(bytes) => cli::run_with_stdin(args, bytes, timeout)?,
            None => cli::run(args, timeout)?,
        };
        if !output.success() && is_lock_contention_message(output.raw_stderr()) {
            return Err(AppError::Git(output.stderr));
        }
        Ok(output)
    })
}

/// `paths` as NUL-terminated `:(top,literal)` pathspecs, the stdin
/// payload for `--pathspec-from-file=- --pathspec-file-nul`. `literal`
/// switches off glob and magic matching — a Next.js route file
/// `app/[slug]/page.tsx` must never also match `app/s/page.tsx` — and
/// `top` anchors each path at the worktree root. Reading paths from
/// stdin also keeps a large change set off the command line.
fn literal_pathspecs<'a>(paths: impl IntoIterator<Item = &'a str>) -> Vec<u8> {
    let mut payload = Vec::new();
    for path in paths {
        payload.extend_from_slice(b":(top,literal)");
        payload.extend_from_slice(path.as_bytes());
        payload.push(0);
    }
    payload
}

// ── Guards and branch resolution ─────────────────────────────────────

const NOT_A_WORKTREE: &str = "Refusing To Ship — This Path Is Not A Valid, Isolated Worktree.";
const PRIMARY_CHECKOUT: &str =
    "Refusing To Ship From The Primary Checkout — This Is Not A Worker's Isolated Worktree.";

/// The hard, pre-mutation guard [`stage_and_commit`] and [`push`] run
/// before touching the working tree — see the module doc. One `git
/// rev-parse` resolves both checks; any uncertainty (the query itself
/// failing) blocks shipping rather than proceeding.
fn guard_not_primary_checkout(worktree: &Path) -> Result<(), ShipError> {
    let refuse = |message: &str| ShipError::new(ShipErrorKind::PrimaryCheckout, message);
    let location = repo::locate(worktree).map_err(|_| refuse(NOT_A_WORKTREE))?;
    if !location.is_toplevel(worktree) {
        return Err(refuse(NOT_A_WORKTREE));
    }
    if location.is_primary_checkout() {
        return Err(refuse(PRIMARY_CHECKOUT));
    }
    Ok(())
}

/// The branch checked out in `worktree` right now, or `None` on a
/// detached `HEAD` (`-q` makes that a silent non-zero exit).
fn current_branch(worktree: &Path) -> Result<Option<String>, AppError> {
    let output = git(
        worktree,
        &["symbolic-ref", "-q", "--short", "HEAD"],
        READ_TIMEOUT,
    )?;
    Ok(single_value(&output))
}

/// Resolves the branch **currently** checked out in `worktree`,
/// hard-failing on a detached `HEAD` — never falling back to the
/// possibly-stale `WorkerHandle.branch`. Every action that acts on the
/// branch ([`push`], [`compare_url`]) resolves it here, once, so what it
/// operates on can never drift from what the worktree has checked out.
/// [`preflight`] reads the same fact from its status snapshot and
/// reports a detached `HEAD` as a blocker instead.
fn resolve_live_branch(worktree: &Path) -> Result<String, ShipError> {
    current_branch(worktree)?.ok_or_else(|| {
        ShipError::new(
            ShipErrorKind::InvalidBranch,
            "Worktree Is In A Detached HEAD State — Nothing To Ship From.",
        )
    })
}

/// Branches ship refuses to push onto directly: exact `main`/`master`/
/// `develop`, and anything under `release/`.
fn is_protected_branch(branch: &str) -> bool {
    matches!(branch, "main" | "master" | "develop") || branch.starts_with("release/")
}

/// `git remote get-url <remote_name>`, raw (credentials included — the
/// caller redacts before surfacing it).
fn remote_url(worktree: &Path, remote_name: &str) -> Option<String> {
    git(worktree, &["remote", "get-url", remote_name], READ_TIMEOUT)
        .ok()
        .as_ref()
        .and_then(single_value)
}

/// The branch a worker's isolation branch is compared against. Only the
/// base *commit* is recorded at spawn, so this is a live lookup, and
/// **never** the primary checkout's current `HEAD` (a human can check
/// out anything there at any time). Resolution order, each step run
/// only when the one before found nothing:
///
/// 1. `git symbolic-ref --short refs/remotes/origin/HEAD` minus its
///    `origin/` prefix — the remote's own default branch (set by `git
///    clone`, or `git remote set-head origin -a`).
/// 2. The repository's `init.defaultBranch`.
/// 3. The literal `"main"`.
fn resolve_base_branch(repo_root: &Path) -> String {
    choose_base_branch(
        || origin_head_branch(repo_root),
        || configured_default_branch(repo_root),
    )
}

/// The resolution order of [`resolve_base_branch`], separated from the
/// git queries so it is testable without depending on the host's global
/// `init.defaultBranch`.
fn choose_base_branch(
    origin_head: impl FnOnce() -> Option<String>,
    configured_default: impl FnOnce() -> Option<String>,
) -> String {
    origin_head()
        .or_else(configured_default)
        .unwrap_or_else(|| "main".to_owned())
}

fn origin_head_branch(repo_root: &Path) -> Option<String> {
    let output = git(
        repo_root,
        &["symbolic-ref", "-q", "--short", "refs/remotes/origin/HEAD"],
        READ_TIMEOUT,
    )
    .ok()?;
    single_value(&output).map(|head| head.trim_prefix("origin/").to_owned())
}

fn configured_default_branch(repo_root: &Path) -> Option<String> {
    let output = git(
        repo_root,
        &["config", "--get", "init.defaultBranch"],
        READ_TIMEOUT,
    )
    .ok()?;
    single_value(&output)
}
