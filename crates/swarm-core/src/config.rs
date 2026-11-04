//! `swarm-config.json`: the app's flat key-value settings file.
//!
//! One JSON object in [`Paths::data_dir`], keyed by setting name. It
//! holds `max_workers`, `agent_concurrency`, `default_repo_root`,
//! `shipCoAuthoredBy`, and the frontend's namespaced `<store>:<key>`
//! entries. Keys are written in sorted order, so the file diffs cleanly
//! between saves.
//!
//! # Secrets live in the secret store
//!
//! `anthropic_api_key` is read and written through these same
//! functions (so the `read_config`/`write_config` commands keep their
//! shape) but is kept in [`secrets`]: the OS keychain, or the
//! owner-only `swarm-secrets.json` on a host without one. Writing
//! `null` or `""` deletes it. A key that a build from before the
//! keychain left in this file is moved to the store, once, by
//! [`migrate_secrets`], which the key's first read or write and any
//! rewrite of the file run; a store that refuses it leaves the file as
//! it was, and the key keeps reading from the file until a later
//! access moves it. Store calls block, so call these functions from a
//! blocking thread.
//!
//! # Security
//!
//! Nothing here formats a value into a log line or an error message,
//! and callers must not either. On Unix the file is owner-only
//! (`0600`).
//!
//! # A damaged file is never overwritten blindly
//!
//! A missing file is an empty config. [`read_value`] is lenient: a file
//! that cannot be read or parsed reads as "not configured" (and is
//! logged). [`read_value_checked`] (`read_config`) reports an unreadable file as
//! an error. [`write_value`] rewrites the whole file, so it is strict: it
//! refuses when the file exists but cannot be read, and it moves a
//! malformed file aside (`swarm-config.json.corrupt-<unix ms>`) before
//! writing, so a hand-edit typo can never silently cost every other key.
//!
//! # Concurrency and durability
//!
//! A process-wide lock serializes every read-modify-write cycle, and each
//! write replaces the file atomically and durably (see
//! `state_file::write_atomic`).

#[path = "secrets/mod.rs"]
pub mod secrets;

use std::path::PathBuf;

use parking_lot::Mutex;
use serde_json::{Map, Value};

use self::secrets::{SecretStore, SecretString};
use crate::Paths;
use crate::error::AppError;
use crate::state_file::{self, StoredObject};

/// Config file name within the app data directory.
pub(crate) const CONFIG_FILE: &str = "swarm-config.json";

/// Serializes every read and read-modify-write of the file.
static CONFIG_LOCK: Mutex<()> = Mutex::new(());

/// Keys kept in the [`secrets`] store instead of the file.
const SECRET_KEYS: &[&str] = &["anthropic_api_key"];

fn config_path(paths: &Paths) -> PathBuf {
    paths.data_dir.join(CONFIG_FILE)
}

fn is_secret(key: &str) -> bool {
    SECRET_KEYS.contains(&key)
}

fn holds_secret(map: &Map<String, Value>) -> bool {
    SECRET_KEYS.iter().any(|key| map.contains_key(*key))
}

/// Moves every secret a pre-keychain build left in `swarm-config.json`
/// into the secret store and rewrites the file without it. A no-op when
/// the file holds none (or is missing, malformed or unreadable), so the
/// store is opened only when there is something to move.
///
/// The file's copy wins over one already in the store: only a build
/// from before the store writes the key to the file, so the file's
/// copy is the newer user write.
///
/// # Errors
///
/// [`AppError::Config`] when the file cannot be rewritten or the store
/// refuses a secret; the file is then left as it was.
pub fn migrate_secrets(paths: &Paths) -> Result<(), AppError> {
    let _guard = CONFIG_LOCK.lock();
    match state_file::read_object(&config_path(paths)) {
        Ok(StoredObject::Object(map)) if holds_secret(&map) => {
            secrets::with_store(paths, |store| migrate_locked(paths, store))
        }
        _ => Ok(()),
    }
}

