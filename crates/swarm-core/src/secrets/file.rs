//! [`FileStore`]: `swarm-secrets.json`, the fallback for a host with no
//! OS keychain.

use std::path::{Path, PathBuf};

use parking_lot::Mutex;
use serde_json::Value;

use super::{SecretStore, SecretString};
use crate::error::AppError;
use crate::state_file::{self, StoredObject};

/// File name of the fallback store within the data directory; it holds
/// credentials, so the file commands must deny it as they deny
/// `swarm-config.json`.
pub const SECRETS_FILE: &str = "swarm-secrets.json";

/// Serializes every read-modify-write of a secrets file.
static SECRETS_LOCK: Mutex<()> = Mutex::new(());

/// Secrets as one JSON object in `<dir>/swarm-secrets.json`, replaced
/// atomically and created owner-only (`0600`) on Unix. On Windows the
/// mode bits mean nothing, so the profile directory's ACL is the only
/// guard; the keychain is the store there whenever it opens.
///
/// A malformed file reads as holding no secrets (logged) and is moved
/// aside (`swarm-secrets.json.corrupt-<unix ms>`) before the next
/// write, as `swarm-config.json` is; an unreadable one is an error and
/// is never overwritten.
pub struct FileStore {
    path: PathBuf,
}

impl FileStore {
    /// The store in data directory `dir`, which must exist.
    pub fn new(dir: &Path) -> Self {
        Self {
            path: dir.join(SECRETS_FILE),
        }
    }

    fn error(&self, action: &str, e: &std::io::Error) -> AppError {
        AppError::Config(format!("Failed To {action} {}: {e}", self.path.display()))
    }

    fn read(&self) -> Result<serde_json::Map<String, Value>, AppError> {
        match state_file::read_object(&self.path) {
            Ok(StoredObject::Object(map)) => Ok(map),
            Ok(StoredObject::Missing) => Ok(serde_json::Map::new()),
            Ok(StoredObject::Malformed) => {
                tracing::warn!("swarm-secrets.json is malformed; reading it as holding no secrets");
                Ok(serde_json::Map::new())
            }
            Err(e) => Err(self.error("Read", &e)),
        }
    }

    /// Applies `edit` to the stored object and writes it back when
    /// `edit` reports a change.
    fn update(
        &self,
        edit: impl FnOnce(&mut serde_json::Map<String, Value>) -> bool,
    ) -> Result<(), AppError> {
        let _guard = SECRETS_LOCK.lock();
        let mut map = match state_file::read_object(&self.path) {
            Ok(StoredObject::Object(map)) => map,
            Ok(StoredObject::Missing) => serde_json::Map::new(),
            Ok(StoredObject::Malformed) => {
                let aside = state_file::quarantine(&self.path)
                    .map_err(|e| self.error("Move Aside The Malformed", &e))?;
                tracing::warn!(
                    moved_to = %aside.display(),
                    "swarm-secrets.json was malformed; moved it aside and started a fresh one"
                );
                serde_json::Map::new()
            }
            Err(e) => return Err(self.error("Read (So Not Overwriting)", &e)),
        };
        if !edit(&mut map) {
            return Ok(());
        }
        let json = serde_json::to_vec_pretty(&map)?;
        state_file::write_atomic(&self.path, &json).map_err(|e| self.error("Write", &e))
    }
}

impl SecretStore for FileStore {
    fn get(&self, name: &str) -> Result<Option<SecretString>, AppError> {
        let _guard = SECRETS_LOCK.lock();
        Ok(match self.read()?.remove(name) {
            Some(Value::String(value)) if !value.is_empty() => Some(value.into()),
            _ => None,
        })
    }

    fn set(&self, name: &str, secret: &SecretString) -> Result<(), AppError> {
        self.update(|map| {
            map.insert(name.to_owned(), Value::String(secret.expose().to_owned()));
            true
        })
    }

    fn delete(&self, name: &str) -> Result<(), AppError> {
        self.update(|map| map.remove(name).is_some())
    }
}
