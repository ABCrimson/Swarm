//! `read_config`/`write_config` registry handlers over
//! [`crate::config`].
//!
//! The handlers themselves apply no key restrictions: the desktop app
//! legitimately reads `anthropic_api_key` over local IPC (the webview
//! calls the Anthropic API itself). Remote access is where secrets must
//! not flow, in either direction — reading one would exfiltrate a
//! credential, writing one would plant a credential the desktop app then
//! trusts. That is enforced by [`RemotePolicy::SecretFiltered`] in
//! [`Registry::dispatch_remote`], using [`is_secret_key`].
//!
//! [`RemotePolicy::SecretFiltered`]: super::RemotePolicy::SecretFiltered
//! [`Registry::dispatch_remote`]: super::Registry::dispatch_remote

use serde::Deserialize;
use serde_json::Value;

use super::{Ctx, err_value, ok_value, parse_args};

/// Word a secret-shaped key ENDS with (`anthropic_api_key`,
/// `github_token`, `db_password`, `githubPat`, ...).
const SECRET_LAST_WORDS: &[&str] = &[
    "key",
    "apikey",
    "token",
    "secret",
    "password",
    "passwd",
    "pat",
    "credential",
    "credentials",
];

/// Word that marks a key as secret-shaped ANYWHERE in it
/// (`client_secret_id`, `password_hint`, `apikey_v2`, ...).
const SECRET_ANY_WORDS: &[&str] = &[
    "apikey",
    "secret",
    "password",
    "passwd",
    "credential",
    "credentials",
];

/// `true` for a config key that must never cross the network: one
/// shaped like a credential by naming convention, so a future secret is
/// denied by construction rather than by an explicit list entry added
/// after the fact.
///
/// The key is split into lowercase words first — at `_`, `-`, `:`, `.`,
/// spaces and camelCase boundaries — so `ANTHROPIC_API_KEY`,
/// `settings:githubToken` and `api-key` are judged like
/// `anthropic_api_key`, `settings_github_token` and `api_key`. It is
/// secret-shaped when its LAST word is one of `SECRET_LAST_WORDS`, or
/// ANY word is one of `SECRET_ANY_WORDS`. Ordinary settings such as
/// `max_workers`, `max_tokens` or `default_repo_root` are not.
pub fn is_secret_key(key: &str) -> bool {
    let words = key_words(key);
    words
        .last()
        .is_some_and(|last| SECRET_LAST_WORDS.contains(&last.as_str()))
        || words
            .iter()
            .any(|word| SECRET_ANY_WORDS.contains(&word.as_str()))
}

/// `key` as lowercase alphanumeric words (see [`is_secret_key`]).
fn key_words(key: &str) -> Vec<String> {
    let mut words = Vec::new();
    let mut word = String::new();
    let mut prev_lower_or_digit = false;
    for c in key.chars() {
        if !c.is_alphanumeric() {
            words.extend((!word.is_empty()).then(|| std::mem::take(&mut word)));
            prev_lower_or_digit = false;
            continue;
        }
        if c.is_uppercase() && prev_lower_or_digit {
            words.push(std::mem::take(&mut word));
        }
        prev_lower_or_digit = c.is_lowercase() || c.is_numeric();
        word.extend(c.to_lowercase());
    }
    words.extend((!word.is_empty()).then_some(word));
    words
}

#[derive(Deserialize)]
struct KeyArgs {
    key: String,
}

/// Reads one config value (`null` when unset); see
/// [`crate::config::read_value`].
pub async fn read_config(ctx: Ctx, args: Value) -> Result<Value, Value> {
    let KeyArgs { key } = parse_args(args)?;
    let paths = ctx.paths.clone();
    let value = tokio::task::spawn_blocking(move || crate::config::read_value(&paths, &key))
        .await
        .map_err(|e| Value::String(e.to_string()))?;
    ok_value(&value)
}

#[derive(Deserialize)]
struct WriteArgs {
    key: String,
    value: Value,
}

/// Sets one config value; see [`crate::config::write_value`].
pub async fn write_config(ctx: Ctx, args: Value) -> Result<Value, Value> {
    let WriteArgs { key, value } = parse_args(args)?;
    let paths = ctx.paths.clone();
    tokio::task::spawn_blocking(move || crate::config::write_value(&paths, &key, value))
        .await
        .map_err(|e| Value::String(e.to_string()))?
        .map_err(|e| err_value(&e))?;
    ok_value(&())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_key_words_splits_on_separators_and_camel_case() {
        assert_eq!(key_words("anthropic_api_key"), ["anthropic", "api", "key"]);
        assert_eq!(
            key_words("settings:githubToken"),
            ["settings", "github", "token"]
        );
        assert_eq!(key_words("APIKey"), ["apikey"]);
        assert_eq!(
            key_words("shipCoAuthoredBy"),
            ["ship", "co", "authored", "by"]
        );
        assert_eq!(key_words("__x--y__"), ["x", "y"]);
        assert!(key_words("").is_empty());
    }

    #[test]
    fn test_is_secret_key_denies_the_anthropic_key_in_any_spelling() {
        for key in [
            "anthropic_api_key",
            "ANTHROPIC_API_KEY",
            "anthropicApiKey",
            "anthropic-api-key",
        ] {
            assert!(is_secret_key(key), "{key}");
        }
    }

    /// UNVERIFIED-low finding, verified: the old suffix check was
    /// case-sensitive and `_`-only, so every key below was remotely
    /// readable and writable.
    #[test]
    fn test_is_secret_key_denies_other_secret_shapes() {
        for key in [
            "openai_api_key",
            "daemon_token",
            "session_secret",
            "Github_Token",
            "settings:githubToken",
            "apikey",
            "api-key",
            "db_password",
            "smtp_passwd",
            "github_pat",
            "aws_credentials",
            "client_secret_id",
        ] {
            assert!(is_secret_key(key), "{key}");
        }
    }

    #[test]
    fn test_is_secret_key_allows_ordinary_settings() {
        for key in [
            "max_workers",
            "max_tokens",
            "agent_concurrency",
            "default_repo_root",
            "shipCoAuthoredBy",
            "theme",
            "keyboard_layout",
            "lazy-store:recent",
            "",
        ] {
            assert!(!is_secret_key(key), "{key}");
        }
    }
}