/// [`migrate_secrets`] into `store`, with [`CONFIG_LOCK`] held.
fn migrate_locked(paths: &Paths, store: &dyn SecretStore) -> Result<(), AppError> {
    let path = config_path(paths);
    let Ok(StoredObject::Object(mut map)) = state_file::read_object(&path) else {
        return Ok(());
    };
    if !holds_secret(&map) {
        return Ok(());
    }
    take_secrets(&mut map, store)?;
    let json = serde_json::to_vec_pretty(&map)?;
    state_file::write_atomic(&path, &json)
        .map_err(|e| AppError::Config(format!("Failed To Write {}: {e}", path.display())))
}

/// Moves each secret key out of `map` into `store`. A non-empty string
/// is stored; anything else is no usable key and is dropped. On a store
/// error the keys not yet moved stay in `map`.
fn take_secrets(map: &mut Map<String, Value>, store: &dyn SecretStore) -> Result<(), AppError> {
    for &key in SECRET_KEYS {
        if let Some(Value::String(value)) = map.get(key)
            && !value.is_empty()
        {
            store.set(key, &SecretString::from(value.clone()))?;
        }
        map.remove(key);
    }
    Ok(())
}

/// Reads secret `key` from `store`, migrating the file first. While the
/// migration fails, the file's copy is still the key.
fn read_secret(
    paths: &Paths,
    store: &dyn SecretStore,
    key: &str,
) -> Result<Option<Value>, AppError> {
    {
        let _guard = CONFIG_LOCK.lock();
        if let Err(e) = migrate_locked(paths, store) {
            tracing::warn!(error = %e, "could not move the API key out of swarm-config.json yet");
            if let Ok(StoredObject::Object(mut map)) = state_file::read_object(&config_path(paths))
                && let Some(value) = map.remove(key)
            {
                return Ok(Some(value));
            }
        }
    }
    Ok(store
        .get(key)?
        .map(|secret| Value::String(secret.expose().to_owned())))
}

/// Writes secret `key` to `store` (`null` or `""` deletes it), after
/// migrating the file, so its old copy can never overwrite this write.
fn write_secret(
    paths: &Paths,
    store: &dyn SecretStore,
    key: &str,
    value: Value,
) -> Result<(), AppError> {
    let secret = match value {
        Value::Null => None,
        Value::String(value) if value.is_empty() => None,
        Value::String(value) => Some(SecretString::from(value)),
        _ => {
            return Err(AppError::Config(format!("{key} Must Be A String Or Null")));
        }
    };
    {
        let _guard = CONFIG_LOCK.lock();
        migrate_locked(paths, store)?;
    }
    match secret {
        Some(secret) => store.set(key, &secret),
        None => store.delete(key),
    }
}

