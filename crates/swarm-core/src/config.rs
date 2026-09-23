//! App configuration: atomic key-value JSON persistence.
//!
//! Persists arbitrary key-value configuration (currently just the
//! Anthropic API key, under the `anthropic_api_key` key) to a flat
//! JSON file — `swarm-config.json` — inside the shell-provided
//! [`Paths::data_dir`].
//!
//! # Security
//!
//! Config values may be secrets (e.g. an API key). No function here
//! ever formats a value into a log line, error message, or trace
//! field. Callers should mirror this discipline in their own tracing.
//!
//! # Format compatibility
//!
//! An earlier era of the app already created an empty `{}`
//! `swarm-config.json` in some installs. `load_config_map` treats
//! a missing file, an empty object, and malformed JSON identically —
//! all fall back to an empty map — so those pre-existing files are
//! transparently reused rather than rejected.
//!
//! # Concurrency
//!
//! Reads and writes are serialized through a process-wide
//! [`parking_lot::Mutex`] so two concurrent writes (or a write racing
//! a read) can't interleave their read-modify-write cycles. Writes
//! themselves are additionally crash-safe: the new content is written
//! to a sibling `.tmp` file and then atomically renamed over the
//! destination, so a crash or power loss mid-write can never leave a
//! truncated/corrupt config file on disk.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use parking_lot::Mutex;
use serde_json::Value;

use crate::Paths;
use crate::error::AppError;

/// Config file name within the app data directory.
const CONFIG_FILE: &str = "swarm-config.json";

/// Process-wide lock serializing config file read-modify-write cycles.
static CONFIG_LOCK: Mutex<()> = Mutex::new(());

/// Resolves the absolute path to `swarm-config.json` under `paths`.
fn config_path(paths: &Paths) -> PathBuf {
    paths.data_dir.join(CONFIG_FILE)
}

/// Loads the full config map from `path`.
///
/// Tolerant by design: a missing file, an empty/`{}` file, and
/// malformed JSON all resolve to an empty map rather than an error.
/// Config corruption should degrade to "not configured" rather than
/// hard-fail an unrelated command.
fn load_config_map(path: &Path) -> HashMap<String, Value> {
    match std::fs::read_to_string(path) {
        Ok(contents) => serde_json::from_str(&contents).unwrap_or_default(),
        Err(_) => HashMap::new(),
    }
}

/// Writes `map` to `path` atomically.
///
/// Serializes to pretty JSON, writes it to a sibling `<file>.tmp`
/// path, then renames it over `path`. The rename is atomic on both
/// Windows and POSIX filesystems, so readers never observe a
/// partially-written file.
fn save_config_map(path: &Path, map: &HashMap<String, Value>) -> Result<(), AppError> {
    let json = serde_json::to_string_pretty(map)?;
    let tmp_path = PathBuf::from(format!("{}.tmp", path.display()));
    std::fs::write(&tmp_path, json)?;
    std::fs::rename(&tmp_path, path)?;
    Ok(())
}

/// Reads a single config value by key.
///
/// Returns `None` if the key is absent, the config file doesn't exist
/// yet, or the file is malformed (see `load_config_map`).
pub fn read_value(paths: &Paths, key: &str) -> Option<Value> {
    let _guard = CONFIG_LOCK.lock();
    load_config_map(&config_path(paths)).remove(key)
}

/// Writes a single config value by key.
///
/// Merges `value` into the existing config map (other keys are
/// preserved) and persists atomically.
///
/// # Errors
///
/// Returns [`AppError`] if the write-temp-then-rename sequence fails
/// (disk full, permission denied, etc).
pub fn write_value(paths: &Paths, key: &str, value: Value) -> Result<(), AppError> {
    let _guard = CONFIG_LOCK.lock();
    let path = config_path(paths);
    let mut map = load_config_map(&path);
    map.insert(key.to_string(), value);
    save_config_map(&path, &map)
}

#[cfg(test)]
mod tests {
    use std::mem::DropGuard;

    use super::*;
    use uuid::Uuid;

