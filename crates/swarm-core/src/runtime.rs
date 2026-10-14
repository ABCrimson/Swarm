//! Shared runtime construction and teardown for both shells.
//!
//! `swarm-desktop` and `swarmd` build their engine, registries,
//! adapters and scheduler through [`Runtime::start`] — one construction
//! site, so the two shells cannot drift apart (one forgetting the
//! scheduler's per-worker turn lock, say, or applying the persisted
//! `max_workers` differently) — and tear them down through
//! [`Runtime::shutdown`]. What stays shell-specific (the `emit`
//! closure's delivery mechanism, managed state, windows, signals) is the
//! caller's.

use std::sync::Arc;
use std::time::Duration;

use tokio::task::JoinSet;
use tokio_util::sync::CancellationToken;

use crate::Paths;
use crate::agent::{
    AgentScheduler, AgentSchedulerConfig, AgentSessionRegistry, AgentTurnRequest, AgentTurnStatus,
    ClaudeCodeAdapter, CodexAdapter, MAX_AGENT_CONCURRENCY, MIN_AGENT_CONCURRENCY,
};
use crate::bus::channel::MessageBus;
use crate::bus::router::Router;
use crate::error::AppError;
use crate::events::{AgentTurnSettledPayload, EventSink, SwarmEvent, SystemLogPayload};
use crate::git::{self, GitCapability, RepoLocks};
use crate::lock::{LockError, SingleInstanceLock};
use crate::metrics::SharedSystem;
use crate::orchestration::{DomainEvent, EventLog, OrchestrationEngine};
use crate::session::SessionManager;
use crate::worker::registry::WorkerRegistry;

/// Filename of the SQLite event log under [`Paths::data_dir`] — the one
/// name both shells must agree on (the single-instance lock exists
/// because two writers on this file would collide).
pub const EVENT_LOG_FILE: &str = "swarm-events.db";

/// Inputs to [`Runtime::start`].
pub struct RuntimeConfig {
    /// Resolved data directory (event log, config, sessions, the
    /// single-instance lock files).
    pub paths: Paths,
    /// Identifies the caller in the lock's informational file —
    /// `"swarm-desktop"` or `"swarmd"`.
    pub shell_name: &'static str,
    /// The daemon's listen address, for the lock's informational file.
    /// `None` for the desktop shell (no network listener).
    pub bind: Option<String>,
}

