//! The commands that exist only in the desktop shell
//! ([`swarm_core::commands::NATIVE_ONLY`]): each drives an OS integration
//! through a Tauri plugin, which means nothing to a remote `swarmd`
//! client, so none has a registry entry.

use serde::Serialize;
use swarm_core::commands::Ctx;
use swarm_core::worker::registry::{WorkerId, WorkerRegistry};
use tauri::{AppHandle, State};
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_opener::OpenerExt;
use tauri_plugin_updater::UpdaterExt;

/// Opens worker `worker_id`'s worktree directory in the system file
/// manager.
///
/// The webview names the worker, never a path, and holds no opener path
/// scope: an agent can write any file into its worktree (a `run.bat`),
/// and a scope over the worktrees would let the webview have the OS open
/// (run) it. The path is the one the registry recorded when the worktree
/// was created, and it opens only while it is a real directory (see
/// [`worker_directory`]). A swap of that directory between the check and
/// the open is not seen.
///
/// # Errors
///
/// A message when the worker does not exist, has no worktree, its
/// worktree is not a directory now, or the OS cannot open it.
#[tauri::command]
#[tracing::instrument(level = "debug", skip_all)]
pub async fn open_worker_directory<R: tauri::Runtime>(
    app: AppHandle<R>,
    ctx: State<'_, Ctx>,
    worker_id: WorkerId,
) -> Result<(), String> {
    let registry = ctx.registry.clone();
    // A metadata read and a file-manager launch block, so they run off
    // the async worker threads.
    tauri::async_runtime::spawn_blocking(move || {
        let directory = worker_directory(&registry, worker_id)?;
        app.opener()
            .open_path(directory, None::<&str>)
            .map_err(|error| {
                tracing::warn!(%error, "opening a worktree failed");
                error.to_string()
            })
    })
    .await
    .map_err(|error| error.to_string())?
}

/// The worktree path the registry recorded for worker `id`, when it is a
/// real directory now. `symlink_metadata` does not follow a link, and
/// neither a symlink nor a Windows junction is `is_dir()`, so a worktree
/// replaced by a link to somewhere else, or by a file, is refused.
fn worker_directory(registry: &WorkerRegistry, id: WorkerId) -> Result<String, String> {
    let path = registry
        .get_worker(&id)
        .map_err(|error| error.to_string())?
        .worktree_path
        .ok_or_else(|| "This Worker Has No Worktree.".to_owned())?;
    match std::fs::symlink_metadata(&path) {
        Ok(metadata) if metadata.is_dir() => Ok(path),
        Ok(_) => Err("Refusing To Open The Worktree: It Is Not A Directory.".to_owned()),
        Err(error) => Err(format!("Could Not Read The Worktree: {error}")),
    }
}

/// Shows a native OS notification.
///
/// Fire-and-forget: the notification plugin shows it on a background task
/// and discards the outcome, so an `Ok` means the show was queued, not that
/// the OS accepted or displayed it (the user may have muted the app).
///
/// # Errors
///
/// A message when the notification cannot be prepared: on Windows the
/// plugin reads the executable path to decide whether to set the app id,
/// and fails when it cannot.
#[tauri::command]
#[tracing::instrument(level = "debug", skip_all)]
pub async fn send_notification<R: tauri::Runtime>(
    app: AppHandle<R>,
    title: String,
    body: String,
) -> Result<(), String> {
    app.notification()
        .builder()
        .title(title)
        .body(body)
        .show()
        .map_err(|error| {
            tracing::warn!(%error, "notification failed");
            error.to_string()
        })
}

/// What [`check_for_updates`] found.
#[derive(Debug, Serialize)]
pub struct UpdateCheck {
    /// Whether the endpoint announces a version newer than this build.
    pub available: bool,
    /// The announced version.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    /// The release notes.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub body: Option<String>,
    /// The publication date as the manifest states it (RFC 3339).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub date: Option<String>,
}

