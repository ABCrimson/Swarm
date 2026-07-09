//! Auto-updater Tauri IPC command.
//!
//! Provides a `check_for_updates` command that uses `tauri-plugin-updater`
//! to check for available application updates and return their details
//! to the frontend.

use tauri::AppHandle;
use tauri_plugin_updater::UpdaterExt;

/// Checks for available application updates.
///
/// Uses `tauri-plugin-updater` to query the configured update endpoint
/// and returns information about any available update. If no update is
/// available, returns a JSON object with `available: false`.
///
/// # Arguments
///
/// * `app` - Tauri app handle (injected by Tauri)
///
/// # Returns
///
/// A `serde_json::Value` with update information:
/// - `available` (bool) - Whether an update is available
/// - `version` (string) - Version of the available update (if any)
/// - `body` (string) - Release notes (if any)
/// - `date` (string) - Release date (if any)
///
/// # Errors
///
/// Returns a `String` error if the update check fails (e.g., network error).
#[tauri::command]
#[tracing::instrument(skip(app))]
pub async fn check_for_updates(app: AppHandle) -> Result<serde_json::Value, String> {
    tracing::info!("check_for_updates called");

    let updater = app.updater().map_err(|e| {
        tracing::error!(error = %e, "failed to get updater");
        e.to_string()
    })?;

    match updater.check().await {
        Ok(Some(update)) => {
            tracing::info!(version = %update.version, "update available");
            Ok(serde_json::json!({
                "available": true,
                "version": update.version,
                "body": update.body,
                "date": update.date.map(|d| d.to_string()),
            }))
        }
        Ok(None) => {
            tracing::info!("no update available");
            Ok(serde_json::json!({
                "available": false,
            }))
        }
        Err(e) => {
            tracing::error!(error = %e, "update check failed");
            Err(e.to_string())
        }
    }
}
