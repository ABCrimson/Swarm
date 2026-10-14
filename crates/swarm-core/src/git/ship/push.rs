//! [`push`] and [`compare_url`]: publishing a worker's branch and the
//! prefilled compare page for it.

use std::path::Path;

use serde::Serialize;

use super::{
    RepoLocks, ShipError, ShipErrorKind, ShipRemedy, guard_not_primary_checkout,
    is_protected_branch, mutate, remote_url, resolve_base_branch, resolve_live_branch,
    worktree_info_for_worker,
};
use crate::git::cli::{PUSH_TIMEOUT, READ_TIMEOUT};
use crate::git::remote;
use crate::git::repo::{self, args_in};
use crate::worker::registry::{WorkerId, WorkerRegistry};

/// A push [`push`] made — `git_push`'s IPC result, which the frontend
/// validates with `PushOutcomeSchema` (`src/store/types.ts`).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PushOutcome {
    /// The remote-tracking ref pushed to (`origin/<branch>`).
    pub pushed_ref: String,
    /// The remote pushed to (`origin`).
    pub remote: String,
    /// The ref updated on that remote (`refs/heads/<branch>`).
    pub remote_ref: String,
    /// The commit pushed: `HEAD`'s sha as [`push`] resolved it — never a
    /// caller-supplied value — and, because the push carries exactly
    /// this sha, the commit the remote ref now points at.
    pub sha: String,
}

/// Argv for `git push --end-of-options origin
/// <sha>:refs/heads/<branch>` — fixed shape, with no
/// `--force`/`-f`/`--force-with-lease` or `--no-verify` token. The source
/// is the commit id itself, never a branch name, so what the remote
/// receives is the commit that was read, whatever lands on the branch
/// afterwards. A refspec starting with `+` would force the update; the
/// source is a hex object id (checked by [`is_object_id`] before this
/// runs), so it cannot start with `+`, and the fully qualified
/// destination makes a leading `+` in `branch` part of the literal ref
/// name, so a branch named `+main` cannot force-update `main`.
/// `--end-of-options` keeps an option-shaped branch (`--all`, `--force`)
/// an operand. The fixed shape is pinned by
/// `test_push_args_never_contains_force`, the option-shaped branch by
/// `test_push_args_keep_option_shaped_branch_a_refspec`, the `+` branch by
/// `test_push_args_force_marker_branch_is_a_literal_ref`.
///
/// There is deliberately no `--set-upstream`: git records an upstream only
/// for a refspec whose source is a local branch, so [`set_upstream_args`]
/// does it after the push.
fn push_args(worktree: &Path, sha: &str, branch: &str) -> Vec<String> {
    let refspec = format!("{sha}:refs/heads/{branch}");
    args_in(worktree, &["push", "--end-of-options", "origin", &refspec])
}

/// Argv for `git branch --set-upstream-to=origin/<branch>
/// --end-of-options <branch>` — makes `branch` track the remote-tracking
/// ref the push just updated, which preflight's ahead/behind counts read.
fn set_upstream_args(worktree: &Path, branch: &str) -> Vec<String> {
    let upstream = format!("--set-upstream-to=origin/{branch}");
    args_in(worktree, &["branch", &upstream, "--end-of-options", branch])
}

