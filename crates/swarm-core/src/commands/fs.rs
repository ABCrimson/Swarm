//! `read_file` and `write_file`, confined to fixed directory scopes.
//!
//! Reads may touch the data directory and the home directory; writes
//! only the data directory and `~/.swarm`. Every path must be absolute.
//! It is normalized lexically (`..` and `.` resolved without touching
//! the filesystem), then canonicalized against the real filesystem
//! (symlinks resolved: for reads the file itself, for writes its parent
//! and, when it is a symlink, the target) before the scope check, so
//! neither a traversal nor a symlink inside a scope can climb out.
//!
//! A deny list applies to the canonical path of both reads and writes,
//! so the app's secrets can never be read through (or planted by) these
//! commands, whatever scope they sit in: `swarm-config.json` (it holds
//! the Anthropic API key) and `daemon-token` in the data directory,
//! along with the backup files named after them (for example
//! `swarm-config.json.corrupt-<ms>`), and the credential directories
//! `~/.ssh`, `~/.gnupg` and `~/.aws`. A hard link to a secret is not
//! detected.

use std::io;
use std::path::{Component, Path, PathBuf};

use serde::Deserialize;
use serde_json::Value;

use crate::events::{FileWrittenPayload, SwarmEvent};
use crate::git;

use super::{Ctx, ok_value, parse_args, parse_provenance};

/// File-name prefixes (compared lower-case) of the data-directory files
/// that hold credentials.
const DENIED_DATA_FILE_PREFIXES: [&str; 2] = ["swarm-config.json", "daemon-token"];

/// Home-relative directories that hold credentials.
const DENIED_HOME_DIRS: [&str; 3] = [".ssh", ".gnupg", ".aws"];

const DENIED_MESSAGE: &str = "This Path Holds Credentials And Is Never Accessible.";

/// The directories `read_file`/`write_file` may touch.
struct FsScopes {
    app_data: PathBuf,
    home: PathBuf,
}

/// A scope root with symlinks resolved; the lexical form when the root
/// does not exist (nothing can resolve through a missing directory).
fn canonical_root(root: &Path) -> PathBuf {
    std::fs::canonicalize(root).unwrap_or_else(|_| normalize_lexically(root))
}

impl FsScopes {
    fn resolve(ctx: &Ctx) -> Result<Self, Value> {
        let home = git::home_dir().map_err(|e| Value::String(e.to_string()))?;
        Ok(Self {
            app_data: ctx.paths.data_dir.clone(),
            home,
        })
    }

    /// Whether the canonical `real` path is on the deny list.
    fn is_denied(&self, real: &Path) -> bool {
        let app_data = canonical_root(&self.app_data);
        let home = canonical_root(&self.home);
        let secret_in_data_dir = real.parent() == Some(app_data.as_path())
            && real.file_name().is_some_and(|name| {
                let name = name.to_string_lossy().to_lowercase();
                DENIED_DATA_FILE_PREFIXES
                    .iter()
                    .any(|prefix| name.starts_with(prefix))
            });
        secret_in_data_dir
            || DENIED_HOME_DIRS
                .iter()
                .any(|dir| real.starts_with(home.join(dir)))
    }

    /// Resolves `path` to the real file a read would open, or the error
    /// to return. Blocks on the filesystem; call from `spawn_blocking`.
    fn check_read(&self, path: &Path) -> Result<PathBuf, Value> {
        let real = std::fs::canonicalize(normalize_lexically(path))
            .map_err(|e| Value::String(truthful_read_error(&e, &path.display().to_string())))?;
        if !real.starts_with(canonical_root(&self.app_data))
            && !real.starts_with(canonical_root(&self.home))
        {
            return Err(Value::String(
                "Read Access Is Limited To The App Data And Home Directories.".to_owned(),
            ));
        }
        if self.is_denied(&real) {
            return Err(Value::String(DENIED_MESSAGE.to_owned()));
        }
        Ok(real)
    }

