//! The commands that exist only in the desktop shell
//! ([`swarm_core::commands::NATIVE_ONLY`]): both drive an OS integration
//! through a Tauri plugin, which means nothing to a remote `swarmd`
//! client, so neither has a registry entry.

use serde::Serialize;
use tauri::AppHandle;
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_updater::UpdaterExt;

/// Shows a native OS notification.
///
/// Fire-and-forget: the notification plugin delivers it on a background
/// task and discards the outcome, so an `Ok` means it was handed to the
/// OS, not that it was displayed (the user may have muted the app).
///
/// # Errors
///
/// A message when the notification cannot be built, e.g. the executable
/// path cannot be read to derive the Windows app id.
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
        .map_err(|error| error.to_string())
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
        .map_err(|error| error.to_string())?
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
    use super::*;

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
