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

use swarm_core::events::EventSink;
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
#[tauri::command]
#[tracing::instrument(skip(sink, registry, repo_locks))]
pub async fn spawn_worker(
    sink: tauri::State<'_, EventSink>,
    registry: tauri::State<'_, WorkerRegistry>,
    repo_locks: tauri::State<'_, RepoLocks>,
    config: WorkerConfig,
    origin_worker: Option<String>,
    cause_seq: Option<u64>,
) -> Result<String, String> {
    tracing::info!(name = %config.name, "spawn_worker called");
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
/// # Arguments
///
/// * `sink` - Event sink for recording emitted events (managed state)
/// * `registry` - Shared worker registry (managed state)
/// * `repo_locks` - Per-repo git-operation serialization (managed state)
/// * `id` - UUID string of the worker to kill
///
/// # Errors
///
/// Returns a `String` error if:
/// - The `id` is not a valid UUID
/// - No worker with the given ID exists
#[tauri::command]
#[tracing::instrument(skip(sink, registry, repo_locks))]
pub async fn kill_worker(
    sink: tauri::State<'_, EventSink>,
    registry: tauri::State<'_, WorkerRegistry>,
    repo_locks: tauri::State<'_, RepoLocks>,
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
    tokio::task::spawn_blocking(move || {
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
    })
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
/// `test_worker_input_string_arg_reproduces_the_original_vec_u8_contract_bug`
/// in this module's test block. Fixed by taking the string directly and
/// writing its UTF-8 bytes to the PTY (`data.as_bytes()`) — exactly
/// what every caller already sends.
///
/// # Arguments
///
/// * `sink` - Event sink for recording the `worker_input` event (managed state)
/// * `registry` - Shared worker registry (managed state)
/// * `id` - UUID string of the target worker
/// * `data` - Text to write to the worker's PTY
/// * `source` - `"terminal"`, `"tool"`, or `"automation"` — see
///   `WorkerInputPayload`'s doc for the persistence/preview implications
/// * `originWorker`/`causeSeq` - Optional causal attribution (absent for
///   `source == "terminal"`, since the causer there is a human, not a
///   worker's turn)
///
/// # Errors
///
/// Returns a `String` error if:
/// - The `id` is not a valid UUID
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
    source: String,
    origin_worker: Option<String>,
    cause_seq: Option<u64>,
) -> Result<(), String> {
    tracing::debug!(worker_id = %id, bytes = data.len(), source = %source, "worker_input called");
    let uuid = Uuid::parse_str(&id).map_err(|e| {
        tracing::error!(error = %e, "invalid worker ID");
        e.to_string()
    })?;
    let provenance = parse_provenance(origin_worker, cause_seq)?;
    let sink = sink.inner().clone();
    let registry = registry.inner().clone();
    tokio::task::spawn_blocking(move || {
        lifecycle::do_worker_input(&sink, &registry, uuid, data.as_bytes(), &source, provenance)
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
    /// DIRECTIVE (Phase 5c, VERIFY-FIRST): reproduces the exact
    /// deserialization failure the plan flagged — `Vec<u8>` cannot be
    /// deserialized from a JSON string, which is what every frontend
    /// caller sends (`invoke("worker_input", { id, data: "some text" })`).
    /// This is a permanent regression guard: if this signature is ever
    /// reintroduced, this test fails loudly instead of every real
    /// terminal keystroke silently erroring in production.
    #[test]
    fn test_worker_input_string_arg_reproduces_the_original_vec_u8_contract_bug() {
        let frontend_arg = serde_json::json!("some text\n");

        let as_vec_u8 = serde_json::from_value::<Vec<u8>>(frontend_arg.clone());
        assert!(
            as_vec_u8.is_err(),
            "a JSON string must NOT deserialize into Vec<u8> — this is the bug the plan flagged"
        );

        // The fix: the command's `data` parameter is `String`, which
        // deserializes from exactly what every caller sends.
        let as_string = serde_json::from_value::<String>(frontend_arg);
        assert_eq!(as_string.unwrap(), "some text\n");
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
