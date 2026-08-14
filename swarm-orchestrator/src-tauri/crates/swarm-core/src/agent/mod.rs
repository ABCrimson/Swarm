//! Multi-provider agent execution.
//!
//! One Rust trait pair ([`adapter::AgentAdapter`] / [`adapter::AgentSession`])
//! every provider CLI implements, so every provider's turns land as
//! normalized `agent_*` events (`crate::events::emitter`) on the
//! existing ordered spine (`crate::orchestration`). See
//! `docs/architecture.md`'s adapter-layer section for the full design
//! and the Phase 1 spike's empirical findings.
//!
//! ## Module Layout
//!
//! - [`adapter`] — The trait pair, [`adapter::Capabilities`], and every
//!   supporting type (`ProviderId`, `AgentSpawnSpec`, `TurnInput`, ...)
//! - [`claude_code`] — `ClaudeCodeAdapter`/`ClaudeCodeSession` (Phase 3):
//!   the first concrete provider, driving `claude -p --output-format
//!   stream-json` over [`crate::worker::proc::spawn_piped`]
//! - [`scheduler`] — Priority + concurrency gating for agent turns
//!   (absorbed from the deleted `ai/queue.rs`)
//! - [`registry`] — Live `Arc<dyn AgentSession>` handles keyed by
//!   worker id, the Tauri-free counterpart to
//!   [`crate::worker::registry::WorkerRegistry`] for provider sessions
//!
//! Phase 2 shipped this module fully typed and tested but unwired — no
//! concrete [`adapter::AgentAdapter`] implementation existed yet. Phase
//! 3 lands the first one ([`claude_code::ClaudeCodeAdapter`]) and wires
//! it: `swarm-desktop` now `app.manage()`s an
//! [`scheduler::AgentScheduler`] and an [`registry::AgentSessionRegistry`].

pub mod adapter;
pub mod claude_code;
pub mod registry;
pub mod scheduler;

pub use adapter::{
    AgentAdapter, AgentSession, AgentSpawnSpec, BoxFuture, CancelGranularity, Capabilities,
    ExitSummary, PermissionDecision, PermissionId, ProbeReport, ProviderId, SessionKey, TurnId,
    TurnInput,
};
pub use claude_code::{ClaudeCodeAdapter, ClaudeCodeSession, ClaudeCodeTrustTier};
pub use registry::AgentSessionRegistry;
pub use scheduler::{AgentScheduler, AgentSchedulerConfig, AgentTurnRequest, TurnPriority};
