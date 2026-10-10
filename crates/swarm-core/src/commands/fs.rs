//! `read_file` and `write_file`, confined to fixed directory scopes.
//!
//! Reads may touch the data directory and the home directory; writes
//! only the data directory and `~/.swarm`. Every path must be absolute.
//! It is normalized lexically (`..` and `.` resolved without touching
//! the filesystem) and canonicalized against the real filesystem
//! (symlinks resolved: for reads the file itself, for writes its parent
//! and, when the target already exists, the target itself) before the
//! scope check, so neither a traversal nor a symlink inside a scope can
//! climb out. When canonicalization fails, the lexical form only picks
//! the error: a path outside every scope gets the scope error whether or
//! not it exists, so a missing path elsewhere on disk cannot be told
//! from an existing one.
//! Canonicalizing an existing write target also expands Windows 8.3
//! short names (`SWARM-~1.JSO`) to the real name the deny list sees. On
//! Windows a write is refused outright when its file name contains `:`
//! (an NTFS alternate data stream), ends in `.` or a space, or is a
//! reserved device name (`CON`, `NUL`, `COM1`, `COM¹`, ...), with or
//! without an extension. The superscript digits `¹ ² ³` are reserved
//! after `COM` and `LPT` just like `1`..`3`.
//!
//! A deny list applies to the canonical path of both reads and writes,
//! so the app's secrets can never be read through (or planted by) these
//! commands, whatever scope they sit in: `swarm-config.json` (it holds
//! the Anthropic API key) and `daemon-token` in the data directory,
//! along with the backup files named after them (for example
//! `swarm-config.json.corrupt-<ms>`, or the daemon's `.daemon-token.<rand>`
//! mint-time temp file, compared with leading dots ignored), and the
//! credential stores under `~` that the capability's fs:scope deny list
//! covers: `.ssh`, `.gnupg`, `.aws`, `.azure`, `.kube`, `.docker`,
//! `.config/gh`, `.claude`, `.codex`, `.git-credentials`, `.netrc`. A
//! hard link to a secret is not detected.

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

/// Home-relative directories and files that hold credentials (the
/// fs:scope deny list in `src-tauri/capabilities/default.json`).
const DENIED_HOME_ENTRIES: [&str; 11] = [
    ".ssh",
    ".gnupg",
    ".aws",
    ".azure",
    ".kube",
    ".docker",
    ".config/gh",
    ".claude",
    ".codex",
    ".git-credentials",
    ".netrc",
];

const DENIED_MESSAGE: &str = "This Path Holds Credentials And Is Never Accessible.";

const READ_SCOPE_MESSAGE: &str = "Read Access Is Limited To The App Data And Home Directories.";

const WRITE_SCOPE_MESSAGE: &str = "Write Access Is Limited To The App Data And .swarm Directories.";

/// Windows device names that open a device instead of a file.
const WINDOWS_DEVICE_NAMES: [&str; 4] = ["con", "prn", "aux", "nul"];

/// Windows device names followed by a digit 1-9.
const WINDOWS_NUMBERED_DEVICES: [&str; 2] = ["com", "lpt"];

