//! `sessions.json`: the persisted session set, shared by both shells.
//!
//! The file is a JSON object whose `sessions` key holds an array of
//! [`Session`]s — the exact layout `tauri-plugin-store` wrote before the
//! core took persistence over, so files from those builds load
//! unchanged. Any other top-level key is preserved across saves.
//!
//! # Damage handling
//!
//! A file that is not a JSON object (or whose `sessions` is not an
//! array) is never treated as "no sessions" and overwritten: it is moved
//! aside to `sessions.json.corrupt-<unix ms>` and the app starts with no
//! sessions. A single entry that does not parse is skipped (and logged),
//! keeping every other session. A file that exists but cannot be read is
//! left untouched — loading fails and saving refuses — until it can be.
//!
//! # Concurrency and durability
//!
//! One process-wide lock covers every read and write, and [`save`] takes
//! its snapshot of the manager INSIDE it, so two overlapping saves can
//! never land out of order (an older snapshot overwriting a newer one).
//! Each write replaces the file atomically and durably (see
//! [`crate::state_file::write_atomic`]).

use std::path::{Path, PathBuf};

use parking_lot::Mutex;
use serde_json::{Map, Value};

use super::manager::{Session, SessionManager};
use crate::Paths;
use crate::error::AppError;
use crate::state_file::{self, StoredObject};

const SESSIONS_FILE: &str = "sessions.json";
const SESSIONS_KEY: &str = "sessions";

/// Serializes every read and write of the file, and — in [`save`] — the
/// snapshot each write is taken from.
static SESSIONS_LOCK: Mutex<()> = Mutex::new(());

fn sessions_path(paths: &Paths) -> PathBuf {
    paths.data_dir.join(SESSIONS_FILE)
}

/// The file's top-level object, with a malformed file moved aside (and
/// read as empty). `None` when there is no file yet.
fn read_root(path: &Path) -> Result<Option<Map<String, Value>>, AppError> {
    let malformed = || -> Result<Option<Map<String, Value>>, AppError> {
        let aside = state_file::quarantine(path)?;
        tracing::warn!(
            moved_to = %aside.display(),
            "sessions.json was malformed; moved it aside and started with no sessions"
        );
        Ok(Some(Map::new()))
    };
    match state_file::read_object(path)? {
        StoredObject::Missing => Ok(None),
        StoredObject::Malformed => malformed(),
        StoredObject::Object(root) => match root.get(SESSIONS_KEY) {
            None | Some(Value::Array(_)) => Ok(Some(root)),
            Some(_) => malformed(),
        },
    }
}

/// Loads the persisted sessions into `manager`. A no-op when the file
/// does not exist yet (a fresh data directory).
///
/// # Errors
///
/// [`AppError::Io`] when the file exists but cannot be read, or a
/// malformed file cannot be moved aside.
pub fn load(paths: &Paths, manager: &SessionManager) -> Result<(), AppError> {
    let _guard = SESSIONS_LOCK.lock();
    let Some(mut root) = read_root(&sessions_path(paths))? else {
        tracing::debug!("no sessions.json yet; starting with no sessions");
        return Ok(());
    };
    let Some(Value::Array(entries)) = root.remove(SESSIONS_KEY) else {
        return Ok(());
    };
    let sessions = entries
        .into_iter()
        .filter_map(|entry| {
            serde_json::from_value::<Session>(entry)
                .inspect_err(|e| {
                    tracing::warn!(error = %e, "skipping a sessions.json entry that does not parse");
                })
                .ok()
        })
        .collect();
    manager.restore_sessions(sessions);
    Ok(())
}

