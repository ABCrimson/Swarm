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

use crate::agent::{AgentScheduler, AgentSessionRegistry, ClaudeCodeAdapter, CodexAdapter};
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
    pub codex_adapter: Arc<CodexAdapter>,
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
            codex_adapter: rt.codex_adapter.clone(),
            agent_session_registry: rt.agent_session_registry.clone(),
            scheduler: rt.scheduler.clone(),
        }))
    }

    /// Test/tool constructor — builds a `Ctx` from raw parts without
    /// requiring a full `Runtime` (which needs a real data dir + the
    /// single-instance lock). Used by this module's own unit tests and
    /// by `swarmd`'s integration test harness where convenient.
    #[doc(hidden)]
    #[expect(
        clippy::too_many_arguments,
        reason = "takes every Runtime part separately so tests can supply each one"
    )]
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
        codex_adapter: Arc<CodexAdapter>,
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
            codex_adapter,
            agent_session_registry,
            scheduler,
        }))
    }
}

/// A handler's return future, boxed for storage in the registry map.
pub type BoxFuture = Pin<Box<dyn Future<Output = Result<Value, Value>> + Send>>;

type HandlerBox = Arc<dyn Fn(Ctx, Value) -> BoxFuture + Send + Sync>;

/// Declarative remote-network policy for one registry entry — the
/// `security-review` finding BLOCK-1 fix: a network client (`swarmd`'s
/// WS `rpc` dispatcher) must never reach a handler through anything
/// OTHER than this declared policy. Before this type existed, the only
/// gate was `swarmd::ws`'s own `cmd == "read_config"` string check,
/// which caught the ONE command someone thought to special-case and let
/// `read_file`/`write_file` through uninspected — reproduced as a live
/// exfiltration of `<data_dir>/daemon-token`, `swarm-config.json` (the
/// Anthropic API key), and arbitrary `$HOME` files (`~/.gitconfig`,
/// `~/.claude/settings.json`) over an authenticated WS connection.
///
/// The Tauri desktop path is UNAFFECTED — [`Registry::dispatch`] (used
/// by every `#[tauri::command]` wrapper) never consults this; only
/// [`Registry::dispatch_remote`] (used exclusively by `swarmd`'s WS `rpc`
/// handler) does. Local IPC and local file access were never the
/// vulnerability — the network boundary was.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RemotePolicy {
    /// Safe to expose to any authenticated remote client verbatim — the
    /// default for the worker/session/agent/bus/metrics/orchestration
    /// surface. Note this still means "an authenticated remote client
    /// can run arbitrary shell commands as this user" via
    /// `spawn_worker`'s `shell`/`env`/`cwd` — that is the product's
    /// actual trust model (see `docs/architecture.md`'s Runtime Modes
    /// trust-boundary paragraph), not an oversight this enum fixes.
    Allowed,
    /// Never reachable over the network under ANY arguments —
    /// `read_file`/`write_file` read/write the DAEMON HOST's
    /// filesystem, including outside `Paths::data_dir` (their own
    /// `FsScopes` boundary permits all of `$HOME`) — not on the MVP
    /// remote surface (Dashboard/Workers/Terminals/Metrics/Agent chat),
    /// and the exact vector this fix closes.
    Denied,
    /// Reachable, but [`secret_filtered_denial`] inspects `args` first
    /// and can still deny — `read_config`/`write_config` both take a
    /// free-form `key: String`; a remote client must not be able to
    /// READ a secret-shaped key (credential exfiltration) or WRITE one
    /// (credential poisoning — a remote client planting its own
    /// `anthropic_api_key` that the desktop app would then trust).
    SecretFiltered,
}

/// `true` when `args`' `key` field (the shape both `read_config` and
/// `write_config` share) names a secret-prefixed key — see
/// [`config::is_secret_key`]. Applied uniformly to every
/// [`RemotePolicy::SecretFiltered`] entry by
/// [`Registry::dispatch_remote`] — a declarative, argument-shape check,
/// never a `cmd ==` string comparison at the call site.
fn secret_filtered_denial(args: &Value) -> Option<Value> {
    let is_secret = args
        .get("key")
        .and_then(|v| v.as_str())
        .is_some_and(config::is_secret_key);
    is_secret
        .then(|| Value::String("Remote Access To Secret-Shaped Config Keys Is Denied.".to_string()))
}

struct RegistryEntry {
    handler: HandlerBox,
    policy: RemotePolicy,
}

