//! File system commands.
//!
//! `read_file`/`write_file`: real Rust commands with path validation
//! matching the scopes `tauri-plugin-fs` enforces declaratively for the
//! app's own scoped file access (`src-tauri/capabilities/default.json`):
//! reads permitted under `$APPDATA/**` and `$HOME/**`, writes permitted
//! under `$APPDATA/**` and `$HOME/.swarm/**`. That capability scope
//! does not apply here — these are plain custom commands, not
//! `tauri-plugin-fs` calls — so the same boundary is enforced by hand
//! in [`FsScopes`], with the identical truthful, Title Case error
//! messages the plugin-fs path already surfaces (`#lib/fs.ts`'s
//! `toAbsolutePathError`), so a model-supplied path is held to the same
//! boundary and gets the same wording regardless of which mechanism
//! handles it.
//!
//! `write_file` emits a stamped, persisted `file_written` event on
//! success — write only; a read is not a causally interesting side
//! effect and emits nothing. `tools.ts`'s `read_file`/`write_file` AI
//! tools invoke these commands (migrated off the plugin-fs path so file
//! writes join the causality graph — see docs/architecture.md's
//! "Ordered Event Core" section, and its "The honest v1 attribution
//! table" in particular); `#lib/fs.ts` backs unrelated, non-tool UI
//! file access and is unaffected by this migration.

use std::path::{Path, PathBuf};

use swarm_core::events::{EventSink, FileWrittenPayload, SwarmEvent};
use swarm_core::git;

use crate::commands::parse_provenance;

/// Read/write base directories, resolved once per call.
struct FsScopes {
    app_data: PathBuf,
    home: PathBuf,
}

impl FsScopes {
    fn resolve(app: &tauri::AppHandle) -> Result<Self, String> {
        let app_data = crate::resolve_paths(app)
            .map_err(|e| e.to_string())?
            .data_dir;
        let home = git::home_dir().map_err(|e| e.to_string())?;
        Ok(Self { app_data, home })
    }

    /// Reads are permitted under `$APPDATA/**` and `$HOME/**`.
    fn check_read(&self, path: &Path) -> Result<PathBuf, String> {
        let normalized = normalize_lexically(path);
        if within(&normalized, &self.app_data) || within(&normalized, &self.home) {
            Ok(normalized)
        } else {
            Err("Read Access Is Limited To The App Data And Home Directories.".to_string())
        }
    }

    /// Writes are permitted under `$APPDATA/**` and `$HOME/.swarm/**`.
    fn check_write(&self, path: &Path) -> Result<PathBuf, String> {
        let normalized = normalize_lexically(path);
        let swarm_home = self.home.join(".swarm");
        if within(&normalized, &self.app_data) || within(&normalized, &swarm_home) {
            Ok(normalized)
        } else {
            Err("Write Access Is Limited To The App Data And .swarm Directories.".to_string())
        }
    }
}

/// Lexically resolves `.`/`..` components without touching the
/// filesystem (the target of a `write_file` call may not exist yet, so
/// `std::fs::canonicalize` — which requires the full path to already
/// exist — is not usable here). Not symlink-proof; matches the
/// lexical-normalization boundary `tauri-plugin-fs` itself applies for
/// its declarative scopes.
fn normalize_lexically(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            std::path::Component::ParentDir => {
                out.pop();
            }
            std::path::Component::CurDir => {}
            other => out.push(other.as_os_str()),
        }
    }
    out
}

fn within(candidate: &Path, base: &Path) -> bool {
    candidate.starts_with(base)
}

fn truthful_read_error(err: &std::io::Error, path: &str) -> String {
    match err.kind() {
        std::io::ErrorKind::NotFound => format!("File Not Found: \"{path}\"."),
        std::io::ErrorKind::PermissionDenied => {
            format!("The Operating System Denied Access To \"{path}\".")
        }
        _ => format!("Failed To Read \"{path}\": {err}"),
    }
}

fn truthful_write_error(err: &std::io::Error, path: &str) -> String {
    match err.kind() {
        std::io::ErrorKind::PermissionDenied => {
            format!("The Operating System Denied Access To \"{path}\".")
        }
        std::io::ErrorKind::NotFound => {
            format!("Cannot Write \"{path}\": Parent Directory Does Not Exist.")
        }
        _ => format!("Failed To Write \"{path}\": {err}"),
    }
}

