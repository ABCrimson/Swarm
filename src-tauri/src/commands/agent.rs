//! Provider-adapter agent Tauri IPC command handlers — thin wrappers
//! over [`swarm_core::commands::agent`].

use serde::Serialize;
use swarm_core::agent::{PermissionDecision, ProbeReport};
use swarm_core::commands::Registry;
use swarm_core::worker::handle::WorkerConfig;

use crate::commands::{call, call_typed_err};

/// Mirrors the pre-Phase-2 `AgentSpawnError` shape exactly (same field
/// names/types) — this crate's own Tauri-IPC-facing type, deserialized
/// from the registry's `err_value` JSON on the shell side (see
/// `commands::call_typed_err`'s doc for why a typed round-trip, not a
/// plain string, is needed for this one command).
#[derive(Debug, Clone, Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSpawnError {
    pub worker_id: Option<String>,
    pub message: String,
}

impl std::fmt::Display for AgentSpawnError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message)
    }
}

#[tauri::command]
#[tracing::instrument(skip(registry, ctx))]
pub async fn agent_turn_started(
    registry: tauri::State<'_, std::sync::Arc<Registry>>,
    ctx: tauri::State<'_, swarm_core::commands::Ctx>,
    worker_id: String,
    model: String,
    request_id: String,
) -> Result<u64, String> {
    call(
        &registry,
        ctx.inner().clone(),
        "agent_turn_started",
        serde_json::json!({ "workerId": worker_id, "model": model, "requestId": request_id }),
    )
    .await
}

#[tauri::command]
#[tracing::instrument(skip(registry, ctx, config))]
#[expect(
    clippy::too_many_arguments,
    reason = "Tauri IPC command: two injected States plus one parameter per wire argument"
)]
pub async fn agent_spawn(
    registry: tauri::State<'_, std::sync::Arc<Registry>>,
    ctx: tauri::State<'_, swarm_core::commands::Ctx>,
    config: WorkerConfig,
    provider: String,
    model: Option<String>,
    trust_tier: Option<String>,
    origin_worker: Option<String>,
    cause_seq: Option<u64>,
) -> Result<String, AgentSpawnError> {
    call_typed_err(
        &registry,
        ctx.inner().clone(),
        "agent_spawn",
        serde_json::json!({
            "config": config, "provider": provider, "model": model, "trustTier": trust_tier,
            "originWorker": origin_worker, "causeSeq": cause_seq
        }),
        |message| AgentSpawnError {
            worker_id: None,
            message,
        },
    )
    .await
}

#[tauri::command]
#[tracing::instrument(skip(registry, ctx))]
pub async fn agent_send_turn(
    registry: tauri::State<'_, std::sync::Arc<Registry>>,
    ctx: tauri::State<'_, swarm_core::commands::Ctx>,
    worker_id: String,
    prompt: String,
) -> Result<(), String> {
    call(
        &registry,
        ctx.inner().clone(),
        "agent_send_turn",
        serde_json::json!({ "workerId": worker_id, "prompt": prompt }),
    )
    .await
}

#[tauri::command]
#[tracing::instrument(skip(registry, ctx))]
pub async fn agent_cancel(
    registry: tauri::State<'_, std::sync::Arc<Registry>>,
    ctx: tauri::State<'_, swarm_core::commands::Ctx>,
    worker_id: String,
    turn_id: String,
) -> Result<(), String> {
    call(
        &registry,
        ctx.inner().clone(),
        "agent_cancel",
        serde_json::json!({ "workerId": worker_id, "turnId": turn_id }),
    )
    .await
}

#[tauri::command]
#[tracing::instrument(skip(registry, ctx))]
pub async fn agent_shutdown(
    registry: tauri::State<'_, std::sync::Arc<Registry>>,
    ctx: tauri::State<'_, swarm_core::commands::Ctx>,
    worker_id: String,
) -> Result<(), String> {
    call(
        &registry,
        ctx.inner().clone(),
        "agent_shutdown",
        serde_json::json!({ "workerId": worker_id }),
    )
    .await
}

#[tauri::command]
#[tracing::instrument(skip(registry, ctx))]
pub async fn agent_probe(
    registry: tauri::State<'_, std::sync::Arc<Registry>>,
    ctx: tauri::State<'_, swarm_core::commands::Ctx>,
    provider: Option<String>,
) -> Result<ProbeReport, String> {
    call(
        &registry,
        ctx.inner().clone(),
        "agent_probe",
        serde_json::json!({ "provider": provider }),
    )
    .await
}

#[tauri::command]
#[tracing::instrument(skip(registry, ctx))]
pub async fn agent_permission_respond(
    registry: tauri::State<'_, std::sync::Arc<Registry>>,
    ctx: tauri::State<'_, swarm_core::commands::Ctx>,
    worker_id: String,
    request_id: String,
    decision: PermissionDecision,
) -> Result<(), String> {
    call(
        &registry,
        ctx.inner().clone(),
        "agent_permission_respond",
        serde_json::json!({ "workerId": worker_id, "requestId": request_id, "decision": decision }),
    )
    .await
}

#[tauri::command]
#[tracing::instrument(skip(registry, ctx))]
pub async fn set_agent_concurrency(
    registry: tauri::State<'_, std::sync::Arc<Registry>>,
    ctx: tauri::State<'_, swarm_core::commands::Ctx>,
    limit: u32,
) -> Result<(), String> {
    call(
        &registry,
        ctx.inner().clone(),
        "set_agent_concurrency",
        serde_json::json!({ "limit": limit }),
    )
    .await
}
