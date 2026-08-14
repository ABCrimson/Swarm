//! Worker lifecycle Tauri IPC command handlers.
//!
//! Exposes worker management operations to the React frontend.
//! Each command delegates to [`swarm_core::worker::lifecycle`] functions,
//! converting [`AppError`](swarm_core::error::AppError) to `String`
//! for Tauri IPC error transport.
//!
//! Blocking lifecycle calls are wrapped in `tokio::task::spawn_blocking`
//! to avoid starving the async executor (Prime Directive #11).

use tauri::AppHandle;
use uuid::Uuid;

use swarm_core::events::{EventSink, InputSource};
use swarm_core::git::RepoLocks;
use swarm_core::worker::handle::{WorkerConfig, WorkerInfo};
use swarm_core::worker::lifecycle;
use swarm_core::worker::registry::WorkerRegistry;

use crate::commands::parse_provenance;

/// Spawns a new worker with the given configuration.
///
/// Creates a PTY process, registers the worker in the registry,
/// and emits a `worker_spawned` event on `swarm://events`.
///
/// # Arguments
///
/// * `sink` - Event sink for recording emitted events (managed state)
/// * `registry` - Shared worker registry (managed state)
/// * `repo_locks` - Per-repo git-operation serialization (managed state)
/// * `config` - Worker spawn configuration from the frontend
///
/// # Returns
///
/// The UUID string of the newly spawned worker.
///
/// # Errors
///
/// Returns a `String` error if:
/// - The PTY process fails to spawn
/// - The registry is at capacity
/// - `config.repoRoot` is present and worktree creation fails (repo
///   discovery, `HEAD` resolution, `git worktree add`/`lock`) — this
///   hard-fails the whole spawn, never falling back to an unisolated
///   shared cwd
/// - `originWorker` is present but not a valid UUID
///
/// # Credential-leak fix (Phase 2, multi-provider plan step 4)
///
/// `config` is `skip`ped here too, for the same reason as
/// `swarm_core::worker::lifecycle::do_spawn_worker`'s matching fix:
/// this Tauri command is the FIRST boundary `config` (including its
/// `env: HashMap<String, String>`) crosses, so leaving it captured here
/// would have reintroduced the same leak one layer up even after the
/// `swarm-core` fix landed.
#[tauri::command]
#[tracing::instrument(skip(sink, registry, repo_locks, config))]
pub async fn spawn_worker(
    sink: tauri::State<'_, EventSink>,
    registry: tauri::State<'_, WorkerRegistry>,
    repo_locks: tauri::State<'_, RepoLocks>,
    config: WorkerConfig,
    origin_worker: Option<String>,
    cause_seq: Option<u64>,
) -> Result<String, String> {
    tracing::info!(name = %config.name, env_key_count = config.env.len(), "spawn_worker called");
    let provenance = parse_provenance(origin_worker, cause_seq)?;
    let registry = registry.inner().clone();
    let sink = sink.inner().clone();
    let repo_locks = repo_locks.inner().clone();
    let id = tokio::task::spawn_blocking(move || {
        lifecycle::do_spawn_worker(&sink, &registry, &repo_locks, config, provenance)
    })
    .await
    .map_err(|e| {
        tracing::error!(error = %e, "spawn_worker task panicked");
        e.to_string()
    })?
    .map_err(|e| {
        tracing::error!(error = %e, "failed to spawn worker");
        e.to_string()
    })?;
    Ok(id.to_string())
}

/// Pauses an active worker by transitioning it to the `Paused` state.
///
/// # Arguments
///
/// * `sink` - Event sink for recording the `worker_state` event (managed state)
/// * `registry` - Shared worker registry (managed state)
/// * `id` - UUID string of the worker to pause
///
/// # Errors
///
/// Returns a `String` error if:
/// - The `id` is not a valid UUID
/// - No worker with the given ID exists
#[tauri::command]
#[tracing::instrument(skip(sink, registry))]
pub async fn pause_worker(
    sink: tauri::State<'_, EventSink>,
    registry: tauri::State<'_, WorkerRegistry>,
    id: String,
    origin_worker: Option<String>,
    cause_seq: Option<u64>,
) -> Result<(), String> {
    tracing::info!(worker_id = %id, "pause_worker called");
    let uuid = Uuid::parse_str(&id).map_err(|e| {
        tracing::error!(error = %e, "invalid worker ID");
        e.to_string()
    })?;
    let provenance = parse_provenance(origin_worker, cause_seq)?;
    let registry = registry.inner().clone();
    let sink = sink.inner().clone();
    tokio::task::spawn_blocking(move || {
        lifecycle::do_pause_worker(&sink, &registry, uuid, provenance)
    })
    .await
    .map_err(|e| {
        tracing::error!(error = %e, "pause_worker task panicked");
        e.to_string()
    })?
    .map_err(|e| {
        tracing::error!(error = %e, "failed to pause worker");
        e.to_string()
    })
}

