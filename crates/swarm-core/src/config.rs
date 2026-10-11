//! `swarm-config.json`: the app's flat key-value settings file.
//!
//! One JSON object in [`Paths::data_dir`], keyed by setting name. It
//! holds `anthropic_api_key`, `max_workers`, `agent_concurrency`,
//! `default_repo_root`, `shipCoAuthoredBy`, and the frontend's
//! namespaced `<store>:<key>` entries. Keys are written in sorted order,
//! so the file diffs cleanly between saves.
//!
//! # Security
//!
//! Values may be secrets (the Anthropic API key). Nothing here formats a
//! value into a log line or an error message, and callers must not
//! either. On Unix the file is owner-only (`0600`).
//!
//! # A damaged file is never overwritten blindly
//!
//! A missing file is an empty config. [`read_value`] is lenient: a file
//! that cannot be read or parsed reads as "not configured" (and is
//! logged). [`write_value`] rewrites the whole file, so it is strict: it
//! refuses when the file exists but cannot be read, and it moves a
//! malformed file aside (`swarm-config.json.corrupt-<unix ms>`) before
//! writing, so a hand-edit typo can never silently cost every other key.
//!
//! # Concurrency and durability
//!
//! A process-wide lock serializes every read-modify-write cycle, and each
//! write replaces the file atomically and durably (see
//! `state_file::write_atomic`).

use std::path::PathBuf;

use parking_lot::Mutex;
use serde_json::Value;

use crate::Paths;
use crate::error::AppError;
use crate::state_file::{self, StoredObject};

/// Config file name within the app data directory.
const CONFIG_FILE: &str = "swarm-config.json";

/// Serializes every read and read-modify-write of the file.
static CONFIG_LOCK: Mutex<()> = Mutex::new(());

fn config_path(paths: &Paths) -> PathBuf {
    paths.data_dir.join(CONFIG_FILE)
}

/// Reads one config value.
///
/// `None` when the key is absent, the file does not exist yet, or the
/// file cannot be read or parsed (logged, without its contents).
pub fn read_value(paths: &Paths, key: &str) -> Option<Value> {
    let _guard = CONFIG_LOCK.lock();
    match state_file::read_object(&config_path(paths)) {
        Ok(StoredObject::Object(mut map)) => map.remove(key),
        Ok(StoredObject::Missing) => None,
        Ok(StoredObject::Malformed) => {
            tracing::warn!("swarm-config.json is malformed; reading it as not configured");
            None
        }
        Err(e) => {
            tracing::warn!(error = %e, "swarm-config.json is unreadable; reading it as not configured");
            None
        }
    }
}

/// Sets one config value, keeping every other key, and persists the
/// file atomically.
///
/// # Errors
///
/// [`AppError::Config`] when the existing file cannot be read (it is
/// left untouched), a malformed file cannot be moved aside, or the new
/// file cannot be written.
pub fn write_value(paths: &Paths, key: &str, value: Value) -> Result<(), AppError> {
    let _guard = CONFIG_LOCK.lock();
    let path = config_path(paths);
    let config_error = |action: &str, e: std::io::Error| {
        AppError::Config(format!("Failed To {action} {}: {e}", path.display()))
    };

    let mut map = match state_file::read_object(&path) {
        Ok(StoredObject::Object(map)) => map,
        Ok(StoredObject::Missing) => serde_json::Map::new(),
        Ok(StoredObject::Malformed) => {
            let aside = state_file::quarantine(&path)
                .map_err(|e| config_error("Move Aside The Malformed", e))?;
            tracing::warn!(
                moved_to = %aside.display(),
                "swarm-config.json was malformed; moved it aside and started a fresh config"
            );
            serde_json::Map::new()
        }
        Err(e) => return Err(config_error("Read (So Not Overwriting)", e)),
    };
    map.insert(key.to_owned(), value);
    let json = serde_json::to_vec_pretty(&map)?;
    state_file::write_atomic(&path, &json).map_err(|e| config_error("Write", e))
}

#[cfg(test)]
mod tests {
    use std::assert_matches;
    use std::fs;

    use serde_json::json;

    use super::*;
    use crate::state_file::tests::temp_dir;

    fn paths(dir: &std::path::Path) -> Paths {
        Paths {
            data_dir: dir.to_path_buf(),
        }
    }