/// Whether `name` cannot be an ordinary file name on Windows: it holds
/// `:` (an alternate data stream), ends in `.` or a space (stripped by
/// Win32, so it aliases the name without it), or its stem before the
/// first `.` is a reserved device name. Platform-independent; callers
/// apply it where Windows semantics hold.
fn invalid_windows_name(name: &str) -> bool {
    if name.contains(':') || name.ends_with('.') || name.ends_with(' ') {
        return true;
    }
    let stem = name.split('.').next().unwrap_or(name).to_lowercase();
    WINDOWS_DEVICE_NAMES.contains(&stem.as_str())
        || WINDOWS_NUMBERED_DEVICES.iter().any(|device| {
            stem.strip_prefix(device).is_some_and(|digit| {
                matches!(
                    digit,
                    "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "¹" | "²" | "³"
                )
            })
        })
}

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
                let name = name.trim_start_matches('.');
                DENIED_DATA_FILE_PREFIXES
                    .iter()
                    .any(|prefix| name.starts_with(prefix))
            });
        secret_in_data_dir
            || DENIED_HOME_ENTRIES
                .iter()
                .any(|entry| real.starts_with(home.join(entry)))
    }

    /// Whether `normalized` sits under any of `roots` (as given or with
    /// symlinks resolved), judged without touching `normalized` itself.
    /// The comparison is case-sensitive and blind to 8.3 short names, so
    /// it never grants or refuses access: it only picks which error to
    /// return once `canonicalize` has failed (a missing path outside the
    /// scopes must not reveal whether it exists).
    fn lexically_within(&self, normalized: &Path, roots: &[&Path]) -> bool {
        roots.iter().any(|root| {
            normalized.starts_with(root) || normalized.starts_with(canonical_root(root))
        })
    }

    /// Resolves `path` to the real file a read would open, or the error
    /// to return. Blocks on the filesystem; call from `spawn_blocking`.
    fn check_read(&self, path: &Path) -> Result<PathBuf, Value> {
        let normalized = normalize_lexically(path);
        let real = match std::fs::canonicalize(&normalized) {
            Ok(real) => real,
            Err(_) if !self.lexically_within(&normalized, &[&self.app_data, &self.home]) => {
                return Err(Value::String(READ_SCOPE_MESSAGE.to_owned()));
            }
            Err(e) => {
                return Err(Value::String(truthful_read_error(
                    &e,
                    &path.display().to_string(),
                )));
            }
        };
        if !real.starts_with(canonical_root(&self.app_data))
            && !real.starts_with(canonical_root(&self.home))
        {
            return Err(Value::String(READ_SCOPE_MESSAGE.to_owned()));
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
        if cfg!(windows) && invalid_windows_name(&name.to_string_lossy()) {
            return Err(Value::String(format!(
                "Cannot Write \"{display}\": The File Name Is Not Allowed."
            )));
        }
        let swarm_dir = self.home.join(".swarm");
        let app_data_real = canonical_root(&self.app_data);
        let swarm_home = canonical_root(&swarm_dir);
        let in_scope = |p: &Path| p.starts_with(&app_data_real) || p.starts_with(&swarm_home);
        let real_parent = match std::fs::canonicalize(parent) {
            Ok(real_parent) => real_parent,
            Err(_) if !self.lexically_within(&normalized, &[&self.app_data, &swarm_dir]) => {
                return Err(Value::String(WRITE_SCOPE_MESSAGE.to_owned()));
            }
            Err(e) => return Err(Value::String(truthful_write_error(&e, &display))),
        };
        let mut real = real_parent.join(name);
        // An existing entry may be a symlink (redirecting the write) or
        // reached through an 8.3 short name; its canonical form is the
        // file the write would really replace. Outside the scopes the
        // failure stays the scope error, so no entry's existence leaks.
        if std::fs::symlink_metadata(&real).is_ok() {
            real = std::fs::canonicalize(&real).map_err(|_| {
                if in_scope(&real_parent) {
                    Value::String(format!(
                        "Cannot Write \"{display}\": Dangling Symbolic Link."
                    ))
                } else {
                    Value::String(WRITE_SCOPE_MESSAGE.to_owned())
                }
            })?;
        }
        if !in_scope(&real) {
            return Err(Value::String(WRITE_SCOPE_MESSAGE.to_owned()));
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
    let event_path = normalize_lexically(&candidate).display().to_string();
    let scopes = FsScopes::resolve(&ctx)?;
    let provenance = parse_provenance(origin_worker, cause_seq)?;

    let bytes = content.len();
    tokio::task::spawn_blocking(move || -> Result<(), Value> {
        let resolved = scopes.check_write(&candidate)?;
        std::fs::write(&resolved, content.as_bytes())
            .map_err(|e| Value::String(truthful_write_error(&e, &path)))
    })
    .await
    .map_err(|e| Value::String(e.to_string()))??;

    ctx.sink.emit_with(
        SwarmEvent::FileWritten(FileWrittenPayload {
            path: event_path,
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

        // A missing target: canonicalize fails, so only the lexical
        // normalization stops `..` from matching a scope by prefix.
        let missing = tree.scopes.home.join(".swarm/../../elsewhere/nope.txt");
        assert_eq!(
            tree.scopes.check_read(&missing).unwrap_err().as_str(),
            Some(READ_SCOPE_MESSAGE)
        );
        assert_eq!(
            tree.scopes.check_write(&missing).unwrap_err().as_str(),
            Some(WRITE_SCOPE_MESSAGE)
        );
    }

    #[test]
    fn test_read_and_write_deny_the_config_file_and_the_daemon_token() {
        let tree = Tree::new();
        for name in [
            "swarm-config.json",
            "swarm-config.json.corrupt-1760000000000",
            "daemon-token",
            "DAEMON-TOKEN",
            ".daemon-token.abc123",
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
    fn test_read_denies_credential_stores_under_home() {
        let tree = Tree::new();
        for entry in DENIED_HOME_ENTRIES {
            let entry = tree.scopes.home.join(entry);
            let secret = if matches!(
                entry.file_name().and_then(|name| name.to_str()),
                Some(".git-credentials" | ".netrc")
            ) {
                entry
            } else {
                std::fs::create_dir_all(&entry).unwrap();
                entry.join("id")
            };
            std::fs::write(&secret, "k").unwrap();
            assert_eq!(tree.scopes.check_read(&secret), denied(), "{secret:?}");
        }
        let other = tree.scopes.home.join(".config/other.txt");
        std::fs::write(&other, "o").unwrap();
        assert!(tree.scopes.check_read(&other).is_ok());
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
    fn test_a_dangling_link_outside_the_scopes_gets_the_scope_error() {
        let tree = Tree::new();
        let link = tree.root.join("dangling.txt");
        if !try_symlink(&tree.root.join("nowhere"), &link) {
            return;
        }
        assert_eq!(
            tree.scopes.check_write(&link).unwrap_err().as_str(),
            Some(WRITE_SCOPE_MESSAGE)
        );
    }

    #[cfg(unix)]
    #[test]
    fn test_a_path_reaching_a_scope_through_an_outside_alias_is_judged_by_its_real_path() {
        let tree = Tree::new();
        std::fs::write(tree.scopes.home.join("notes.txt"), "n").unwrap();
        let alias = tree.root.join("home-alias");
        std::os::unix::fs::symlink(&tree.scopes.home, &alias).unwrap();
        assert!(tree.scopes.check_read(&alias.join("notes.txt")).is_ok());
        let sw = tree.root.join("swarm-alias");
        std::os::unix::fs::symlink(tree.scopes.home.join(".swarm"), &sw).unwrap();
        assert!(tree.scopes.check_write(&sw.join("new.txt")).is_ok());
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

    #[test]
    fn test_invalid_windows_name_flags_streams_trailing_dots_and_devices() {
        for name in [
            "swarm-config.json:x",
            "swarm-config.json::$DATA",
            "swarm-config.json.",
            "swarm-config.json ",
            "CON",
            "con.txt",
            "LPT9.log",
            "COM¹",
            "lpt².log",
            "notes.txt:x",
            "notes.txt.",
            "notes.txt ",
            "NUL.txt",
        ] {
            assert!(invalid_windows_name(name), "{name} must be refused");
        }
        for name in ["notes.txt", "console.log", "com0", "lpt10", "COM1x"] {
            assert!(!invalid_windows_name(name), "{name} must be allowed");
        }
    }

    #[test]
    fn test_a_missing_file_outside_the_scopes_gets_the_scope_error() {
        let tree = Tree::new();
        let missing = tree.root.join("elsewhere/missing.txt");
        let read = tree.scopes.check_read(&missing).unwrap_err();
        assert_eq!(read.as_str(), Some(READ_SCOPE_MESSAGE));
        let write = tree.scopes.check_write(&missing).unwrap_err();
        assert_eq!(write.as_str(), Some(WRITE_SCOPE_MESSAGE));
    }

    #[cfg(windows)]
    #[test]
    #[expect(
        unsafe_code,
        reason = "calls the Win32 GetShortPathNameW, which has no safe std wrapper"
    )]
    fn test_windows_short_name_of_a_secret_is_denied() {
        use std::os::windows::ffi::{OsStrExt, OsStringExt};

        unsafe extern "system" {
            fn GetShortPathNameW(long: *const u16, short: *mut u16, len: u32) -> u32;
        }

        let tree = Tree::new();
        let secret = tree.scopes.app_data.join("swarm-config.json");
        std::fs::write(&secret, "sk-ant-SECRET").unwrap();
        let wide: Vec<u16> = secret.as_os_str().encode_wide().chain([0]).collect();
        let mut buf = vec![0u16; 1024];
        // SAFETY: `wide` is NUL-terminated and `buf` is writable for its length.
        let n = unsafe { GetShortPathNameW(wide.as_ptr(), buf.as_mut_ptr(), buf.len() as u32) };
        if n == 0 || n as usize >= buf.len() {
            return;
        }
        let short = PathBuf::from(std::ffi::OsString::from_wide(&buf[..n as usize]));
        if short.file_name() == secret.file_name() {
            return; // 8.3 names are off on this volume
        }
        assert_eq!(tree.scopes.check_write(&short), denied());
        assert_eq!(tree.scopes.check_read(&short), denied());
    }

    #[cfg(windows)]
    #[test]
    fn test_windows_invalid_names_are_refused_with_the_name_message() {
        let tree = Tree::new();
        // None of these is on the deny list, so only the invalid-name
        // refusal can turn them away.
        for name in ["notes.txt:x", "notes.txt.", "NUL.txt"] {
            let target = tree.scopes.app_data.join(name);
            let err = tree.scopes.check_write(&target).unwrap_err();
            let message = err.as_str().unwrap();
            assert!(
                message.ends_with("The File Name Is Not Allowed."),
                "{name}: {message}"
            );
        }
    }
}
