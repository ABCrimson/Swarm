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
//! - [`fs`] — File system operations (delegates to `tauri-plugin-fs`)
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
