//! [`push`] and [`compare_url`]: publishing a worker's branch and the
//! prefilled compare page for it.

use std::path::Path;

use serde::{Deserialize, Serialize};

use super::{
    RepoLocks, ShipError, ShipErrorKind, ShipRemedy, guard_not_primary_checkout,
    is_protected_branch, mutate, remote_url, resolve_base_branch, resolve_live_branch,
    worktree_info_for_worker,
};
use crate::git::cli::PUSH_TIMEOUT;
use crate::git::remote;
use crate::git::repo::{self, args_in};
use crate::worker::registry::{WorkerId, WorkerRegistry};

/// A push [`push`] made. Serialized over IPC and read back by the
/// desktop shell's thin command wrapper, hence `Deserialize` too.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PushOutcome {
    /// The remote-tracking ref pushed to (`origin/<branch>`).
    pub pushed_ref: String,
    /// `HEAD`'s sha at push time, resolved here — never a caller-supplied
    /// value (see [`push`]).
    pub sha: String,
}

/// Argv for `git push --set-upstream --end-of-options origin <branch>` —
/// fixed shape, structurally incapable of carrying `--force`/`-f`/
/// `--force-with-lease` or `--no-verify`. `--end-of-options` keeps a
/// branch named like an option (`--all`, `--force`) a refspec: pinned by
/// `test_push_args_never_contains_force`.
fn push_args(worktree: &Path, branch: &str) -> Vec<String> {
    args_in(
        worktree,
        &[
            "push",
            "--set-upstream",
            "--end-of-options",
            "origin",
            branch,
        ],
    )
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

/// Pushes `origin <branch>` with `--set-upstream` — fixed argv, never
/// force, hooks always run. Runs the primary-checkout guard first;
/// `branch` is the one checked out **now** (never the stored
/// `WorkerHandle.branch`, which a rename makes stale). The push runs
/// under `repo_locks`, like [`super::stage_and_commit`]'s mutations.
///
/// Resolves `HEAD`'s sha itself and returns it as [`PushOutcome::sha`],
/// which is what makes `push` safe to call with **no** fresh commit: a
/// worker with unpushed commits (`ShipPreflight.ahead > 0`, e.g. from an
/// earlier "Commit Only") goes straight here, and the outcome reports
/// whatever `HEAD` actually is.
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

    let output = mutate(
        repo_locks,
        &info.repo_root,
        &push_args(wt, &branch),
        None,
        PUSH_TIMEOUT,
    )?;
    if !output.success() {
        return Err(classify_push_error(output.raw_stderr(), &output.stderr));
    }

    Ok(PushOutcome {
        pushed_ref: format!("origin/{branch}"),
        sha,
    })
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

    #[test]
    fn test_push_args_never_contains_force() {
        let args = push_args(Path::new("/tmp/wt"), "swarm/agent-abcd1234");
        assert!(
            !args.iter().any(|a| {
                a == "--force" || a == "-f" || a == "--force-with-lease" || a == "--no-verify"
            }),
            "push_args must never construct a force or no-verify token: {args:?}"
        );
        assert_eq!(
            args[4..],
            [
                "push",
                "--set-upstream",
                "--end-of-options",
                "origin",
                "swarm/agent-abcd1234"
            ]
        );
    }

    #[test]
    fn test_push_args_keep_option_shaped_branch_a_refspec() {
        let args = push_args(Path::new("/tmp/wt"), "--force");
        assert_eq!(
            args[4..],
            [
                "push",
                "--set-upstream",
                "--end-of-options",
                "origin",
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
