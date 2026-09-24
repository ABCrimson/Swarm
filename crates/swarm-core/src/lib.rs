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

pub mod agent;
pub mod bus;
mod clock;
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
