//! Worker lifecycle Tauri IPC command handlers.
//!
//! Exposes worker management operations to the React frontend.
//! Each command delegates to [`crate::worker::lifecycle`] functions,
//! converting [`AppError`](crate::error::AppError) to `String`
//! for Tauri IPC error transport.
//!
//! Blocking lifecycle calls are wrapped in `tokio::task::spawn_blocking`
//! to avoid starving the async executor (Prime Directive #11).

use tauri::AppHandle;
use uuid::Uuid;

use crate::worker::handle::{WorkerConfig, WorkerInfo};
use crate::worker::lifecycle;
use crate::worker::registry::WorkerRegistry;

/// Spawns a new worker with the given configuration.
///
/// Creates a PTY process, registers the worker in the registry,
/// and emits a `worker:spawned` event.
///
/// # Arguments
///
/// * `app` - Tauri app handle (injected by Tauri)
/// * `registry` - Shared worker registry (managed state)
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
#[tauri::command]
#[tracing::instrument(skip(app, registry))]
pub async fn spawn_worker(
    app: AppHandle,
    registry: tauri::State<'_, WorkerRegistry>,
    config: WorkerConfig,
) -> Result<String, String> {
    tracing::info!(name = %config.name, "spawn_worker called");
    let registry = registry.inner().clone();
    let app_clone = app.clone();
    let id = tokio::task::spawn_blocking(move || {
        lifecycle::do_spawn_worker(&app_clone, &registry, config)
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
/// * `app` - Tauri app handle (injected by Tauri)
/// * `registry` - Shared worker registry (managed state)
/// * `id` - UUID string of the worker to pause
///
/// # Errors
///
/// Returns a `String` error if:
/// - The `id` is not a valid UUID
/// - No worker with the given ID exists
#[tauri::command]
#[tracing::instrument(skip(app, registry))]
pub async fn pause_worker(
    app: AppHandle,
    registry: tauri::State<'_, WorkerRegistry>,
    id: String,
) -> Result<(), String> {
    tracing::info!(worker_id = %id, "pause_worker called");
    let uuid = Uuid::parse_str(&id).map_err(|e| {
        tracing::error!(error = %e, "invalid worker ID");
        e.to_string()
    })?;
    let registry = registry.inner().clone();
    let app_clone = app.clone();
    tokio::task::spawn_blocking(move || {
        lifecycle::do_pause_worker(&app_clone, &registry, uuid)
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
/// * `app` - Tauri app handle (injected by Tauri)
/// * `registry` - Shared worker registry (managed state)
/// * `id` - UUID string of the worker to resume
///
/// # Errors
///
/// Returns a `String` error if:
/// - The `id` is not a valid UUID
/// - No worker with the given ID exists
#[tauri::command]
#[tracing::instrument(skip(app, registry))]
pub async fn resume_worker(
    app: AppHandle,
    registry: tauri::State<'_, WorkerRegistry>,
    id: String,
) -> Result<(), String> {
    tracing::info!(worker_id = %id, "resume_worker called");
    let uuid = Uuid::parse_str(&id).map_err(|e| {
        tracing::error!(error = %e, "invalid worker ID");
        e.to_string()
    })?;
    let registry = registry.inner().clone();
    let app_clone = app.clone();
    tokio::task::spawn_blocking(move || {
        lifecycle::do_resume_worker(&app_clone, &registry, uuid)
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
/// process, and emits a `worker:killed` event.
///
/// # Arguments
///
/// * `app` - Tauri app handle (injected by Tauri)
/// * `registry` - Shared worker registry (managed state)
/// * `id` - UUID string of the worker to kill
///
/// # Errors
///
/// Returns a `String` error if:
/// - The `id` is not a valid UUID
/// - No worker with the given ID exists
#[tauri::command]
#[tracing::instrument(skip(app, registry))]
pub async fn kill_worker(
    app: AppHandle,
    registry: tauri::State<'_, WorkerRegistry>,
    id: String,
) -> Result<(), String> {
    tracing::info!(worker_id = %id, "kill_worker called");
    let uuid = Uuid::parse_str(&id).map_err(|e| {
        tracing::error!(error = %e, "invalid worker ID");
        e.to_string()
    })?;
    let registry = registry.inner().clone();
    let app_clone = app.clone();
    tokio::task::spawn_blocking(move || {
        lifecycle::do_kill_worker(&app_clone, &registry, uuid)
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

/// Sends input data to a worker's PTY stdin.
///
/// # Arguments
///
/// * `registry` - Shared worker registry (managed state)
/// * `id` - UUID string of the target worker
/// * `data` - Raw bytes to write to the worker's PTY
///
/// # Errors
///
/// Returns a `String` error if:
/// - The `id` is not a valid UUID
/// - No worker with the given ID exists
/// - The worker has no PTY writer
/// - The write to the PTY fails
#[tauri::command]
#[tracing::instrument(skip(registry, data))]
pub async fn worker_input(
    registry: tauri::State<'_, WorkerRegistry>,
    id: String,
    data: Vec<u8>,
) -> Result<(), String> {
    tracing::debug!(worker_id = %id, bytes = data.len(), "worker_input called");
    let uuid = Uuid::parse_str(&id).map_err(|e| {
        tracing::error!(error = %e, "invalid worker ID");
        e.to_string()
    })?;
    let registry = registry.inner().clone();
    tokio::task::spawn_blocking(move || {
        lifecycle::do_worker_input(&registry, uuid, &data)
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