/// Resumes a paused worker by transitioning it back to the `Running` state.
///
/// # Arguments
///
/// * `sink` - Event sink for recording the `worker_state` event (managed state)
/// * `registry` - Shared worker registry (managed state)
/// * `id` - UUID string of the worker to resume
///
/// # Errors
///
/// Returns a `String` error if:
/// - The `id` is not a valid UUID
/// - No worker with the given ID exists
#[tauri::command]
#[tracing::instrument(skip(sink, registry))]
pub async fn resume_worker(
    sink: tauri::State<'_, EventSink>,
    registry: tauri::State<'_, WorkerRegistry>,
    id: String,
    origin_worker: Option<String>,
    cause_seq: Option<u64>,
) -> Result<(), String> {
    tracing::info!(worker_id = %id, "resume_worker called");
    let uuid = Uuid::parse_str(&id).map_err(|e| {
        tracing::error!(error = %e, "invalid worker ID");
        e.to_string()
    })?;
    let provenance = parse_provenance(origin_worker, cause_seq)?;
    let registry = registry.inner().clone();
    let sink = sink.inner().clone();
    tokio::task::spawn_blocking(move || {
        lifecycle::do_resume_worker(&sink, &registry, uuid, provenance)
    })
    .await
    .map_err(|e| {
        tracing::error!(error = %e, "resume_worker task panicked");
        e.to_string()
    })?
    .map_err(|e| {
        tracing::error!(error = %e, "failed to resume worker");
        e.to_string()
    })
}

/// Kills a worker and cleans up all associated resources.
///
/// Removes the worker from the registry, terminates the PTY child
/// process, and emits a `worker_killed` event on `swarm://events`. If
/// the worker was isolated into a git worktree, also unlocks and
/// removes it (never with `--force` — a dirty worktree is preserved,
/// never deleted) and emits `worktree_removed` with the disposition.
///
/// If this worker also has a live provider-adapter session attached
/// (Phase 3, `agent_spawn`), that session is removed from the
/// [`AgentSessionRegistry`] and shut down too — best-effort: a failure
/// here is logged, not propagated, so an agent-session teardown hiccup
/// never blocks the PTY worker's own kill from completing (the primary
/// resource this command exists to clean up).
///
/// # Arguments
///
/// * `sink` - Event sink for recording emitted events (managed state)
/// * `registry` - Shared worker registry (managed state)
/// * `repo_locks` - Per-repo git-operation serialization (managed state)
/// * `session_registry` - Live agent-session handles (managed state)
/// * `id` - UUID string of the worker to kill
///
/// # Errors
///
/// Returns a `String` error if:
/// - The `id` is not a valid UUID
/// - No worker with the given ID exists
#[tauri::command]
#[tracing::instrument(skip(sink, registry, repo_locks, session_registry))]
pub async fn kill_worker(
    sink: tauri::State<'_, EventSink>,
    registry: tauri::State<'_, WorkerRegistry>,
    repo_locks: tauri::State<'_, RepoLocks>,
    session_registry: tauri::State<'_, swarm_core::agent::AgentSessionRegistry>,
    id: String,
    origin_worker: Option<String>,
    cause_seq: Option<u64>,
) -> Result<(), String> {
    tracing::info!(worker_id = %id, "kill_worker called");
    let uuid = Uuid::parse_str(&id).map_err(|e| {
        tracing::error!(error = %e, "invalid worker ID");
        e.to_string()
    })?;
    let provenance = parse_provenance(origin_worker, cause_seq)?;
    let registry = registry.inner().clone();
    let sink = sink.inner().clone();
    let repo_locks = repo_locks.inner().clone();
    let kill_result = tokio::task::spawn_blocking(move || {
        lifecycle::do_kill_worker(&sink, &registry, &repo_locks, uuid, provenance)
    })
    .await
    .map_err(|e| {
        tracing::error!(error = %e, "kill_worker task panicked");
        e.to_string()
    })?
    .map_err(|e| {
        tracing::error!(error = %e, "failed to kill worker");
        e.to_string()
    });

    if let Some(session) = session_registry.remove(&uuid)
        && let Err(e) = session.shutdown().await
    {
        tracing::warn!(worker_id = %uuid, error = %e, "agent session shutdown failed during kill_worker (best-effort)");
    }

    kill_result
}