/// Builds one `(name, entry)` registry row from a plain `async fn(Ctx,
/// Value) -> Result<Value, Value>` plus its declared [`RemotePolicy`] —
/// no manual boxing boilerplate per command, and no command can be
/// added to the registry without SOME explicit policy (the parameter is
/// required, not defaulted).
fn entry<F, Fut>(name: &'static str, f: F, policy: RemotePolicy) -> (&'static str, RegistryEntry)
where
    F: Fn(Ctx, Value) -> Fut + Send + Sync + 'static,
    Fut: Future<Output = Result<Value, Value>> + Send + 'static,
{
    (
        name,
        RegistryEntry {
            handler: Arc::new(move |ctx, args| Box::pin(f(ctx, args)) as BoxFuture),
            policy,
        },
    )
}

/// `name -> handler` dispatch table. See the module doc for the
/// drift-proof contract with `generate_handler!`.
pub struct Registry {
    entries: std::collections::HashMap<&'static str, RegistryEntry>,
}

impl Registry {
    /// Builds the full registry. Every entry here is a command BOTH
    /// shells must expose identically — see [`NATIVE_ONLY`] for the two
    /// that are deliberately absent. Every entry ALSO declares a
    /// [`RemotePolicy`] — see that type's doc for why this is not
    /// optional.
    pub fn new() -> Self {
        use RemotePolicy::{Allowed, Denied, SecretFiltered};
        let entries: Vec<(&'static str, RegistryEntry)> = vec![
            // Worker commands
            entry("spawn_worker", worker::spawn_worker, Allowed),
            entry("pause_worker", worker::pause_worker, Allowed),
            entry("resume_worker", worker::resume_worker, Allowed),
            entry("kill_worker", worker::kill_worker, Allowed),
            entry("list_workers", worker::list_workers, Allowed),
            entry("worker_input", worker::worker_input, Allowed),
            entry("resize_worker", worker::resize_worker, Allowed),
            entry("set_max_workers", worker::set_max_workers, Allowed),
            // Git / ship commands
            entry("validate_repo_root", git::validate_repo_root, Allowed),
            entry("git_ship_preflight", git::git_ship_preflight, Allowed),
            entry("git_stage_commit", git::git_stage_commit, Allowed),
            entry("git_push", git::git_push, Allowed),
            entry("ship_compare_url", git::ship_compare_url, Allowed),
            entry("ship_context", git::ship_context, Allowed),
            // Session commands
            entry("create_session", session::create_session, Allowed),
            entry("delete_session", session::delete_session, Allowed),
            entry("list_sessions", session::list_sessions, Allowed),
            entry("get_session", session::get_session, Allowed),
            entry("session_add_worker", session::session_add_worker, Allowed),
            entry(
                "session_remove_worker",
                session::session_remove_worker,
                Allowed,
            ),
            // Agent commands
            entry("agent_turn_started", agent::agent_turn_started, Allowed),
            entry("agent_spawn", agent::agent_spawn, Allowed),
            entry("agent_send_turn", agent::agent_send_turn, Allowed),
            entry("agent_cancel", agent::agent_cancel, Allowed),
            entry("agent_shutdown", agent::agent_shutdown, Allowed),
            entry("agent_probe", agent::agent_probe, Allowed),
            entry(
                "agent_permission_respond",
                agent::agent_permission_respond,
                Allowed,
            ),
            entry(
                "set_agent_concurrency",
                agent::set_agent_concurrency,
                Allowed,
            ),
            // Config commands — secret-shaped keys filtered both ways
            // (read = exfiltration, write = poisoning).
            entry("read_config", config::read_config, SecretFiltered),
            entry("write_config", config::write_config, SecretFiltered),
            // File system commands — NEVER remote. Arbitrary daemon-host
            // file read/write, not on the MVP remote surface.
            entry("read_file", fs::read_file, Denied),
            entry("write_file", fs::write_file, Denied),
            // Metrics commands
            entry("get_metrics", metrics::get_metrics, Allowed),
            // Orchestration commands
            entry("events_since", orchestration::events_since, Allowed),
            // Bus commands — bus_subscribe/bus_create_pipeline/
            // bus_list_pipelines DELETED in Phase 4 (see
            // crate::bus::router's module doc): bus_send now emits
            // bus_message directly, and the pipeline machinery never
            // awaited a real stage's completion.
            entry("bus_send", bus::bus_send, Allowed),
            entry("bus_list_channels", bus::bus_list_channels, Allowed),
        ];
        Self {
            entries: entries.into_iter().collect(),
        }
    }

