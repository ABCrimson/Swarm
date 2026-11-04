//! The public secret-store API: the `FileStore` fallback a headless
//! `swarmd` uses, and the redaction every secret value carries. The OS
//! keychain is never touched here; a test must not write to the
//! developer's credential store.

use std::fs;
use std::path::PathBuf;

use swarm_core::secrets::{FileStore, SecretStore, SecretString};

/// A fresh directory under the system temp dir, removed on drop.
struct TempDir(PathBuf);

impl TempDir {
    fn new() -> Self {
        let dir = std::env::temp_dir().join(format!("swarm-secrets-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        Self(dir)
    }

    fn file(&self) -> PathBuf {
        self.0.join("swarm-secrets.json")
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn secret(value: &str) -> SecretString {
    SecretString::from(value.to_owned())
}

#[test]
fn file_store_round_trips_replaces_and_deletes() {
    let dir = TempDir::new();
    let store = FileStore::new(&dir.0);
    assert!(store.get("anthropic_api_key").unwrap().is_none());

    store
        .set("anthropic_api_key", &secret("sk-ant-one"))
        .unwrap();
    store.set("other", &secret("kept")).unwrap();
    store
        .set("anthropic_api_key", &secret("sk-ant-two"))
        .unwrap();
    assert_eq!(
        store.get("anthropic_api_key").unwrap().unwrap().expose(),
        "sk-ant-two"
    );

    store.delete("anthropic_api_key").unwrap();
    assert!(store.get("anthropic_api_key").unwrap().is_none());
    assert_eq!(store.get("other").unwrap().unwrap().expose(), "kept");
}

/// Deleting what is not there succeeds and creates no file.
#[test]
fn file_store_delete_of_an_absent_secret_is_a_no_op() {
    let dir = TempDir::new();
    let store = FileStore::new(&dir.0);
    store.delete("anthropic_api_key").unwrap();
    assert!(!dir.file().exists());
}

/// A malformed file reads as empty and is moved aside intact before
/// the next write, never overwritten.
#[test]
fn file_store_quarantines_a_malformed_file() {
    let dir = TempDir::new();
    let store = FileStore::new(&dir.0);
    fs::write(dir.file(), "{not json").unwrap();

    assert!(store.get("anthropic_api_key").unwrap().is_none());
    store
        .set("anthropic_api_key", &secret("sk-ant-new"))
        .unwrap();

    assert_eq!(
        store.get("anthropic_api_key").unwrap().unwrap().expose(),
        "sk-ant-new"
    );
    let aside: Vec<_> = fs::read_dir(&dir.0)
        .unwrap()
        .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
        .filter(|name| name.starts_with("swarm-secrets.json.corrupt-"))
        .collect();
    assert_eq!(aside.len(), 1, "{aside:?}");
    assert_eq!(
        fs::read_to_string(dir.0.join(&aside[0])).unwrap(),
        "{not json"
    );
}

/// An unreadable store (here a directory in the file's place) is an
/// error for reads and writes alike, and is left untouched.
#[test]
fn file_store_never_overwrites_an_unreadable_file() {
    let dir = TempDir::new();
    let store = FileStore::new(&dir.0);
    fs::create_dir(dir.file()).unwrap();

    assert!(store.get("anthropic_api_key").is_err());
    let err = store
        .set("anthropic_api_key", &secret("sk-ant-new"))
        .unwrap_err();
    assert!(err.to_string().contains("Not Overwriting"), "{err}");
    assert!(!err.to_string().contains("sk-ant-new"), "{err}");
    assert!(dir.file().is_dir());
}

#[cfg(unix)]
#[test]
fn file_store_is_owner_only() {
    use std::os::unix::fs::PermissionsExt;

    let dir = TempDir::new();
    FileStore::new(&dir.0)
        .set("anthropic_api_key", &secret("sk-ant-mode"))
        .unwrap();
    let mode = fs::metadata(dir.file()).unwrap().permissions().mode();
    assert_eq!(mode & 0o777, 0o600);
}

#[test]
fn secret_string_debug_is_redacted() {
    let value = secret("sk-ant-hidden");
    assert!(!format!("{value:?}").contains("sk-ant-hidden"));
}
