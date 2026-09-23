//! Tauri-free session persistence: atomic JSON, shared by both shells.
//!
//! Headless-daemon plan Phase 2 item 11: sessions move off
//! `tauri-plugin-store` onto `swarm_core`'s own atomic JSON persistence,
//! so `swarm-desktop` and `swarmd` share one on-disk session set instead
//! of the daemon needing its own separate store implementation.
//!
//! # Format compatibility (no explicit migration needed)
//!
//! `tauri-plugin-store` persists each store as a flat JSON object at
//! `<data_dir>/<store_file>`, where `store.set(key, value)` sets a
//! top-level key in that object. The pre-Phase-2 desktop shell used
//! `PluginSessionStore` with `STORE_FILE = "sessions.json"` and
//! `STORE_KEY = "sessions"` — i.e. exactly `{"sessions": [...]}` at
//! `<data_dir>/sessions.json`. This module targets the SAME filename and
//! the SAME top-level key with the same atomic-write discipline as
//! [`crate::config`], so an existing pre-Phase-2 `sessions.json` loads
//! here unmodified — no read-then-rewrite migration step is needed, the
//! wire format was always plain JSON underneath the plugin.

use std::path::PathBuf;

use parking_lot::Mutex;

use super::SessionStore;
use super::manager::{Session, SessionManager};
use crate::Paths;

const SESSIONS_FILE: &str = "sessions.json";
const SESSIONS_KEY: &str = "sessions";

/// Process-wide lock serializing read-modify-write cycles — mirrors
/// [`crate::config::CONFIG_LOCK`]'s discipline for a second file.
static SESSIONS_LOCK: Mutex<()> = Mutex::new(());

fn sessions_path(paths: &Paths) -> PathBuf {
    paths.data_dir.join(SESSIONS_FILE)
}

/// [`SessionStore`] backed by [`Paths::data_dir`]`/sessions.json`,
/// atomic-write-then-rename on save. Used by both shells' `Runtime`
/// construction — no shell-specific persistence backend remains.
pub struct JsonSessionStore<'a>(pub &'a Paths);

impl SessionStore for JsonSessionStore<'_> {
    fn load(&self) -> anyhow::Result<Option<Vec<Session>>> {
        let _guard = SESSIONS_LOCK.lock();
        let path = sessions_path(self.0);
        let contents = match std::fs::read_to_string(&path) {
            Ok(c) => c,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(e.into()),
        };
        let map: serde_json::Map<String, serde_json::Value> =
            serde_json::from_str(&contents).unwrap_or_default();
        match map.get(SESSIONS_KEY) {
            Some(value) => Ok(Some(serde_json::from_value(value.clone())?)),
            None => Ok(None),
        }
    }

    fn save(&self, sessions: &[Session]) -> anyhow::Result<()> {
        let _guard = SESSIONS_LOCK.lock();
        let path = sessions_path(self.0);

        // Preserve any other top-level keys already in the file (none
        // exist in practice — the plugin-store era only ever wrote
        // `sessions` — but read-modify-write is the same safe discipline
        // `config.rs` uses, and costs nothing here).
        let mut map: serde_json::Map<String, serde_json::Value> = std::fs::read_to_string(&path)
            .ok()
            .and_then(|c| serde_json::from_str(&c).ok())
            .unwrap_or_default();
        map.insert(SESSIONS_KEY.to_string(), serde_json::to_value(sessions)?);

        let json = serde_json::to_string_pretty(&map)?;
        let tmp_path = PathBuf::from(format!("{}.tmp", path.display()));
        std::fs::write(&tmp_path, json)?;
        std::fs::rename(&tmp_path, &path)?;
        Ok(())
    }
}

/// Loads persisted sessions into `manager`. A no-op (logged) when the
/// file doesn't exist yet — a fresh install/data dir.
pub fn load(paths: &Paths, manager: &SessionManager) -> anyhow::Result<()> {
    match JsonSessionStore(paths).load()? {
        Some(sessions) => manager.restore_sessions(sessions),
        None => tracing::debug!("no sessions.json found, starting fresh"),
    }
    Ok(())
}

/// Saves `manager`'s full session list to disk.
pub fn save(paths: &Paths, manager: &SessionManager) -> anyhow::Result<()> {
    let sessions = manager.list_sessions();
    JsonSessionStore(paths).save(&sessions)?;
    tracing::debug!(count = sessions.len(), "sessions saved");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use uuid::Uuid;

    fn temp_paths() -> (Paths, TempDir) {
        let dir = std::env::temp_dir().join(format!("swarm-sessions-test-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let cleanup = TempDir(dir.clone());
        (Paths { data_dir: dir }, cleanup)
    }

    struct TempDir(PathBuf);
    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn test_load_missing_file_returns_none() {
        let (paths, _cleanup) = temp_paths();
        assert!(JsonSessionStore(&paths).load().unwrap().is_none());
    }

    #[test]
    fn test_save_then_load_roundtrip() {
        let (paths, _cleanup) = temp_paths();
        let manager = SessionManager::new();
        let s = manager.create_session("Research".to_string(), serde_json::json!({"a": 1}));

        save(&paths, &manager).unwrap();

        let manager2 = SessionManager::new();
        load(&paths, &manager2).unwrap();
        let loaded = manager2.get_session(&s.id).unwrap();
        assert_eq!(loaded.name, "Research");
        assert_eq!(loaded.config, serde_json::json!({"a": 1}));
    }

    /// DIRECTIVE: a plugin-store-era `sessions.json` (plain
    /// `{"sessions": [...]}`, camelCase fields — exactly what
    /// `tauri-plugin-store`'s `store.save()` wrote) must load here with
    /// zero migration code, proving format compatibility.
    #[test]
    fn test_loads_a_plugin_store_era_file_unmodified() {
        let (paths, _cleanup) = temp_paths();
        let id = Uuid::new_v4();
        let legacy_json = serde_json::json!({
            "sessions": [
                {
                    "id": id,
                    "name": "Legacy Session",
                    "workerIds": [],
                    "createdAt": 1_700_000_000,
                    "config": {}
                }
            ]
        });
        std::fs::write(
            paths.data_dir.join("sessions.json"),
            serde_json::to_string_pretty(&legacy_json).unwrap(),
        )
        .unwrap();

        let manager = SessionManager::new();
        load(&paths, &manager).unwrap();
        let loaded = manager.get_session(&id).unwrap();
        assert_eq!(loaded.name, "Legacy Session");
    }

    #[test]
    fn test_save_is_atomic_no_tmp_file_left_behind() {
        let (paths, _cleanup) = temp_paths();
        let manager = SessionManager::new();
        manager.create_session("A".to_string(), serde_json::json!({}));
        save(&paths, &manager).unwrap();
        assert!(!paths.data_dir.join("sessions.json.tmp").exists());
    }
}
