//! Helpers the unit tests share.

use std::mem::DropGuard;
use std::path::{Path, PathBuf};

use swarm_core::Paths;
use swarm_core::orchestration::DomainEvent;
use swarm_core::runtime::{Runtime, RuntimeConfig};

/// A temporary directory that is removed, with its contents, on drop.
/// Derefs to its path.
pub(crate) type TempDir = DropGuard<PathBuf, fn(PathBuf)>;

/// A fresh, empty directory for the test `name`, unique to this process.
pub(crate) fn temp_dir(name: &str) -> TempDir {
    fn remove(dir: PathBuf) {
        let _ = std::fs::remove_dir_all(dir);
    }
    let dir = std::env::temp_dir().join(format!("swarm-desktop-{name}-{}", std::process::id()));
    remove(dir.clone());
    std::fs::create_dir_all(&dir).expect("create the test directory");
    DropGuard::new(dir, remove as fn(PathBuf))
}

/// Starts swarm-core on `data_dir` the way the app does, with every
/// recorded event passed to `emit`. Its background tasks are spawned on
/// the ambient Tokio runtime, which the caller must have entered.
pub(crate) fn start_runtime(
    data_dir: &Path,
    emit: impl FnMut(&DomainEvent) + Send + 'static,
) -> Runtime {
    Runtime::start(
        RuntimeConfig {
            paths: Paths {
                data_dir: data_dir.to_owned(),
            },
            shell_name: "swarm-desktop",
            bind: None,
        },
        emit,
    )
    .expect("start swarm-core")
}