/// `true` for a full SHA-1 or SHA-256 object id in lowercase hex — the
/// only shape [`push_args`] accepts as a refspec source.
fn is_object_id(sha: &str) -> bool {
    matches!(sha.len(), 40 | 64) && sha.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

/// stderr phrases of a credential failure, lowercase. Specific phrases
/// only: a bare "403" or "permission denied" also appears in unrelated
/// rejections (a branch name, a hook's own message).
const AUTH_FAILURE_PHRASES: &[&str] = &[
    "authentication failed",
    "could not read username",
    "could not read password",
    "terminal prompts disabled",
    "the requested url returned error: 401",
    "the requested url returned error: 403",
    "permission denied (publickey",
    "invalid username or password",
    "invalid username or token",
    "http basic: access denied",
    "password authentication is not supported",
    "support for password authentication was removed",
];

/// Maps a failed `git push` to a [`ShipError`]: `raw_stderr` is matched
/// against, `surfaced_stderr` (redacted) goes into the message.
fn classify_push_error(raw_stderr: &str, surfaced_stderr: &str) -> ShipError {
    let lower = raw_stderr.to_lowercase();
    let non_fast_forward = lower.lines().any(|line| {
        line.contains("[rejected]")
            && ["(non-fast-forward)", "(fetch first)", "(stale info)"]
                .iter()
                .any(|reason| line.contains(reason))
    });
    if non_fast_forward {
        return ShipError::new(
            ShipErrorKind::PushRejected,
            "Push Rejected — `origin` Has Commits You Don't Have. Fetch And Rebase, Then Ship Again.",
        )
        .with_remedy(ShipRemedy::FetchAndRebase);
    }
    // GitHub: "remote: Permission to <owner>/<repo>.git denied to <user>."
    let permission_denied_to_user = lower
        .lines()
        .any(|line| line.contains("permission to ") && line.contains(" denied to "));
    if permission_denied_to_user
        || AUTH_FAILURE_PHRASES
            .iter()
            .any(|phrase| lower.contains(phrase))
    {
        return ShipError::new(
            ShipErrorKind::AuthExpired,
            "Authentication Failed — Re-Authenticate With Your Git Credential Helper And Ship Again.",
        )
        .with_remedy(ShipRemedy::ReAuthenticate);
    }
    ShipError::new(
        ShipErrorKind::Unknown,
        format!("Push Failed: {}", surfaced_stderr.trim()),
    )
}

/// Pushes the worker's current `HEAD` commit to `origin`'s branch of the
/// same name — fixed argv (see [`push_args`]), never force, hooks always
/// run — and records the upstream. Runs the primary-checkout guard
/// first; `branch` is the one checked out **now** (never the stored
/// `WorkerHandle.branch`, which a rename makes stale). Each git call runs
/// under `repo_locks`, like [`super::stage_and_commit`]'s mutations.
///
/// Resolves `HEAD`'s sha itself and pushes that exact commit, so a commit
/// that lands on the branch afterwards is not pushed and
/// [`PushOutcome::sha`] is what the remote received. This also makes
/// `push` safe to call with **no** fresh commit: a worker with unpushed
/// commits (`ShipPreflight.ahead > 0`, e.g. from an earlier "Commit
/// Only") goes straight here.
///
/// # Errors
///
/// * [`ShipErrorKind::WorkerNotFound`] / [`ShipErrorKind::NoWorktree`] —
///   as [`super::worktree_info_for_worker`].
/// * [`ShipErrorKind::PrimaryCheckout`] — the guard fired.
/// * [`ShipErrorKind::InvalidBranch`] — detached `HEAD`, a protected
///   branch, or the base branch.
/// * [`ShipErrorKind::NoRemote`] — no `origin` remote configured.
/// * [`ShipErrorKind::PushRejected`] / [`ShipErrorKind::AuthExpired`] /
///   [`ShipErrorKind::Timeout`] / [`ShipErrorKind::Unknown`] — the push
///   itself failed, or reading the live branch or the `origin` remote
///   did.
pub fn push(
    registry: &WorkerRegistry,
    repo_locks: &RepoLocks,
    id: WorkerId,
) -> Result<PushOutcome, ShipError> {
    let info = worktree_info_for_worker(registry, id)?;
    let wt = info.worktree_path.as_path();

    guard_not_primary_checkout(wt)?;
    let branch = resolve_live_branch(wt)?;
    if is_protected_branch(&branch) {
        return Err(ShipError::new(
            ShipErrorKind::InvalidBranch,
            format!("Branch `{branch}` Is Protected — Ship Refuses To Push Directly To It."),
        ));
    }
    if branch == resolve_base_branch(&info.repo_root) {
        return Err(ShipError::new(
            ShipErrorKind::InvalidBranch,
            format!("Branch `{branch}` Is The Base Branch — Ship Refuses To Push Directly To It."),
        ));
    }
    if remote_url(wt, "origin")?.is_none() {
        return Err(ShipError::new(
            ShipErrorKind::NoRemote,
            "No `origin` Remote Configured.",
        ));
    }
    let sha = repo::head_sha(wt)?;
    push_commit(repo_locks, &info.repo_root, wt, &branch, &sha)
}

/// Pushes commit `sha` to `origin`'s `branch` (non-force: a
/// non-fast-forward is [`ShipErrorKind::PushRejected`]), then points
/// `branch`'s upstream at `origin/<branch>`. Each git call runs under
/// `repo_locks`; the push carries `sha` itself, so the receipt names
/// exactly the commit that was pushed even when `branch` has moved since
/// `sha` was read.
///
/// The upstream is bookkeeping after the push has already succeeded, so a
/// failure to record it is logged, not returned — reporting the push as
/// failed would hide a commit that is on the remote.
pub(super) fn push_commit(
    repo_locks: &RepoLocks,
    repo_root: &Path,
    wt: &Path,
    branch: &str,
    sha: &str,
) -> Result<PushOutcome, ShipError> {
    if !is_object_id(sha) {
        return Err(ShipError::new(
            ShipErrorKind::Unknown,
            format!("Refusing To Push: `{sha}` Is Not A Commit Id."),
        ));
    }
    let output = mutate(
        repo_locks,
        repo_root,
        &push_args(wt, sha, branch),
        None,
        PUSH_TIMEOUT,
    )?;
    if !output.success() {
        return Err(classify_push_error(output.raw_stderr(), &output.stderr));
    }

    match mutate(
        repo_locks,
        repo_root,
        &set_upstream_args(wt, branch),
        None,
        READ_TIMEOUT,
    ) {
        Ok(output) if output.success() => {}
        Ok(output) => {
            tracing::warn!(%branch, stderr = %output.stderr.trim(), "ship: pushed, but could not record the upstream");
        }
        Err(error) => {
            tracing::warn!(%branch, %error, "ship: pushed, but could not record the upstream");
        }
    }

    Ok(PushOutcome {
        pushed_ref: format!("origin/{branch}"),
        remote: "origin".to_owned(),
        remote_ref: format!("refs/heads/{branch}"),
        sha: sha.to_owned(),
    })
}

/// The last push recorded for a worker — what a compare-page receipt
/// reports, read from the registry instead of taken from the caller.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RecordedPush {
    /// The commit sha the last successful [`push`] recorded.
    pub sha: String,
    /// The remote-tracking ref of the branch checked out now
    /// (`origin/<branch>`), as in [`PushOutcome::pushed_ref`].
    pub pushed_ref: String,
}

