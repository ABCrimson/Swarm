//! The single command registry: `name -> handler(Ctx, Value)`.
//!
//! Headless-daemon plan Phase 2 item 2: ONE registry, consumed by BOTH
//! the `swarm-desktop` `#[tauri::command]` wrappers and `swarmd`'s WS
//! `rpc` dispatcher. Without this, "works locally, missing remotely" is
//! a permanent drift risk — every handler here is the ONLY place its
//! logic lives; both shells are thin adapters over it (the Tauri
//! wrappers convert typed IPC args to/from JSON and call
//! [`Registry::dispatch`]; `swarmd`'s WS layer does the same for `rpc`
//! frames).
//!
//! # Drift-proof contract
//!
//! [`Registry::keys`] must equal `generate_handler!`'s command list
//! minus [`NATIVE_ONLY`] (commands that only make sense with a live
//! webview/OS integration: `check_for_updates`, `send_notification`).
//! `swarm-desktop`'s test suite enforces this by parsing its own
//! `lib.rs` source (`include_str!`) for the `generate_handler![...]`
//! block — re-read on every test run, not a hand-maintained snapshot —
//! so a new Tauri command added without a matching registry entry (or
//! vice versa) fails CI. See `swarm-desktop/src/registry_contract.rs`.
//!
//! # `Ctx`
//!
//! A cheap-to-clone (`Arc`-wrapped) bundle of every piece of shared
//! state a handler might need, built once from a
//! [`crate::runtime::Runtime`] via [`Ctx::from_runtime`]. Handlers never
//! see a `Runtime` directly — only the fields they need, through `Ctx`'s
//! `Deref`.

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use serde::de::DeserializeOwned;
use serde_json::Value;
use uuid::Uuid;

use crate::agent::{AgentScheduler, AgentSessionRegistry, ClaudeCodeAdapter};
use crate::bus::channel::MessageBus;
use crate::bus::router::Router;
use crate::events::Provenance;
use crate::git::RepoLocks;
use crate::metrics::SharedSystem;
use crate::orchestration::OrchestrationEngine;
use crate::session::SessionManager;
use crate::worker::registry::WorkerRegistry;
use crate::{Paths, events::EventSink};

pub mod agent;
pub mod bus;
pub mod config;
pub mod fs;
pub mod git;
pub mod metrics;
pub mod orchestration;
pub mod session;
pub mod worker;

/// Commands that exist ONLY as `#[tauri::command]` wrappers in
/// `swarm-desktop` — they need a live webview/OS integration
/// (`tauri-plugin-updater`, `tauri-plugin-notification`) that has no
/// meaning over a network RPC call, so they deliberately have no
/// registry entry. The contract test subtracts this list from
/// `generate_handler!`'s names before comparing against
/// [`Registry::keys`].
pub const NATIVE_ONLY: &[&str] = &["check_for_updates", "send_notification"];

/// Shared state every registry handler may need, built once per shell
/// from a [`crate::runtime::Runtime`]. Cloning `Ctx` is one `Arc` bump —
/// safe and cheap to clone per WS connection / per IPC call.
#[derive(Clone)]
pub struct Ctx(Arc<CtxInner>);

pub struct CtxInner {
    pub paths: Paths,
    pub registry: WorkerRegistry,
    pub session_manager: SessionManager,
    pub repo_locks: RepoLocks,
    pub message_bus: MessageBus,
    pub router: Router,
    pub shared_system: SharedSystem,
    pub engine: OrchestrationEngine,
    pub sink: EventSink,
    pub claude_adapter: Arc<ClaudeCodeAdapter>,
    pub agent_session_registry: AgentSessionRegistry,
    pub scheduler: Arc<AgentScheduler>,
}

impl std::ops::Deref for Ctx {
    type Target = CtxInner;
    fn deref(&self) -> &CtxInner {
        &self.0
    }
}

