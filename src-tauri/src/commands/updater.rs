//! Auto-updater Tauri IPC command.
//!
//! NATIVE_ONLY (see `swarm_core::commands::NATIVE_ONLY`): needs
//! `tauri-plugin-updater`, which has no meaning over a network RPC
//! call, so this has no registry entry.
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

/// Contract tests for `tauri.conf.json`, the file the updater plugin and
/// the bundler both read at build time.
#[cfg(test)]
mod tests {
    const TAURI_CONF: &str = include_str!("../../tauri.conf.json");

    /// `plugins.updater` must deserialize into the plugin's own config
    /// type with signed-version enforcement on: `download()` then also
    /// rejects a signature whose minisign trusted comment carries no
    /// `version:` at all (`MissingSignedVersion`). A comment naming a
    /// different version than `latest.json` announces is rejected by the
    /// plugin regardless of this flag.
    #[test]
    fn updater_config_requires_signed_versions() {
        let conf: serde_json::Value = serde_json::from_str(TAURI_CONF).unwrap();
        let updater: tauri_plugin_updater::Config =
            serde_json::from_value(conf["plugins"]["updater"].clone()).unwrap();
        assert!(updater.require_signed_version);
        assert!(!updater.allow_downgrades);
        assert_eq!(updater.endpoints.len(), 1);
    }

    /// `version` is the path `../package.json`, so the bundle and updater
    /// version come from package.json. tauri-build and tauri-codegen
    /// resolve that path against src-tauri/; cargo runs this test from the
    /// same directory, so the parse below resolves it exactly as the build
    /// does. The Cargo workspace version is the one site that cannot be
    /// derived, so it is held in lockstep here.
    #[test]
    fn app_version_resolves_from_package_json() {
        let conf: tauri::utils::config::Config = serde_json::from_str(TAURI_CONF).unwrap();
        let package_json: serde_json::Value =
            serde_json::from_str(include_str!("../../../package.json")).unwrap();
        let resolved = conf.version.as_deref();
        assert_eq!(resolved, package_json["version"].as_str());
        assert_eq!(resolved, Some(env!("CARGO_PKG_VERSION")));
    }
}
