//! The command registry: one `name -> handler(Ctx, args)` table that
//! both shells dispatch through.
//!
//! `swarm-desktop`'s `#[tauri::command]` forwarders hand each invoke's
//! JSON arguments to [`Registry::dispatch`] untouched; `swarmd`'s
//! WebSocket `rpc` frames go through
//! [`Registry::dispatch_remote`], which additionally enforces each
//! command's [`RemotePolicy`]. Every handler body lives here exactly
//! once, so a command cannot work locally yet be missing — or behave
//! differently — remotely.
//!
//! # Arguments
//!
//! A handler takes its arguments as one JSON object. Both dispatchers
//! normalize them first: omitted or `null` arguments become `{}`, and
//! anything other than an object (a positional array, a bare string) is
//! rejected before any policy check or handler runs. Serde would happily
//! deserialize a handler's argument struct from an array, so an
//! un-normalized array could carry a secret-shaped config key straight
//! past [`RemotePolicy::SecretFiltered`]'s inspection of the `key`
//! field.
//!
//! # Drift-proof contract
//!
//! [`Registry::keys`] must equal the desktop shell's forwarded command
//! list, and its native commands must equal [`NATIVE_ONLY`].
//! `swarm-desktop`'s `commands` tests compare the two name lists its
//! `commands!` macro declares against these, so a command added on one
//! side only fails CI.
//!
//! # `Ctx`
//!
//! A cheap-to-clone bundle of every piece of shared state a handler may
//! need, built once per shell from a [`crate::runtime::Runtime`] via
//! [`Ctx::from_runtime`]. Handlers reach its fields through `Deref`.

use std::collections::HashMap;
use std::pin::Pin;
use std::sync::Arc;

use serde::de::DeserializeOwned;
use serde_json::Value;
use uuid::Uuid;

use crate::Paths;
use crate::agent::{AgentScheduler, AgentSessionRegistry, ClaudeCodeAdapter, CodexAdapter};
use crate::bus::channel::MessageBus;
use crate::bus::router::Router;
use crate::events::{EventSink, Provenance};
use crate::git::RepoLocks;
use crate::metrics::SharedSystem;
use crate::orchestration::OrchestrationEngine;
use crate::session::SessionManager;
use crate::worker::registry::WorkerRegistry;

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
/// `swarm-desktop`: they need a live webview or OS integration
/// (`tauri-plugin-updater`, `tauri-plugin-notification`) that means
/// nothing over a network, so they have no registry entry. The desktop
/// shell's contract tests check that its native commands are exactly
/// this list and that none of them is a [`Registry::keys`] entry.
pub const NATIVE_ONLY: &[&str] = &["check_for_updates", "send_notification"];

/// Shared state for every registry handler. Cloning is one `Arc` bump —
/// cheap per WebSocket connection and per IPC call.
#[derive(Clone)]
pub struct Ctx(Arc<CtxInner>);

/// The fields of a [`Ctx`] (reached through its `Deref`). Each is
/// already cheap to clone; see [`crate::runtime::Runtime`] for what each
/// one is.
pub struct CtxInner {
    /// The data directory (config, sessions, event log).
    pub paths: Paths,
    /// Live PTY workers.
    pub registry: WorkerRegistry,
    /// Sessions and their worker membership.
    pub session_manager: SessionManager,
    /// Per-repository git operation locks.
    pub repo_locks: RepoLocks,
    /// The inter-agent bus's topic registry.
    pub message_bus: MessageBus,
    /// Routes `bus_send` messages onto the ordered event stream.
    pub router: Router,
    /// The shared `sysinfo` handle metrics are sampled from.
    pub shared_system: SharedSystem,
    /// The ordered event engine.
    pub engine: OrchestrationEngine,
    /// Records events into [`Self::engine`].
    pub sink: EventSink,
    /// The Claude Code provider adapter.
    pub claude_adapter: Arc<ClaudeCodeAdapter>,
    /// The Codex provider adapter.
    pub codex_adapter: Arc<CodexAdapter>,
    /// Live provider-agent sessions, keyed by worker id.
    pub agent_session_registry: AgentSessionRegistry,
    /// The agent-turn scheduler.
    pub scheduler: Arc<AgentScheduler>,
}

