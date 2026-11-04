//! Test fixtures shared by the crate's unit tests: each defined once so
//! no module grows its own copy of the temp-path, cleanup and capture
//! plumbing.

use std::io;
use std::mem::DropGuard;
use std::path::PathBuf;
use std::sync::Arc;

use parking_lot::Mutex;

/// A `Write` over a shared buffer: a stand-in PTY writer, and the sink
/// for a captured tracing subscriber.
#[derive(Clone, Default)]
pub(crate) struct SharedBuf(pub(crate) Arc<Mutex<Vec<u8>>>);

impl io::Write for SharedBuf {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        self.0.lock().extend_from_slice(buf);
        Ok(buf.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

impl<'a> tracing_subscriber::fmt::MakeWriter<'a> for SharedBuf {
    type Writer = Self;
    fn make_writer(&'a self) -> Self::Writer {
        self.clone()
    }
}

/// A fresh, empty directory removed (with everything in it) on drop,
/// so a failing assertion still cleans up.
pub(crate) fn temp_dir(label: &str) -> (PathBuf, DropGuard<PathBuf, impl FnOnce(PathBuf)>) {
    let dir = std::env::temp_dir().join(format!("swarm-{label}-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let guard = DropGuard::new(dir.clone(), |dir| {
        let _ = std::fs::remove_dir_all(dir);
    });
    (dir, guard)
}

/// A not-yet-created SQLite database path in the temp directory,
/// removed on drop together with its `-wal` and `-shm` siblings.
pub(crate) fn temp_db() -> (PathBuf, DropGuard<PathBuf, impl FnOnce(PathBuf)>) {
    let path = std::env::temp_dir().join(format!("swarm-test-{}.db", uuid::Uuid::new_v4()));
    let guard = DropGuard::new(path.clone(), |path| {
        for suffix in ["-wal", "-shm"] {
            let mut sibling = path.clone().into_os_string();
            sibling.push(suffix);
            let _ = std::fs::remove_file(sibling);
        }
        let _ = std::fs::remove_file(&path);
    });
    (path, guard)
}
