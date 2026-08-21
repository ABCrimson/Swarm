//! App config registry handlers: `read_config`/`write_config`.
//!
//! # The secret-key denylist lives at the transport layer, not here
//!
//! This module's handlers are behaviorally IDENTICAL to the pre-Phase-2
//! Tauri commands — no restriction on which keys may be read, because
//! the desktop shell's webview-direct AI chat path (`AIChat.tsx`) still
//! legitimately reads `anthropic_api_key` locally over Tauri IPC (see
//! `RECONCILIATION.md` §4: "the webview-direct AI path exists"). The
//! headless-daemon plan's denylist ("`read_config` over WS DENIES
//! secret-prefixed keys") is a NETWORK-boundary policy, not a
//! `read_config`-the-command policy — baking it in here would also
//! block the legitimate local desktop path. [`is_secret_key`] is the
//! shared predicate; `swarmd`'s WS `rpc` dispatcher calls it BEFORE
//! ever reaching [`Registry::dispatch`] for `cmd == "read_config"`,
//! short-circuiting with a denial that never touches this handler at
//! all. See `swarmd::ws`'s doc for the enforcement site.

use serde::Deserialize;
use serde_json::Value;

use super::{Ctx, err_value, ok_value, parse_args};

/// `true` for a config key that must never cross the network: the
/// Anthropic API key itself, and any key that LOOKS like a secret by
/// naming convention (`_key`/`_token`/`_secret` suffix) — a
/// forward-looking guard so a future `some_provider_api_key` or
/// `oauth_token` config value is denied by construction, not only by an
/// explicit name added to a list after the fact.
pub fn is_secret_key(key: &str) -> bool {
    key == "anthropic_api_key"
        || key.ends_with("_key")
        || key.ends_with("_token")
        || key.ends_with("_secret")
}

#[derive(Deserialize)]
struct KeyArgs {
    key: String,
}

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
    fn test_is_secret_key_denies_the_anthropic_key() {
        assert!(is_secret_key("anthropic_api_key"));
    }

    #[test]
    fn test_is_secret_key_denies_any_suffix_match() {
        assert!(is_secret_key("openai_api_key"));
        assert!(is_secret_key("daemon_token"));
        assert!(is_secret_key("session_secret"));
    }

    #[test]
    fn test_is_secret_key_allows_ordinary_settings() {
        assert!(!is_secret_key("max_workers"));
        assert!(!is_secret_key("default_repo_root"));
        assert!(!is_secret_key("theme"));
    }
}