    /// Resolves `path` to the real file a write would create or replace,
    /// or the error to return. Blocks on the filesystem; call from
    /// `spawn_blocking`.
    fn check_write(&self, path: &Path) -> Result<PathBuf, Value> {
        let normalized = normalize_lexically(path);
        let display = path.display().to_string();
        let (Some(parent), Some(name)) = (normalized.parent(), normalized.file_name()) else {
            return Err(Value::String("Write Requires A File Path.".to_owned()));
        };
        let real_parent = std::fs::canonicalize(parent)
            .map_err(|e| Value::String(truthful_write_error(&e, &display)))?;
        let mut real = real_parent.join(name);
        // A symlink at the target would redirect the write elsewhere.
        if std::fs::symlink_metadata(&real).is_ok_and(|meta| meta.is_symlink()) {
            real = std::fs::canonicalize(&real).map_err(|_| {
                Value::String(format!(
                    "Cannot Write \"{display}\": Dangling Symbolic Link."
                ))
            })?;
        }
        let swarm_home = canonical_root(&self.home.join(".swarm"));
        if !real.starts_with(canonical_root(&self.app_data)) && !real.starts_with(swarm_home) {
            return Err(Value::String(
                "Write Access Is Limited To The App Data And .swarm Directories.".to_owned(),
            ));
        }
        if self.is_denied(&real) {
            return Err(Value::String(DENIED_MESSAGE.to_owned()));
        }
        Ok(real)
    }
}

/// Resolves `.` and `..` components without touching the filesystem
/// (`..` at the root stays at the root).
fn normalize_lexically(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::ParentDir => {
                out.pop();
            }
            Component::CurDir => {}
            other => out.push(other.as_os_str()),
        }
    }
    out
}

fn truthful_read_error(err: &io::Error, path: &str) -> String {
    match err.kind() {
        io::ErrorKind::NotFound => format!("File Not Found: \"{path}\"."),
        io::ErrorKind::PermissionDenied => {
            format!("The Operating System Denied Access To \"{path}\".")
        }
        _ => format!("Failed To Read \"{path}\": {err}"),
    }
}

