//! Folder grants that also reach dot entries on macOS and Linux.
//!
//! Opening a folder in a dialog grants it on tauri-plugin-fs's runtime
//! scope as a `<folder>/**` (or `<folder>/*`) glob. That scope is built
//! with Tauri's default match options, under which `*` and `**` never
//! match a path component starting with `.` on Unix, and the plugin's
//! `requireLiteralLeadingDot` setting does not change them. So on macOS
//! and Linux `.github/`, `.gitignore` and `.env.example` inside an opened
//! workspace would stay unreadable (Windows matches dots either way).
//!
//! The fs commands also allow a path that the capability's global
//! `fs:scope` allows, and that scope is matched with the plugin setting,
//! which tauri.conf.json turns off (`requireLiteralLeadingDot: false`).
//! [`mirror_dialog_grants`] therefore copies every folder grant into it
//! as a runtime capability. Nothing else is widened: the grant covers the
//! same folder with the same depth, and the capability's deny list (the
//! app data directory, credential stores) still wins over it.

use std::path::Path;

use tauri::ipc::CapabilityBuilder;
use tauri::scope::fs::{Event, Scope};
use tauri::{AppHandle, Manager};
use tauri_plugin_fs::FsExt;

/// Identifier of the runtime capabilities that carry mirrored grants.
const CAPABILITY: &str = "dialog-grants";

/// Label of the window the capability applies to, as in
/// capabilities/default.json.
const MAIN_WINDOW: &str = "main";

/// Mirrors every folder the fs scope grants from now on (an open dialog,
/// a drag and drop) into the global `fs:scope`. Called once, from the
/// app's `setup` hook, after tauri-plugin-fs is initialized.
pub(crate) fn mirror_dialog_grants<R: tauri::Runtime>(app: &AppHandle<R>) {
    let scope = app.fs_scope();
    let grants = scope.clone();
    let app = app.clone();
    scope.listen(move |event| {
        let Event::PathAllowed(path) = event else {
            return;
        };
        let patterns = folder_patterns(&grants, path);
        if patterns.is_empty() {
            return;
        }
        let capability = CapabilityBuilder::new(CAPABILITY)
            .window(MAIN_WINDOW)
            .permission_scoped(
                "fs:scope",
                patterns
                    .into_iter()
                    .map(|path| serde_json::json!({ "path": path }))
                    .collect(),
                Vec::<serde_json::Value>::new(),
            );
        if let Err(error) = app.add_capability(capability) {
            tracing::warn!(%error, path = %path.display(), "failed to mirror a folder grant");
        }
    });
}

/// The patterns in `scope` that grant the entries of the folder `path`:
/// `<path>/**` for a recursive grant, `<path>/*` for a flat one, exactly
/// as Tauri escaped and stored them. Empty when `path` is not a folder
/// (a file grant names its file literally and needs no mirror).
fn folder_patterns(scope: &Scope, path: &Path) -> Vec<String> {
    if !path.is_dir() {
        return Vec::new();
    }
    // A child's name is never a glob metacharacter sequence, so only a
    // pattern ending in `*` or `**` right under `path` matches it.
    let child = path.join("swarm-grant-probe");
    scope
        .allowed_patterns()
        .into_iter()
        .filter(|pattern| pattern.matches_path(&child))
        .map(|pattern| pattern.as_str().to_owned())
        .collect()
}

