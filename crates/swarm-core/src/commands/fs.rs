//! `read_file` and `write_file`, confined to fixed directory scopes.
//!
//! Reads may touch the data directory and the home directory; writes
//! only the data directory and `~/.swarm`. Paths must be absolute and
//! are normalized lexically (`..` and `.` resolved without touching the
//! filesystem) before the scope check, so a traversal cannot climb out.

use std::path::{Path, PathBuf};

use serde::Deserialize;
use serde_json::Value;

use crate::events::{FileWrittenPayload, SwarmEvent};
use crate::git;

use super::{Ctx, ok_value, parse_args, parse_provenance};

/// The directories `read_file`/`write_file` may touch.
struct FsScopes {
    app_data: PathBuf,
    home: PathBuf,
}

impl FsScopes {
    fn resolve(ctx: &Ctx) -> Result<Self, Value> {
        let home = git::home_dir().map_err(|e| Value::String(e.to_string()))?;
        Ok(Self {
            app_data: ctx.paths.data_dir.clone(),
            home,
        })
    }

    fn check_read(&self, path: &Path) -> Result<PathBuf, Value> {
        let normalized = normalize_lexically(path);
        if normalized.starts_with(&self.app_data) || normalized.starts_with(&self.home) {
            Ok(normalized)
        } else {
            Err(Value::String(
                "Read Access Is Limited To The App Data And Home Directories.".to_owned(),
            ))
        }
    }

    fn check_write(&self, path: &Path) -> Result<PathBuf, Value> {
        let normalized = normalize_lexically(path);
        let swarm_home = self.home.join(".swarm");
        if normalized.starts_with(&self.app_data) || normalized.starts_with(&swarm_home) {
            Ok(normalized)
        } else {
            Err(Value::String(
                "Write Access Is Limited To The App Data And .swarm Directories.".to_owned(),
            ))
        }
    }
}

/// Resolves `.` and `..` components without touching the filesystem
/// (`..` at the root stays at the root).
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

#[derive(Deserialize)]
struct ReadFileArgs {
    path: String,
}

/// Reads a UTF-8 file inside the read scope.
pub async fn read_file(ctx: Ctx, args: Value) -> Result<Value, Value> {
    let ReadFileArgs { path } = parse_args(args)?;
    let candidate = PathBuf::from(&path);
    if !candidate.is_absolute() {
        return Err(Value::String("Read Requires An Absolute Path.".to_owned()));
    }
    let scopes = FsScopes::resolve(&ctx)?;
    let resolved = scopes.check_read(&candidate)?;

    let path_for_error = path.clone();
    let contents = tokio::task::spawn_blocking(move || std::fs::read_to_string(&resolved))
        .await
        .map_err(|e| Value::String(e.to_string()))?
        .map_err(|e| Value::String(truthful_read_error(&e, &path_for_error)))?;
    ok_value(&contents)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WriteFileArgs {
    path: String,
    content: String,
    #[serde(default)]
    origin_worker: Option<String>,
    #[serde(default)]
    cause_seq: Option<u64>,
}

/// Writes a file inside the write scope and records `file_written`.
pub async fn write_file(ctx: Ctx, args: Value) -> Result<Value, Value> {
    let WriteFileArgs {
        path,
        content,
        origin_worker,
        cause_seq,
    } = parse_args(args)?;
    let candidate = PathBuf::from(&path);
    if !candidate.is_absolute() {
        return Err(Value::String("Write Requires An Absolute Path.".to_owned()));
    }
    let scopes = FsScopes::resolve(&ctx)?;
    let resolved = scopes.check_write(&candidate)?;
    let provenance = parse_provenance(origin_worker, cause_seq)?;

    let bytes = content.len();
    let write_path = resolved.clone();
    let path_for_error = path.clone();
    tokio::task::spawn_blocking(move || std::fs::write(&write_path, content.as_bytes()))
        .await
        .map_err(|e| Value::String(e.to_string()))?
        .map_err(|e| Value::String(truthful_write_error(&e, &path_for_error)))?;

    ctx.sink.emit_with(
        SwarmEvent::FileWritten(FileWrittenPayload {
            path: resolved.display().to_string(),
            bytes,
        }),
        provenance,
    );

    ok_value(&())
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
    fn test_scope_check_rejects_a_sibling_path() {
        let scopes = FsScopes {
            app_data: PathBuf::from("/data/swarm"),
            home: PathBuf::from("/home/user"),
        };
        assert!(scopes.check_read(Path::new("/etc/passwd")).is_err());
        assert!(scopes.check_read(Path::new("/home/user/notes.txt")).is_ok());
        assert!(
            scopes
                .check_write(Path::new("/home/user/notes.txt"))
                .is_err()
        );
        assert!(scopes.check_write(Path::new("/home/user/.swarm/x")).is_ok());
    }

    #[test]
    fn test_traversal_escaping_the_scope_is_normalized_before_the_scope_check() {
        let escaped = normalize_lexically(Path::new("/home/user/.swarm/../../../etc/passwd"));
        assert_eq!(escaped, PathBuf::from("/etc/passwd"));
        assert!(!escaped.starts_with("/home/user/.swarm"));
    }
}
