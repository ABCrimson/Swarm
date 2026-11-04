//! [`KeyringStore`]: the OS keychain through `keyring::v1`.

use keyring::v1::{Entry, Error};
use zeroize::Zeroize;

use super::{SecretStore, SecretString};
use crate::error::AppError;

/// The keychain service every Swarm secret is filed under; a secret's
/// name is the entry's user (`swarm` / `anthropic_api_key`).
const KEYCHAIN_SERVICE: &str = "swarm";

/// Secrets in the OS keychain: Windows Credential Manager, macOS
/// Keychain, or the Secret Service over D-Bus on Linux.
///
/// Every call is synchronous and may wait on the OS (a locked keychain
/// can prompt), so it belongs on a blocking thread.
pub struct KeyringStore(());

impl KeyringStore {
    /// The keychain, when this host has one.
    ///
    /// # Errors
    ///
    /// The `keyring` crate's store initialization error from
    /// `Entry::store_status()`: for example no D-Bus session or no
    /// Secret Service on a headless Linux host.
    pub fn open() -> Result<Self, &'static Error> {
        Entry::store_status().as_ref().map(|_| Self(()))
    }
}

/// A store error for `action`. `keyring` errors are formatted with
/// `Display` only: their `Debug` carries the raw secret bytes of a
/// value that failed to decode.
fn keychain_error(action: &str, e: &Error) -> AppError {
    AppError::Config(format!("OS Keychain Could Not {action} The Secret: {e}"))
}

fn entry(name: &str, action: &str) -> Result<Entry, AppError> {
    Entry::new(KEYCHAIN_SERVICE, name).map_err(|e| keychain_error(action, &e))
}

impl SecretStore for KeyringStore {
    fn get(&self, name: &str) -> Result<Option<SecretString>, AppError> {
        match entry(name, "Read")?.get_secret() {
            Ok(bytes) => String::from_utf8(bytes)
                .map(|value| Some(value.into()))
                .map_err(|e| {
                    e.into_bytes().zeroize();
                    AppError::Config("OS Keychain Holds A Secret That Is Not UTF-8".to_owned())
                }),
            Err(Error::NoEntry) => Ok(None),
            Err(Error::BadEncoding(mut bytes) | Error::BadDataFormat(mut bytes, _)) => {
                bytes.zeroize();
                Err(AppError::Config(
                    "OS Keychain Holds A Secret It Cannot Decode".to_owned(),
                ))
            }
            Err(e) => Err(keychain_error("Read", &e)),
        }
    }

    fn set(&self, name: &str, secret: &SecretString) -> Result<(), AppError> {
        entry(name, "Write")?
            .set_secret(secret.expose().as_bytes())
            .map_err(|e| keychain_error("Write", &e))
    }

    fn delete(&self, name: &str) -> Result<(), AppError> {
        match entry(name, "Delete")?.delete_credential() {
            Ok(()) | Err(Error::NoEntry) => Ok(()),
            Err(e) => Err(keychain_error("Delete", &e)),
        }
    }
}