impl std::ops::Deref for Ctx {
    type Target = CtxInner;

    fn deref(&self) -> &CtxInner {
        &self.0
    }
}

/// Builds a `Ctx` from explicit parts — for callers (tests, tools) that
/// have no full [`crate::runtime::Runtime`] with its data-directory
/// lock.
impl From<CtxInner> for Ctx {
    fn from(inner: CtxInner) -> Self {
        Self(Arc::new(inner))
    }
}

impl Ctx {
    /// Builds a `Ctx` sharing every part of a live runtime (a handful of
    /// reference-count bumps, not a deep copy).
    pub fn from_runtime(rt: &crate::runtime::Runtime) -> Self {
        CtxInner {
            paths: rt.paths.clone(),
            registry: rt.registry.clone(),
            session_manager: rt.session_manager.clone(),
            repo_locks: rt.repo_locks.clone(),
            message_bus: rt.message_bus.clone(),
            router: rt.router.clone(),
            shared_system: rt.shared_system.clone(),
            engine: rt.engine.clone(),
            sink: rt.sink.clone(),
            claude_adapter: Arc::clone(&rt.claude_adapter),
            codex_adapter: Arc::clone(&rt.codex_adapter),
            agent_session_registry: rt.agent_session_registry.clone(),
            scheduler: Arc::clone(&rt.scheduler),
        }
        .into()
    }
}

/// A handler's return future, boxed for storage in the registry map.
pub type BoxFuture = Pin<Box<dyn Future<Output = Result<Value, Value>> + Send>>;

type Handler = Box<dyn Fn(Ctx, Value) -> BoxFuture + Send + Sync>;

/// How a command may be reached over the network (through
/// [`Registry::dispatch_remote`]). Local desktop IPC
/// ([`Registry::dispatch`]) never consults it: the desktop app on the
/// user's own machine is not the boundary this defends.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RemotePolicy {
    /// Reachable by any authenticated remote client. Note this includes
    /// `spawn_worker`, i.e. running shell commands as this user — the
    /// product's actual trust model for an authenticated client (see
    /// `docs/architecture.md`'s Runtime Modes section).
    Allowed,
    /// Never reachable remotely, whatever the arguments:
    /// `read_file`/`write_file` touch the daemon host's filesystem
    /// (all of `$HOME` for reads), including the daemon token and the
    /// API key file.
    Denied,
    /// Reachable, but denied when the `key` argument names a secret (see
    /// [`config::is_secret_key`]): reading one would exfiltrate a
    /// credential, writing one would plant a credential the desktop app
    /// then trusts.
    SecretFiltered,
}

/// The denial for a [`RemotePolicy::SecretFiltered`] call whose
/// (normalized, see the module doc) arguments name a secret key.
fn secret_filtered_denial(args: &Value) -> Option<Value> {
    args.get("key")
        .and_then(Value::as_str)
        .is_some_and(config::is_secret_key)
        .then(|| Value::String("Remote Access To Secret-Shaped Config Keys Is Denied.".to_owned()))
}

/// Canonical form of a command's arguments: always a JSON object (see
/// the module doc).
fn normalize_args(args: Value) -> Result<Value, Value> {
    match args {
        Value::Null => Ok(Value::Object(serde_json::Map::new())),
        Value::Object(_) => Ok(args),
        _ => Err(not_an_object()),
    }
}

fn not_an_object() -> Value {
    Value::String("Invalid Arguments: Expected A JSON Object.".to_owned())
}

struct RegistryEntry {
    handler: Handler,
    policy: RemotePolicy,
}

/// One `(name, entry)` registry row from a plain `async fn(Ctx, Value)
/// -> Result<Value, Value>` and its [`RemotePolicy`] — which is a
/// required parameter, so no command can be registered without one.
fn entry<F, Fut>(name: &'static str, f: F, policy: RemotePolicy) -> (&'static str, RegistryEntry)
where
    F: Fn(Ctx, Value) -> Fut + Send + Sync + 'static,
    Fut: Future<Output = Result<Value, Value>> + Send + 'static,
{
    (
        name,
        RegistryEntry {
            handler: Box::new(move |ctx, args| Box::pin(f(ctx, args)) as BoxFuture),
            policy,
        },
    )
}

