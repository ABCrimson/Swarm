//! Session persistent storage.
//!
//! Serializes session state to disk via `tauri-plugin-store`
//! for crash recovery and workspace restoration. Sessions are
//! stored as a JSON array in a `sessions.json` store file
//! managed by Tauri's app data directory.

use anyhow::Context;
use tauri::AppHandle;
use tauri_plugin_store::StoreExt;

use super::manager::{Session, SessionManager};

/// Store file name for session persistence.
const STORE_FILE: &str = "sessions.json";
/// Key within the store file where the session array is stored.
const STORE_KEY: &str = "sessions";

/// Saves all sessions to the persistent store.
///
/// Serializes the full session list to JSON and writes it to
/// the `sessions.json` store file. This is called automatically
/// after session creation and deletion.
///
/// # Arguments
///
/// * `app` - Tauri app handle for accessing the store
/// * `manager` - The session manager containing sessions to save
///
/// # Errors
///
/// Returns `anyhow::Error` if:
/// - The store file cannot be opened
/// - Session serialization fails
/// - The store file cannot be flushed to disk
#[tracing::instrument(skip(app, manager))]
pub fn save_sessions(app: &AppHandle, manager: &SessionManager) -> anyhow::Result<()> {
    let sessions = manager.list_sessions();
    let store = app
        .store(STORE_FILE)
        .context("failed to open session store")?;
    store.set(
        STORE_KEY,
        serde_json::to_value(&sessions).context("failed to serialize sessions")?,
    );
    store.save().context("failed to save session store")?;
    tracing::debug!(count = sessions.len(), "sessions saved to store");
    Ok(())
}

/// Loads sessions from the persistent store into the manager.
///
/// Reads the `sessions.json` store file and deserializes the
/// session array. If the store file does not exist or contains
/// no sessions key, this is a no-op (fresh start).
///
/// Called once during application setup in [`crate::run`].
///
/// # Arguments
///
/// * `app` - Tauri app handle for accessing the store
/// * `manager` - The session manager to restore sessions into
///
/// # Errors
///
/// Returns `anyhow::Error` if:
/// - The store file cannot be opened
/// - Session deserialization fails (corrupted data)
#[tracing::instrument(skip(app, manager))]
pub fn load_sessions(app: &AppHandle, manager: &SessionManager) -> anyhow::Result<()> {
    let store = app
        .store(STORE_FILE)
        .context("failed to open session store")?;

    if let Some(value) = store.get(STORE_KEY) {
        let sessions: Vec<Session> =
            serde_json::from_value(value.clone()).context("failed to deserialize sessions")?;
        tracing::info!(count = sessions.len(), "loaded sessions from store");
        manager.restore_sessions(sessions);
    } else {
        tracing::debug!("no sessions found in store, starting fresh");
    }

    Ok(())
}