    #[test]
    fn test_missing_file_reads_as_not_configured() {
        let (dir, _cleanup) = temp_dir("config");
        assert_eq!(read_value(&paths(&dir), "anthropic_api_key"), None);
    }

    /// An existing `{}` file is an empty config: reads give `None` and a write keeps working.
    #[test]
    fn test_an_empty_object_file_is_reused() {
        let (dir, _cleanup) = temp_dir("config");
        let paths = paths(&dir);
        fs::write(config_path(&paths), "{}").unwrap();
        assert_eq!(read_value(&paths, "max_workers"), None);
        write_value(&paths, "max_workers", json!(8)).unwrap();
        assert_eq!(read_value(&paths, "max_workers"), Some(json!(8)));
    }

    #[test]
    fn test_write_then_read_roundtrip_keeps_other_keys() {
        let (dir, _cleanup) = temp_dir("config");
        let paths = paths(&dir);
        write_value(&paths, "other_setting", json!(true)).unwrap();
        write_value(&paths, "anthropic_api_key", json!("sk-ant-test")).unwrap();

        assert_eq!(read_value(&paths, "other_setting"), Some(json!(true)));
        assert_eq!(
            read_value(&paths, "anthropic_api_key"),
            Some(json!("sk-ant-test"))
        );
        assert_eq!(read_value(&paths, "absent"), None);
        assert!(!config_path(&paths).with_added_extension("tmp").exists());
    }

    #[test]
    fn test_keys_are_written_in_sorted_order() {
        let (dir, _cleanup) = temp_dir("config");
        let paths = paths(&dir);
        for key in ["zeta", "alpha", "mid"] {
            write_value(&paths, key, json!(1)).unwrap();
        }
        let text = fs::read_to_string(config_path(&paths)).unwrap();
        let positions: Vec<usize> = ["alpha", "mid", "zeta"]
            .iter()
            .map(|key| text.find(key).unwrap())
            .collect();
        assert!(positions.is_sorted(), "{text}");
    }

    /// A malformed file reads as not configured, and a write moves it
    /// aside intact (`swarm-config.json.corrupt-<unix ms>`) before
    /// writing, so its keys are never silently dropped.
    #[test]
    fn test_writing_over_a_malformed_file_quarantines_it_instead_of_dropping_keys() {
        let (dir, _cleanup) = temp_dir("config");
        let paths = paths(&dir);
        let damaged = r#"{"anthropic_api_key": "sk-ant-keep-me", "max_workers": 8,}"#;
        fs::write(config_path(&paths), damaged).unwrap();

        assert_eq!(read_value(&paths, "max_workers"), None);
        write_value(&paths, "theme", json!("dark")).unwrap();

        assert_eq!(read_value(&paths, "theme"), Some(json!("dark")));
        let quarantined: Vec<_> = fs::read_dir(&dir)
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .filter(|p| {
                p.file_name()
                    .unwrap()
                    .to_string_lossy()
                    .starts_with("swarm-config.json.corrupt-")
            })
            .collect();
        assert_eq!(quarantined.len(), 1);
        assert_eq!(fs::read_to_string(&quarantined[0]).unwrap(), damaged);
    }

    /// A non-object top level (e.g. `[]`) is malformed too, never
    /// "empty".
    #[test]
    fn test_a_non_object_file_is_malformed() {
        let (dir, _cleanup) = temp_dir("config");
        let paths = paths(&dir);
        fs::write(config_path(&paths), "[1, 2]").unwrap();
        write_value(&paths, "k", json!(1)).unwrap();
        assert_eq!(read_value(&paths, "k"), Some(json!(1)));
        assert_eq!(
            fs::read_dir(&dir).unwrap().count(),
            2,
            "config + quarantine"
        );
    }

    /// A file that exists but cannot be read is never overwritten.
    #[test]
    fn test_an_unreadable_file_is_left_untouched() {
        let (dir, _cleanup) = temp_dir("config");
        let paths = paths(&dir);
        fs::create_dir(config_path(&paths)).unwrap();

        assert_eq!(read_value(&paths, "k"), None);
        assert_matches!(
            write_value(&paths, "k", json!(1)),
            Err(AppError::Config(msg)) if msg.contains("Not Overwriting")
        );
        assert!(config_path(&paths).is_dir());
    }
}