/// The `name -> handler` dispatch table. See the module doc.
pub struct Registry {
    entries: HashMap<&'static str, RegistryEntry>,
}

impl Registry {
    /// Builds the full registry: every command both shells expose (see
    /// [`NATIVE_ONLY`] for the two that are deliberately absent), each
    /// with its [`RemotePolicy`].
    pub fn new() -> Self {
        use RemotePolicy::{Allowed, Denied, SecretFiltered};
        let entries = HashMap::from([
            // Workers
            entry("spawn_worker", worker::spawn_worker, Allowed),
            entry("pause_worker", worker::pause_worker, Allowed),
            entry("resume_worker", worker::resume_worker, Allowed),
            entry("kill_worker", worker::kill_worker, Allowed),
            entry("list_workers", worker::list_workers, Allowed),
            entry("worker_input", worker::worker_input, Allowed),
            entry("resize_worker", worker::resize_worker, Allowed),
            entry("set_max_workers", worker::set_max_workers, Allowed),
            // Git / ship
            entry("validate_repo_root", git::validate_repo_root, Allowed),
            entry("git_ship_preflight", git::git_ship_preflight, Allowed),
            entry("git_stage_commit", git::git_stage_commit, Allowed),
            entry("git_push", git::git_push, Allowed),
            entry("ship_compare_url", git::ship_compare_url, Allowed),
            entry("ship_context", git::ship_context, Allowed),
            // Sessions
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
            // Provider agents
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
            // Config — secret-shaped keys filtered in both directions.
            entry("read_config", config::read_config, SecretFiltered),
            entry("write_config", config::write_config, SecretFiltered),
            // Files — never remote.
            entry("read_file", fs::read_file, Denied),
            entry("write_file", fs::write_file, Denied),
            // Metrics, event log, bus
            entry("get_metrics", metrics::get_metrics, Allowed),
            entry("events_since", orchestration::events_since, Allowed),
            entry("bus_send", bus::bus_send, Allowed),
            entry("bus_list_channels", bus::bus_list_channels, Allowed),
        ]);
        Self { entries }
    }

    /// Every command name, sorted.
    pub fn keys(&self) -> Vec<&'static str> {
        let mut keys: Vec<&'static str> = self.entries.keys().copied().collect();
        keys.sort_unstable();
        keys
    }

    /// The [`RemotePolicy`] of `cmd`, or `None` when there is no such
    /// command.
    pub fn policy(&self, cmd: &str) -> Option<RemotePolicy> {
        self.entries.get(cmd).map(|e| e.policy)
    }

    /// Runs `cmd` for a LOCAL (desktop IPC) caller — no
    /// [`RemotePolicy`] check. The arguments are normalized (see the
    /// module doc); an unknown command is an `"Unknown Command"` error.
    pub async fn dispatch(&self, cmd: &str, ctx: Ctx, args: Value) -> Result<Value, Value> {
        let entry = self.entry(cmd)?;
        (entry.handler)(ctx, normalize_args(args)?).await
    }

    /// Runs `cmd` for a REMOTE (`swarmd` WebSocket `rpc`) caller: the
    /// arguments are normalized FIRST, then the command's
    /// [`RemotePolicy`] is enforced — a [`RemotePolicy::Denied`] command
    /// never reaches its handler, and a [`RemotePolicy::SecretFiltered`]
    /// one is refused when its `key` names a secret. `swarmd` must call
    /// this, never [`Self::dispatch`], and must not special-case command
    /// names itself.
    pub async fn dispatch_remote(&self, cmd: &str, ctx: Ctx, args: Value) -> Result<Value, Value> {
        let entry = self.entry(cmd)?;
        let args = normalize_args(args)?;
        match entry.policy {
            RemotePolicy::Denied => Err(Value::String(format!(
                "\"{cmd}\" Is Not Available Over A Remote Connection."
            ))),
            RemotePolicy::SecretFiltered if let Some(denial) = secret_filtered_denial(&args) => {
                Err(denial)
            }
            RemotePolicy::SecretFiltered | RemotePolicy::Allowed => {
                (entry.handler)(ctx, args).await
            }
        }
    }

    fn entry(&self, cmd: &str) -> Result<&RegistryEntry, Value> {
        self.entries
            .get(cmd)
            .ok_or_else(|| Value::String(format!("Unknown Command: \"{cmd}\".")))
    }
}

