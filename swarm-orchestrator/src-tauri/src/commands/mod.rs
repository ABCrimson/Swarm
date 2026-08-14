//! Tauri IPC command handlers.
//!
//! Each submodule exposes `#[tauri::command]` functions that are
//! registered in [`crate::run`] via `tauri::generate_handler!`.
//! Commands bridge the React frontend to the Rust backend over
//! Tauri's IPC invoke/listen protocol.
//!
//! ## Modules
//!
//! - [`worker`] — Worker lifecycle commands (spawn, pause, resume, kill, list, input)
//! - [`session`] — Session CRUD commands (create, delete, list, get)
//! - [`ai`] — AI request enqueue command
//! - [`config`] — App config file commands (read_config, write_config)
//! - [`metrics`] — System metrics collection and retrieval
//! - [`bus`] — Message bus commands (send, subscribe, pipeline, list channels)
//! - [`fs`] — `read_file`/`write_file` commands (stamped, persisted
//!   `file_written` on write); `tauri-plugin-fs` itself continues to
//!   back non-tool UI file access (`#lib/fs.ts`)
//! - [`git`] — Git repo-root validation command (validate_repo_root)
//! - [`notification`] — OS notification command
//! - [`orchestration`] — Ordered event core commands (events_since)
//! - [`updater`] — Auto-updater check command

pub mod ai;
pub mod bus;
pub mod config;
pub mod fs;
pub mod git;
pub mod metrics;
pub mod notification;
pub mod orchestration;
pub mod session;
pub mod updater;
pub mod worker;

use swarm_core::events::Provenance;

/// Parses optional `originWorker`/`causeSeq` IPC args into a
/// [`Provenance`]. Shared by every command that accepts explicit
/// causal-attribution args (see Phase 4's "explicit IPC args, not
/// ambient cause state" decision) — `spawn_worker`, `kill_worker`,
/// `pause_worker`, `resume_worker`, `worker_input`, `write_file`,
/// `create_session`, `delete_session`.
///
/// Absent `originWorker` yields `Provenance::default()` — the honest
/// "unattributed" value every existing caller keeps producing. A
/// present-but-malformed `originWorker` is rejected (same treatment as
/// a malformed worker `id` elsewhere in this codebase) rather than
/// silently downgraded to `None`, since it is a caller/programming bug,
/// not a legitimate "I don't know" case.
pub(crate) fn parse_provenance(
    origin_worker: Option<String>,
    cause_seq: Option<u64>,
) -> Result<Provenance, String> {
    let origin_worker = origin_worker
        .map(|s| uuid::Uuid::parse_str(&s))
        .transpose()
        .map_err(|e| e.to_string())?;
    Ok(Provenance {
        origin_worker,
        cause_seq,
    })
}