impl Ctx {
    /// Builds a `Ctx` from a live [`crate::runtime::Runtime`]. Every
    /// field is independently `Clone` (each already `Arc`/`DashMap`
    /// internally, or now `Arc`-wrapped for the two that weren't) —
    /// this is a handful of cheap ref-count bumps, not a deep copy.
    pub fn from_runtime(rt: &crate::runtime::Runtime) -> Self {
        Self(Arc::new(CtxInner {
            paths: rt.paths.clone(),
            registry: rt.registry.clone(),
            session_manager: rt.session_manager.clone(),
            repo_locks: rt.repo_locks.clone(),
            message_bus: rt.message_bus.clone(),
            router: rt.router.clone(),
            shared_system: rt.shared_system.clone(),
            engine: rt.engine.clone(),
            sink: rt.sink.clone(),
            claude_adapter: rt.claude_adapter.clone(),
            agent_session_registry: rt.agent_session_registry.clone(),
            scheduler: rt.scheduler.clone(),
        }))
    }

    /// Test/tool constructor — builds a `Ctx` from raw parts without
    /// requiring a full `Runtime` (which needs a real data dir + the
    /// single-instance lock). Used by this module's own unit tests and
    /// by `swarmd`'s integration test harness where convenient.
    #[doc(hidden)]
    #[allow(clippy::too_many_arguments)]
    pub fn new_for_test(
        paths: Paths,
        registry: WorkerRegistry,
        session_manager: SessionManager,
        repo_locks: RepoLocks,
        message_bus: MessageBus,
        router: Router,
        shared_system: SharedSystem,
        engine: OrchestrationEngine,
        sink: EventSink,
        claude_adapter: Arc<ClaudeCodeAdapter>,
        agent_session_registry: AgentSessionRegistry,
        scheduler: Arc<AgentScheduler>,
    ) -> Self {
        Self(Arc::new(CtxInner {
            paths,
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
        }))
    }
}

/// A handler's return future, boxed for storage in the registry map.
pub type BoxFuture = Pin<Box<dyn Future<Output = Result<Value, Value>> + Send>>;

type HandlerBox = Arc<dyn Fn(Ctx, Value) -> BoxFuture + Send + Sync>;

/// Builds one `(name, handler)` registry entry from a plain `async fn(Ctx,
/// Value) -> Result<Value, Value>` — no manual boxing boilerplate per
/// command.
fn entry<F, Fut>(name: &'static str, f: F) -> (&'static str, HandlerBox)
where
    F: Fn(Ctx, Value) -> Fut + Send + Sync + 'static,
    Fut: Future<Output = Result<Value, Value>> + Send + 'static,
{
    (
        name,
        Arc::new(move |ctx, args| Box::pin(f(ctx, args)) as BoxFuture),
    )
}

/// `name -> handler` dispatch table. See the module doc for the
/// drift-proof contract with `generate_handler!`.
pub struct Registry {
    handlers: std::collections::HashMap<&'static str, HandlerBox>,
}

