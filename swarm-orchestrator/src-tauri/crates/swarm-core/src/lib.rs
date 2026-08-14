//! # SWARM Orchestrator Core
//!
//! Tauri-free domain library for the SWARM Orchestrator backend:
//! multi-agent worker management, AI streaming integration, session
//! domain types, an ordered event log, real-time metrics support, and
//! an inter-agent message bus.
//!
//! `swarm-core` has no dependency on `tauri` or any `tauri-plugin-*`
//! crate (enforced in CI via `cargo tree -p swarm-core -e normal`). Every
//! seam that would otherwise require a Tauri type is expressed as a
//! plain Rust abstraction instead:
//!
//! - **Event emission** — [`events::EventSink`], a cloneable handle
//!   obtained from [`orchestration::OrchestrationEngine::sink`]. Callers
//!   record events without knowing (or caring) how — or whether — a
//!   shell forwards them onward.
//! - **Live fanout** — [`orchestration::OrchestrationEngine::subscribe`]
//!   hands out `broadcast::Receiver<Arc<DomainEvent>>` handles; any
//!   number of shells/clients can forward the ordered stream.
//! - **Filesystem roots** — [`Paths`], constructed by the shell (e.g.
//!   from Tauri's `app.path().app_data_dir()`) and passed in, never
//!   resolved by swarm-core itself.
//! - **Session persistence** — [`session::SessionStore`], a `load`/`save`
//!   port; the shell supplies the concrete backend (`tauri-plugin-store`
//!   today).
//!
//! ## Module Layout
//!
//! - [`worker`] — PTY-backed worker process registry and lifecycle management
//! - [`agent`] — Multi-provider agent execution: the `AgentAdapter`/
//!   `AgentSession` trait pair, capabilities, and the turn scheduler
//!   (absorbed the former `ai` module's queue; see `agent`'s module doc)
//! - [`session`] — Session domain types, CRUD, and the `SessionStore` port
//! - [`events`] — Typed domain events and the `EventSink` emission seam
//! - [`orchestration`] — Ordered event log + single-writer engine
//! - [`bus`] — Inter-agent message bus with broadcast channels and pipelines
//! - [`config`] — Atomic key-value JSON config persistence
//! - [`git`] — Worktree-per-worker isolation: binary discovery, repo
//!   discovery, and worktree add/lock/unlock/remove/list/prune, all
//!   shelling out to the system `git` binary via arg-vector `Command`
//!   invocations (never a shell string)
//! - [`error`] — Shared application error type

pub mod agent;
pub mod ai;
pub mod bus;
pub mod config;
pub mod error;
pub mod events;
pub mod git;
pub mod orchestration;
mod paths;
pub mod session;
pub mod worker;

pub use paths::Paths;