/// Writes `manager`'s current sessions to disk, snapshotting them under
/// the file lock (see the module doc).
///
/// # Errors
///
/// [`AppError::Io`] when the existing file cannot be read (it is left
/// untouched) or the new one cannot be written.
pub fn save(paths: &Paths, manager: &SessionManager) -> Result<(), AppError> {
    let _guard = SESSIONS_LOCK.lock();
    let path = sessions_path(paths);
    let mut root = read_root(&path)?.unwrap_or_default();
    let sessions = manager.list_sessions();
    root.insert(SESSIONS_KEY.to_owned(), serde_json::to_value(&sessions)?);
    state_file::write_atomic(&path, &serde_json::to_vec_pretty(&root)?)?;
    tracing::debug!(count = sessions.len(), "sessions saved");
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::fs;

    use serde_json::json;
    use uuid::Uuid;

    use super::*;
    use crate::state_file::tests::temp_dir;

    fn paths(dir: &Path) -> Paths {
        Paths {
            data_dir: dir.to_path_buf(),
        }
    }

    fn corrupt_files(dir: &Path) -> Vec<PathBuf> {
        fs::read_dir(dir)
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .filter(|p| {
                p.file_name()
                    .unwrap()
                    .to_string_lossy()
                    .starts_with("sessions.json.corrupt-")
            })
            .collect()
    }

    #[test]
    fn test_load_without_a_file_is_a_no_op() {
        let (dir, _cleanup) = temp_dir("sessions");
        let manager = SessionManager::new();
        load(&paths(&dir), &manager).unwrap();
        assert!(manager.list_sessions().is_empty());
    }

    #[test]
    fn test_save_then_load_roundtrip() {
        let (dir, _cleanup) = temp_dir("sessions");
        let paths = paths(&dir);
        let manager = SessionManager::new();
        let s = manager.create_session("Research".to_string(), json!({"a": 1}));
        save(&paths, &manager).unwrap();
        assert!(!sessions_path(&paths).with_added_extension("tmp").exists());

        let restored = SessionManager::new();
        load(&paths, &restored).unwrap();
        let loaded = restored.get_session(&s.id).unwrap();
        assert_eq!(loaded.name, "Research");
        assert_eq!(loaded.config, json!({"a": 1}));
    }

    /// A file `tauri-plugin-store` wrote (plain `{"sessions": [...]}`,
    /// camelCase fields) loads with no migration step.
    #[test]
    fn test_loads_a_plugin_store_era_file_unmodified() {
        let (dir, _cleanup) = temp_dir("sessions");
        let paths = paths(&dir);
        let id = Uuid::new_v4();
        let legacy = json!({
            "sessions": [{
                "id": id,
                "name": "Legacy Session",
                "workerIds": [],
                "createdAt": 1_700_000_000,
                "config": {}
            }]
        });
        fs::write(sessions_path(&paths), legacy.to_string()).unwrap();

        let manager = SessionManager::new();
        load(&paths, &manager).unwrap();
        assert_eq!(manager.get_session(&id).unwrap().name, "Legacy Session");
    }

    /// CONFIRMED regression: a malformed file used to load as "no
    /// sessions", and the next autosave overwrote it — losing every
    /// session. Now it is moved aside intact first.
    #[test]
    fn test_a_malformed_file_is_quarantined_not_overwritten() {
        let (dir, _cleanup) = temp_dir("sessions");
        let paths = paths(&dir);
        let damaged = r#"{"sessions": [{"id": "#;
        fs::write(sessions_path(&paths), damaged).unwrap();

        let manager = SessionManager::new();
        load(&paths, &manager).unwrap();
        assert!(manager.list_sessions().is_empty());
        manager.create_session("After".to_string(), json!({}));
        save(&paths, &manager).unwrap();

        let quarantined = corrupt_files(&dir);
        assert_eq!(quarantined.len(), 1);
        assert_eq!(fs::read_to_string(&quarantined[0]).unwrap(), damaged);
    }

    /// `sessions` present but not an array is damage too, not "empty".
    #[test]
    fn test_a_non_array_sessions_key_is_quarantined() {
        let (dir, _cleanup) = temp_dir("sessions");
        let paths = paths(&dir);
        fs::write(sessions_path(&paths), r#"{"sessions": {"oops": true}}"#).unwrap();
        load(&paths, &SessionManager::new()).unwrap();
        assert_eq!(corrupt_files(&dir).len(), 1);
    }

    /// One bad entry costs only itself, never its siblings.
    #[test]
    fn test_one_unparseable_entry_is_skipped_and_the_rest_load() {
        let (dir, _cleanup) = temp_dir("sessions");
        let paths = paths(&dir);
        let good = Uuid::new_v4();
        let file = json!({
            "sessions": [
                {"id": "not-a-uuid", "name": "Bad", "workerIds": [], "createdAt": 0, "config": {}},
                {"id": good, "name": "Good", "workerIds": [], "createdAt": 0, "config": {}}
            ]
        });
        fs::write(sessions_path(&paths), file.to_string()).unwrap();

        let manager = SessionManager::new();
        load(&paths, &manager).unwrap();
        assert_eq!(manager.list_sessions().len(), 1);
        assert_eq!(manager.get_session(&good).unwrap().name, "Good");
    }

    #[test]
    fn test_save_preserves_other_top_level_keys() {
        let (dir, _cleanup) = temp_dir("sessions");
        let paths = paths(&dir);
        fs::write(
            sessions_path(&paths),
            r#"{"sessions": [], "other": {"kept": true}}"#,
        )
        .unwrap();
        save(&paths, &SessionManager::new()).unwrap();
        let root: Value =
            serde_json::from_str(&fs::read_to_string(sessions_path(&paths)).unwrap()).unwrap();
        assert_eq!(root["other"]["kept"], true);
    }

    /// CONFIRMED regression: the snapshot used to be taken outside the
    /// file lock, so a slower save could write an OLDER snapshot over a
    /// newer one. With the snapshot inside the lock, the file always
    /// ends at the state after the last mutation, however the
    /// concurrent saves interleave.
    #[test]
    fn test_concurrent_saves_always_leave_the_newest_state() {
        let (dir, _cleanup) = temp_dir("sessions");
        let paths = paths(&dir);
        let manager = SessionManager::new();

        std::thread::scope(|scope| {
            for i in 0..16 {
                manager.create_session(format!("S{i}"), json!({}));
                let (paths, manager) = (&paths, &manager);
                scope.spawn(move || save(paths, manager).unwrap());
            }
        });

        let restored = SessionManager::new();
        load(&paths, &restored).unwrap();
        assert_eq!(restored.list_sessions().len(), 16);
    }

    #[test]
    fn test_an_unreadable_file_fails_load_and_is_never_overwritten() {
        let (dir, _cleanup) = temp_dir("sessions");
        let paths = paths(&dir);
        fs::create_dir(sessions_path(&paths)).unwrap();

        assert!(load(&paths, &SessionManager::new()).is_err());
        assert!(save(&paths, &SessionManager::new()).is_err());
        assert!(sessions_path(&paths).is_dir());
    }
}
