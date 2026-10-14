//! # SWARM Orchestrator core
//!
//! The Tauri-free domain library both shells embed: the desktop app
//! (`swarm-desktop`) and the headless daemon (`swarmd`). It owns the
//! PTY workers and provider agents (Claude Code, Codex), sessions, git
//! worktrees and shipping, the ordered event log, metrics, the
//! inter-agent bus, and the command registry every IPC call and remote
//! `rpc` frame is dispatched through.
//!
//! `swarm-core` depends on no `tauri` or `tauri-plugin-*` crate (CI
//! checks `cargo tree -p swarm-core -e normal`). Every seam a shell
//! would otherwise fill with a Tauri type is a plain Rust value instead:
//!
//! - **Recording events**: [`events::EventSink`], from
//!   [`orchestration::OrchestrationEngine::sink`].
//! - **Delivering events**: the `emit` callback a shell passes to
//!   [`runtime::Runtime::start`], plus any number of
//!   [`orchestration::OrchestrationEngine::subscribe`] receivers.
//! - **Filesystem roots**: [`Paths`], resolved by the shell (Tauri's
//!   app data directory, or `swarmd`'s `--data-dir`) and passed in.
//!
//! ## Modules
//!
//! - [`runtime`] — builds and tears down everything below, once per
//!   shell, behind the [`lock`] single-instance lock.
//! - [`commands`] — the command registry and its remote policy.
//! - [`protocol`] — `swarmd`'s WebSocket frames.
//! - [`events`] and [`orchestration`] — typed events, the single-writer
//!   engine and its SQLite log.
//! - [`worker`], [`agent`] — PTY workers and provider-agent sessions with
//!   the turn scheduler.
//! - [`session`] — sessions and `sessions.json`.
//! - [`git`] — worktree-per-worker isolation and the ship chain.
//! - [`bus`] — worker-to-worker messages, recorded as events.
//! - [`config`] — `swarm-config.json`.
//! - [`metrics`] — system and per-worker resource sampling.
//! - [`error`] — [`error::AppError`], the shared error type.
//! - [`clock`] — wall-clock time as the `i64` Unix-epoch timestamps every
//!   event and persisted record carries.

pub mod agent;
pub mod bus;
pub mod clock;
pub mod commands;
pub mod config;
pub mod error;
pub mod events;
pub mod git;
pub mod lock;
pub mod metrics;
pub mod orchestration;
mod paths;
pub mod protocol;
pub mod runtime;
pub mod session;
mod state_file;
pub mod worker;

pub use paths::Paths;

/// Test fixtures shared by the crate's unit tests: each defined once so
/// no module grows its own copy of the temp-path and cleanup plumbing.
#[cfg(test)]
pub(crate) mod test_support {
    use std::mem::DropGuard;
    use std::path::PathBuf;

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
}
