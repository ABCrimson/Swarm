//! Contract tests for `tauri.conf.json`, parsed into Tauri's own config
//! type exactly as tauri-build and tauri-codegen read it.

use std::collections::HashMap;

use tauri::utils::config::{Config, CspDirectiveSources};

const TAURI_CONF: &str = include_str!("../tauri.conf.json");

fn config() -> Config {
    serde_json::from_str(TAURI_CONF).expect("tauri.conf.json parses as a Tauri config")
}

fn csp() -> HashMap<String, CspDirectiveSources> {
    config()
        .app
        .security
        .csp
        .expect("a production CSP is configured")
        .into()
}

/// xterm.js and sonner insert `<style>` elements at runtime (xterm for
/// its renderers and scrollbar theme, sonner for the toast styles), which
/// a `style-src` without `'unsafe-inline'` blocks in production builds.
/// Tauri must not add nonces or hashes to `style-src` either: a browser
/// ignores `'unsafe-inline'` in a directive that also lists one.
#[test]
fn runtime_style_elements_are_allowed() {
    let config = config();
    let csp = csp();
    assert!(csp["style-src"].contains("'unsafe-inline'"));
    assert!(
        !config
            .app
            .security
            .dangerous_disable_asset_csp_modification
            .can_modify("style-src")
    );
    assert!(
        config
            .app
            .security
            .dangerous_disable_asset_csp_modification
            .can_modify("script-src"),
        "script-src keeps Tauri's nonces"
    );
}

/// Scripts stay locked to the bundle, plugins and `<base>` / form
/// hijacking are off, and no source names the asset protocol, which the
/// app does not enable.
#[test]
fn csp_is_otherwise_strict() {
    let csp = csp();
    for unsafe_source in ["'unsafe-inline'", "'unsafe-eval'"] {
        assert!(
            !csp["script-src"].contains(unsafe_source),
            "script-src allows {unsafe_source}"
        );
    }
    for directive in ["object-src", "base-uri", "form-action"] {
        assert!(
            csp[directive].contains("'none'"),
            "{directive} is not 'none'"
        );
    }
    for (directive, sources) in &csp {
        for asset in ["asset:", "https://asset.localhost"] {
            assert!(!sources.contains(asset), "{directive} lists {asset}");
        }
    }
}

/// The main window starts hidden; `startup::boot` shows it once
/// swarm-core runs, so a failed start shows only its error dialog.
#[test]
fn main_window_starts_hidden() {
    let config = config();
    let main = config
        .app
        .windows
        .iter()
        .find(|window| window.label == "main")
        .expect("a main window is declared");
    assert!(!main.visible);
    assert!(main.create);
}

/// tauri-codegen uses the first PNG in `bundle.icon` as the window icon
/// on macOS and Linux (Windows uses the `.ico` resource), so the
/// full-size icon comes first.
#[test]
fn window_icon_is_the_full_size_png() {
    let config = config();
    let first_png = config
        .bundle
        .icon
        .iter()
        .find(|icon| icon.ends_with(".png"));
    assert_eq!(first_png.map(String::as_str), Some("icons/icon.png"));
}

/// `plugins.updater` deserializes into the plugin's own config type with
/// signed-version enforcement on: a download is then also rejected when
/// the signature's minisign trusted comment carries no `version:` at all
/// (`MissingSignedVersion`). A comment naming a different version than
/// `latest.json` announces is rejected regardless of this flag.
#[test]
fn updater_requires_signed_versions() {
    let conf: serde_json::Value = serde_json::from_str(TAURI_CONF).unwrap();
    let updater: tauri_plugin_updater::Config =
        serde_json::from_value(conf["plugins"]["updater"].clone()).unwrap();
    assert!(updater.require_signed_version);
    assert!(!updater.allow_downgrades);
    assert_eq!(updater.endpoints.len(), 1);
}

/// `plugins.fs.requireLiteralLeadingDot` is off, so a folder allowed on
/// an fs scope built with it (the capability's global `fs:scope`, where
/// `dialog_grants` mirrors dialog grants) covers its dot entries on macOS
/// and Linux too: `.github/`, `.gitignore`, `.env.example`. The plugin's
/// default, `true` on Unix, leaves them out of every `**`.
#[test]
fn fs_scopes_match_dot_entries() {
    use tauri::utils::config::FsScope;

    let conf: serde_json::Value = serde_json::from_str(TAURI_CONF).unwrap();
    let require_literal_leading_dot = conf["plugins"]["fs"]["requireLiteralLeadingDot"].as_bool();
    assert_eq!(require_literal_leading_dot, Some(false));

    let app = tauri::test::mock_app();
    let root = std::path::Path::new("/workspace");
    let scope = tauri::scope::fs::Scope::new(
        &app,
        &FsScope::Scope {
            allow: vec![root.join("**")],
            deny: Vec::new(),
            require_literal_leading_dot,
        },
    )
    .unwrap();
    for entry in [".github/workflows/ci.yml", ".gitignore", "src/.env.example"] {
        assert!(scope.is_allowed(root.join(entry)), "{entry} is not allowed");
    }
}

/// `version` is the path `../package.json`, so the bundle and updater
/// version come from package.json; the Cargo workspace version, which
/// cannot be derived from it, is held in lockstep here. tauri-build and
/// tauri-codegen resolve the path against src-tauri/, and cargo runs this
/// test from the same directory, so the parse resolves it exactly as the
/// build does.
#[test]
fn app_version_resolves_from_package_json() {
    let package_json: serde_json::Value =
        serde_json::from_str(include_str!("../../package.json")).unwrap();
    let resolved = config().version;
    assert_eq!(resolved.as_deref(), package_json["version"].as_str());
    assert_eq!(resolved.as_deref(), Some(env!("CARGO_PKG_VERSION")));
}
