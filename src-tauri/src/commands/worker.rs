//! Worker lifecycle Tauri IPC command handlers — thin wrappers over
//! [`swarm_core::commands::worker`]. See `commands::mod`'s doc for the
//! wrapper pattern.

use swarm_core::commands::Registry;
use swarm_core::worker::handle::{WorkerConfig, WorkerInfo};

use crate::commands::call;

#[tauri::command]
#[tracing::instrument(skip(registry, ctx, config))]
pub async fn spawn_worker(
    registry: tauri::State<'_, std::sync::Arc<Registry>>,
    ctx: tauri::State<'_, swarm_core::commands::Ctx>,
    config: WorkerConfig,
    origin_worker: Option<String>,
    cause_seq: Option<u64>,
) -> Result<String, String> {
    call(
        &registry,
        ctx.inner().clone(),
        "spawn_worker",
        serde_json::json!({ "config": config, "originWorker": origin_worker, "causeSeq": cause_seq }),
    )
    .await
}

#[tauri::command]
#[tracing::instrument(skip(registry, ctx))]
pub async fn pause_worker(
    registry: tauri::State<'_, std::sync::Arc<Registry>>,
    ctx: tauri::State<'_, swarm_core::commands::Ctx>,
    id: String,
    origin_worker: Option<String>,
    cause_seq: Option<u64>,
) -> Result<(), String> {
    call(
        &registry,
        ctx.inner().clone(),
        "pause_worker",
        serde_json::json!({ "id": id, "originWorker": origin_worker, "causeSeq": cause_seq }),
    )
    .await
}

#[tauri::command]
#[tracing::instrument(skip(registry, ctx))]
pub async fn resume_worker(
    registry: tauri::State<'_, std::sync::Arc<Registry>>,
    ctx: tauri::State<'_, swarm_core::commands::Ctx>,
    id: String,
    origin_worker: Option<String>,
    cause_seq: Option<u64>,
) -> Result<(), String> {
    call(
        &registry,
        ctx.inner().clone(),
        "resume_worker",
        serde_json::json!({ "id": id, "originWorker": origin_worker, "causeSeq": cause_seq }),
    )
    .await
}

#[tauri::command]
#[tracing::instrument(skip(registry, ctx))]
pub async fn kill_worker(
    registry: tauri::State<'_, std::sync::Arc<Registry>>,
    ctx: tauri::State<'_, swarm_core::commands::Ctx>,
    id: String,
    origin_worker: Option<String>,
    cause_seq: Option<u64>,
) -> Result<(), String> {
    call(
        &registry,
        ctx.inner().clone(),
        "kill_worker",
        serde_json::json!({ "id": id, "originWorker": origin_worker, "causeSeq": cause_seq }),
    )
    .await
}

#[tauri::command]
#[tracing::instrument(skip(registry, ctx))]
pub async fn list_workers(
    registry: tauri::State<'_, std::sync::Arc<Registry>>,
    ctx: tauri::State<'_, swarm_core::commands::Ctx>,
) -> Result<Vec<WorkerInfo>, String> {
    call(
        &registry,
        ctx.inner().clone(),
        "list_workers",
        serde_json::json!({}),
    )
    .await
}

#[tauri::command]
#[tracing::instrument(skip(registry, ctx, data))]
pub async fn worker_input(
    registry: tauri::State<'_, std::sync::Arc<Registry>>,
    ctx: tauri::State<'_, swarm_core::commands::Ctx>,
    id: String,
    data: String,
    source: swarm_core::events::InputSource,
    origin_worker: Option<String>,
    cause_seq: Option<u64>,
) -> Result<(), String> {
    call(
        &registry,
        ctx.inner().clone(),
        "worker_input",
        serde_json::json!({
            "id": id, "data": data, "source": source,
            "originWorker": origin_worker, "causeSeq": cause_seq
        }),
    )
    .await
}

#[tauri::command]
#[tracing::instrument(skip(registry, ctx))]
pub async fn resize_worker(
    registry: tauri::State<'_, std::sync::Arc<Registry>>,
    ctx: tauri::State<'_, swarm_core::commands::Ctx>,
    id: String,
    rows: u16,
    cols: u16,
) -> Result<(), String> {
    call(
        &registry,
        ctx.inner().clone(),
        "resize_worker",
        serde_json::json!({ "id": id, "rows": rows, "cols": cols }),
    )
    .await
}

#[tauri::command]
#[tracing::instrument(skip(registry, ctx))]
pub async fn set_max_workers(
    registry: tauri::State<'_, std::sync::Arc<Registry>>,
    ctx: tauri::State<'_, swarm_core::commands::Ctx>,
    max: usize,
) -> Result<(), String> {
    call(
        &registry,
        ctx.inner().clone(),
        "set_max_workers",
        serde_json::json!({ "max": max }),
    )
    .await
}
