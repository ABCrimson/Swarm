//! Test-only construction helpers for every `commands::*` test module.

use std::mem::DropGuard;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::mpsc::{self, Receiver};

use super::{Ctx, CtxInner};
use crate::Paths;
use crate::agent::{
    AgentScheduler, AgentSchedulerConfig, AgentSessionRegistry, ClaudeCodeAdapter, CodexAdapter,
};
use crate::bus::channel::MessageBus;
use crate::bus::router::Router;
use crate::events::EventSink;
use crate::git::RepoLocks;
use crate::metrics::SharedSystem;
use crate::orchestration::{DomainEvent, EventLog, OrchestrationEngine};
use crate::session::SessionManager;
use crate::worker::registry::WorkerRegistry;

/// A fully wired `Ctx` over an in-memory event log and a fresh temp
/// data directory (removed when the returned guard drops), plus a
/// receiver of every envelope the engine emits. No single-instance
/// lock is taken, so any number can coexist.
pub(crate) fn test_ctx() -> (
    Ctx,
    DropGuard<PathBuf, impl FnOnce(PathBuf)>,
    Receiver<DomainEvent>,
) {
    test_ctx_with_claude(ClaudeCodeAdapter::new)
}

/// [`test_ctx`] whose Claude Code adapter is built by `claude_adapter`
/// from the engine's sink, e.g. a [`ClaudeCodeAdapter::with_test_binary`]
/// stand-in for the CLI.
pub(crate) fn test_ctx_with_claude(
    claude_adapter: impl FnOnce(EventSink) -> ClaudeCodeAdapter,
) -> (
    Ctx,
    DropGuard<PathBuf, impl FnOnce(PathBuf)>,
    Receiver<DomainEvent>,
) {
    let (dir, cleanup) = crate::test_support::temp_dir("cmd-test");

    let (events_tx, events) = mpsc::channel();
    let engine = OrchestrationEngine::start(EventLog::open_in_memory().unwrap(), None, move |e| {
        let _ = events_tx.send(e.clone());
    });
    let sink = engine.sink();
    let message_bus = MessageBus::new();
    let ctx = CtxInner {
        paths: Paths { data_dir: dir },
        registry: WorkerRegistry::new(),
        session_manager: SessionManager::new(),
        repo_locks: RepoLocks::new(),
        router: Router::new(message_bus.clone(), sink.clone()),
        message_bus,
        shared_system: SharedSystem::new(),
        claude_adapter: Arc::new(claude_adapter(sink.clone())),
        codex_adapter: Arc::new(CodexAdapter::new(sink.clone())),
        agent_session_registry: AgentSessionRegistry::new(),
        scheduler: Arc::new(AgentScheduler::new(
            AgentSchedulerConfig::default(),
            |_req| async {},
        )),
        engine,
        sink,
    }
    .into();
    (ctx, cleanup, events)
}