    /// Sorted command names — deterministic for the contract test and
    /// for any diagnostic listing.
    pub fn keys(&self) -> Vec<&'static str> {
        let mut v: Vec<&'static str> = self.entries.keys().copied().collect();
        v.sort_unstable();
        v
    }

    /// The declared [`RemotePolicy`] for `cmd`, or `None` if `cmd` has
    /// no registry entry at all.
    pub fn policy(&self, cmd: &str) -> Option<RemotePolicy> {
        self.entries.get(cmd).map(|e| e.policy)
    }

    /// Dispatches `cmd` with `args` for a LOCAL (Tauri IPC) caller — no
    /// [`RemotePolicy`] check. `swarm-desktop`'s command wrappers call
    /// this exclusively; they need the real `anthropic_api_key`, real
    /// file contents, etc. — the desktop app running on the user's own
    /// machine was never the threat model `RemotePolicy` defends
    /// against.
    ///
    /// Returns an `"Unknown Command"` error `Value` if no handler is
    /// registered under that name.
    pub async fn dispatch(&self, cmd: &str, ctx: Ctx, args: Value) -> Result<Value, Value> {
        match self.entries.get(cmd) {
            Some(entry) => (entry.handler)(ctx, args).await,
            None => Err(Value::String(format!("Unknown Command: \"{cmd}\"."))),
        }
    }

    /// Dispatches `cmd` with `args` for a REMOTE (WS `rpc`) caller —
    /// `swarmd`'s WS handler calls this EXCLUSIVELY, never
    /// [`Self::dispatch`], and never inspects `cmd` itself to decide
    /// what's safe (see [`RemotePolicy`]'s doc for why that string-check
    /// pattern was the vulnerability). [`RemotePolicy::Denied`] entries
    /// return a typed denial without ever invoking the handler;
    /// [`RemotePolicy::SecretFiltered`] entries run
    /// [`secret_filtered_denial`] first.
    pub async fn dispatch_remote(&self, cmd: &str, ctx: Ctx, args: Value) -> Result<Value, Value> {
        let Some(entry) = self.entries.get(cmd) else {
            return Err(Value::String(format!("Unknown Command: \"{cmd}\".")));
        };
        match entry.policy {
            RemotePolicy::Denied => Err(Value::String(format!(
                "\"{cmd}\" Is Not Available Over A Remote Connection."
            ))),
            RemotePolicy::SecretFiltered => {
                if let Some(denial) = secret_filtered_denial(&args) {
                    return Err(denial);
                }
                (entry.handler)(ctx, args).await
            }
            RemotePolicy::Allowed => (entry.handler)(ctx, args).await,
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
    fn test_registry_has_36_entries() {
        // 38 tauri commands total minus the 2 NATIVE_ONLY. Ship added
        // ship_context (Phase 2, +1); Codex added agent_permission_respond
        // (the real round-trip its interactive approvals need, +1) and
        // deleted bus_subscribe/bus_create_pipeline/bus_list_pipelines
        // (−3, see crate::bus::router's module doc); resize_worker
        // (+1). 36 + 1 + 1 − 3 + 1 = 36.
        assert_eq!(Registry::new().keys().len(), 36);
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

    // ── RemotePolicy (BLOCK-1 fix) ───────────────────────────────────

    /// DIRECTIVE (BLOCK-1): every registry entry has SOME policy — this
    /// is structurally guaranteed by `entry()`'s required parameter, but
    /// asserted here anyway as an explicit, readable contract: iterating
    /// `Registry::keys()` and asking `policy()` for each must never
    /// return `None` for a name the registry itself just returned.
    #[test]
    fn test_every_registry_entry_declares_a_policy() {
        let registry = Registry::new();
        for key in registry.keys() {
            assert!(
                registry.policy(key).is_some(),
                "{key} is a registry key but has no declared RemotePolicy"
            );
        }
    }

    /// DIRECTIVE (BLOCK-1): the remote-denied set, asserted EXPLICITLY
    /// by name — read_file/write_file, and nothing else. A regression
    /// that widens or narrows this set fails here, not silently.
    #[test]
    fn test_remote_denied_set_is_exactly_read_file_and_write_file() {
        let registry = Registry::new();
        let denied: std::collections::BTreeSet<&str> = registry
            .keys()
            .into_iter()
            .filter(|k| registry.policy(k) == Some(RemotePolicy::Denied))
            .collect();
        assert_eq!(
            denied,
            std::collections::BTreeSet::from(["read_file", "write_file"])
        );
    }

    /// DIRECTIVE (BLOCK-1): the secret-filtered set, asserted EXPLICITLY
    /// — read_config/write_config, both directions (read = exfiltration,
    /// write = poisoning).
    #[test]
    fn test_secret_filtered_set_is_exactly_read_config_and_write_config() {
        let registry = Registry::new();
        let filtered: std::collections::BTreeSet<&str> = registry
            .keys()
            .into_iter()
            .filter(|k| registry.policy(k) == Some(RemotePolicy::SecretFiltered))
            .collect();
        assert_eq!(
            filtered,
            std::collections::BTreeSet::from(["read_config", "write_config"])
        );
    }

    /// DIRECTIVE (BLOCK-1, the reproduced exfiltration, closed): a
    /// remote `read_file` call — for ANY path, including the daemon
    /// token file itself — is denied without the handler ever running
    /// (so a filesystem error from an unscoped path can't leak path
    /// existence either).
    #[tokio::test]
    async fn test_dispatch_remote_denies_read_file_unconditionally() {
        let registry = Registry::new();
        let ctx = test_support::test_ctx();
        // The exact reproduced exfiltration target — daemon-token — but
        // the point of `Denied` is that ANY path is refused before the
        // handler (and therefore the path itself) is ever inspected.
        let daemon_token_path = ctx.paths.data_dir.join("daemon-token");
        let result = registry
            .dispatch_remote(
                "read_file",
                ctx,
                serde_json::json!({ "path": daemon_token_path.display().to_string() }),
            )
            .await;
        assert!(
            result.is_err(),
            "read_file must be denied over dispatch_remote"
        );
    }

    #[tokio::test]
    async fn test_dispatch_remote_denies_write_file_unconditionally() {
        let registry = Registry::new();
        let ctx = test_support::test_ctx();
        let result = registry
            .dispatch_remote(
                "write_file",
                ctx,
                serde_json::json!({ "path": "/tmp/whatever", "content": "x" }),
            )
            .await;
        assert!(
            result.is_err(),
            "write_file must be denied over dispatch_remote"
        );
    }

    /// DIRECTIVE (BLOCK-1): `read_config("anthropic_api_key")` over
    /// `dispatch_remote` is denied — the exact reproduced exfiltration
    /// path, now closed at the registry layer instead of a
    /// `swarmd::ws`-local string check.
    #[tokio::test]
    async fn test_dispatch_remote_denies_reading_the_anthropic_key() {
        let registry = Registry::new();
        let ctx = test_support::test_ctx();
        let result = registry
            .dispatch_remote(
                "read_config",
                ctx,
                serde_json::json!({ "key": "anthropic_api_key" }),
            )
            .await;
        assert!(result.is_err());
    }

    /// DIRECTIVE (BLOCK-1, poisoning half): a remote client must not be
    /// able to WRITE a secret-shaped key either — planting a value the
    /// desktop app (or `swarmd` itself) would later trust.
    #[tokio::test]
    async fn test_dispatch_remote_denies_writing_a_secret_shaped_key() {
        let registry = Registry::new();
        let ctx = test_support::test_ctx();
        let result = registry
            .dispatch_remote(
                "write_config",
                ctx,
                serde_json::json!({ "key": "anthropic_api_key", "value": "sk-attacker-planted" }),
            )
            .await;
        assert!(result.is_err());
    }

    /// An ordinary (non-secret) config key still works over
    /// `dispatch_remote` — the filter is narrow, not a blanket ban.
    #[tokio::test]
    async fn test_dispatch_remote_allows_an_ordinary_config_key() {
        let registry = Registry::new();
        let ctx = test_support::test_ctx();
        let result = registry
            .dispatch_remote(
                "read_config",
                ctx,
                serde_json::json!({ "key": "max_workers" }),
            )
            .await;
        assert!(result.is_ok());
    }

    /// DIRECTIVE (BLOCK-1): an `Allowed` command (e.g. `list_workers`)
    /// behaves identically through `dispatch_remote` as through
    /// `dispatch` — the policy layer adds a gate, not a behavior change,
    /// for the commands that were always meant to be remote.
    #[tokio::test]
    async fn test_dispatch_remote_allowed_command_behaves_like_local_dispatch() {
        let registry = Registry::new();
        let ctx = test_support::test_ctx();
        let result = registry
            .dispatch_remote("list_workers", ctx, serde_json::json!({}))
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
        AgentScheduler, AgentSchedulerConfig, AgentSessionRegistry, ClaudeCodeAdapter, CodexAdapter,
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
        let shared_system = SharedSystem::new();
        let log = EventLog::open_in_memory().unwrap();
        let engine = OrchestrationEngine::start(log, None, |_| {});
        let sink = engine.sink();
        let router = Router::new(message_bus.clone(), sink.clone());
        let claude_adapter = Arc::new(ClaudeCodeAdapter::new(sink.clone()));
        let codex_adapter = Arc::new(CodexAdapter::new(sink.clone()));
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
            codex_adapter,
            agent_session_registry,
            scheduler,
        )
    }
}
