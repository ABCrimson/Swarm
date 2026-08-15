//! Session CRUD Tauri IPC command handlers — thin wrappers over
//! [`swarm_core::commands::session`].

use swarm_core::commands::Registry;
use swarm_core::session::manager::Session;

use crate::commands::call;

#[tauri::command]
#[tracing::instrument(skip(registry, ctx))]
pub async fn create_session(
    registry: tauri::State<'_, std::sync::Arc<Registry>>,
    ctx: tauri::State<'_, swarm_core::commands::Ctx>,
    name: String,
    config: serde_json::Value,
    origin_worker: Option<String>,
    cause_seq: Option<u64>,
) -> Result<Session, String> {
    call(
        &registry,
        ctx.inner().clone(),
        "create_session",
        serde_json::json!({ "name": name, "config": config, "originWorker": origin_worker, "causeSeq": cause_seq }),
    )
    .await
}

#[tauri::command]
#[tracing::instrument(skip(registry, ctx))]
pub async fn delete_session(
    registry: tauri::State<'_, std::sync::Arc<Registry>>,
    ctx: tauri::State<'_, swarm_core::commands::Ctx>,
    id: String,
    origin_worker: Option<String>,
    cause_seq: Option<u64>,
) -> Result<(), String> {
    call(
        &registry,
        ctx.inner().clone(),
        "delete_session",
        serde_json::json!({ "id": id, "originWorker": origin_worker, "causeSeq": cause_seq }),
    )
    .await
}

#[tauri::command]
#[tracing::instrument(skip(registry, ctx))]
pub async fn list_sessions(
    registry: tauri::State<'_, std::sync::Arc<Registry>>,
    ctx: tauri::State<'_, swarm_core::commands::Ctx>,
) -> Result<Vec<Session>, String> {
    call(
        &registry,
        ctx.inner().clone(),
        "list_sessions",
        serde_json::json!({}),
    )
    .await
}

#[tauri::command]
#[tracing::instrument(skip(registry, ctx))]
pub async fn get_session(
    registry: tauri::State<'_, std::sync::Arc<Registry>>,
    ctx: tauri::State<'_, swarm_core::commands::Ctx>,
    id: String,
) -> Result<Session, String> {
    call(
        &registry,
        ctx.inner().clone(),
        "get_session",
        serde_json::json!({ "id": id }),
    )
    .await
}

#[tauri::command]
#[tracing::instrument(skip(registry, ctx))]
pub async fn session_add_worker(
    registry: tauri::State<'_, std::sync::Arc<Registry>>,
    ctx: tauri::State<'_, swarm_core::commands::Ctx>,
    session_id: String,
    worker_id: String,
) -> Result<(), String> {
    call(
        &registry,
        ctx.inner().clone(),
        "session_add_worker",
        serde_json::json!({ "sessionId": session_id, "workerId": worker_id }),
    )
    .await
}

#[tauri::command]
#[tracing::instrument(skip(registry, ctx))]
pub async fn session_remove_worker(
    registry: tauri::State<'_, std::sync::Arc<Registry>>,
    ctx: tauri::State<'_, swarm_core::commands::Ctx>,
    session_id: String,
    worker_id: String,
) -> Result<(), String> {
    call(
        &registry,
        ctx.inner().clone(),
        "session_remove_worker",
        serde_json::json!({ "sessionId": session_id, "workerId": worker_id }),
    )
    .await
}