impl Default for Registry {
    fn default() -> Self {
        Self::new()
    }
}

// ── Shared handler helpers ──────────────────────────────────────────

/// Deserializes a handler's (normalized) arguments into `T`. Anything
/// but a JSON object is refused outright, even when `T` could be built
/// from it — see the module doc.
pub(crate) fn parse_args<T: DeserializeOwned>(args: Value) -> Result<T, Value> {
    if !args.is_object() {
        return Err(not_an_object());
    }
    serde_json::from_value(args).map_err(|e| Value::String(format!("Invalid Arguments: {e}")))
}

/// Serializes a successful result into the registry's `Value` return
/// type.
pub(crate) fn ok_value<T: serde::Serialize>(v: &T) -> Result<Value, Value> {
    serde_json::to_value(v).map_err(|e| Value::String(format!("Serialization Error: {e}")))
}

/// Serializes a typed error (e.g. [`crate::error::AppError`],
/// [`crate::git::ShipError`]) into the registry's error `Value`, through
/// the same `Serialize` impl every transport carries.
pub(crate) fn err_value<E: serde::Serialize>(e: &E) -> Value {
    serde_json::to_value(e).unwrap_or_else(|_| Value::String("Serialization Error".to_owned()))
}

/// Parses the optional `originWorker`/`causeSeq` arguments into a
/// [`Provenance`]. Absent means unattributed; a malformed `originWorker`
/// is rejected, never silently dropped.
pub(crate) fn parse_provenance(
    origin_worker: Option<String>,
    cause_seq: Option<u64>,
) -> Result<Provenance, Value> {
    Ok(Provenance {
        origin_worker: origin_worker.as_deref().map(parse_uuid).transpose()?,
        cause_seq,
    })
}