/// Asks the endpoint in `plugins.updater` whether a newer release exists.
///
/// Check only: the app tells the user an update is available and never
/// downloads or installs it. The plugin verifies an update's minisign
/// signature (and, with `requireSignedVersion`, the version it signs) on
/// download, which the app does not do today.
///
/// # Errors
///
/// A message when the updater is not configured or the check fails
/// (network error, malformed manifest).
#[tauri::command]
#[tracing::instrument(level = "debug", skip_all)]
pub async fn check_for_updates<R: tauri::Runtime>(
    app: AppHandle<R>,
) -> Result<UpdateCheck, String> {
    let update = app
        .updater()
        .map_err(|error| {
            tracing::warn!(%error, "the updater is unavailable");
            error.to_string()
        })?
        .check()
        .await
        .map_err(|error| {
            tracing::warn!(%error, "update check failed");
            error.to_string()
        })?;
    Ok(match update {
        Some(update) => {
            tracing::info!(version = %update.version, "update available");
            UpdateCheck {
                available: true,
                // The plugin parsed `pub_date` from this field; passing
                // the manifest's own string on keeps it RFC 3339 (the
                // parsed `OffsetDateTime`'s `Display` is not).
                date: update
                    .date
                    .and(update.raw_json["pub_date"].as_str().map(str::to_owned)),
                version: Some(update.version),
                body: update.body,
            }
        }
        None => UpdateCheck {
            available: false,
            version: None,
            body: None,
            date: None,
        },
    })
}

#[cfg(test)]
mod tests {
    use swarm_core::worker::handle::{WorkerHandle, WorkerState};

    use super::*;
    use crate::test_support::temp_dir;

    /// A registry holding one worker whose recorded worktree is `path`.
    fn registry_with(path: Option<&std::path::Path>) -> (WorkerRegistry, WorkerId) {
        let registry = WorkerRegistry::new();
        let id = registry
            .register(WorkerHandle {
                id: WorkerId::new_v4(),
                state: WorkerState::Running,
                name: "w".to_owned(),
                pid: None,
                started_at: 0,
                pty_writer: None,
                child: None,
                worktree_path: path.map(|path| path.display().to_string()),
                repo_root: None,
                branch: None,
                base_commit: None,
                last_shipped_seq: None,
                last_shipped_commit: None,
            })
            .unwrap();
        (registry, id)
    }

    #[test]
    fn worker_directory_is_the_recorded_worktree_directory() {
        let dir = temp_dir("open-dir");
        let (registry, id) = registry_with(Some(&dir));
        assert_eq!(
            worker_directory(&registry, id),
            Ok(dir.display().to_string())
        );
    }

    /// An agent can replace its worktree with a file it wrote; the OS
    /// would run that file, so it is never opened.
    #[test]
    fn worker_directory_refuses_a_file() {
        let dir = temp_dir("open-file");
        let file = dir.join("run.bat");
        std::fs::write(&file, "echo pwned").unwrap();
        let (registry, id) = registry_with(Some(&file));
        assert_eq!(
            worker_directory(&registry, id),
            Err("Refusing To Open The Worktree: It Is Not A Directory.".to_owned())
        );
    }

    /// A link is refused even when it points at a directory: its target
    /// can be anywhere.
    #[cfg(unix)]
    #[test]
    fn worker_directory_refuses_a_symlink_to_a_directory() {
        let dir = temp_dir("open-link");
        let target = dir.join("elsewhere");
        std::fs::create_dir(&target).unwrap();
        let link = dir.join("w-11112222");
        std::os::unix::fs::symlink(&target, &link).unwrap();
        let (registry, id) = registry_with(Some(&link));
        assert_eq!(
            worker_directory(&registry, id),
            Err("Refusing To Open The Worktree: It Is Not A Directory.".to_owned())
        );
    }

    #[test]
    fn worker_directory_refuses_a_missing_worktree_or_worker() {
        let dir = temp_dir("open-missing");
        let (registry, id) = registry_with(Some(&dir.join("gone")));
        assert!(
            worker_directory(&registry, id)
                .unwrap_err()
                .starts_with("Could Not Read The Worktree: ")
        );

        let (registry, id) = registry_with(None);
        assert_eq!(
            worker_directory(&registry, id),
            Err("This Worker Has No Worktree.".to_owned())
        );

        let unknown = WorkerId::new_v4();
        assert_eq!(
            worker_directory(&registry, unknown),
            Err(format!("Worker `{unknown}` not found"))
        );
    }

    #[test]
    fn update_check_serializes_like_the_frontends_update_check_result() {
        let none = UpdateCheck {
            available: false,
            version: None,
            body: None,
            date: None,
        };
        assert_eq!(
            serde_json::to_value(none).unwrap(),
            serde_json::json!({ "available": false })
        );

        let some = UpdateCheck {
            available: true,
            version: Some("0.14.0".into()),
            body: None,
            date: Some("2026-09-23T12:00:00Z".into()),
        };
        assert_eq!(
            serde_json::to_value(some).unwrap(),
            serde_json::json!({
                "available": true,
                "version": "0.14.0",
                "date": "2026-09-23T12:00:00Z",
            })
        );
    }
}