#[cfg(test)]
mod tests {
    use serde_json::json;
    use tauri::ipc::{CallbackFn, InvokeBody};
    use tauri::test::{INVOKE_KEY, MockRuntime, get_ipc_response, mock_builder};
    use tauri::webview::InvokeRequest;
    use tauri::{App, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

    use super::*;
    use crate::test_support::temp_dir;

    /// The app's real tauri.conf.json and capabilities (the generated
    /// context carries the resolved ACL), with tauri-plugin-fs and the
    /// grant mirror installed as `run` installs them, and the main window
    /// the capability applies to. A mock app never runs its event loop,
    /// so neither the `setup` hook nor the configured window creation
    /// happens by itself.
    fn app() -> (App<MockRuntime>, WebviewWindow<MockRuntime>) {
        let app = mock_builder()
            .plugin(tauri_plugin_fs::init())
            .build(tauri::generate_context!(test = true))
            .unwrap();
        mirror_dialog_grants(app.handle());
        let main = WebviewWindowBuilder::new(&app, MAIN_WINDOW, WebviewUrl::default())
            .build()
            .unwrap();
        (app, main)
    }

    /// `readTextFile(path)` from the webview, which fs 3.0.0-alpha.2
    /// serves through the `read_file` command.
    fn read_file(webview: &WebviewWindow<MockRuntime>, path: &Path) -> Result<(), String> {
        get_ipc_response(
            webview,
            InvokeRequest {
                cmd: "plugin:fs|read_file".into(),
                callback: CallbackFn(0),
                error: CallbackFn(1),
                url: "tauri://localhost".parse().unwrap(),
                body: InvokeBody::Json(json!({ "path": path })),
                headers: Default::default(),
                invoke_key: INVOKE_KEY.to_owned(),
            },
        )
        .map(drop)
        .map_err(|error| error.to_string())
    }

    /// A workspace folder opened recursively in a dialog is readable
    /// throughout, dot entries included, and nothing outside it is.
    #[test]
    fn a_granted_folder_is_readable_with_its_dot_entries() {
        let dir = temp_dir("dialog-grants");
        let workspace = dir.join("workspace");
        for file in [
            ".gitignore",
            ".github/workflows/ci.yml",
            "src/.env.example",
            "README.md",
        ] {
            let file = workspace.join(file);
            std::fs::create_dir_all(file.parent().unwrap()).unwrap();
            std::fs::write(&file, "x").unwrap();
        }
        std::fs::write(dir.join("outside.txt"), "x").unwrap();
        let workspace = std::fs::canonicalize(&workspace).unwrap();
        let (app, main) = app();

        // What the dialog plugin does with a folder picked in
        // `open({ directory: true, recursive: true })`.
        app.fs_scope().allow_directory(&workspace, true).unwrap();

        for file in [
            ".gitignore",
            ".github/workflows/ci.yml",
            "src/.env.example",
            "README.md",
        ] {
            let path = workspace.join(file);
            assert_eq!(read_file(&main, &path), Ok(()), "{}", path.display());
        }
        let outside = workspace.parent().unwrap().join("outside.txt");
        assert!(read_file(&main, &outside).is_err());
    }

    /// A flat grant stays flat: its direct entries (dot files included)
    /// are readable, nested ones are not.
    #[test]
    fn a_flat_folder_grant_stays_flat() {
        let dir = temp_dir("dialog-grants-flat");
        for file in [".env", "nested/file.txt"] {
            let file = dir.join(file);
            std::fs::create_dir_all(file.parent().unwrap()).unwrap();
            std::fs::write(&file, "x").unwrap();
        }
        let folder = std::fs::canonicalize(&*dir).unwrap();
        let (app, main) = app();

        app.fs_scope().allow_directory(&folder, false).unwrap();

        assert_eq!(read_file(&main, &folder.join(".env")), Ok(()));
        assert!(read_file(&main, &folder.join("nested/file.txt")).is_err());
    }

    /// A file grant (a save dialog) needs and gets no mirror, even inside
    /// a folder the scope already grants recursively, whose `<folder>/**`
    /// would otherwise match a probe under the file.
    #[test]
    fn file_grants_are_not_mirrored() {
        let dir = temp_dir("dialog-grants-file");
        let file = dir.join("export.json");
        std::fs::write(&file, "{}").unwrap();
        let (app, _main) = app();

        app.fs_scope().allow_directory(&*dir, true).unwrap();
        app.fs_scope().allow_file(&file).unwrap();

        assert!(folder_patterns(&app.fs_scope(), &file).is_empty());
    }
}
