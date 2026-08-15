//! Message bus Tauri IPC command handlers — thin wrappers over
//! [`swarm_core::commands::bus`].

use swarm_core::bus::router::{PipelineInfo, PipelineStage};
use swarm_core::commands::Registry;

use crate::commands::call;

#[tauri::command]
#[tracing::instrument(skip(registry, ctx, payload))]
pub async fn bus_send(
    registry: tauri::State<'_, std::sync::Arc<Registry>>,
    ctx: tauri::State<'_, swarm_core::commands::Ctx>,
    from_worker_id: String,
    to_worker_id: Option<String>,
    topic: String,
    payload: serde_json::Value,
) -> Result<usize, String> {
    call(
        &registry,
        ctx.inner().clone(),
        "bus_send",
        serde_json::json!({
            "fromWorkerId": from_worker_id, "toWorkerId": to_worker_id,
            "topic": topic, "payload": payload
        }),
    )
    .await
}

#[tauri::command]
#[tracing::instrument(skip(registry, ctx))]
pub async fn bus_subscribe(
    registry: tauri::State<'_, std::sync::Arc<Registry>>,
    ctx: tauri::State<'_, swarm_core::commands::Ctx>,
    topic: String,
) -> Result<(), String> {
    call(
        &registry,
        ctx.inner().clone(),
        "bus_subscribe",
        serde_json::json!({ "topic": topic }),
    )
    .await
}

#[tauri::command]
#[tracing::instrument(skip(registry, ctx, stages))]
pub async fn bus_create_pipeline(
    registry: tauri::State<'_, std::sync::Arc<Registry>>,
    ctx: tauri::State<'_, swarm_core::commands::Ctx>,
    stages: Vec<PipelineStage>,
) -> Result<String, String> {
    call(
        &registry,
        ctx.inner().clone(),
        "bus_create_pipeline",
        serde_json::json!({ "stages": stages }),
    )
    .await
}

#[tauri::command]
#[tracing::instrument(skip(registry, ctx))]
pub async fn bus_list_channels(
    registry: tauri::State<'_, std::sync::Arc<Registry>>,
    ctx: tauri::State<'_, swarm_core::commands::Ctx>,
) -> Result<Vec<String>, String> {
    call(
        &registry,
        ctx.inner().clone(),
        "bus_list_channels",
        serde_json::json!({}),
    )
    .await
}

#[tauri::command]
#[tracing::instrument(skip(registry, ctx))]
pub async fn bus_list_pipelines(
    registry: tauri::State<'_, std::sync::Arc<Registry>>,
    ctx: tauri::State<'_, swarm_core::commands::Ctx>,
) -> Result<Vec<PipelineInfo>, String> {
    call(
        &registry,
        ctx.inner().clone(),
        "bus_list_pipelines",
        serde_json::json!({}),
    )
    .await
}
