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
    let attributes = tauri_build::Attributes::new()
        .app_manifest(tauri_build::AppManifest::new().commands(APP_COMMANDS));
    tauri_build::try_build(attributes).expect("failed to run tauri-build");
}
