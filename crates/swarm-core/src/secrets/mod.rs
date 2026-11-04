//! Secrets kept out of `swarm-config.json`: the OS keychain, with an
//! owner-only file for hosts that have none.
//!
//! [`SecretStore`] is the seam: [`KeyringStore`] is the OS keychain
//! (Windows Credential Manager, macOS Keychain, the Secret Service on
//! Linux), [`FileStore`] the `swarm-secrets.json` fallback (`0600` on
//! Unix) for a headless `swarmd` whose host runs no Secret Service.
//! Which one serves a process is decided once, on the first secret
//! access, by `keyring::v1::Entry::store_status()` (see [`with_store`]).
//! Unit tests always get the file store, so no test touches the
//! developer's keychain.
//!
//! The OS keychain holds one `swarm`/`anthropic_api_key` entry per OS
//! user, shared by every data directory; migrating a legacy key from
//! any data directory replaces it, and clearing it clears it for all.
//! Only the [`FileStore`] is per data directory.
//!
//! Every store call blocks (the keychain APIs are synchronous, and a
//! locked keychain can wait on the user), so it runs on a blocking
//! thread, never on a Tokio worker. Only [`crate::config`] opens a
//! store, for the API key itself and for a file rewrite that carries a
//! legacy key out; the commands that reach those paths (`read_config`,
//! `write_config`, the `max_workers` and `agent_concurrency` setters)
//! run them inside `spawn_blocking`.
//!
//! A value lives in a [`SecretString`], zeroed on drop, whose `Debug`
//! is redacted. Errors carry the store's reason, never the value.

mod file;
mod keychain;

use std::collections::HashMap;
use std::fmt;
use std::time::{Duration, Instant};

use parking_lot::Mutex;
use zeroize::Zeroizing;

pub use self::file::{FileStore, SECRETS_FILE};
pub use self::keychain::KeyringStore;
use crate::Paths;
use crate::error::AppError;

/// A secret string, zeroed when dropped; its `Debug` prints no value.
pub struct SecretString(Zeroizing<String>);

impl SecretString {
    /// The secret itself. Every copy made from it is the caller's to
    /// keep out of logs and error messages.
    pub fn expose(&self) -> &str {
        &self.0
    }
}

impl From<String> for SecretString {
    /// Takes ownership of `value` without copying it.
    fn from(value: String) -> Self {
        Self(Zeroizing::new(value))
    }
}

impl fmt::Debug for SecretString {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("SecretString(<redacted>)")
    }
}

/// Named secrets in one backing store. Every method blocks.
pub trait SecretStore: Send + Sync {
    /// The secret stored as `name`, or `None` when there is none.
    ///
    /// # Errors
    ///
    /// [`AppError::Config`] when the store cannot be read.
    fn get(&self, name: &str) -> Result<Option<SecretString>, AppError>;

    /// Stores `secret` as `name`, replacing any earlier value.
    ///
    /// # Errors
    ///
    /// [`AppError::Config`] when the store cannot be written; the
    /// earlier value, if any, is then still in place.
    fn set(&self, name: &str, secret: &SecretString) -> Result<(), AppError>;

    /// Removes `name`. Removing a secret that is not there succeeds.
    ///
    /// # Errors
    ///
    /// [`AppError::Config`] when the store cannot be written.
    fn delete(&self, name: &str) -> Result<(), AppError>;
}

/// How long [`with_store`]'s keychain remembers a failed read before it
/// asks the OS again: long enough that a burst of reads against a
/// locked or broken keychain makes one OS call, short enough that an
/// unlock takes effect within one Settings visit.
pub const FAILURE_TTL: Duration = Duration::from_secs(30);

/// A [`SecretStore`] that remembers a failed [`SecretStore::get`] for
/// `ttl` and answers the same error without calling the inner store.
///
/// Only failures are cached, never values, and only per name and for
/// `ttl`, never for the life of the process. A successful
/// [`SecretStore::set`] or [`SecretStore::delete`] of a name forgets
/// its failure, so a write is read back at once.
pub struct CachedStore<S> {
    inner: S,
    ttl: Duration,
    failures: Mutex<HashMap<String, Failure>>,
}

struct Failure {
    until: Instant,
    message: String,
}

impl<S: SecretStore> CachedStore<S> {
    /// Wraps `inner`, caching each failed read for `ttl`.
    pub fn new(inner: S, ttl: Duration) -> Self {
        Self {
            inner,
            ttl,
            failures: Mutex::new(HashMap::new()),
        }
    }

    fn forget_failure(&self, name: &str) {
        self.failures.lock().remove(name);
    }
}