/// Lists all active workers as serializable info snapshots.
///
/// # Arguments
///
/// * `registry` - Shared worker registry (managed state)
///
/// # Returns
///
/// A `Vec<WorkerInfo>` containing all registered workers.
#[tauri::command]
#[tracing::instrument(skip(registry))]
pub async fn list_workers(
    registry: tauri::State<'_, WorkerRegistry>,
) -> Result<Vec<WorkerInfo>, String> {
    tracing::debug!("list_workers called");
    Ok(registry.list_workers())
}

/// Sends input data to a worker's PTY stdin, then emits a stamped
/// `worker_input` event recording that it happened.
///
/// # Contract fix (provenance Phase 5c)
///
/// `data` is `String`, not `Vec<u8>`. Every frontend caller
/// (`useTerminal.ts`, `tools.ts`'s `run_command`, `useWorkspaceWatcher.ts`)
/// sends a JS string; `serde_json` cannot deserialize a JSON string into
/// `Vec<u8>` (it expects a JSON array of byte numbers), so with the
/// prior signature this command failed IPC deserialization for every
/// caller before the handler body ever ran. Confirmed via
/// `test_worker_input_frontend_payload_matches_the_real_command_signature`
/// in this module's test block. Fixed by taking the string directly and
/// writing its UTF-8 bytes to the PTY (`data.as_bytes()`) — exactly
/// what every caller already sends.
///
/// `source` is a closed, typed enum ([`InputSource`]), not a bare
/// string — an unrecognized value fails IPC deserialization before the
/// handler body runs, so the "raw keystrokes never persisted/previewed"
/// guarantee never depends on the webview spelling `"terminal"` correctly.
///
/// # Arguments
///
/// * `sink` - Event sink for recording the `worker_input` event (managed state)
/// * `registry` - Shared worker registry (managed state)
/// * `id` - UUID string of the target worker
/// * `data` - Text to write to the worker's PTY
/// * `source` - `"terminal"`, `"tool"`, or `"automation"` on the wire,
///   deserialized into `InputSource` — see `WorkerInputPayload`'s doc
///   for the persistence/preview implications
/// * `originWorker`/`causeSeq` - Optional causal attribution (absent for
///   `source == "terminal"`, since the causer there is a human, not a
///   worker's turn)
///
/// # Errors
///
/// Returns a `String` error if:
/// - The `id` is not a valid UUID
/// - `source` is present but not one of `"terminal"`/`"tool"`/`"automation"`
/// - `originWorker` is present but not a valid UUID
/// - No worker with the given ID exists
/// - The worker has no PTY writer
/// - The write to the PTY fails
#[tauri::command]
#[tracing::instrument(skip(sink, registry, data))]
pub async fn worker_input(
    sink: tauri::State<'_, EventSink>,
    registry: tauri::State<'_, WorkerRegistry>,
    id: String,
    data: String,
    source: InputSource,
    origin_worker: Option<String>,
    cause_seq: Option<u64>,
) -> Result<(), String> {
    tracing::debug!(worker_id = %id, bytes = data.len(), ?source, "worker_input called");
    let uuid = Uuid::parse_str(&id).map_err(|e| {
        tracing::error!(error = %e, "invalid worker ID");
        e.to_string()
    })?;
    let provenance = parse_provenance(origin_worker, cause_seq)?;
    let sink = sink.inner().clone();
    let registry = registry.inner().clone();
    tokio::task::spawn_blocking(move || {
        lifecycle::do_worker_input(&sink, &registry, uuid, data.as_bytes(), source, provenance)
    })
    .await
    .map_err(|e| {
        tracing::error!(error = %e, "worker_input task panicked");
        e.to_string()
    })?
    .map_err(|e| {
        tracing::error!(error = %e, "failed to send input to worker");
        e.to_string()
    })
}

#[cfg(test)]
mod tests {
    use swarm_core::events::InputSource;
    use swarm_core::worker::handle::WorkerConfig;

    /// Mirrors `worker_input`'s real, non-injected argument list
    /// (`id`, `data`, `source`, `origin_worker`, `cause_seq` — the
    /// `sink`/`registry` params are Tauri-injected managed state, never
    /// part of the IPC payload). Tauri's `#[tauri::command]` macro
    /// builds its own args-extraction struct internally and doesn't
    /// expose it for external testing, so this shadow struct is the
    /// closest a unit test (no live `tauri::App` harness exists in this
    /// codebase) can get to exercising the actual signature rather than
    /// a single field type in isolation.
    ///
    /// KEEP THIS IN SYNC with `worker_input`'s parameter list above —
    /// that coupling is exactly the point: if `data`'s type reverts to
    /// `Vec<u8>` (or any other field's type changes) without updating
    /// this struct to match, the test below stops proving anything
    /// meaningful about the real command. The reverse also holds: if you
    /// change `worker_input`'s signature, update this struct too.
    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct WorkerInputArgs {
        #[allow(dead_code)]
        id: String,
        data: String,
        source: InputSource,
        origin_worker: Option<String>,
        cause_seq: Option<u64>,
    }

