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
//! keychain left in this file is moved to the store, once, by the same
//! step [`migrate_secrets`] runs, once at startup (in the background,
//! from [`crate::runtime::Runtime::start`]), on the key's first read or
//! write and on any rewrite of the file; a store that refuses it leaves the file
//! as it was, and the key keeps reading from the file until a later
//! access moves it. Store calls block, so call these functions from a
//! blocking thread. No store call runs under the file's lock, so a
//! keychain waiting on an access prompt stalls only other secret
//! accesses, never a read of another key.
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

use std::path::PathBuf;

use parking_lot::Mutex;
use serde_json::{Map, Value};

use crate::Paths;
use crate::error::AppError;
use crate::secrets::{self, SecretStore, SecretString};
use crate::state_file::{self, StoredObject};

/// Config file name within the app data directory.
pub(crate) const CONFIG_FILE: &str = "swarm-config.json";

/// Serializes every read and read-modify-write of the file. Never held
/// across a [`SecretStore`] call.
static CONFIG_LOCK: Mutex<()> = Mutex::new(());

/// Serializes every move of a secret into the store with every secret
/// write, so a moved copy can never land after a newer write. Taken
/// before [`CONFIG_LOCK`], never while holding it.
static SECRET_LOCK: Mutex<()> = Mutex::new(());

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

/// The secret entries `swarm-config.json` holds; none when the file is
/// missing, malformed or unreadable.
fn file_secrets(paths: &Paths) -> Map<String, Value> {
    let _guard = CONFIG_LOCK.lock();
    match state_file::read_object(&config_path(paths)) {
        Ok(StoredObject::Object(map)) => {
            map.into_iter().filter(|(key, _)| is_secret(key)).collect()
        }
        _ => Map::new(),
    }
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
    let _secret_guard = SECRET_LOCK.lock();
    let found = file_secrets(paths);
    if found.is_empty() {
        return Ok(());
    }
    secrets::with_store(paths, |store| move_secrets(paths, store, &found))
}

/// Moves `found` (read by [`file_secrets`]) into `store`, with
/// [`SECRET_LOCK`] held. A non-empty string is stored; anything else is
/// no usable key and is only dropped from the file.
///
/// The store calls run without [`CONFIG_LOCK`] (a keychain can wait on
/// an access prompt, and config reads must not wait with it), so the
/// file is read again afterwards and an entry is removed only if it
/// still holds the value moved: a key written meanwhile is newer and
/// stays for the next migration. On a store error the file is left as
/// it was.
fn move_secrets(
    paths: &Paths,
    store: &dyn SecretStore,
    found: &Map<String, Value>,
) -> Result<(), AppError> {
    for (key, value) in found {
        if let Value::String(value) = value
            && !value.is_empty()
        {
            store.set(key, &SecretString::from(value.clone()))?;
        }
    }
    let _guard = CONFIG_LOCK.lock();
    let path = config_path(paths);
    let Ok(StoredObject::Object(mut map)) = state_file::read_object(&path) else {
        return Ok(());
    };
    let before = map.len();
    for (key, value) in found {
        if map.get(key) == Some(value) {
            map.remove(key);
        }
    }
    if map.len() == before {
        return Ok(());
    }
    let json = serde_json::to_vec_pretty(&map)?;
    state_file::write_atomic(&path, &json)
        .map_err(|e| AppError::Config(format!("Failed To Write {}: {e}", path.display())))
}

/// Reads secret `key` from `store`, migrating the file first. While the
/// migration fails, the file's copy is still the key.
fn read_secret(
    paths: &Paths,
    store: &dyn SecretStore,
    key: &str,
) -> Result<Option<Value>, AppError> {
    {
        let _secret_guard = SECRET_LOCK.lock();
        let found = file_secrets(paths);
        if !found.is_empty()
            && let Err(e) = move_secrets(paths, store, &found)
        {
            tracing::warn!(error = %e, "could not move the API key out of swarm-config.json yet");
            if let Some(value) = file_secrets(paths).remove(key) {
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
    let _secret_guard = SECRET_LOCK.lock();
    let found = file_secrets(paths);
    if !found.is_empty() {
        move_secrets(paths, store, &found)?;
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
    if write_plain(paths, key, value)? {
        // A store that refuses the secret keeps it in the file; this
        // write of another key has gone through.
        if let Err(e) = migrate_secrets(paths) {
            tracing::warn!(error = %e, "could not move the API key out of swarm-config.json yet");
        }
    }
    Ok(())
}

/// [`write_value`] of a key kept in the file. Returns whether the file
/// still holds a secret, for the caller to move once [`CONFIG_LOCK`] is
/// released.
fn write_plain(paths: &Paths, key: &str, value: Value) -> Result<bool, AppError> {
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
    map.insert(key.to_owned(), value);
    let json = serde_json::to_vec_pretty(&map)?;
    state_file::write_atomic(&path, &json).map_err(|e| config_error("Write", e))?;
    Ok(holds_secret(&map))
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

        assert!(move_secrets(&paths, &Refusing, &file_secrets(&paths)).is_err());
        assert_eq!(config_text(&paths), legacy);
    }

    /// A store whose `set` runs `during_set` first, then accepts.
    struct Probe<F: Fn() + Send + Sync>(F);

    impl<F: Fn() + Send + Sync> SecretStore for Probe<F> {
        fn get(&self, _name: &str) -> Result<Option<SecretString>, AppError> {
            Ok(None)
        }

        fn set(&self, _name: &str, _secret: &SecretString) -> Result<(), AppError> {
            (self.0)();
            Ok(())
        }

        fn delete(&self, _name: &str) -> Result<(), AppError> {
            Ok(())
        }
    }

    /// A keychain call can wait on an access prompt, so it never runs
    /// with `CONFIG_LOCK` held: other config reads go on meanwhile.
    #[test]
    fn test_the_store_is_called_without_the_config_lock() {
        let (dir, _cleanup) = temp_dir("config");
        let paths = paths(&dir);
        fs::write(
            config_path(&paths),
            r#"{"anthropic_api_key": "sk-ant-legacy"}"#,
        )
        .unwrap();
        let free = Probe(|| {
            assert!(
                CONFIG_LOCK
                    .try_lock_for(std::time::Duration::from_secs(5))
                    .is_some(),
                "CONFIG_LOCK is held during a store call"
            );
        });

        assert_eq!(read_secret(&paths, &free, API_KEY).unwrap(), None);
        assert!(!config_text(&paths).contains("sk-ant-legacy"));
        fs::write(
            config_path(&paths),
            r#"{"anthropic_api_key": "sk-ant-legacy"}"#,
        )
        .unwrap();
        write_secret(&paths, &free, API_KEY, json!("sk-ant-new")).unwrap();
        assert!(!config_text(&paths).contains("sk-ant-legacy"));
    }

    /// A key written to the file while the store call waited is newer
    /// than the copy moved, so the migration leaves it in the file.
    #[test]
    fn test_a_migration_keeps_a_key_changed_during_the_store_call() {
        let (dir, _cleanup) = temp_dir("config");
        let paths = paths(&dir);
        let file = config_path(&paths);
        fs::write(&file, r#"{"anthropic_api_key": "sk-ant-legacy"}"#).unwrap();
        let rewrite = Probe(|| {
            fs::write(
                &file,
                r#"{"anthropic_api_key": "sk-ant-newer", "theme": "dark"}"#,
            )
            .unwrap();
        });

        read_secret(&paths, &rewrite, API_KEY).unwrap();
        let text = config_text(&paths);
        assert!(text.contains("sk-ant-newer"), "{text}");
        assert!(text.contains("dark"), "{text}");
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
