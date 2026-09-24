//! Contract tests for `capabilities/default.json`, the ACL the webview
//! runs under.
//!
//! The opener URL scope is checked with the matcher tauri-plugin-opener
//! evaluates it with (`glob::Pattern::new(url).matches(..)`, in its
//! `scope.rs`), against the URLs `swarm_core::git::remote::compare_url`
//! really builds for the ship chain's "Open Compare Page".

use serde_json::Value;
use swarm_core::git::remote::{compare_url, parse};

const CAPABILITY: &str = include_str!("../capabilities/default.json");

fn permissions() -> Vec<Value> {
    let capability: Value = serde_json::from_str(CAPABILITY).expect("capability is valid JSON");
    capability["permissions"]
        .as_array()
        .expect("permissions is an array")
        .clone()
}

fn identifier(permission: &Value) -> &str {
    permission
        .as_str()
        .or_else(|| permission["identifier"].as_str())
        .expect("permission has an identifier")
}

/// The `key` values of the `list` (`allow` or `deny`) scope entries of
/// the permission `id`.
fn scope(id: &str, list: &str, key: &str) -> Vec<String> {
    permissions()
        .iter()
        .filter(|p| identifier(p) == id)
        .flat_map(|p| p[list].as_array().cloned().unwrap_or_default())
        .map(|entry| entry[key].as_str().expect("scope entry value").to_owned())
        .collect()
}

fn url_allowed(url: &str) -> bool {
    scope("opener:allow-open-url", "allow", "url")
        .iter()
        .any(|pattern| {
            glob::Pattern::new(pattern)
                .expect("valid glob")
                .matches(url)
        })
}

/// The compare URL of every remote shape the ship chain supports is
/// openable, GitHub Enterprise Server hosts included: swarm-core builds
/// the same `https://<host>/<owner>/<repo>/compare/...` URL for any host
/// that is not a known non-GitHub forge.
#[test]
fn ship_compare_urls_are_openable() {
    for remote in [
        "https://github.com/ABCrimson/Swarm.git",
        "git@github.com:ABCrimson/Swarm.git",
        "ssh://git@github.com/some-org/some.repo",
        "https://github.example-corp.com/platform/api.git",
        "git@ghe.internal:team/service.git",
    ] {
        let parsed = parse(remote).expect("parses");
        let url = compare_url(
            &parsed,
            "main",
            "swarm/agent-abcd1234",
            "Fix: Handle [Edge] Cases?",
            "Body with * and ? and\nnewlines",
        );
        assert!(url_allowed(&url), "compare URL rejected: {url}");
    }
}

/// Only https compare pages open: no other scheme, and no other page.
#[test]
fn url_scope_admits_nothing_else() {
    for url in [
        "http://github.com/o/r/compare/main...b",
        "https://github.com/o/r/pulls",
        "https://github.com/o/r",
        "file:///etc/passwd",
        "mailto:someone@example.com",
        "javascript:alert(1)//compare/x",
        "swarm://github.com/o/r/compare/main...b",
    ] {
        assert!(!url_allowed(url), "URL scope admitted {url}");
    }
}

/// Every opener permission carries a scope (no bare `opener:default`,
/// which admits any http(s)/mailto/tel URL and reveals any path), no
/// shell or updater permission is granted (the frontend uses neither
/// plugin), and the webview-profile deny set is present.
#[test]
fn capability_is_least_privilege() {
    let permissions = permissions();
    let ids: Vec<&str> = permissions.iter().map(identifier).collect();

    for permission in &permissions {
        let id = identifier(permission);
        if id.starts_with("opener:") {
            assert!(
                permission["allow"]
                    .as_array()
                    .is_some_and(|a| !a.is_empty()),
                "{id} is granted without a scope"
            );
        }
        assert!(
            !id.starts_with("shell:"),
            "{id}: the app has no shell plugin"
        );
        assert!(
            !id.starts_with("updater:"),
            "{id}: the frontend never calls plugin:updater"
        );
    }
    assert!(ids.contains(&"fs:deny-default"));
    assert_eq!(
        scope("opener:allow-open-path", "allow", "path"),
        ["$HOME/.swarm/worktrees/**"],
        "openPath is limited to the worker worktree root"
    );
}

/// No fs permission grants a static path: the webview reads and writes
/// only what a dialog granted at runtime. A static `$HOME/**` scope made
/// every file under the home directory readable (dotfiles and credential
/// stores included on Windows, where fs scopes match leading dots) whether
/// or not the user ever opened it.
#[test]
fn fs_access_has_no_static_allow_scope() {
    for permission in permissions() {
        let id = identifier(&permission);
        if id.starts_with("fs:") {
            assert!(
                permission.get("allow").is_none(),
                "{id} grants a static fs scope"
            );
        }
    }
    assert!(
        !permissions()
            .iter()
            .any(|p| identifier(p) == "fs:allow-mkdir")
    );
}

/// The app's own data directory (the API key in swarm-config.json, the
/// event log, swarmd's token) and the usual credential stores stay out of
/// reach even when a dialog grant covers them, e.g. when the user opens
/// their home directory as a workspace.
#[test]
fn app_data_and_credential_stores_are_denied() {
    let denied = scope("fs:scope", "deny", "path");
    for path in [
        "$APPDATA/**",
        "$HOME/.ssh/**",
        "$HOME/.aws/**",
        "$HOME/.claude/**",
        "$HOME/.codex/**",
    ] {
        assert!(denied.iter().any(|d| d == path), "{path} is not denied");
    }
}