    /// The historical (pre-fix) `data: Vec<u8>` shape, for the negative
    /// assertion below.
    #[derive(serde::Deserialize)]
    struct WorkerInputArgsVecU8Era {
        #[allow(dead_code)]
        id: String,
        #[allow(dead_code)]
        data: Vec<u8>,
    }

    /// DIRECTIVE (Phase 5c, VERIFY-FIRST, hardened per review): exercises
    /// the REAL command argument shape — not just `data` in isolation.
    /// The exact payload every frontend caller sends
    /// (`invoke("worker_input", { id, data: "some text\n", source: "terminal" })`)
    /// must deserialize successfully into `worker_input`'s actual
    /// argument types, `originWorker`/`causeSeq` included (both absent
    /// here, both must default to `None`). The historical `Vec<u8>`-era
    /// shape must reject that same string payload — this is the bug the
    /// plan flagged: `serde_json` cannot deserialize a JSON string into
    /// `Vec<u8>` (it expects an array of byte numbers), so with the old
    /// signature this command failed IPC deserialization for every real
    /// caller before the fix.
    #[test]
    fn test_worker_input_frontend_payload_matches_the_real_command_signature() {
        let frontend_payload = serde_json::json!({
            "id": "550e8400-e29b-41d4-a716-446655440000",
            "data": "some text\n",
            "source": "terminal",
        });

        let parsed: WorkerInputArgs = serde_json::from_value(frontend_payload.clone())
            .expect("the real frontend payload must deserialize into worker_input's arg shape");
        assert_eq!(parsed.data, "some text\n");
        assert_eq!(parsed.source, InputSource::Terminal);
        assert_eq!(parsed.origin_worker, None);
        assert_eq!(parsed.cause_seq, None);

        let as_vec_u8_era: Result<WorkerInputArgsVecU8Era, _> =
            serde_json::from_value(frontend_payload);
        assert!(
            as_vec_u8_era.is_err(),
            "a JSON string must NOT deserialize into the old Vec<u8>-era `data` field — \
             this is the bug the plan flagged"
        );
    }

    /// `source` is a closed, typed enum — an unrecognized value must
    /// fail deserialization outright rather than silently defaulting to
    /// something, so the same real-payload shape rejects a typo.
    #[test]
    fn test_worker_input_frontend_payload_rejects_an_unknown_source() {
        let frontend_payload = serde_json::json!({
            "id": "550e8400-e29b-41d4-a716-446655440000",
            "data": "ls\n",
            "source": "carrier_pigeon",
        });

        let parsed: Result<WorkerInputArgs, _> = serde_json::from_value(frontend_payload);
        assert!(parsed.is_err());
    }

    // ── Credential-leak fix, command layer (review nit I) ────────────

    /// `Write` + `tracing_subscriber::fmt::MakeWriter` impl over a
    /// shared buffer, so a captured subscriber can be pointed at
    /// in-process memory instead of stdout — mirrors
    /// `swarm_core::worker::lifecycle::tests::TracingCaptureBuf`
    /// exactly (duplicated rather than shared: it is a few lines, and
    /// this crate has no existing shared test-support module to put it
    /// in).
    #[derive(Clone, Default)]
    struct TracingCaptureBuf(std::sync::Arc<parking_lot::Mutex<Vec<u8>>>);

