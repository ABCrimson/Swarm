//! App configuration Tauri IPC commands.
//!
//! Thin `#[tauri::command]` wrappers around `swarm_core::config`'s
//! atomic key-value JSON persistence (currently just the Anthropic API
//! key, under the `anthropic_api_key` key), resolving the on-disk
//! location via [`crate::resolve_paths`].
//!
//! # Security
//!
//! Config values may be secrets (e.g. an API key). Neither command
//! logs a value: `write_config`'s `#[tracing::instrument]` explicitly
//! skips its `value` argument, and no code path here ever formats a
//! value into a log line, error message, or trace field. Only key
//! *names* and structural outcomes (found/not-found, ok/err) are
//! traced.

use serde_json::Value;
use tauri::AppHandle;

use swarm_core::config;

/// Synchronously reads a single config value by key.
///
/// For startup paths (e.g. applying the persisted worker-registry cap
/// in `lib.rs`'s setup hook) that run before the async runtime is the
/// natural home for work. Missing file/key or malformed JSON all yield
/// `None`, mirroring [`read_config`]'s tolerance.
pub(crate) fn read_config_value_sync(app: &AppHandle, key: &str) -> Option<Value> {
    let paths = crate::resolve_paths(app).ok()?;
    config::read_value(&paths, key)
}

/// Reads a single config value by key.
///
/// # Arguments
///
/// * `app` - Tauri app handle (injected by Tauri)
/// * `key` - The config key to look up (e.g. `"anthropic_api_key"`)
///
/// # Returns
///
/// The stored value, or `null` if the key is absent, the config
/// file doesn't exist yet, or the file is malformed.
///
/// # Errors
///
/// Returns a `String` error only if the app data directory itself
/// cannot be resolved/created — never for a missing or malformed
/// config file.
#[tauri::command]
#[tracing::instrument(skip(app))]
pub async fn read_config(app: AppHandle, key: String) -> Result<Option<Value>, String> {
    let paths = crate::resolve_paths(&app).map_err(|e| {
        tracing::error!(error = %e, "failed to resolve config path");
        e.to_string()
    })?;

    let lookup_key = key.clone();
    let value = tokio::task::spawn_blocking(move || config::read_value(&paths, &lookup_key))
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "read_config task panicked");
            e.to_string()
        })?;

    tracing::debug!(key = %key, found = value.is_some(), "read_config called");
    Ok(value)
}

/// Writes a single config value by key.
///
/// Merges `value` into the existing config map (other keys are
/// preserved) and persists atomically. The value itself is never
/// logged — see the module-level security note.
///
/// # Arguments
///
/// * `app` - Tauri app handle (injected by Tauri)
/// * `key` - The config key to set (e.g. `"anthropic_api_key"`)
/// * `value` - The value to store (arbitrary JSON)
///
/// # Errors
///
/// Returns a `String` error if the app data directory cannot be
/// resolved/created, or if the write-temp-then-rename sequence fails
/// (disk full, permission denied, etc).
#[tauri::command]
#[tracing::instrument(skip(app, value))]
pub async fn write_config(app: AppHandle, key: String, value: Value) -> Result<(), String> {
    let paths = crate::resolve_paths(&app).map_err(|e| {
        tracing::error!(error = %e, "failed to resolve config path");
        e.to_string()
    })?;

    let store_key = key.clone();
    tokio::task::spawn_blocking(move || config::write_value(&paths, &store_key, value))
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "write_config task panicked");
            e.to_string()
        })?
        .map_err(|e| {
            tracing::error!(error = %e, "failed to persist config");
            e.to_string()
        })?;

    tracing::debug!(key = %key, "write_config called");
    Ok(())
}