/// Reads a file at an absolute path, scoped to `$APPDATA/**` and
/// `$HOME/**`.
///
/// # Arguments
///
/// * `app` - Tauri app handle (injected by Tauri)
/// * `path` - Absolute path to read
///
/// # Errors
///
/// Returns a `String` error if:
/// - `path` is not absolute
/// - `path` falls outside the read scope
/// - The file does not exist, or the OS denies access
#[tauri::command]
#[tracing::instrument(skip(app))]
pub async fn read_file(app: tauri::AppHandle, path: String) -> Result<String, String> {
    let candidate = PathBuf::from(&path);
    if !candidate.is_absolute() {
        return Err("Read Requires An Absolute Path.".to_string());
    }
    let scopes = FsScopes::resolve(&app)?;
    let resolved = scopes.check_read(&candidate)?;

    let path_for_error = path.clone();
    tokio::task::spawn_blocking(move || std::fs::read_to_string(&resolved))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| truthful_read_error(&e, &path_for_error))
}

/// Writes a file at an absolute path, scoped to `$APPDATA/**` and
/// `$HOME/.swarm/**`. Emits a stamped, persisted `file_written` event
/// on success.
///
/// # Arguments
///
/// * `app` - Tauri app handle (injected by Tauri)
/// * `sink` - Event sink for recording the `file_written` event (managed state)
/// * `path` - Absolute path to write (created or overwritten)
/// * `content` - Text content to write
/// * `originWorker`/`causeSeq` - Optional causal attribution (e.g. the
///   AI turn whose `write_file` tool call triggered this write)
///
/// # Errors
///
/// Returns a `String` error if:
/// - `path` is not absolute
/// - `path` falls outside the write scope
/// - `originWorker` is present but not a valid UUID
/// - The write fails (parent directory missing, OS denies access, disk full, ...)
#[tauri::command]
#[tracing::instrument(skip(app, sink, content))]
pub async fn write_file(
    app: tauri::AppHandle,
    sink: tauri::State<'_, EventSink>,
    path: String,
    content: String,
    origin_worker: Option<String>,
    cause_seq: Option<u64>,
) -> Result<(), String> {
    let candidate = PathBuf::from(&path);
    if !candidate.is_absolute() {
        return Err("Write Requires An Absolute Path.".to_string());
    }
    let scopes = FsScopes::resolve(&app)?;
    let resolved = scopes.check_write(&candidate)?;
    let provenance = parse_provenance(origin_worker, cause_seq)?;
    let sink = sink.inner().clone();

    let bytes = content.len();
    let write_path = resolved.clone();
    let path_for_error = path.clone();
    tokio::task::spawn_blocking(move || std::fs::write(&write_path, content.as_bytes()))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| truthful_write_error(&e, &path_for_error))?;

    sink.emit_with(
        SwarmEvent::FileWritten(FileWrittenPayload {
            path: resolved.display().to_string(),
            bytes,
        }),
        provenance,
    );

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_normalize_lexically_resolves_parent_dir_segments() {
        let normalized = normalize_lexically(Path::new("/home/user/../user/notes.txt"));
        assert_eq!(normalized, PathBuf::from("/home/user/notes.txt"));
    }

    #[test]
    fn test_normalize_lexically_drops_current_dir_segments() {
        let normalized = normalize_lexically(Path::new("/home/./user/./notes.txt"));
        assert_eq!(normalized, PathBuf::from("/home/user/notes.txt"));
    }

    #[test]
    fn test_within_accepts_nested_path() {
        assert!(within(
            Path::new("/home/user/.swarm/out.txt"),
            Path::new("/home/user/.swarm")
        ));
    }

    #[test]
    fn test_within_rejects_sibling_path() {
        assert!(!within(Path::new("/etc/passwd"), Path::new("/home/user")));
    }

    #[test]
    fn test_traversal_escaping_the_scope_is_normalized_before_the_scope_check() {
        // A model-supplied path trying to escape $HOME/.swarm via `..`
        // must normalize to its real (out-of-scope) target BEFORE the
        // scope check runs, not be compared as a raw string.
        let escaped = normalize_lexically(Path::new("/home/user/.swarm/../../../etc/passwd"));
        assert_eq!(escaped, PathBuf::from("/etc/passwd"));
        assert!(!within(&escaped, Path::new("/home/user/.swarm")));
    }

    #[test]
    fn test_truthful_read_error_distinguishes_not_found_from_permission_denied() {
        let not_found = std::io::Error::from(std::io::ErrorKind::NotFound);
        let denied = std::io::Error::from(std::io::ErrorKind::PermissionDenied);
        assert!(truthful_read_error(&not_found, "/x").contains("File Not Found"));
        assert!(truthful_read_error(&denied, "/x").contains("Operating System Denied"));
    }
}