impl Registry {
    /// Builds the full registry. Every entry here is a command BOTH
    /// shells must expose identically — see [`NATIVE_ONLY`] for the two
    /// that are deliberately absent.
    pub fn new() -> Self {
        let entries: Vec<(&'static str, HandlerBox)> = vec![
            // Worker commands
            entry("spawn_worker", worker::spawn_worker),
            entry("pause_worker", worker::pause_worker),
            entry("resume_worker", worker::resume_worker),
            entry("kill_worker", worker::kill_worker),
            entry("list_workers", worker::list_workers),
            entry("worker_input", worker::worker_input),
            entry("set_max_workers", worker::set_max_workers),
            // Git / ship commands
            entry("validate_repo_root", git::validate_repo_root),
            entry("git_ship_preflight", git::git_ship_preflight),
            entry("git_stage_commit", git::git_stage_commit),
            entry("git_push", git::git_push),
            entry("ship_compare_url", git::ship_compare_url),
            // Session commands
            entry("create_session", session::create_session),
            entry("delete_session", session::delete_session),
            entry("list_sessions", session::list_sessions),
            entry("get_session", session::get_session),
            entry("session_add_worker", session::session_add_worker),
            // Agent commands
            entry("agent_turn_started", agent::agent_turn_started),
            entry("agent_spawn", agent::agent_spawn),
            entry("agent_send_turn", agent::agent_send_turn),
            entry("agent_cancel", agent::agent_cancel),
            entry("agent_shutdown", agent::agent_shutdown),
            entry("agent_probe", agent::agent_probe),
            // Config commands
            entry("read_config", config::read_config),
            entry("write_config", config::write_config),
            // File system commands
            entry("read_file", fs::read_file),
            entry("write_file", fs::write_file),
            // Metrics commands
            entry("get_metrics", metrics::get_metrics),
            // Orchestration commands
            entry("events_since", orchestration::events_since),
            // Bus commands
            entry("bus_send", bus::bus_send),
            entry("bus_subscribe", bus::bus_subscribe),
            entry("bus_create_pipeline", bus::bus_create_pipeline),
            entry("bus_list_channels", bus::bus_list_channels),
            entry("bus_list_pipelines", bus::bus_list_pipelines),
        ];
        Self {
            handlers: entries.into_iter().collect(),
        }
    }

    /// Sorted command names — deterministic for the contract test and
    /// for any diagnostic listing.
    pub fn keys(&self) -> Vec<&'static str> {
        let mut v: Vec<&'static str> = self.handlers.keys().copied().collect();
        v.sort_unstable();
        v
    }

    /// Dispatches `cmd` with `args`, or an `"Unknown Command"` error
    /// `Value` if no handler is registered under that name.
    pub async fn dispatch(&self, cmd: &str, ctx: Ctx, args: Value) -> Result<Value, Value> {
        match self.handlers.get(cmd) {
            Some(handler) => handler(ctx, args).await,
            None => Err(Value::String(format!("Unknown Command: \"{cmd}\"."))),
        }
    }
}

impl Default for Registry {
    fn default() -> Self {
        Self::new()
    }
}

// ── Shared handler helpers ──────────────────────────────────────────

/// Deserializes `args` into `T`, mapping a shape mismatch to a plain
/// string error `Value` (the same wire shape every other handler error
/// uses).
pub(crate) fn parse_args<T: DeserializeOwned>(args: Value) -> Result<T, Value> {
    serde_json::from_value(args).map_err(|e| Value::String(format!("Invalid Arguments: {e}")))
}

/// Serializes a successful result into the registry's `Value` return
/// type.
pub(crate) fn ok_value<T: serde::Serialize>(v: &T) -> Result<Value, Value> {
    serde_json::to_value(v).map_err(|e| Value::String(e.to_string()))
}

/// Serializes a typed error (e.g. [`crate::error::AppError`],
/// [`crate::git::ShipError`]) into the registry's `Value` error type —
/// the exact same `Serialize` impl Tauri IPC already uses to ship these
/// errors to the frontend, just captured as `Value` instead of sent
/// directly over IPC.
pub(crate) fn err_value<E: serde::Serialize>(e: &E) -> Value {
    serde_json::to_value(e).unwrap_or_else(|_| Value::String("Serialization Error".to_string()))
}

/// Parses optional `originWorker`/`causeSeq` args into a [`Provenance`]
/// — the registry-side counterpart of the identical helper that used to
/// live only in `swarm-desktop::commands::parse_provenance`. Absent
/// `originWorker` yields `Provenance::default()`; a present-but-malformed
/// one is rejected (not silently downgraded), matching every other
/// closed-shape validation in this codebase.
pub(crate) fn parse_provenance(
    origin_worker: Option<String>,
    cause_seq: Option<u64>,
) -> Result<Provenance, Value> {
    let origin_worker = origin_worker
        .map(|s| Uuid::parse_str(&s))
        .transpose()
        .map_err(|e| Value::String(e.to_string()))?;
    Ok(Provenance {
        origin_worker,
        cause_seq,
    })
}

