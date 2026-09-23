//! Contract tests for `capabilities/default.json`, the ACL the webview
//! runs under.
//!
//! The opener URL scope is checked with the same matcher
//! tauri-plugin-opener uses (`glob::Pattern::new(url).matches(..)`, in
//! its `scope.rs`), against the URLs `swarm_core::git::remote::compare_url`
//! really builds. The shell plugin's `open` regex this scope replaced
//! only admitted filesystem paths, so every "Open Compare Page" in the
//! ship chain was rejected.

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

/// The `allow` scope entries' `key` values of the permission `id`.
fn scope(id: &str, key: &str) -> Vec<String> {
    permissions()
        .iter()
        .filter(|p| identifier(p) == id)
        .flat_map(|p| p["allow"].as_array().cloned().unwrap_or_default())
        .map(|entry| entry[key].as_str().expect("scope entry value").to_owned())
        .collect()
}

fn url_allowed(url: &str) -> bool {
    scope("opener:allow-open-url", "url").iter().any(|pattern| {
        glob::Pattern::new(pattern)
            .expect("valid glob")
            .matches(url)
    })
}

#[test]
fn ship_compare_urls_are_openable() {
    for remote in [
        "https://github.com/ABCrimson/Swarm.git",
        "git@github.com:ABCrimson/Swarm.git",
        "ssh://git@github.com/some-org/some.repo",
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

#[test]
fn url_scope_admits_nothing_else() {
    for url in [
        "http://github.com/o/r/compare/main...b",
        "https://github.com.evil.example/o/r/compare/main...b",
        "https://evil.example/github.com/o/r/compare/main...b",
        "https://github.com@evil.example/o/r/compare/main...b",
        "https://api.github.com/repos/o/r/compare/main...b",
        "https://github.com/o/r/pulls",
        "file:///etc/passwd",
        "mailto:someone@example.com",
    ] {
        assert!(!url_allowed(url), "URL scope admitted {url}");
    }
}

/// Every opener permission carries a scope (no bare `opener:default`,
/// which admits any http(s)/mailto/tel URL and reveals any path), the
/// removed shell plugin and the frontend-unused updater commands grant
/// nothing, and the webview-profile deny set is present.
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
        assert!(!id.starts_with("shell:"), "{id}: the shell plugin is gone");
        assert!(
            !id.starts_with("updater:"),
            "{id}: the frontend never calls plugin:updater"
        );
    }
    assert!(ids.contains(&"fs:deny-default"));
    assert_eq!(
        scope("opener:allow-open-path", "path"),
        ["$HOME/.swarm/worktrees/**"],
        "openPath is limited to the worker worktree root"
    );
}
