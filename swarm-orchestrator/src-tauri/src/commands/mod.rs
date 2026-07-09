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
//! - [`metrics`] — System metrics collection and retrieval
//! - [`bus`] — Message bus commands (send, subscribe, pipeline, list channels)
//! - [`fs`] — File system operations (delegates to `tauri-plugin-fs`)
//! - [`notification`] — OS notification command
//! - [`updater`] — Auto-updater check command

pub mod ai;
pub mod bus;
pub mod fs;
pub mod metrics;
pub mod notification;
pub mod session;
pub mod updater;
pub mod worker;