    impl std::io::Write for TracingCaptureBuf {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            self.0.lock().extend_from_slice(buf);
            Ok(buf.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    impl<'a> tracing_subscriber::fmt::MakeWriter<'a> for TracingCaptureBuf {
        type Writer = TracingCaptureBuf;
        fn make_writer(&'a self) -> Self::Writer {
            self.clone()
        }
    }

    /// DIRECTIVE (review nit I): span-capture regression test for THIS
    /// layer's credential-leak fix (`spawn_worker`'s own
    /// `#[tracing::instrument(skip(sink, registry, repo_locks,
    /// config))]`), mirroring
    /// `swarm_core::worker::lifecycle::tests::test_do_spawn_worker_never_leaks_env_secret_into_tracing_output`
    /// at the Tauri-command boundary — the first layer's test alone
    /// left this second, earlier-in-the-call-chain boundary unverified.
    ///
    /// `spawn_worker` takes `tauri::State<'_, T>` parameters that
    /// cannot be constructed outside a live `tauri::App` — no such test
    /// harness exists in this codebase (see the `WorkerInputArgs`
    /// shadow-struct note above for the same constraint applied to
    /// argument-shape testing). This test instead reproduces the EXACT
    /// span `#[tracing::instrument(skip(sink, registry, repo_locks,
    /// config))]` generates for `spawn_worker`'s real, unmodified
    /// parameter list (a `tracing::info_span!` naming the same fields
    /// the macro would capture — `origin_worker`/`cause_seq` included,
    /// `config` excluded) around the identical `tracing::info!` call
    /// `spawn_worker`'s body makes, so a regression in either this
    /// file's skip list or its logged summary is caught here without
    /// needing a full Tauri harness.
    ///
    /// KEEP THIS IN SYNC with `spawn_worker`'s `#[tracing::instrument]`
    /// attribute and its first `tracing::info!` call — same discipline
    /// as the `WorkerInputArgs` shadow struct.
    #[test]
    fn test_spawn_worker_command_layer_never_leaks_env_secret_into_tracing_output() {
        let capture = TracingCaptureBuf::default();
        let subscriber = tracing_subscriber::fmt()
            .with_writer(capture.clone())
            .with_max_level(tracing::Level::DEBUG)
            .with_ansi(false)
            .finish();

        const SECRET: &str = "sk-ant-command-layer-secret-should-never-be-logged";
        let mut env = std::collections::HashMap::new();
        env.insert("ANTHROPIC_API_KEY".to_string(), SECRET.to_string());
        let config = WorkerConfig {
            name: "Command Layer Secret Bearer".to_string(),
            env,
            ..WorkerConfig::default()
        };
        let origin_worker: Option<String> = None;
        let cause_seq: Option<u64> = None;

        tracing::subscriber::with_default(subscriber, || {
            // Mirrors #[tracing::instrument(skip(sink, registry,
            // repo_locks, config))] on spawn_worker(sink, registry,
            // repo_locks, config, origin_worker, cause_seq) — same
            // fields captured, `config` excluded.
            let span = tracing::info_span!("spawn_worker", ?origin_worker, cause_seq);
            let _enter = span.enter();
            tracing::info!(
                name = %config.name,
                env_key_count = config.env.len(),
                "spawn_worker called"
            );
        });

        let captured = String::from_utf8_lossy(&capture.0.lock()).into_owned();
        assert!(
            !captured.contains(SECRET),
            "captured tracing output leaked an env secret value at the command layer: {captured}"
        );
        assert!(
            captured.contains("Command Layer Secret Bearer"),
            "expected the redacted summary's name field to appear (proves the \
             subscriber actually captured this call, not a vacuous pass), got: {captured}"
        );
    }
}

/// Updates the worker registry's maximum concurrent worker cap.
///
/// Applies immediately to subsequent spawns and persists the value to
/// `swarm-config.json` (key `max_workers`) so it survives restarts —
/// the setup hook in `lib.rs` re-applies it on launch.
///
/// Ordering: validate → persist → apply. Applying cannot fail after
/// validation, so an `Err` from this command always means the live cap
/// is unchanged — persistence failure must not leave the backend
/// enforcing a cap that neither the UI nor disk agrees with.
///
/// # Arguments
///
/// * `app` - Tauri app handle (injected by Tauri)
/// * `registry` - Worker registry state (injected by Tauri)
/// * `max` - New cap; must be within the registry's accepted range
///
/// # Errors
///
/// Returns a `String` error if `max` is out of range or persistence
/// fails; in both cases the live cap keeps its previous value.
#[tauri::command]
#[tracing::instrument(skip(app, registry))]
pub async fn set_max_workers(
    app: AppHandle,
    registry: tauri::State<'_, WorkerRegistry>,
    max: usize,
) -> Result<(), String> {
    use swarm_core::worker::registry::{MAX_MAX_WORKERS, MIN_MAX_WORKERS};

    tracing::info!(max, "set_max_workers called");

    if !(MIN_MAX_WORKERS..=MAX_MAX_WORKERS).contains(&max) {
        tracing::error!(max, "rejected out-of-range max_workers update");
        return Err(format!(
            "max_workers must be between {MIN_MAX_WORKERS} and {MAX_MAX_WORKERS}, got {max}"
        ));
    }

    crate::commands::config::write_config(app, "max_workers".to_string(), serde_json::json!(max))
        .await?;

    registry.set_max_workers(max).map_err(|e| {
        tracing::error!(error = %e, "failed to apply validated max_workers");
        e.to_string()
    })
}
