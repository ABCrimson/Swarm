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
//! - [`scheduler`] — Priority + concurrency gating for agent turns
//!   (absorbed from the deleted `ai/queue.rs`)
//!
//! Phase 2 ships this module fully typed and tested but unwired — no
//! concrete [`adapter::AgentAdapter`] implementation exists yet (that's
//! Phase 3's `ClaudeCodeAdapter`), and `swarm-desktop` does not
//! `app.manage()` an [`scheduler::AgentScheduler`] until one does.

pub mod adapter;
pub mod scheduler;

pub use adapter::{
    AgentAdapter, AgentSession, AgentSpawnSpec, BoxFuture, CancelGranularity, Capabilities,
    ExitSummary, PermissionDecision, PermissionId, ProbeReport, ProviderId, SessionKey, TurnId,
    TurnInput,
};
pub use scheduler::{AgentScheduler, AgentSchedulerConfig, AgentTurnRequest, TurnPriority};
