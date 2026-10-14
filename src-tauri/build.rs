//! Generates the app's ACL manifest: every app command gets an
//! `allow-<command>` / `deny-<command>` permission, and a webview can
//! invoke only the ones its capability grants (`capabilities/default.json`).
//! The command names come from the same file `src/commands/mod.rs`
//! declares its forwarders from.

include!("src/commands/command_list.rs");

/// Every app command name, registry commands first.
macro_rules! names {
    (
        registry: [$($registry:ident),+ $(,)?],
        native: [$($native:ident),+ $(,)?] $(,)?
    ) => {
        &[$(stringify!($registry),)+ $(stringify!($native)),+]
    };
}

const APP_COMMANDS: &[&str] = command_list!(names);

fn main() {
    println!("cargo:rerun-if-changed=src/commands/command_list.rs");
    let mut attributes = tauri_build::Attributes::new()
        .app_manifest(tauri_build::AppManifest::new().commands(APP_COMMANDS));
    if targets_windows_msvc() {
        // tauri-build embeds its Common Controls v6 manifest as a resource
        // that embed-resource links with `cargo:rustc-link-arg-bins`, so only
        // the app binary carries it. The lib's unit-test harness and the
        // integration tests link without it: the loader then binds the
        // System32 comctl32.dll 5.82, which lacks v6-only exports such as
        // the TaskDialogIndirect that muda (tauri's menus) and rfd
        // (tauri-plugin-dialog) import under their `common-controls-v6`
        // features, and the test exe dies before `main` with 0xc0000139
        // STATUS_ENTRYPOINT_NOT_FOUND. The linker embeds the same
        // manifest into every executable instead (`cargo:rustc-link-arg`
        // reaches the bin, the lib test harness and tests/*.rs alike), and
        // tauri-build's copy is dropped because an exe holds one manifest.
        attributes = attributes
            .windows_attributes(tauri_build::WindowsAttributes::new_without_app_manifest());
        embed_manifest_in_every_executable();
    }
    tauri_build::try_build(attributes).expect("failed to run tauri-build");
}

/// Whether this build targets Windows with the MSVC linker. A build script
/// reads the target from Cargo's `CARGO_CFG_*` variables: its own `cfg!`
/// describes the host it runs on.
fn targets_windows_msvc() -> bool {
    std::env::var_os("CARGO_CFG_TARGET_OS").is_some_and(|os| os == "windows")
        && std::env::var_os("CARGO_CFG_TARGET_ENV").is_some_and(|env| env == "msvc")
}

/// Has link.exe embed `windows-app-manifest.xml` into every executable this
/// package links (the same workaround Tauri's own workspace applies to its
/// tests, tauri/build.rs `embed_manifest_for_tests`).
fn embed_manifest_in_every_executable() {
    const MANIFEST: &str = "windows-app-manifest.xml";
    println!("cargo:rerun-if-changed={MANIFEST}");
    let manifest_dir =
        std::env::var_os("CARGO_MANIFEST_DIR").expect("cargo sets CARGO_MANIFEST_DIR");
    let manifest = std::path::Path::new(&manifest_dir).join(MANIFEST);
    println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
    println!("cargo:rustc-link-arg=/MANIFESTINPUT:{}", manifest.display());
}
