//! Multi-provider agent execution.
//!
//! One Rust trait pair ([`adapter::AgentAdapter`] / [`adapter::AgentSession`])
//! every provider CLI implements, so every provider's turns land as
//! normalized `agent_*` events (`crate::events::emitter`) on the
//! ordered spine (`crate::orchestration`). `docs/architecture.md`'s
//! Adapter Layer section has the full design.
//!
//! ## Module Layout
//!
//! - [`adapter`] — the trait pair, [`adapter::Capabilities`], and every
//!   supporting type (`ProviderId`, `AgentSpawnSpec`, `TurnInput`, ...)
//! - [`claude_code`] — `ClaudeCodeAdapter`/`ClaudeCodeSession`: the
//!   `claude` CLI's `stream-json` protocol and its control requests
//!   (handshake, interrupt, interactive permissions) over
//!   [`crate::worker::proc::spawn_piped`]
//! - [`codex`] — `CodexAdapter`/`CodexSession`: `codex app-server`'s
//!   JSON-RPC 2.0 protocol over the same [`crate::worker::proc::spawn_piped`]
//!   substrate
//! - [`scheduler`] — priority + concurrency gating for agent turns
//! - [`registry`] — live `Arc<dyn AgentSession>` handles keyed by
//!   worker id, the counterpart to
//!   [`crate::worker::registry::WorkerRegistry`] for provider sessions
//!
//! ## Wiring
//!
//! [`crate::runtime::Runtime::start`] builds one adapter per implemented
//! provider, one [`registry::AgentSessionRegistry`] and one
//! [`scheduler::AgentScheduler`], which both shells (the desktop app and
//! `swarmd`) share. `agent_spawn`/`agent_probe` pick the adapter by
//! [`adapter::ProviderId`]; every other agent command reaches the live
//! session through the registry by worker id.

use std::collections::VecDeque;
use std::time::Duration;

use parking_lot::Mutex;

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

/// The tail of a child's stderr as one line for a failure message:
/// `Stderr: <text>`, or `No Stderr Output` when it wrote nothing.
/// Shared by both provider adapters, which keep the same bounded byte
/// tail of their CLI's stderr.
pub(crate) fn stderr_snippet(tail: &Mutex<VecDeque<u8>>) -> String {
    let mut tail = tail.lock();
    let text = String::from_utf8_lossy(tail.make_contiguous());
    match text.trim() {
        "" => "No Stderr Output".to_owned(),
        text => format!("Stderr: {text}"),
    }
}

/// The child's last stderr bytes as [`stderr_snippet`], after waiting up to
/// 200 ms for the piped stderr drain thread, which can trail the child's
/// exit: without the wait, a crash that wrote a panic message could settle
/// as "No Stderr Output". Shared by both provider adapters.
pub(crate) async fn drained_stderr_snippet(tail: &Mutex<VecDeque<u8>>) -> String {
    for _ in 0..10 {
        if !tail.lock().is_empty() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    stderr_snippet(tail)
}