/// Failure constructing a [`Runtime`].
#[derive(Debug, thiserror::Error)]
pub enum RuntimeStartError {
    /// Another process already holds the data directory (or the lock
    /// could not be acquired for another I/O reason). Its message is the
    /// user-facing "SWARM Is Already Running" text.
    #[error(transparent)]
    Lock(#[from] LockError),
    /// The event log could not be opened, or its writer not started.
    #[error("Failed To Open The Event Log: {0}")]
    EventLog(#[source] AppError),
}

/// Every piece of shared, Tauri-free application state, wired together
/// once. The caller owns what happens to each field afterwards (managing
/// it as Tauri state, or handing it to the WebSocket RPC dispatcher's
/// [`crate::commands::Ctx`]).
pub struct Runtime {
    /// The data directory this runtime owns.
    pub paths: Paths,
    /// Held for the process's lifetime: dropping it releases the OS
    /// lock on [`Self::paths`]. Never read after construction.
    pub lock: SingleInstanceLock,
    /// Live PTY workers.
    pub registry: WorkerRegistry,
    /// Sessions and their worker membership (restored from disk).
    pub session_manager: SessionManager,
    /// Per-repository git operation locks.
    pub repo_locks: RepoLocks,
    /// The inter-agent bus's topic registry.
    pub message_bus: MessageBus,
    /// Routes bus messages onto the ordered event stream.
    pub router: Router,
    /// The `sysinfo` handle metrics are sampled from.
    pub shared_system: SharedSystem,
    /// The ordered event engine.
    pub engine: OrchestrationEngine,
    /// Records events into [`Self::engine`].
    pub sink: EventSink,
    /// The Claude Code provider adapter. `Arc`-wrapped (the other fields
    /// are internally shared and `Clone` already) so the shell's managed
    /// copy and [`crate::commands::Ctx`] share one instance.
    pub claude_adapter: Arc<ClaudeCodeAdapter>,
    /// The Codex provider adapter (`Arc`-wrapped, as above).
    pub codex_adapter: Arc<CodexAdapter>,
    /// Live provider-agent sessions, keyed by worker id.
    pub agent_session_registry: AgentSessionRegistry,
    /// The agent-turn scheduler (`Arc`-wrapped, as above).
    pub scheduler: Arc<AgentScheduler>,
    /// Stops the background metrics loop; [`Self::shutdown`] cancels it.
    pub metrics_cancel: CancellationToken,
}

impl Runtime {
    /// Acquires the single-instance lock, opens the event log and starts
    /// its writer (delivering through `emit`, the caller's primary,
    /// lossless path — see [`OrchestrationEngine::try_start`]), restores
    /// persisted sessions and the persisted worker and agent-turn caps,
    /// starts the metrics loop, and wires the agent scheduler. The git
    /// probe and the startup `git worktree prune` of the configured
    /// default repository run on a blocking task in the background.
    ///
    /// # Errors
    ///
    /// [`RuntimeStartError::Lock`] if another process holds the data
    /// directory (exit with its message);
    /// [`RuntimeStartError::EventLog`] if the event log cannot be opened
    /// or its writer cannot start.
    ///
    /// # Panics
    ///
    /// Outside a Tokio runtime: the metrics loop, the scheduler and the
    /// background git task are spawned onto the current one.
    ///
    /// # Blocking
    ///
    /// Opens and migrates the SQLite log and reads the config and
    /// session files synchronously. From async code, call it through
    /// `tokio::task::spawn_blocking` (whose threads still see the
    /// runtime, so the spawns above work).
    pub fn start(
        config: RuntimeConfig,
        emit: impl FnMut(&DomainEvent) + Send + 'static,
    ) -> Result<Self, RuntimeStartError> {
        let RuntimeConfig {
            paths,
            shell_name,
            bind,
        } = config;
        let lock = SingleInstanceLock::acquire(&paths.data_dir, shell_name, bind)?;

        let db_path = paths.data_dir.join(EVENT_LOG_FILE);
        let engine = EventLog::open(&db_path)
            .and_then(|log| OrchestrationEngine::try_start(log, Some(db_path), emit))
            .map_err(RuntimeStartError::EventLog)?;
        let sink = engine.sink();

        let registry = WorkerRegistry::new();
        let session_manager = SessionManager::new();
        let message_bus = MessageBus::new();
        let shared_system = SharedSystem::new();
        let router = Router::new(message_bus.clone(), sink.clone());

        if let Err(e) = crate::session::persist::load(&paths, &session_manager) {
            tracing::warn!(error = %e, "failed to load persisted sessions");
        }
        if let Some(max) = read_u64(&paths, "max_workers")
            && let Err(e) = registry.set_max_workers(usize::try_from(max).unwrap_or(usize::MAX))
        {
            tracing::warn!(error = %e, "ignoring persisted max_workers");
        }

        spawn_git_startup(&paths, sink.clone());

        let metrics_cancel = CancellationToken::new();
        crate::metrics::start_metrics_loop(
            sink.clone(),
            registry.clone(),
            shared_system.clone(),
            metrics_cancel.clone(),
        );

        let claude_adapter = Arc::new(ClaudeCodeAdapter::new(sink.clone()));
        let codex_adapter = Arc::new(CodexAdapter::new(sink.clone()));
        let agent_session_registry = AgentSessionRegistry::new();
        let scheduler = Arc::new(AgentScheduler::new(AgentSchedulerConfig::default(), {
            let (sessions, sink) = (agent_session_registry.clone(), sink.clone());
            move |request| execute_turn(sessions.clone(), sink.clone(), request)
        }));
        // The persisted agent-turn cap (Settings -> set_agent_concurrency).
        // Absent or out of range keeps the scheduler's default.
        if let Some(limit) = read_u64(&paths, "agent_concurrency") {
            match u32::try_from(limit) {
                Ok(limit) if (MIN_AGENT_CONCURRENCY..=MAX_AGENT_CONCURRENCY).contains(&limit) => {
                    scheduler.set_concurrency(limit as usize);
                }
                _ => tracing::warn!(limit, "ignoring out-of-range persisted agent_concurrency"),
            }
        }

        Ok(Self {
            paths,
            lock,
            registry,
            session_manager,
            repo_locks: RepoLocks::new(),
            message_bus,
            router,
            shared_system,
            engine,
            sink,
            claude_adapter,
            codex_adapter,
            agent_session_registry,
            scheduler,
            metrics_cancel,
        })
    }

    /// Stops background work and makes every recorded event durable:
    /// cancels the metrics loop, shuts down every live provider-agent
    /// session (their final `agent_turn_settled`/`agent_session_exited`
    /// events are recorded), then drains the event engine (see
    /// [`OrchestrationEngine::shutdown`]) and returns its final head
    /// seq. PTY workers are not killed.
    ///
    /// Each worker's session is stopped in `kill_worker`'s order: the
    /// worker is held closing while attaches in flight for it finish
    /// (see [`AgentSessionRegistry::begin_close`]), then its session is
    /// removed and shut down, so one an attach registers meanwhile is
    /// stopped too. Agent sessions, attaches included, get up to
    /// `timeout` in total; draining the engine gets up to `timeout`
    /// more. Call it once, on exit — events
    /// recorded afterwards are dropped. The runtime (and its lock) stays
    /// alive until dropped.
    ///
    /// # Errors
    ///
    /// [`AppError::EventLog`] if the engine did not drain in time, its
    /// writer thread is gone, the event log could not be finalized, or an
    /// earlier shutdown failed; a repeat call
    /// after a clean shutdown returns the same head (see
    /// [`OrchestrationEngine::shutdown`]).
    pub async fn shutdown(&self, timeout: Duration) -> Result<u64, AppError> {
        self.metrics_cancel.cancel();

        let mut sessions = JoinSet::new();
        for worker in self.registry.list_workers() {
            let registry = self.agent_session_registry.clone();
            sessions.spawn(async move {
                let _closing = registry.begin_close(worker.id).await;
                if let Some(session) = registry.remove(&worker.id)
                    && let Err(e) = session.shutdown().await
                {
                    tracing::warn!(worker_id = %worker.id, error = %e, "agent session shutdown failed");
                }
            });
        }
        // `join_next`, not `join_all`: `join_all` re-raises a panicked
        // session task, which would skip the engine drain below.
        let drain = async move {
            while let Some(joined) = sessions.join_next().await {
                if let Err(e) = joined {
                    tracing::warn!(error = %e, "an agent session shutdown task failed");
                }
            }
        };
        if tokio::time::timeout(timeout, drain).await.is_err() {
            tracing::warn!("agent sessions did not all shut down in time");
        }

        let engine = self.engine.clone();
        tokio::task::spawn_blocking(move || engine.shutdown(timeout))
            .await
            .map_err(|e| {
                AppError::EventLog(format!("The Event Engine Shutdown Task Failed: {e}"))
            })?
    }
}

/// A persisted integer setting; `None` when absent or not an unsigned
/// integer.
fn read_u64(paths: &Paths, key: &str) -> Option<u64> {
    crate::config::read_value(paths, key).and_then(|v| v.as_u64())
}

/// Probes `git` and prunes stale worktree entries of the configured
/// default repository, off the startup path (both shell out to `git`).
/// A missing or too-old `git` is reported on the event stream too, since
/// isolated spawns will fail until it is fixed. A concurrent spawn is
/// safe: `git worktree add` locks a new worktree against `prune` while
/// it initializes it.
fn spawn_git_startup(paths: &Paths, sink: EventSink) {
    let default_repo_root = crate::config::read_value(paths, "default_repo_root")
        .and_then(|v| v.as_str().map(str::to_owned));
    tokio::task::spawn_blocking(move || {
        match git::probe_capability() {
            GitCapability::Available {
                version: (major, minor, patch),
            } => {
                tracing::info!(version = %format!("{major}.{minor}.{patch}"), "git worktree isolation available");
            }
            GitCapability::Unavailable { reason } => {
                tracing::warn!(%reason, "git worktree isolation unavailable");
                sink.emit(SwarmEvent::SystemLog(SystemLogPayload {
                    level: "warn".to_owned(),
                    message: format!(
                        "Git Unavailable — Isolated Spawns Will Fail Until Git Is Installed Or Upgraded: {reason}"
                    ),
                    target: "swarm_core::git".to_owned(),
                    timestamp: crate::clock::unix_millis(),
                }));
            }
        }

        if let Some(repo_root) = default_repo_root {
            match git::worktree::prune(std::path::Path::new(&repo_root)) {
                Ok(pruned) => tracing::info!(%repo_root, pruned, "startup worktree prune complete"),
                Err(e) => tracing::warn!(%repo_root, error = %e, "startup worktree prune failed"),
            }
        }
    });
}

/// The scheduler's executor: runs one queued turn on the worker's live
/// session, holding that worker's turn lock for the whole turn. A turn
/// that cannot start (no session, or rejected) still gets its terminal
/// `agent_turn_settled` receipt, synthesized here.
async fn execute_turn(sessions: AgentSessionRegistry, sink: EventSink, request: AgentTurnRequest) {
    let turn_lock = sessions.turn_lock(&request.worker_id);
    let _guard = turn_lock.lock().await;

    let dispatch_error = match sessions.get(&request.worker_id) {
        Ok(session) => match session.send_turn(request.turn).await {
            Ok(turn_id) => {
                if let Err(e) = session.await_turn_completion(turn_id).await {
                    tracing::warn!(
                        worker_id = %request.worker_id,
                        error = %e,
                        "agent turn dispatch: await_turn_completion failed"
                    );
                }
                None
            }
            Err(e) => Some(format!("Turn Rejected: {e}")),
        },
        Err(e) => Some(format!("No Live Session For This Worker: {e}")),
    };

    if let Some(error) = dispatch_error {
        tracing::warn!(worker_id = %request.worker_id, %error, "agent turn dispatch failed; synthesizing a terminal receipt");
        sink.emit(SwarmEvent::AgentTurnSettled(AgentTurnSettledPayload {
            worker_id: request.worker_id,
            turn_id: uuid::Uuid::new_v4().to_string(),
            status: AgentTurnStatus::Error,
            error: Some(error),
            cost_usd: None,
            usage: None,
            duration_ms: 0,
            num_turns: None,
        }));
    }
}

#[cfg(test)]
mod tests {
    use std::assert_matches;

    use super::*;
    use crate::state_file::tests::temp_dir;

    fn config(dir: &std::path::Path, shell_name: &'static str) -> RuntimeConfig {
        RuntimeConfig {
            paths: Paths {
                data_dir: dir.to_path_buf(),
            },
            shell_name,
            bind: None,
        }
    }

    #[tokio::test]
    async fn test_runtime_start_succeeds_on_a_fresh_data_dir() {
        let (dir, _cleanup) = temp_dir("runtime");
        assert!(Runtime::start(config(&dir, "swarmd"), |_| {}).is_ok());
    }

    #[tokio::test]
    async fn test_second_runtime_start_against_the_same_data_dir_fails_locked() {
        let (dir, _cleanup) = temp_dir("runtime");
        let first = Runtime::start(config(&dir, "swarm-desktop"), |_| {}).unwrap();
        let second = Runtime::start(config(&dir, "swarmd"), |_| {});
        // `.err()`: `Runtime` is not `Debug`.
        assert_matches!(second.err(), Some(RuntimeStartError::Lock(_)));
        drop(first);
    }

    /// The error chain is kept: `source()` reaches the wrapped `AppError`.
    #[test]
    fn test_runtime_start_error_keeps_its_source() {
        use std::error::Error;

        let err = RuntimeStartError::EventLog(AppError::EventLog("disk full".to_owned()));
        assert_eq!(
            err.to_string(),
            "Failed To Open The Event Log: event log: disk full"
        );
        assert!(err.source().is_some());
    }

    /// `shutdown` drains everything recorded before it (nothing queued is
    /// lost on exit), and a restart continues after the final seq.
    #[tokio::test(flavor = "multi_thread")]
    async fn test_shutdown_drains_the_engine_and_a_restart_continues_after_it() {
        let (dir, _cleanup) = temp_dir("runtime");
        let runtime = Runtime::start(config(&dir, "swarm-desktop"), |_| {}).unwrap();
        for i in 0..50 {
            let session = runtime
                .session_manager
                .create_session(format!("S{i}"), serde_json::json!({}));
            runtime.sink.emit(SwarmEvent::SessionCreated(
                crate::events::SessionCreatedPayload {
                    session_id: session.id,
                    name: session.name,
                },
            ));
        }

        let head = runtime.shutdown(Duration::from_secs(10)).await.unwrap();
        assert!(runtime.metrics_cancel.is_cancelled());
        let log = EventLog::open_readonly(&dir.join(EVENT_LOG_FILE)).unwrap();
        let persisted = log.events_since(0, 1000).unwrap();
        assert_eq!(
            persisted
                .iter()
                .filter(|e| e.event_type == "session_created")
                .count(),
            50
        );
        drop(runtime);

        let restarted = Runtime::start(config(&dir, "swarm-desktop"), |_| {}).unwrap();
        assert!(restarted.engine.head_seq() >= head);
        let seq = restarted
            .sink
            .emit_awaiting_seq(
                SwarmEvent::SessionDeleted(crate::events::SessionDeletedPayload {
                    session_id: uuid::Uuid::nil(),
                }),
                crate::events::Provenance::default(),
            )
            .await
            .unwrap();
        assert!(seq > head, "seq {seq} reused (final head was {head})");
    }

    /// A persisted `max_workers` is restored at start, and one outside the
    /// accepted range is ignored with the default kept.
    #[tokio::test]
    async fn test_start_restores_a_persisted_worker_cap_and_ignores_an_out_of_range_one() {
        let (dir, _cleanup) = temp_dir("runtime");
        let paths = Paths {
            data_dir: dir.to_path_buf(),
        };
        crate::config::write_value(&paths, "max_workers", serde_json::json!(3)).unwrap();
        let runtime = Runtime::start(config(&dir, "swarmd"), |_| {}).unwrap();
        assert_eq!(runtime.registry.config.read().max_workers, 3);
        drop(runtime);

        crate::config::write_value(&paths, "max_workers", serde_json::json!(0)).unwrap();
        let runtime = Runtime::start(config(&dir, "swarmd"), |_| {}).unwrap();
        assert_eq!(
            runtime.registry.config.read().max_workers,
            crate::worker::registry::SystemConfig::default().max_workers
        );
    }

    /// An `AgentSession` whose `send_turn` accepts or rejects on demand
    /// and which records that its turn was awaited.
    struct StubSession {
        key: crate::agent::SessionKey,
        reject: bool,
        completed: Arc<std::sync::atomic::AtomicBool>,
    }

    impl StubSession {
        fn new(reject: bool) -> (Arc<Self>, Arc<std::sync::atomic::AtomicBool>) {
            let completed = Arc::new(std::sync::atomic::AtomicBool::new(false));
            let session = Arc::new(Self {
                key: "stub".to_owned(),
                reject,
                completed: Arc::clone(&completed),
            });
            (session, completed)
        }
    }

    impl crate::agent::AgentSession for StubSession {
        fn session_key(&self) -> &crate::agent::SessionKey {
            &self.key
        }
        fn send_turn(
            &self,
            _turn: crate::agent::TurnInput,
        ) -> crate::agent::BoxFuture<'_, Result<crate::agent::TurnId, AppError>> {
            let reject = self.reject;
            Box::pin(async move {
                if reject {
                    Err(AppError::AgentSessionBusy)
                } else {
                    Ok("t".to_owned())
                }
            })
        }
        fn await_turn_completion(
            &self,
            _turn: crate::agent::TurnId,
        ) -> crate::agent::BoxFuture<'_, Result<(), AppError>> {
            self.completed
                .store(true, std::sync::atomic::Ordering::SeqCst);
            Box::pin(async { Ok(()) })
        }
        fn cancel(
            &self,
            _turn: crate::agent::TurnId,
        ) -> crate::agent::BoxFuture<'_, Result<(), AppError>> {
            Box::pin(async { Ok(()) })
        }
        fn respond_permission(
            &self,
            _req: crate::agent::PermissionId,
            _decision: crate::agent::PermissionDecision,
        ) -> crate::agent::BoxFuture<'_, Result<(), AppError>> {
            Box::pin(async { Ok(()) })
        }
        fn shutdown(
            &self,
        ) -> crate::agent::BoxFuture<'_, Result<crate::agent::ExitSummary, AppError>> {
            Box::pin(async {
                Ok(crate::agent::ExitSummary {
                    exit_code: Some(0),
                    signal: None,
                })
            })
        }
    }

    fn request(worker_id: uuid::Uuid) -> AgentTurnRequest {
        AgentTurnRequest {
            worker_id,
            turn: crate::agent::TurnInput {
                prompt: "p".to_owned(),
            },
            priority: crate::agent::TurnPriority::Normal,
        }
    }

    /// The terminal receipt `execute_turn` synthesized, if any.
    fn synthesized_receipt(
        rx: &std::sync::mpsc::Receiver<crate::events::WriterMsg>,
    ) -> AgentTurnSettledPayload {
        let SwarmEvent::AgentTurnSettled(payload) = rx.try_recv().unwrap().event else {
            panic!("expected an agent_turn_settled receipt");
        };
        payload
    }

    #[tokio::test]
    async fn test_execute_turn_without_a_live_session_synthesizes_an_error_receipt() {
        let (tx, rx) = std::sync::mpsc::channel();
        execute_turn(
            AgentSessionRegistry::new(),
            EventSink::new(tx),
            request(uuid::Uuid::new_v4()),
        )
        .await;
        let receipt = synthesized_receipt(&rx);
        assert_eq!(receipt.status, AgentTurnStatus::Error);
        assert!(
            receipt
                .error
                .unwrap()
                .starts_with("No Live Session For This Worker")
        );
    }

    #[tokio::test]
    async fn test_execute_turn_rejected_by_the_session_synthesizes_an_error_receipt() {
        let worker_id = uuid::Uuid::new_v4();
        let sessions = AgentSessionRegistry::new();
        let (session, completed) = StubSession::new(true);
        sessions
            .begin_attach(worker_id)
            .unwrap()
            .insert(session)
            .unwrap();
        let (tx, rx) = std::sync::mpsc::channel();
        execute_turn(sessions, EventSink::new(tx), request(worker_id)).await;
        let receipt = synthesized_receipt(&rx);
        assert_eq!(receipt.status, AgentTurnStatus::Error);
        assert!(receipt.error.unwrap().starts_with("Turn Rejected"));
        assert!(!completed.load(std::sync::atomic::Ordering::SeqCst));
    }

    #[tokio::test]
    async fn test_execute_turn_accepted_by_the_session_awaits_it_and_emits_no_receipt() {
        let worker_id = uuid::Uuid::new_v4();
        let sessions = AgentSessionRegistry::new();
        let (session, completed) = StubSession::new(false);
        sessions
            .begin_attach(worker_id)
            .unwrap()
            .insert(session)
            .unwrap();
        let (tx, rx) = std::sync::mpsc::channel();
        execute_turn(sessions, EventSink::new(tx), request(worker_id)).await;
        assert!(completed.load(std::sync::atomic::Ordering::SeqCst));
        assert!(rx.try_recv().is_err());
    }

    /// A turn dispatched while a kill holds its worker closing never
    /// reaches the session about to be shut down: it settles as an
    /// error receipt instead.
    #[tokio::test]
    async fn test_execute_turn_for_a_closing_worker_synthesizes_an_error_receipt() {
        let worker_id = uuid::Uuid::new_v4();
        let sessions = AgentSessionRegistry::new();
        let (session, completed) = StubSession::new(false);
        sessions
            .begin_attach(worker_id)
            .unwrap()
            .insert(session)
            .unwrap();
        let _closing = sessions.begin_close(worker_id).await;
        let (tx, rx) = std::sync::mpsc::channel();
        execute_turn(sessions, EventSink::new(tx), request(worker_id)).await;
        let receipt = synthesized_receipt(&rx);
        assert_eq!(receipt.status, AgentTurnStatus::Error);
        assert!(
            receipt
                .error
                .unwrap()
                .starts_with("No Live Session For This Worker: Worker ")
        );
        assert!(!completed.load(std::sync::atomic::Ordering::SeqCst));
    }
}
