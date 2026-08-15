//! Shared runtime construction: the Tauri-free counterpart of what used
//! to be `swarm-desktop`'s `lib.rs::run`'s `setup()` closure.
//!
//! Both shells (`swarm-desktop` and `swarmd`) build their engine,
//! registries, and scheduler through [`Runtime::start`] — one
//! construction site instead of two independently-maintained copies
//! that could silently drift (e.g. one shell forgetting the
//! agent-scheduler's turn-lock discipline, or applying the persisted
//! `max_workers` cap differently). What stays shell-specific (window
//! icon, `app.manage()` calls, the `emit` closure's actual delivery
//! mechanism) is passed in or left to the caller — this module only
//! owns what is identical between the two.
//!
//! # Behavior-preservation note
//!
//! This is a mechanical extraction of `swarm-desktop`'s pre-Phase-2
//! `run()` setup body — same construction order, same defaults, same
//! best-effort/non-fatal handling for a missing git or unreadable
//! persisted config. `swarm-desktop`'s `lib.rs` now calls this instead
//! of duplicating it; nothing about what it constructs changed.

use std::sync::Arc;

use tokio_util::sync::CancellationToken;

use crate::Paths;
use crate::agent::{
    AgentScheduler, AgentSchedulerConfig, AgentSessionRegistry, AgentTurnRequest,
    ClaudeCodeAdapter, MAX_AGENT_CONCURRENCY, MIN_AGENT_CONCURRENCY,
};
use crate::bus::channel::MessageBus;
use crate::bus::router::Router;
use crate::events::{EventSink, SwarmEvent, SystemLogPayload};
use crate::git::{self, GitCapability, RepoLocks};
use crate::lock::{LockError, SingleInstanceLock};
use crate::metrics::SharedSystem;
use crate::orchestration::{DomainEvent, EventLog, OrchestrationEngine};
use crate::session::SessionManager;
use crate::worker::registry::WorkerRegistry;

/// Filename of the SQLite event log under [`Paths::data_dir`] — the
/// single source of truth both shells must agree on (see the
/// single-instance lock's whole reason for existing).
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
#[derive(Debug)]
pub enum RuntimeStartError {
    /// Another process already holds the single-instance lock (or the
    /// lock could not be acquired for another I/O reason).
    Lock(LockError),
    /// The SQLite event log could not be opened.
    EventLog(crate::error::AppError),
}

impl std::fmt::Display for RuntimeStartError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            RuntimeStartError::Lock(e) => write!(f, "{e}"),
            RuntimeStartError::EventLog(e) => write!(f, "Failed To Open The Event Log: {e}"),
        }
    }
}

impl std::error::Error for RuntimeStartError {}

/// Every piece of shared, Tauri-free application state, constructed and
/// wired together once. The caller (`swarm-desktop`'s `setup()` closure
/// or `swarmd`'s `main()`) owns what happens to each field afterward
/// (e.g. `app.manage()`-ing them, or handing them to the WS RPC
/// dispatcher's [`crate::commands::Ctx`]).
pub struct Runtime {
    pub paths: Paths,
    /// Held for the process's lifetime — dropping it releases the OS
    /// lock. Never read after construction; its existence in this
    /// struct simply keeps it alive as long as `Runtime` is.
    pub lock: SingleInstanceLock,
    pub registry: WorkerRegistry,
    pub session_manager: SessionManager,
    pub repo_locks: RepoLocks,
    pub message_bus: MessageBus,
    pub router: Router,
    pub shared_system: SharedSystem,
    pub engine: OrchestrationEngine,
    pub sink: EventSink,
    /// `Arc`-wrapped (unlike every other field here, which is already
    /// internally `Arc`/`DashMap`-backed and `Clone`) so that
    /// [`crate::commands::Ctx`] — built from `&Runtime` for the WS RPC
    /// dispatcher, and consumed independently of whatever the Tauri
    /// shell does with its own `app.manage()` copy — can share the same
    /// instance without requiring `ClaudeCodeAdapter` itself to be
    /// `Clone`.
    pub claude_adapter: Arc<ClaudeCodeAdapter>,
    pub agent_session_registry: AgentSessionRegistry,
    /// `Arc`-wrapped — see the [`Self::claude_adapter`] doc; same
    /// reasoning applies to `AgentScheduler`.
    pub scheduler: Arc<AgentScheduler>,
    pub metrics_cancel: CancellationToken,
}