pub(crate) fn parse_uuid(raw: &str) -> Result<Uuid, Value> {
    Uuid::parse_str(raw).map_err(|e| Value::String(format!("Invalid UUID \"{raw}\": {e}")))
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeSet;

    use serde_json::json;

    use super::test_support::test_ctx;
    use super::*;

    #[test]
    fn test_registry_has_no_native_only_entries() {
        let keys = Registry::new().keys();
        for native in NATIVE_ONLY {
            assert!(!keys.contains(native), "{native} is NATIVE_ONLY");
        }
    }

    #[test]
    fn test_registry_keys_are_sorted_and_unique() {
        let keys = Registry::new().keys();
        assert!(keys.is_sorted());
        assert_eq!(keys.iter().collect::<BTreeSet<_>>().len(), keys.len());
    }

    /// 38 desktop commands minus the 2 [`NATIVE_ONLY`] ones.
    #[test]
    fn test_registry_has_36_entries() {
        assert_eq!(Registry::new().keys().len(), 36);
    }

    #[tokio::test]
    async fn test_dispatch_unknown_command_is_a_clean_error() {
        let (ctx, _dir, _events) = test_ctx();
        let result = Registry::new()
            .dispatch("does_not_exist", ctx, json!({}))
            .await;
        assert_eq!(result, Err(json!("Unknown Command: \"does_not_exist\".")));
    }

    #[tokio::test]
    async fn test_dispatch_list_workers_on_an_empty_registry() {
        let (ctx, _dir, _events) = test_ctx();
        let result = Registry::new()
            .dispatch("list_workers", ctx, json!({}))
            .await;
        assert_eq!(result, Ok(json!([])));
    }

    // ── Argument normalization ───────────────────────────────────────

    #[test]
    fn test_normalize_args_accepts_objects_and_null_only() {
        assert_eq!(normalize_args(Value::Null), Ok(json!({})));
        assert_eq!(normalize_args(json!({"a": 1})), Ok(json!({"a": 1})));
        for bad in [
            json!(["anthropic_api_key"]),
            json!("x"),
            json!(1),
            json!(true),
        ] {
            assert_eq!(normalize_args(bad), Err(not_an_object()));
        }
    }

    /// An `rpc` frame that omits `args` arrives as `null`: it reaches
    /// the handler as `{}`, so a missing required field is reported as
    /// such, not as a type error.
    #[tokio::test]
    async fn test_null_args_reach_the_handler_as_an_empty_object() {
        let (ctx, _dir, _events) = test_ctx();
        let registry = Registry::new();
        assert_eq!(
            registry
                .dispatch("list_sessions", ctx.clone(), Value::Null)
                .await,
            Ok(json!([]))
        );
        let err = registry
            .dispatch_remote("read_config", ctx, Value::Null)
            .await
            .unwrap_err();
        assert!(
            err.as_str().unwrap().contains("missing field `key`"),
            "{err}"
        );
    }

    #[test]
    fn test_parse_args_refuses_positional_arrays() {
        #[derive(serde::Deserialize, Debug)]
        #[expect(dead_code, reason = "only deserialized")]
        struct KeyArgs {
            key: String,
        }
        assert!(parse_args::<KeyArgs>(json!({"key": "k"})).is_ok());
        assert_eq!(
            parse_args::<KeyArgs>(json!(["k"])).unwrap_err(),
            not_an_object()
        );
    }

    // ── RemotePolicy ─────────────────────────────────────────────────

    #[test]
    fn test_every_registry_entry_declares_a_policy() {
        let registry = Registry::new();
        for key in registry.keys() {
            assert!(registry.policy(key).is_some(), "{key} has no policy");
        }
    }

    fn keys_with(policy: RemotePolicy) -> BTreeSet<&'static str> {
        let registry = Registry::new();
        registry
            .keys()
            .into_iter()
            .filter(|k| registry.policy(k) == Some(policy))
            .collect()
    }

    #[test]
    fn test_remote_denied_set_is_exactly_read_file_and_write_file() {
        assert_eq!(
            keys_with(RemotePolicy::Denied),
            BTreeSet::from(["read_file", "write_file"])
        );
    }

    #[test]
    fn test_secret_filtered_set_is_exactly_read_config_and_write_config() {
        assert_eq!(
            keys_with(RemotePolicy::SecretFiltered),
            BTreeSet::from(["read_config", "write_config"])
        );
    }

    /// Any path — the daemon token included — is refused before the
    /// handler (and so the path itself) is ever looked at.
    #[tokio::test]
    async fn test_dispatch_remote_denies_file_access_unconditionally() {
        let (ctx, _dir, _events) = test_ctx();
        let registry = Registry::new();
        let token_path = ctx.paths.data_dir.join("daemon-token");
        let read = registry
            .dispatch_remote(
                "read_file",
                ctx.clone(),
                json!({ "path": token_path.display().to_string() }),
            )
            .await;
        assert_eq!(
            read,
            Err(json!(
                "\"read_file\" Is Not Available Over A Remote Connection."
            ))
        );
        let write = registry
            .dispatch_remote(
                "write_file",
                ctx,
                json!({ "path": "/tmp/x", "content": "x" }),
            )
            .await;
        assert!(write.is_err());
    }

    /// A data dir whose config already holds the API key.
    fn ctx_with_api_key() -> (Ctx, impl Sized, impl Sized) {
        let (ctx, dir, events) = test_ctx();
        crate::config::write_value(&ctx.paths, "anthropic_api_key", json!("sk-ant-SECRET"))
            .unwrap();
        (ctx, dir, events)
    }

    fn denied() -> Result<Value, Value> {
        Err(json!(
            "Remote Access To Secret-Shaped Config Keys Is Denied."
        ))
    }

    #[tokio::test]
    async fn test_dispatch_remote_denies_reading_and_writing_the_api_key() {
        let (ctx, _dir, _events) = ctx_with_api_key();
        let registry = Registry::new();
        assert_eq!(
            registry
                .dispatch_remote(
                    "read_config",
                    ctx.clone(),
                    json!({ "key": "anthropic_api_key" })
                )
                .await,
            denied()
        );
        assert_eq!(
            registry
                .dispatch_remote(
                    "write_config",
                    ctx.clone(),
                    json!({ "key": "anthropic_api_key", "value": "sk-attacker" }),
                )
                .await,
            denied()
        );
        assert_eq!(
            crate::config::read_value(&ctx.paths, "anthropic_api_key"),
            Some(json!("sk-ant-SECRET"))
        );
    }

    /// CONFIRMED regression (security): positional-array arguments used
    /// to skip the `key` inspection (`args.get("key")` is `None` on an
    /// array) while the handler still deserialized the key from them —
    /// a remote read returned the API key, and a remote write replaced
    /// it. Both are now refused before any policy or handler runs, and
    /// the stored key is untouched.
    #[tokio::test]
    async fn test_dispatch_remote_refuses_positional_args_for_config_both_ways() {
        let (ctx, _dir, _events) = ctx_with_api_key();
        let registry = Registry::new();

        let read = registry
            .dispatch_remote("read_config", ctx.clone(), json!(["anthropic_api_key"]))
            .await;
        assert_eq!(read, Err(not_an_object()));

        let write = registry
            .dispatch_remote(
                "write_config",
                ctx.clone(),
                json!(["anthropic_api_key", "sk-attacker"]),
            )
            .await;
        assert_eq!(write, Err(not_an_object()));
        assert_eq!(
            crate::config::read_value(&ctx.paths, "anthropic_api_key"),
            Some(json!("sk-ant-SECRET"))
        );

        // The local path refuses them too: no handler ever sees one.
        let local = registry
            .dispatch("read_config", ctx, json!(["anthropic_api_key"]))
            .await;
        assert_eq!(local, Err(not_an_object()));
    }

    /// The filter is narrow: an ordinary key still works remotely.
    #[tokio::test]
    async fn test_dispatch_remote_allows_an_ordinary_config_key() {
        let (ctx, _dir, _events) = test_ctx();
        let registry = Registry::new();
        registry
            .dispatch_remote(
                "write_config",
                ctx.clone(),
                json!({ "key": "max_workers", "value": 4 }),
            )
            .await
            .unwrap();
        assert_eq!(
            registry
                .dispatch_remote("read_config", ctx, json!({ "key": "max_workers" }))
                .await,
            Ok(json!(4))
        );
    }

    /// An `Allowed` command behaves identically through either
    /// dispatcher.
    #[tokio::test]
    async fn test_dispatch_remote_allowed_command_behaves_like_local_dispatch() {
        let (ctx, _dir, _events) = test_ctx();
        let result = Registry::new()
            .dispatch_remote("list_workers", ctx, json!({}))
            .await;
        assert_eq!(result, Ok(json!([])));
    }

    #[test]
    fn test_parse_provenance_rejects_a_malformed_origin_worker() {
        assert_eq!(parse_provenance(None, Some(3)).unwrap().cause_seq, Some(3));
        let err = parse_provenance(Some("nope".to_owned()), None).unwrap_err();
        assert!(err.as_str().unwrap().starts_with("Invalid UUID \"nope\""));
    }
}

/// Test-only construction helpers for every `commands::*` test module.
#[cfg(test)]
pub(crate) mod test_support {
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
        let dir = std::env::temp_dir().join(format!("swarm-cmd-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let cleanup = DropGuard::new(dir.clone(), |dir| {
            let _ = std::fs::remove_dir_all(dir);
        });

        let (events_tx, events) = mpsc::channel();
        let engine =
            OrchestrationEngine::start(EventLog::open_in_memory().unwrap(), None, move |e| {
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
            claude_adapter: Arc::new(ClaudeCodeAdapter::new(sink.clone())),
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
}
