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
//! - [`codex`] — `CodexAdapter`/`CodexSession` (Phase 4): the second
//!   concrete provider, driving `codex app-server`'s stateful,
//!   bidirectional JSON-RPC 2.0 protocol over the SAME
//!   [`crate::worker::proc::spawn_piped`] substrate — proves the
//!   [`adapter::AgentAdapter`]/[`adapter::AgentSession`] trait survives a
//!   genuinely different protocol family (see that module's doc for the
//!   verdict and its ASSUMPTIONS list)
//! - [`scheduler`] — Priority + concurrency gating for agent turns
//!   (absorbed from the deleted `ai/queue.rs`)
//! - [`registry`] — Live `Arc<dyn AgentSession>` handles keyed by
//!   worker id, the Tauri-free counterpart to
//!   [`crate::worker::registry::WorkerRegistry`] for provider sessions
//!
//! Phase 2 shipped this module fully typed and tested but unwired — no
//! concrete [`adapter::AgentAdapter`] implementation existed yet. Phase
//! 3 landed the first one ([`claude_code::ClaudeCodeAdapter`]) and wired
//! it: `swarm-desktop` `app.manage()`s an [`scheduler::AgentScheduler`]
//! and an [`registry::AgentSessionRegistry`]. Phase 4 adds the second
//! ([`codex::CodexAdapter`]) behind the same registry/scheduler, provider
//! selection handled entirely by `commands::agent::agent_spawn`/`agent_probe`.

pub mod adapter;
pub mod claude_code;
pub mod codex;
pub mod registry;
pub mod scheduler;

pub use adapter::{
    AgentAdapter, AgentSession, AgentSpawnSpec, AgentTurnStatus, BoxFuture, CancelGranularity,
    Capabilities, ExitSummary, PermissionDecision, PermissionId, ProbeReport, ProviderId,
    SessionKey, TurnId, TurnInput,
};
pub use claude_code::{ClaudeCodeAdapter, ClaudeCodeSession, ClaudeCodeTrustTier};
pub use codex::{CodexAdapter, CodexSession, CodexTrustTier};
pub use registry::AgentSessionRegistry;
pub use scheduler::{
    AgentScheduler, AgentSchedulerConfig, AgentTurnRequest, MAX_AGENT_CONCURRENCY,
    MIN_AGENT_CONCURRENCY, TurnPriority,
};