impl Runtime {
    /// Acquires the single-instance lock, opens the event log, starts
    /// the writer thread (via `emit`, the caller's PRIMARY delivery
    /// mechanism — see [`OrchestrationEngine::start`]'s doc), loads
    /// persisted sessions and the persisted worker cap, probes git,
    /// prunes stale worktrees for the default repo root, starts the
    /// metrics loop, and wires the agent scheduler's executor — in that
    /// order, matching the pre-extraction `swarm-desktop` setup exactly.
    ///
    /// # Errors
    ///
    /// [`RuntimeStartError::Lock`] if another process already holds the
    /// data directory (the caller should exit with the message —
    /// [`RuntimeStartError`]'s `Display` is already the Title Case
    /// "SWARM Is Already Running" text). [`RuntimeStartError::EventLog`]
    /// if the SQLite file cannot be opened.
    pub fn start(
        config: RuntimeConfig,
        emit: impl FnMut(&DomainEvent) + Send + 'static,
    ) -> Result<Self, RuntimeStartError> {
        let lock =
            SingleInstanceLock::acquire(&config.paths.data_dir, config.shell_name, config.bind)
                .map_err(RuntimeStartError::Lock)?;

        let registry = WorkerRegistry::new();
        let session_manager = SessionManager::new();
        let repo_locks = RepoLocks::new();
        let message_bus = MessageBus::new();
        let router = Router::new(message_bus.clone());
        let shared_system = SharedSystem::new();

        let db_path = config.paths.data_dir.join(EVENT_LOG_FILE);
        let event_log = EventLog::open(&db_path).map_err(RuntimeStartError::EventLog)?;
        let engine = OrchestrationEngine::start(event_log, Some(db_path), emit);
        let sink = engine.sink();

        if let Err(e) = crate::session::persist::load(&config.paths, &session_manager) {
            tracing::warn!(error = %e, "failed to load persisted sessions");
        }

        if let Some(max) =
            crate::config::read_value(&config.paths, "max_workers").and_then(|v| v.as_u64())
            && let Err(e) = registry.set_max_workers(max as usize)
        {
            tracing::warn!(error = %e, "ignoring persisted max_workers");
        }

        match git::probe_capability() {
            GitCapability::Available { version } => {
                tracing::info!(
                    version = format!("{}.{}.{}", version.0, version.1, version.2),
                    "git worktree isolation available"
                );
            }
            GitCapability::Unavailable { reason } => {
                tracing::warn!(reason = %reason, "git worktree isolation unavailable");
                sink.emit(SwarmEvent::SystemLog(SystemLogPayload {
                    level: "warn".to_string(),
                    message: format!(
                        "Git Unavailable — Isolated Spawns Will Fail Until Git Is Installed Or Upgraded: {reason}"
                    ),
                    target: "swarm_core::git".to_string(),
                    timestamp: now_ms(),
                }));
            }
        }

        if let Some(default_repo_root) =
            crate::config::read_value(&config.paths, "default_repo_root")
                .and_then(|v| v.as_str().map(str::to_string))
        {
            match git::worktree::prune(std::path::Path::new(&default_repo_root)) {
                Ok(count) => tracing::info!(
                    repo_root = %default_repo_root,
                    pruned = count,
                    "startup worktree prune complete"
                ),
                Err(e) => tracing::warn!(
                    repo_root = %default_repo_root,
                    error = %e,
                    "startup worktree prune failed"
                ),
            }
        }

        let metrics_cancel = CancellationToken::new();
        crate::metrics::start_metrics_loop(
            sink.clone(),
            registry.clone(),
            shared_system.clone(),
            metrics_cancel.clone(),
        );

        let claude_adapter = Arc::new(ClaudeCodeAdapter::new(sink.clone()));
        let agent_session_registry = AgentSessionRegistry::new();

        let scheduler_registry = agent_session_registry.clone();
        let scheduler_sink = sink.clone();
        let scheduler = Arc::new(AgentScheduler::new(
            AgentSchedulerConfig::default(),
            move |request: AgentTurnRequest| {
                let registry = scheduler_registry.clone();
                let sink = scheduler_sink.clone();
                async move {
                    let turn_lock = registry.turn_lock(&request.worker_id);
                    let _guard = turn_lock.lock().await;

                    let dispatch_error = match registry.get(&request.worker_id) {
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
                        tracing::warn!(worker_id = %request.worker_id, %error, "agent turn dispatch failed — synthesizing a terminal receipt");
                        sink.emit(SwarmEvent::AgentTurnSettled(
                            crate::events::AgentTurnSettledPayload {
                                worker_id: request.worker_id,
                                turn_id: uuid::Uuid::new_v4().to_string(),
                                status: crate::agent::AgentTurnStatus::Error,
                                error: Some(error),
                                cost_usd: None,
                                usage: None,
                                duration_ms: 0,
                                num_turns: None,
                            },
                        ));
                    }
                }
            },
        ));

        // Apply the persisted agent-turn concurrency cap (set via
        // Settings -> set_agent_concurrency). An absent or
        // out-of-range value keeps AgentSchedulerConfig::default()'s
        // 3 — same "invalid/missing persisted value degrades to the
        // constructor default" discipline as `max_workers` above.
        if let Some(limit) = crate::config::read_value(&config.paths, "agent_concurrency")
            .and_then(|v| v.as_u64())
            .and_then(|v| u32::try_from(v).ok())
        {
            if (MIN_AGENT_CONCURRENCY..=MAX_AGENT_CONCURRENCY).contains(&limit) {
                scheduler.set_concurrency(limit as usize);
            } else {
                tracing::warn!(limit, "ignoring out-of-range persisted agent_concurrency");
            }
        }

        Ok(Self {
            paths: config.paths,
            lock,
            registry,
            session_manager,
            repo_locks,
            message_bus,
            router,
            shared_system,
            engine,
            sink,
            claude_adapter,
            agent_session_registry,
            scheduler,
            metrics_cancel,
        })
    }
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_paths() -> (Paths, TempDir) {
        let dir = std::env::temp_dir().join(format!("swarm-runtime-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let cleanup = TempDir(dir.clone());
        (Paths { data_dir: dir }, cleanup)
    }

    struct TempDir(std::path::PathBuf);
    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[tokio::test]
    async fn test_runtime_start_succeeds_on_a_fresh_data_dir() {
        let (paths, _cleanup) = temp_paths();
        let rt = Runtime::start(
            RuntimeConfig {
                paths,
                shell_name: "swarmd",
                bind: Some("127.0.0.1:8787".to_string()),
            },
            |_| {},
        );
        assert!(rt.is_ok());
    }

    #[tokio::test]
    async fn test_second_runtime_start_against_the_same_data_dir_fails_locked() {
        let (paths, _cleanup) = temp_paths();
        let rt1 = Runtime::start(
            RuntimeConfig {
                paths: paths.clone(),
                shell_name: "swarm-desktop",
                bind: None,
            },
            |_| {},
        )
        .unwrap();

        let rt2 = Runtime::start(
            RuntimeConfig {
                paths,
                shell_name: "swarmd",
                bind: Some("127.0.0.1:8787".to_string()),
            },
            |_| {},
        );
        assert!(matches!(rt2, Err(RuntimeStartError::Lock(_))));
        drop(rt1);
    }
}