pub(crate) fn parse_uuid(raw: &str) -> Result<Uuid, Value> {
    Uuid::parse_str(raw).map_err(|e| Value::String(format!("Invalid UUID \"{raw}\": {e}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_registry_has_no_native_only_entries() {
        let registry = Registry::new();
        for native in NATIVE_ONLY {
            assert!(
                !registry.keys().contains(native),
                "{native} must not have a registry entry — it is NATIVE_ONLY"
            );
        }
    }

    #[test]
    fn test_registry_keys_are_sorted_and_deduplicated() {
        let registry = Registry::new();
        let keys = registry.keys();
        let mut sorted = keys.clone();
        sorted.sort_unstable();
        assert_eq!(keys, sorted);
        let unique: std::collections::HashSet<_> = keys.iter().collect();
        assert_eq!(unique.len(), keys.len());
    }

    #[test]
    fn test_registry_has_34_entries() {
        // 36 tauri commands total minus the 2 NATIVE_ONLY.
        assert_eq!(Registry::new().keys().len(), 34);
    }

    #[tokio::test]
    async fn test_dispatch_unknown_command_is_a_clean_error_not_a_panic() {
        let registry = Registry::new();
        let ctx = test_support::test_ctx();
        let result = registry
            .dispatch("does_not_exist", ctx, serde_json::json!({}))
            .await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_dispatch_list_workers_on_an_empty_registry() {
        let registry = Registry::new();
        let ctx = test_support::test_ctx();
        let result = registry
            .dispatch("list_workers", ctx, serde_json::json!({}))
            .await
            .unwrap();
        assert_eq!(result, serde_json::json!([]));
    }
}

/// Test-only construction helpers, shared by this module's tests and by
/// every `commands::*` submodule's tests (`#[cfg(test)] pub(crate)` so
/// it never ships in a release build).
#[cfg(test)]
pub(crate) mod test_support {
    use std::sync::Arc;

    use super::Ctx;
    use crate::Paths;
    use crate::agent::{
        AgentScheduler, AgentSchedulerConfig, AgentSessionRegistry, ClaudeCodeAdapter,
    };
    use crate::bus::channel::MessageBus;
    use crate::bus::router::Router;
    use crate::git::RepoLocks;
    use crate::metrics::SharedSystem;
    use crate::orchestration::{EventLog, OrchestrationEngine};
    use crate::session::SessionManager;
    use crate::worker::registry::WorkerRegistry;

    pub(crate) fn temp_paths() -> Paths {
        let dir = std::env::temp_dir().join(format!("swarm-cmd-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        Paths { data_dir: dir }
    }

    /// A fully-wired `Ctx` over an in-memory event log — no data dir
    /// contention with the single-instance lock, safe to build any
    /// number of times per test process.
    pub(crate) fn test_ctx() -> Ctx {
        let registry = WorkerRegistry::new();
        let session_manager = SessionManager::new();
        let repo_locks = RepoLocks::new();
        let message_bus = MessageBus::new();
        let router = Router::new(message_bus.clone());
        let shared_system = SharedSystem::new();
        let log = EventLog::open_in_memory().unwrap();
        let engine = OrchestrationEngine::start(log, None, |_| {});
        let sink = engine.sink();
        let claude_adapter = Arc::new(ClaudeCodeAdapter::new(sink.clone()));
        let agent_session_registry = AgentSessionRegistry::new();
        let scheduler = Arc::new(AgentScheduler::new(
            AgentSchedulerConfig::default(),
            |_req| async {},
        ));

        Ctx::new_for_test(
            temp_paths(),
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
        )
    }
}