    /// Returns a fresh, unique path under the OS temp dir for one test.
    /// Not created on disk — callers write it (or not) as needed.
    fn temp_config_path() -> PathBuf {
        std::env::temp_dir().join(format!("swarm-config-test-{}.json", Uuid::new_v4()))
    }

    /// RAII cleanup so a failing assertion still removes the temp file
    /// and its atomic-write `.tmp` sibling.
    fn remove_on_drop(path: PathBuf) -> DropGuard<PathBuf, impl FnOnce(PathBuf)> {
        DropGuard::new(path, |path| {
            let _ = std::fs::remove_file(&path);
            let _ = std::fs::remove_file(format!("{}.tmp", path.display()));
        })
    }

    #[test]
    fn test_missing_file_defaults_to_empty_map() {
        let path = temp_config_path();
        let _cleanup = remove_on_drop(path.clone());

        let map = load_config_map(&path);
        assert!(map.is_empty(), "expected empty map for a nonexistent file");
    }

    #[test]
    fn test_preexisting_empty_object_file_is_tolerated() {
        // Matches the real earlier-era swarm-config.json content: `{}`.
        let path = temp_config_path();
        let _cleanup = remove_on_drop(path.clone());
        std::fs::write(&path, "{}").unwrap();

        let map = load_config_map(&path);
        assert!(map.is_empty(), "expected empty map for a `{{}}` file");
    }

    #[test]
    fn test_malformed_file_is_tolerated() {
        let path = temp_config_path();
        let _cleanup = remove_on_drop(path.clone());
        std::fs::write(&path, "{not valid json at all").unwrap();

        let map = load_config_map(&path);
        assert!(map.is_empty(), "expected empty map for malformed JSON");
    }

    #[test]
    fn test_write_then_read_roundtrip() {
        let path = temp_config_path();
        let _cleanup = remove_on_drop(path.clone());

        let mut map = HashMap::new();
        map.insert(
            "anthropic_api_key".to_string(),
            Value::String("sk-ant-test-roundtrip".to_string()),
        );
        save_config_map(&path, &map).expect("save should succeed");

        let loaded = load_config_map(&path);
        assert_eq!(
            loaded.get("anthropic_api_key"),
            Some(&Value::String("sk-ant-test-roundtrip".to_string()))
        );
    }

    #[test]
    fn test_write_preserves_other_keys() {
        let path = temp_config_path();
        let _cleanup = remove_on_drop(path.clone());

        let mut map = HashMap::new();
        map.insert("other_setting".to_string(), Value::Bool(true));
        save_config_map(&path, &map).expect("save should succeed");

        // Simulate a second, independent write_config call for a
        // different key — it must not clobber `other_setting`.
        let mut map = load_config_map(&path);
        map.insert(
            "anthropic_api_key".to_string(),
            Value::String("sk-ant-other".to_string()),
        );
        save_config_map(&path, &map).expect("save should succeed");

        let loaded = load_config_map(&path);
        assert_eq!(loaded.get("other_setting"), Some(&Value::Bool(true)));
        assert_eq!(
            loaded.get("anthropic_api_key"),
            Some(&Value::String("sk-ant-other".to_string()))
        );
    }

    #[test]
    fn test_save_leaves_no_tmp_file_behind_on_success() {
        let path = temp_config_path();
        let _cleanup = remove_on_drop(path.clone());

        let map = HashMap::new();
        save_config_map(&path, &map).expect("save should succeed");

        let tmp_path = format!("{}.tmp", path.display());
        assert!(
            !Path::new(&tmp_path).exists(),
            "temp file should be renamed away, not left behind"
        );
    }

    #[test]
    fn test_load_missing_key_returns_none() {
        let path = temp_config_path();
        let _cleanup = remove_on_drop(path.clone());

        let mut map = HashMap::new();
        map.insert("unrelated".to_string(), Value::Bool(false));
        save_config_map(&path, &map).expect("save should succeed");

        let loaded = load_config_map(&path);
        assert!(!loaded.contains_key("anthropic_api_key"));
    }
}
