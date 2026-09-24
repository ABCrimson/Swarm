//! [`ShipError`], the typed error every ship operation returns.

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::error::AppError;

/// Typed ship error — a **documented divergence** from the rest of the
/// codebase's string errors ([`AppError`]'s `Serialize` impl flattens
/// to a display string). The Ship tab branches on `kind` (different
/// second-click remedies for "push was rejected", "not authenticated",
/// "nothing changed"), which a bare string cannot carry, so this
/// serializes as an object: `{ "kind": "pushRejected", "message":
/// "...", "remedy": "fetchAndRebase" }`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShipError {
    /// What failed.
    pub kind: ShipErrorKind,
    /// A Title Case, user-facing explanation. Any git output in it is
    /// redacted and size-capped.
    pub message: String,
    /// The suggested next action, when there is one.
    pub remedy: Option<ShipRemedy>,
}

/// The full enumeration of ways a ship operation can fail. `NoUpstream`
/// is deliberately absent — an isolation branch has no upstream until
/// its first push, which is a normal *preflight state* (surfaced as
/// `ShipPreflight.upstream: null`), never an error.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ShipErrorKind {
    /// `workerId` is malformed or does not resolve in the registry.
    WorkerNotFound,
    /// The worker resolved, but has no worktree (spawned unisolated) —
    /// ship requires worktree isolation.
    NoWorktree,
    /// The resolved worktree path is the repository's primary checkout,
    /// or can no longer be verified as a distinct worktree at all — see
    /// the defense-in-depth note in [`crate::git::ship`]'s module doc.
    PrimaryCheckout,
    /// Detached `HEAD`, `branch == baseBranch`, or a protected branch
    /// (`main`/`master`/`develop`/`release/*`).
    InvalidBranch,
    /// No `origin` remote configured.
    NoRemote,
    /// The `origin` remote's host isn't one a GitHub-style compare URL
    /// can be built for.
    NonGitHubHost,
    /// Every candidate file was skipped by the deny list, or there were
    /// no changes at all.
    NothingToCommit,
    /// `git commit` failed because `user.name`/`user.email` aren't set.
    IdentityMissing,
    /// `git commit` was rejected — most plausibly a `pre-commit` or
    /// `commit-msg` hook, since `--no-verify` is never constructible.
    HookFailed,
    /// `git push` was rejected as non-fast-forward — the remote branch
    /// has commits the local branch doesn't.
    PushRejected,
    /// `git push` failed on credentials — expired or missing auth.
    AuthExpired,
    /// A git invocation exceeded its time budget and was terminated.
    Timeout,
    /// Any failure not otherwise classified. `message` carries git's
    /// own (redacted) stderr.
    Unknown,
}

/// A suggested next action for a [`ShipError`], surfaced by the UI as
/// the label on a second-click remedy button. `None` means "no
/// specific remedy — just report the message".
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ShipRemedy {
    /// `git pull --rebase`, then ship again. **Never** an automatic
    /// `--force`/`--force-with-lease` push: a worker's branch can be a
    /// human's branch.
    FetchAndRebase,
    /// Re-authenticate with the configured git credential helper.
    ReAuthenticate,
    /// Set `user.name`/`user.email` (locally or globally) before
    /// shipping.
    ConfigureIdentity,
}

impl ShipError {
    /// A `kind` error with no remedy.
    pub(super) fn new(kind: ShipErrorKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
            remedy: None,
        }
    }

    /// `self` with `remedy` attached.
    pub(super) fn with_remedy(self, remedy: ShipRemedy) -> Self {
        Self {
            remedy: Some(remedy),
            ..self
        }
    }

    pub(super) fn worker_not_found(id: Uuid) -> Self {
        Self::new(
            ShipErrorKind::WorkerNotFound,
            format!("Worker `{id}` Not Found."),
        )
    }

    pub(super) fn no_worktree(id: Uuid) -> Self {
        Self::new(
            ShipErrorKind::NoWorktree,
            format!("Worker `{id}` Has No Worktree — Ship Requires Worktree Isolation."),
        )
    }
}

/// Classifies by variant, never by message text: only a typed
/// [`AppError::GitTimeout`] is a [`ShipErrorKind::Timeout`].
impl From<AppError> for ShipError {
    fn from(err: AppError) -> Self {
        let kind = match err {
            AppError::GitTimeout { .. } => ShipErrorKind::Timeout,
            _ => ShipErrorKind::Unknown,
        };
        Self::new(kind, err.to_string())
    }
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use super::*;

    #[test]
    fn test_ship_error_from_git_timeout_is_timeout() {
        let err: ShipError = AppError::GitTimeout {
            command: "push".to_owned(),
            timeout: Duration::from_secs(600),
        }
        .into();
        assert_eq!(err.kind, ShipErrorKind::Timeout);
        assert!(
            err.message.contains("`git push` timed out"),
            "{}",
            err.message
        );
    }

    /// An echoed network error that merely *contains* "timed out" is not
    /// a SWARM-side timeout.
    #[test]
    fn test_ship_error_from_a_message_mentioning_timed_out_is_unknown() {
        let err: ShipError =
            AppError::Git("fatal: unable to access: Connection timed out".to_owned()).into();
        assert_eq!(err.kind, ShipErrorKind::Unknown);
    }

    #[test]
    fn test_ship_error_serializes_as_structured_object_not_a_bare_string() {
        let err = ShipError::new(ShipErrorKind::PushRejected, "Push Rejected")
            .with_remedy(ShipRemedy::FetchAndRebase);
        let json = serde_json::to_value(&err).unwrap();
        assert_eq!(json["kind"], "pushRejected");
        assert_eq!(json["message"], "Push Rejected");
        assert_eq!(json["remedy"], "fetchAndRebase");

        let json = serde_json::to_value(ShipError::new(ShipErrorKind::Timeout, "t")).unwrap();
        assert!(
            json["remedy"].is_null(),
            "a missing remedy is an explicit null"
        );
    }
}