/// Reads one config value.
///
/// `None` when the key is absent, the file does not exist yet, or the
/// file (for a secret, its store) cannot be read or parsed (logged,
/// without its contents).
pub fn read_value(paths: &Paths, key: &str) -> Option<Value> {
    if is_secret(key) {
        return secrets::with_store(paths, |store| read_secret(paths, store, key))
            .inspect_err(|e| {
                tracing::warn!(error = %e, "the API key is unreadable; reading it as not configured");
            })
            .ok()
            .flatten();
    }
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

/// Like [`read_value`], for the `read_config` command.
///
/// A malformed file reads as `None` (logged), exactly as in
/// [`read_value`]; an unreadable one is an error, so the caller does not
/// take a locked or permission-denied file for an unset key.
///
/// # Errors
///
/// [`AppError::Config`] when the file exists but cannot be read, or a
/// secret's store cannot be read.
pub fn read_value_checked(paths: &Paths, key: &str) -> Result<Option<Value>, AppError> {
    if is_secret(key) {
        return secrets::with_store(paths, |store| read_secret(paths, store, key));
    }
    let _guard = CONFIG_LOCK.lock();
    let path = config_path(paths);
    match state_file::read_object(&path) {
        Ok(StoredObject::Object(mut map)) => Ok(map.remove(key)),
        Ok(StoredObject::Missing) => Ok(None),
        Ok(StoredObject::Malformed) => {
            tracing::warn!("swarm-config.json is malformed; reading it as not configured");
            Ok(None)
        }
        Err(e) => Err(AppError::Config(format!(
            "Failed To Read {}: {e}",
            path.display()
        ))),
    }
}

/// Sets one config value, keeping every other key, and persists the
/// file atomically. A secret key goes to the secret store instead
/// (`null` or `""` deletes it), and every rewrite also moves a secret a
/// pre-keychain build left in the file (see [`migrate_secrets`]).
///
/// # Errors
///
/// [`AppError::Config`] when the existing file cannot be read (it is
/// left untouched), a malformed file cannot be moved aside, or the new
/// file cannot be written; for a secret key, when the value is neither
/// a string nor `null`, or the store refuses the write.
pub fn write_value(paths: &Paths, key: &str, value: Value) -> Result<(), AppError> {
    if is_secret(key) {
        return secrets::with_store(paths, |store| write_secret(paths, store, key, value));
    }
    let _guard = CONFIG_LOCK.lock();
    let path = config_path(paths);
    let config_error = |action: &str, e: std::io::Error| {
        AppError::Config(format!("Failed To {action} {}: {e}", path.display()))
    };

    let mut map = match state_file::read_object(&path) {
        Ok(StoredObject::Object(map)) => map,
        Ok(StoredObject::Missing) => Map::new(),
        Ok(StoredObject::Malformed) => {
            let aside = state_file::quarantine(&path)
                .map_err(|e| config_error("Move Aside The Malformed", e))?;
            tracing::warn!(
                moved_to = %aside.display(),
                "swarm-config.json was malformed; moved it aside and started a fresh config"
            );
            Map::new()
        }
        Err(e) => return Err(config_error("Read (So Not Overwriting)", e)),
    };
    // A store that refuses the secret keeps it in the file; this write
    // of another key still goes through.
    if holds_secret(&map)
        && let Err(e) = secrets::with_store(paths, |store| take_secrets(&mut map, store))
    {
        tracing::warn!(error = %e, "could not move the API key out of swarm-config.json yet");
    }
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
    use crate::test_support::temp_dir;

    const API_KEY: &str = "anthropic_api_key";

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

    fn config_text(paths: &Paths) -> String {
        fs::read_to_string(config_path(paths)).unwrap_or_default()
    }

    /// The API key round-trips through the config functions but never
    /// lands in `swarm-config.json`.
    #[test]
    fn test_the_api_key_is_kept_out_of_the_config_file() {
        let (dir, _cleanup) = temp_dir("config");
        let paths = paths(&dir);
        write_value(&paths, "max_workers", json!(4)).unwrap();
        write_value(&paths, API_KEY, json!("sk-ant-stored")).unwrap();

        assert_eq!(read_value(&paths, API_KEY), Some(json!("sk-ant-stored")));
        assert_eq!(
            read_value_checked(&paths, API_KEY).unwrap(),
            Some(json!("sk-ant-stored"))
        );
        assert!(!config_text(&paths).contains("sk-ant-stored"));
        assert!(!config_text(&paths).contains(API_KEY));
        assert_eq!(read_value(&paths, "max_workers"), Some(json!(4)));
    }

    /// Writing `null` or `""` deletes the stored key (the reverse of a
    /// write), and deleting an absent key succeeds.
    #[test]
    fn test_writing_null_or_empty_deletes_the_api_key() {
        let (dir, _cleanup) = temp_dir("config");
        let paths = paths(&dir);
        for clear in [json!(null), json!("")] {
            write_value(&paths, API_KEY, json!("sk-ant-gone")).unwrap();
            write_value(&paths, API_KEY, clear.clone()).unwrap();
            assert_eq!(read_value(&paths, API_KEY), None, "{clear}");
        }
        write_value(&paths, API_KEY, json!(null)).unwrap();
        assert_matches!(
            write_value(&paths, API_KEY, json!(42)),
            Err(AppError::Config(msg)) if msg.contains("Must Be A String")
        );
    }

    /// A key a pre-keychain build left in `swarm-config.json` moves to
    /// the secret store on first access; every other key stays.
    #[test]
    fn test_a_plaintext_key_migrates_out_of_the_file_on_first_read() {
        let (dir, _cleanup) = temp_dir("config");
        let paths = paths(&dir);
        fs::write(
            config_path(&paths),
            r#"{"anthropic_api_key": "sk-ant-legacy", "max_workers": 8}"#,
        )
        .unwrap();

        assert_eq!(read_value(&paths, API_KEY), Some(json!("sk-ant-legacy")));
        assert!(!config_text(&paths).contains("sk-ant-legacy"));
        assert_eq!(read_value(&paths, "max_workers"), Some(json!(8)));
        assert_eq!(read_value(&paths, API_KEY), Some(json!("sk-ant-legacy")));
    }

    /// Any whole-file rewrite also carries the legacy key out, so the
    /// plaintext does not wait for the key's first read.
    #[test]
    fn test_a_plaintext_key_migrates_on_any_write() {
        let (dir, _cleanup) = temp_dir("config");
        let paths = paths(&dir);
        fs::write(
            config_path(&paths),
            r#"{"anthropic_api_key": "sk-ant-legacy"}"#,
        )
        .unwrap();

        write_value(&paths, "theme", json!("dark")).unwrap();

        assert!(!config_text(&paths).contains("sk-ant-legacy"));
        assert_eq!(read_value(&paths, API_KEY), Some(json!("sk-ant-legacy")));
        assert_eq!(read_value(&paths, "theme"), Some(json!("dark")));
    }

    #[test]
    fn test_migrate_secrets_moves_the_key_once_and_is_then_a_no_op() {
        let (dir, _cleanup) = temp_dir("config");
        let paths = paths(&dir);
        migrate_secrets(&paths).unwrap();
        assert!(!config_path(&paths).exists(), "no file is created");

        fs::write(
            config_path(&paths),
            r#"{"anthropic_api_key": "sk-ant-legacy", "theme": "dark"}"#,
        )
        .unwrap();
        migrate_secrets(&paths).unwrap();
        let migrated = config_text(&paths);
        assert!(!migrated.contains(API_KEY), "{migrated}");
        migrate_secrets(&paths).unwrap();
        assert_eq!(config_text(&paths), migrated);
        assert_eq!(read_value(&paths, API_KEY), Some(json!("sk-ant-legacy")));
        assert_eq!(read_value(&paths, "theme"), Some(json!("dark")));
    }

    /// A store that refuses every write.
    struct Refusing;

    impl SecretStore for Refusing {
        fn get(&self, _name: &str) -> Result<Option<SecretString>, AppError> {
            Ok(None)
        }

        fn set(&self, _name: &str, _secret: &SecretString) -> Result<(), AppError> {
            Err(AppError::Config("Refused".to_owned()))
        }

        fn delete(&self, _name: &str) -> Result<(), AppError> {
            Err(AppError::Config("Refused".to_owned()))
        }
    }

    /// A refused migration is no one-way door: the file stays as it was,
    /// the key still reads from it, and a failed write changes nothing.
    #[test]
    fn test_a_refused_migration_leaves_the_file_and_the_key_usable() {
        let (dir, _cleanup) = temp_dir("config");
        let paths = paths(&dir);
        let legacy = r#"{"anthropic_api_key": "sk-ant-legacy", "theme": "dark"}"#;
        fs::write(config_path(&paths), legacy).unwrap();

        assert_eq!(
            read_secret(&paths, &Refusing, API_KEY).unwrap(),
            Some(json!("sk-ant-legacy"))
        );
        assert_eq!(config_text(&paths), legacy);
        assert_matches!(
            write_secret(&paths, &Refusing, API_KEY, json!("sk-ant-new")),
            Err(AppError::Config(msg)) if msg == "Refused"
        );
        assert_eq!(config_text(&paths), legacy);

        let StoredObject::Object(mut map) = state_file::read_object(&config_path(&paths)).unwrap()
        else {
            panic!("legacy file is an object");
        };
        assert!(take_secrets(&mut map, &Refusing).is_err());
        assert_eq!(map.get(API_KEY), Some(&json!("sk-ant-legacy")));
    }

    /// A file that exists but cannot be read is never overwritten.
    #[test]
    fn test_an_unreadable_file_is_left_untouched() {
        let (dir, _cleanup) = temp_dir("config");
        let paths = paths(&dir);
        fs::create_dir(config_path(&paths)).unwrap();

        assert_eq!(read_value(&paths, "k"), None);
        assert_matches!(
            read_value_checked(&paths, "k"),
            Err(AppError::Config(msg)) if msg.contains("Failed To Read")
        );
        assert_matches!(
            write_value(&paths, "k", json!(1)),
            Err(AppError::Config(msg)) if msg.contains("Not Overwriting")
        );
        assert!(config_path(&paths).is_dir());
    }
}