/// The push recorded for `id` through
/// [`WorkerRegistry::set_last_shipped`], or `None` when this worker has
/// not pushed since it was spawned (the record is in memory only).
///
/// # Errors
///
/// * [`ShipErrorKind::WorkerNotFound`] / [`ShipErrorKind::NoWorktree`] —
///   as [`super::worktree_info_for_worker`].
/// * [`ShipErrorKind::InvalidBranch`] / [`ShipErrorKind::Timeout`] /
///   [`ShipErrorKind::Unknown`] — reading the live branch failed.
pub fn recorded_push(
    registry: &WorkerRegistry,
    id: WorkerId,
) -> Result<Option<RecordedPush>, ShipError> {
    let info = worktree_info_for_worker(registry, id)?;
    let Some(sha) = info.last_shipped_commit else {
        return Ok(None);
    };
    let branch = resolve_live_branch(&info.worktree_path)?;
    Ok(Some(RecordedPush {
        sha,
        pushed_ref: format!("origin/{branch}"),
    }))
}

/// Builds the GitHub-style compare URL for `id`'s worktree, prefilled
/// with `title`/`body` (capped per [`remote::MAX_COMPARE_URL_LEN`]).
/// The branch is the one checked out **now**, as in [`push`].
///
/// The UI checks `ShipPreflight.hostSupportsCompare` and disables "Open
/// Compare Page" before ever calling this (leaving Commit Only and
/// Commit + Push available); [`ShipErrorKind::NonGitHubHost`] here is
/// the fallback for a stale preflight.
///
/// # Errors
///
/// * [`ShipErrorKind::WorkerNotFound`] / [`ShipErrorKind::NoWorktree`] —
///   as [`super::worktree_info_for_worker`].
/// * [`ShipErrorKind::InvalidBranch`] — detached `HEAD`.
/// * [`ShipErrorKind::NoRemote`] — no `origin` remote configured.
/// * [`ShipErrorKind::NonGitHubHost`] — the remote's host isn't one a
///   GitHub-style compare URL applies to.
/// * [`ShipErrorKind::Timeout`] / [`ShipErrorKind::Unknown`] — reading the
///   live branch or the `origin` remote failed.
pub fn compare_url(
    registry: &WorkerRegistry,
    id: WorkerId,
    title: &str,
    body: &str,
) -> Result<String, ShipError> {
    let info = worktree_info_for_worker(registry, id)?;
    let wt = info.worktree_path.as_path();
    let branch = resolve_live_branch(wt)?;

    let raw_remote = remote_url(wt, "origin")?
        .ok_or_else(|| ShipError::new(ShipErrorKind::NoRemote, "No `origin` Remote Configured."))?;
    let parsed = remote::parse(&raw_remote).ok_or_else(|| {
        ShipError::new(
            ShipErrorKind::NonGitHubHost,
            "Could Not Parse The `origin` Remote URL Into A Compare Link.",
        )
    })?;
    if !remote::looks_like_github_host(&parsed.host) {
        return Err(ShipError::new(
            ShipErrorKind::NonGitHubHost,
            format!(
                "`{}` Doesn't Look Like A GitHub Host — A Compare Link Can't Be Built For It.",
                parsed.host
            ),
        ));
    }

    let base_branch = resolve_base_branch(&info.repo_root);
    Ok(remote::compare_url(
        &parsed,
        &base_branch,
        &branch,
        title,
        body,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    const SHA: &str = "0123456789abcdef0123456789abcdef01234567";

    #[test]
    fn test_push_args_never_contains_force() {
        let args = push_args(Path::new("/tmp/wt"), SHA, "swarm/agent-abcd1234");
        assert!(
            !args.iter().any(|a| {
                a == "--force"
                    || a == "-f"
                    || a == "--force-with-lease"
                    || a == "--no-verify"
                    || a.starts_with('+')
            }),
            "push_args must never construct a force or no-verify token: {args:?}"
        );
        assert_eq!(
            args[4..],
            [
                "push",
                "--end-of-options",
                "origin",
                "0123456789abcdef0123456789abcdef01234567:refs/heads/swarm/agent-abcd1234"
            ]
        );
    }

    #[test]
    fn test_push_args_keep_option_shaped_branch_a_refspec() {
        let args = push_args(Path::new("/tmp/wt"), SHA, "--force");
        assert_eq!(
            args[4..],
            [
                "push",
                "--end-of-options",
                "origin",
                "0123456789abcdef0123456789abcdef01234567:refs/heads/--force"
            ]
        );
    }

    #[test]
    fn test_push_args_force_marker_branch_is_a_literal_ref() {
        let args = push_args(Path::new("/tmp/wt"), SHA, "+main");
        assert_eq!(
            args.last().map(String::as_str),
            Some("0123456789abcdef0123456789abcdef01234567:refs/heads/+main")
        );
    }

    #[test]
    fn test_is_object_id_accepts_only_full_lowercase_hex_ids() {
        assert!(is_object_id(SHA));
        assert!(is_object_id(&"a".repeat(64)));
        for bad in [
            "",
            "+main",
            "HEAD",
            "--force",
            "abc123",
            &SHA.to_uppercase(),
            &format!("+{SHA}"),
        ] {
            assert!(!is_object_id(bad), "{bad:?}");
        }
    }

    #[test]
    fn test_set_upstream_args_keep_option_shaped_branch_an_operand() {
        let args = set_upstream_args(Path::new("/tmp/wt"), "--force");
        assert_eq!(
            args[4..],
            [
                "branch",
                "--set-upstream-to=origin/--force",
                "--end-of-options",
                "--force"
            ]
        );
    }

    #[test]
    fn test_classify_push_error_kinds() {
        let cases = [
            (
                " ! [rejected]        swarm/x -> swarm/x (non-fast-forward)",
                ShipErrorKind::PushRejected,
            ),
            (
                " ! [rejected]        swarm/x -> swarm/x (fetch first)",
                ShipErrorKind::PushRejected,
            ),
            (
                "fatal: Authentication failed for 'https://github.com/o/r.git/'",
                ShipErrorKind::AuthExpired,
            ),
            (
                "fatal: could not read Username for 'https://github.com': terminal prompts disabled",
                ShipErrorKind::AuthExpired,
            ),
            (
                "remote: Permission to o/r.git denied to someone.",
                ShipErrorKind::AuthExpired,
            ),
            (
                "fatal: unable to access 'https://h/o/r.git/': The requested URL returned error: 403",
                ShipErrorKind::AuthExpired,
            ),
            (
                "git@github.com: Permission denied (publickey).",
                ShipErrorKind::AuthExpired,
            ),
            ("some entirely unrecognized failure", ShipErrorKind::Unknown),
        ];
        for (stderr, kind) in cases {
            assert_eq!(classify_push_error(stderr, stderr).kind, kind, "{stderr}");
        }
    }

    /// A server-side hook rejection is not an auth problem, even when
    /// "403" appears in the branch name it echoes.
    #[test]
    fn test_classify_push_error_hook_declined_with_403_in_the_branch_is_unknown() {
        let stderr = " ! [remote rejected] swarm/fix-403-ab403cd1 -> swarm/fix-403-ab403cd1 (pre-receive hook declined)";
        let err = classify_push_error(stderr, stderr);
        assert_eq!(err.kind, ShipErrorKind::Unknown);
        assert!(
            err.message.contains("pre-receive hook declined"),
            "{}",
            err.message
        );
    }
}