impl<S: SecretStore> SecretStore for CachedStore<S> {
    fn get(&self, name: &str) -> Result<Option<SecretString>, AppError> {
        if let Some(failure) = self.failures.lock().get(name)
            && Instant::now() < failure.until
        {
            return Err(AppError::Config(failure.message.clone()));
        }
        self.inner.get(name).inspect_err(|e| {
            let message = match e {
                AppError::Config(message) => message.clone(),
                other => other.to_string(),
            };
            self.failures.lock().insert(
                name.to_owned(),
                Failure {
                    until: Instant::now() + self.ttl,
                    message,
                },
            );
        })
    }

    fn set(&self, name: &str, secret: &SecretString) -> Result<(), AppError> {
        self.inner.set(name, secret)?;
        self.forget_failure(name);
        Ok(())
    }

    fn delete(&self, name: &str) -> Result<(), AppError> {
        self.inner.delete(name)?;
        self.forget_failure(name);
        Ok(())
    }
}

/// Runs `f` with the store that holds this process's secrets: the OS
/// keychain when `Entry::store_status()` reports one (checked once,
/// then fixed for the process), else the [`FileStore`] in
/// `paths.data_dir`. Blocks; call it from a blocking thread.
pub(crate) fn with_store<R>(paths: &Paths, f: impl FnOnce(&dyn SecretStore) -> R) -> R {
    match keychain() {
        Some(store) => f(store),
        None => f(&FileStore::new(&paths.data_dir)),
    }
}

/// The process-wide keychain store, or `None` when the host has no
/// usable keychain. Unit tests never open the keychain.
#[cfg(not(test))]
fn keychain() -> Option<&'static CachedStore<KeyringStore>> {
    use std::sync::LazyLock;

    static KEYCHAIN: LazyLock<Option<CachedStore<KeyringStore>>> =
        LazyLock::new(|| match KeyringStore::open() {
            Ok(store) => Some(CachedStore::new(store, FAILURE_TTL)),
            Err(e) => {
                tracing::warn!(
                    error = %e,
                    "no OS keychain; secrets are kept in the owner-only swarm-secrets.json"
                );
                None
            }
        });
    KEYCHAIN.as_ref()
}

#[cfg(test)]
fn keychain() -> Option<&'static CachedStore<KeyringStore>> {
    None
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};

    use super::*;

    /// A store whose reads always fail, counting how often it is asked.
    #[derive(Default)]
    struct Broken {
        reads: AtomicUsize,
    }

    impl SecretStore for Broken {
        fn get(&self, _name: &str) -> Result<Option<SecretString>, AppError> {
            self.reads.fetch_add(1, Ordering::SeqCst);
            Err(AppError::Config("Keychain Locked".to_owned()))
        }

        fn set(&self, _name: &str, _secret: &SecretString) -> Result<(), AppError> {
            Ok(())
        }

        fn delete(&self, _name: &str) -> Result<(), AppError> {
            Ok(())
        }
    }

    fn reads(store: &CachedStore<Broken>) -> usize {
        store.inner.reads.load(Ordering::SeqCst)
    }

    #[test]
    fn test_debug_never_prints_the_value() {
        let secret = SecretString::from("sk-ant-hidden".to_owned());
        assert_eq!(format!("{secret:?}"), "SecretString(<redacted>)");
        assert_eq!(secret.expose(), "sk-ant-hidden");
    }

    #[test]
    fn test_a_failed_read_is_cached_within_its_ttl() {
        let store = CachedStore::new(Broken::default(), Duration::from_secs(3600));
        for _ in 0..3 {
            assert!(matches!(
                store.get("k"),
                Err(AppError::Config(message)) if message == "Keychain Locked"
            ));
        }
        assert_eq!(reads(&store), 1);
        // Another name is not covered by the first name's failure.
        assert!(store.get("other").is_err());
        assert_eq!(reads(&store), 2);
    }

    /// The cache is never for the process life: an expired failure asks
    /// the store again.
    #[test]
    fn test_an_expired_failure_reads_the_store_again() {
        let store = CachedStore::new(Broken::default(), Duration::ZERO);
        assert!(store.get("k").is_err());
        assert!(store.get("k").is_err());
        assert_eq!(reads(&store), 2);
    }

    #[test]
    fn test_a_write_forgets_the_cached_failure() {
        let store = CachedStore::new(Broken::default(), Duration::from_secs(3600));
        assert!(store.get("k").is_err());
        store.set("k", &SecretString::from("v".to_owned())).unwrap();
        assert!(store.get("k").is_err());
        store.delete("k").unwrap();
        assert!(store.get("k").is_err());
        assert_eq!(reads(&store), 3);
    }
}
