//! Message bus Tauri IPC command handlers — thin wrappers over
//! [`swarm_core::commands::bus`]. `bus_subscribe`/`bus_create_pipeline`/
//! `bus_list_pipelines` DELETED in Phase 4 — see
//! `swarm_core::bus::router`'s module doc.

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
    cause_seq: Option<u64>,
) -> Result<usize, String> {
    call(
        &registry,
        ctx.inner().clone(),
        "bus_send",
        serde_json::json!({
            "fromWorkerId": from_worker_id, "toWorkerId": to_worker_id,
            "topic": topic, "payload": payload, "causeSeq": cause_seq
        }),
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
