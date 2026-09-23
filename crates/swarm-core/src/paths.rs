//! Filesystem paths shared by every shell that embeds `swarm-core`.
//!
//! A single identifier-scoped data directory anchors the event log,
//! the config file, and (via [`crate::session::SessionStore`]
//! implementations) session persistence. `swarm-core` never resolves
//! this directory itself — that is inherently platform/shell-specific
//! (e.g. Tauri's `app.path().app_data_dir()`) — the shell constructs
//! [`Paths`] once at startup and passes it in.

use std::path::PathBuf;

/// Resolved data directory for this run.
#[derive(Debug, Clone)]
pub struct Paths {
    /// Root directory for all persisted swarm-core state (event log,
    /// config file, session store). Must already exist — the shell is
    /// responsible for creating it before constructing `Paths`.
    pub data_dir: PathBuf,
}
