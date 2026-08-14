//! Git repo-root validation Tauri IPC command.
//!
//! A thin wrapper over `swarm_core::git::repo::discover_toplevel` —
//! lets the frontend's Project Root picker (Workers page) confirm a
//! chosen directory is actually inside a git repository *before*
//! persisting it as the `default_repo_root` config value, instead of
//! silently accepting anything and letting every subsequent isolated
//! spawn hard-fail with a raw git error.

use swarm_core::git;

/// Validates that `path` is inside a git repository, returning its
/// canonical toplevel absolute path on success.
///
/// # Arguments
///
/// * `path` - Candidate directory to validate (e.g. from a directory picker)
///
/// # Returns
///
/// The repo's toplevel absolute path (may differ from `path` if
/// `path` was a subdirectory of the repo).
///
/// # Errors
///
/// Returns a `String` error if `path` is not inside a git repository,
/// `git` could not be spawned, or the operation timed out.
#[tauri::command]
#[tracing::instrument]
pub async fn validate_repo_root(path: String) -> Result<String, String> {
    tokio::task::spawn_blocking(move || git::repo::discover_toplevel(std::path::Path::new(&path)))
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "validate_repo_root task panicked");
            e.to_string()
        })?
        .map(|toplevel| toplevel.display().to_string())
        .map_err(|e| {
            tracing::debug!(error = %e, "repo root validation failed");
            e.to_string()
        })
}