fn truthful_write_error(err: &io::Error, path: &str) -> String {
    match err.kind() {
        io::ErrorKind::PermissionDenied => {
            format!("The Operating System Denied Access To \"{path}\".")
        }
        io::ErrorKind::NotFound => {
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

    let contents = tokio::task::spawn_blocking(move || -> Result<String, Value> {
        let resolved = scopes.check_read(&candidate)?;
        std::fs::read_to_string(&resolved)
            .map_err(|e| Value::String(truthful_read_error(&e, &path)))
    })
    .await
    .map_err(|e| Value::String(e.to_string()))??;
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
    let provenance = parse_provenance(origin_worker, cause_seq)?;

    let bytes = content.len();
    let resolved = tokio::task::spawn_blocking(move || -> Result<PathBuf, Value> {
        let resolved = scopes.check_write(&candidate)?;
        std::fs::write(&resolved, content.as_bytes())
            .map_err(|e| Value::String(truthful_write_error(&e, &path)))?;
        Ok(resolved)
    })
    .await
    .map_err(|e| Value::String(e.to_string()))??;

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

    /// A unique temp tree with a data dir and a home dir, removed on drop.
    struct Tree {
        root: PathBuf,
        scopes: FsScopes,
    }

    impl Tree {
        fn new() -> Self {
            let root = std::fs::canonicalize(std::env::temp_dir())
                .unwrap()
                .join(format!("swarm-fs-test-{}", uuid::Uuid::new_v4()));
            let app_data = root.join("data");
            let home = root.join("home");
            std::fs::create_dir_all(&app_data).unwrap();
            std::fs::create_dir_all(home.join(".swarm")).unwrap();
            Self {
                root,
                scopes: FsScopes { app_data, home },
            }
        }
    }

    impl Drop for Tree {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }

    /// Creates a file symlink, or returns `false` where the host forbids
    /// it (Windows without developer mode).
    fn try_symlink(target: &Path, link: &Path) -> bool {
        #[cfg(unix)]
        let result = std::os::unix::fs::symlink(target, link);
        #[cfg(windows)]
        let result = std::os::windows::fs::symlink_file(target, link);
        result.is_ok()
    }

    fn denied() -> Result<PathBuf, Value> {
        Err(Value::String(DENIED_MESSAGE.to_owned()))
    }

    #[test]
    fn test_normalize_lexically_resolves_parent_dir_segments() {
        let normalized = normalize_lexically(Path::new("/home/user/../user/notes.txt"));
        assert_eq!(normalized, PathBuf::from("/home/user/notes.txt"));
    }

    #[test]
    fn test_scope_check_rejects_a_sibling_path_and_accepts_the_scopes() {
        let tree = Tree::new();
        let outside = tree.root.join("outside.txt");
        let note = tree.scopes.home.join("notes.txt");
        let in_swarm = tree.scopes.home.join(".swarm").join("x");
        std::fs::write(&outside, "o").unwrap();
        std::fs::write(&note, "n").unwrap();
        std::fs::write(&in_swarm, "s").unwrap();
        assert!(tree.scopes.check_read(&outside).is_err());
        assert!(tree.scopes.check_read(&note).is_ok());
        assert!(tree.scopes.check_write(&note).is_err());
        assert!(tree.scopes.check_write(&in_swarm).is_ok());
    }

    #[test]
    fn test_traversal_escaping_the_scope_is_refused_after_normalization() {
        let tree = Tree::new();
        std::fs::write(tree.root.join("outside.txt"), "o").unwrap();
        let sneaky = tree.scopes.home.join(".swarm/../../outside.txt");
        assert!(tree.scopes.check_read(&sneaky).is_err());
        assert!(tree.scopes.check_write(&sneaky).is_err());
    }

    #[test]
    fn test_read_and_write_deny_the_config_file_and_the_daemon_token() {
        let tree = Tree::new();
        for name in [
            "swarm-config.json",
            "swarm-config.json.corrupt-1760000000000",
            "daemon-token",
            "DAEMON-TOKEN",
        ] {
            let secret = tree.scopes.app_data.join(name);
            std::fs::write(&secret, "sk-ant-SECRET").unwrap();
            assert_eq!(
                tree.scopes.check_read(&secret),
                denied(),
                "{name} must be unreadable"
            );
            assert_eq!(
                tree.scopes.check_write(&secret),
                denied(),
                "{name} must be unwritable"
            );
        }
        let sessions = tree.scopes.app_data.join("sessions.json");
        std::fs::write(&sessions, "[]").unwrap();
        assert!(tree.scopes.check_read(&sessions).is_ok());
    }

    #[test]
    fn test_read_denies_credential_directories_under_home() {
        let tree = Tree::new();
        for dir in [".ssh", ".gnupg", ".aws"] {
            let dir = tree.scopes.home.join(dir);
            std::fs::create_dir_all(&dir).unwrap();
            let key = dir.join("id");
            std::fs::write(&key, "k").unwrap();
            assert_eq!(tree.scopes.check_read(&key), denied());
        }
    }

    #[test]
    fn test_read_resolves_a_symlink_to_its_real_target_before_the_checks() {
        let tree = Tree::new();
        let secret = tree.scopes.app_data.join("swarm-config.json");
        let outside = tree.root.join("outside.txt");
        std::fs::write(&secret, "sk-ant-SECRET").unwrap();
        std::fs::write(&outside, "o").unwrap();
        let to_secret = tree.scopes.home.join("innocent.txt");
        let to_outside = tree.scopes.home.join("escape.txt");
        if !try_symlink(&secret, &to_secret) || !try_symlink(&outside, &to_outside) {
            return;
        }
        // A link inside $HOME to a denied file, and one to a file outside every scope.
        assert_eq!(tree.scopes.check_read(&to_secret), denied());
        assert!(tree.scopes.check_read(&to_outside).is_err());
    }

    #[test]
    fn test_write_through_a_symlink_cannot_leave_the_write_scope() {
        let tree = Tree::new();
        let outside = tree.root.join("outside.txt");
        std::fs::write(&outside, "o").unwrap();
        let link = tree.scopes.home.join(".swarm").join("link.txt");
        if !try_symlink(&outside, &link) {
            return;
        }
        assert!(tree.scopes.check_write(&link).is_err());
    }

    #[test]
    fn test_write_to_a_missing_parent_reports_the_missing_directory() {
        let tree = Tree::new();
        let target = tree.scopes.home.join(".swarm/nope/x.txt");
        let err = tree.scopes.check_write(&target).unwrap_err();
        assert!(
            err.as_str()
                .unwrap()
                .contains("Parent Directory Does Not Exist")
        );
    }
}
