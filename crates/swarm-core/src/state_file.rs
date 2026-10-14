//! Small JSON state files in the data directory (`swarm-config.json`,
//! `sessions.json`): reading one without ever mistaking damage for
//! "empty", and replacing one atomically and durably.
//!
//! A reader that treated an unreadable or malformed file as empty would
//! make the next read-modify-write silently drop every value the file
//! held. [`read_object`] therefore reports [`StoredObject::Malformed`]
//! and I/O errors distinctly, and [`quarantine`] moves a malformed file
//! aside so a fresh write cannot destroy it.

use std::fs::{self, File, OpenOptions};
use std::io::{self, ErrorKind, Write};
use std::path::{Path, PathBuf};

use serde_json::{Map, Value};

/// What a state file currently holds.
#[derive(Debug)]
pub(crate) enum StoredObject {
    /// No file yet.
    Missing,
    /// A JSON object. An empty or whitespace-only file reads as an empty
    /// object: it holds nothing that a write could lose.
    Object(Map<String, Value>),
    /// The file exists but is not a JSON object.
    Malformed,
}

/// Reads `path` as a JSON object.
///
/// # Errors
///
/// Any I/O error other than `NotFound` (for example a permission
/// error, or a Windows sharing violation while another program holds
/// the file). Callers must not overwrite a file they could not read.
pub(crate) fn read_object(path: &Path) -> io::Result<StoredObject> {
    let contents = match fs::read_to_string(path) {
        Ok(contents) => contents,
        Err(e) if e.kind() == ErrorKind::NotFound => return Ok(StoredObject::Missing),
        Err(e) if e.kind() == ErrorKind::InvalidData => return Ok(StoredObject::Malformed),
        Err(e) => return Err(e),
    };
    if contents.trim().is_empty() {
        return Ok(StoredObject::Object(Map::new()));
    }
    Ok(serde_json::from_str(&contents).map_or(StoredObject::Malformed, StoredObject::Object))
}

/// Renames a malformed `path` to `<path>.corrupt-<unix ms>`, keeping it
/// for manual recovery, and returns the new path.
pub(crate) fn quarantine(path: &Path) -> io::Result<PathBuf> {
    let aside = path.with_added_extension(format!("corrupt-{}", crate::clock::unix_millis()));
    fs::rename(path, &aside)?;
    Ok(aside)
}

/// Replaces `path` with `contents` so that a crash or power loss leaves
/// either the old file or the complete new one, never a truncated mix.
///
/// Writes a sibling `<path>.tmp` (created fresh — a stale one is
/// removed first, and on Unix it is created `0600`, owner-only, since
/// these files can hold secrets), flushes it to disk, renames it over
/// `path`, and on Unix also flushes the directory entry.
pub(crate) fn write_atomic(path: &Path, contents: &[u8]) -> io::Result<()> {
    let tmp = path.with_added_extension("tmp");
    let result = replace_via(&tmp, path, contents);
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result
}

fn replace_via(tmp: &Path, path: &Path, contents: &[u8]) -> io::Result<()> {
    match fs::remove_file(tmp) {
        Err(e) if e.kind() != ErrorKind::NotFound => return Err(e),
        _ => {}
    }
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
    let mut file = options.open(tmp)?;
    file.write_all(contents)?;
    file.sync_all()?;
    drop(file);
    fs::rename(tmp, path)?;
    sync_parent_dir(path)
}

/// Makes the rename itself durable. Windows offers no handle to a
/// directory for this; NTFS journals the rename's metadata instead.
fn sync_parent_dir(path: &Path) -> io::Result<()> {
    if cfg!(unix)
        && let Some(dir) = path.parent().filter(|dir| !dir.as_os_str().is_empty())
    {
        File::open(dir)?.sync_all()?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::temp_dir;
    use std::assert_matches;

    #[test]
    fn test_read_object_distinguishes_missing_empty_object_and_malformed() {
        let (dir, _cleanup) = temp_dir("state-file");
        let path = dir.join("state.json");
        assert_matches!(read_object(&path), Ok(StoredObject::Missing));

        for empty in ["", "  \n", "{}"] {
            fs::write(&path, empty).unwrap();
            assert_matches!(read_object(&path), Ok(StoredObject::Object(map)) if map.is_empty());
        }
        fs::write(&path, r#"{"a":1}"#).unwrap();
        assert_matches!(read_object(&path), Ok(StoredObject::Object(map)) if map["a"] == 1);

        for bad in ["{not json", "[]", "42", "\"text\""] {
            fs::write(&path, bad).unwrap();
            assert_matches!(read_object(&path), Ok(StoredObject::Malformed), "{bad}");
        }
        fs::write(&path, [0xff, 0xfe, 0x00]).unwrap();
        assert_matches!(read_object(&path), Ok(StoredObject::Malformed), "not UTF-8");
    }

    #[test]
    fn test_read_object_reports_an_unreadable_file_as_an_error() {
        let (dir, _cleanup) = temp_dir("state-file");
        // A directory where the file should be: exists, cannot be read.
        let path = dir.join("state.json");
        fs::create_dir(&path).unwrap();
        assert!(read_object(&path).is_err());
    }

    #[test]
    fn test_quarantine_moves_the_file_aside_intact() {
        let (dir, _cleanup) = temp_dir("state-file");
        let path = dir.join("state.json");
        fs::write(&path, "{broken").unwrap();

        let aside = quarantine(&path).unwrap();
        assert!(!path.exists());
        assert!(
            aside
                .file_name()
                .unwrap()
                .to_string_lossy()
                .starts_with("state.json.corrupt-")
        );
        assert_eq!(fs::read_to_string(aside).unwrap(), "{broken");
    }

    #[test]
    fn test_write_atomic_replaces_the_file_and_leaves_no_temp_file() {
        let (dir, _cleanup) = temp_dir("state-file");
        let path = dir.join("state.json");
        write_atomic(&path, b"first").unwrap();
        write_atomic(&path, b"second").unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "second");
        assert!(!path.with_added_extension("tmp").exists());
    }

    /// A stale temp file from an interrupted earlier write is replaced,
    /// not appended to or followed.
    #[test]
    fn test_write_atomic_replaces_a_stale_temp_file() {
        let (dir, _cleanup) = temp_dir("state-file");
        let path = dir.join("state.json");
        fs::write(path.with_added_extension("tmp"), "stale leftovers").unwrap();
        write_atomic(&path, b"fresh").unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "fresh");
    }

    #[cfg(unix)]
    #[test]
    fn test_write_atomic_creates_an_owner_only_file() {
        use std::os::unix::fs::PermissionsExt;

        let (dir, _cleanup) = temp_dir("state-file");
        let path = dir.join("state.json");
        fs::write(&path, "{}").unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();

        write_atomic(&path, b"{}").unwrap();
        let mode = fs::metadata(&path).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o600);
    }
}
