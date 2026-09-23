//! Git repo-root validation and the ship chain's Tauri IPC commands —
//! thin wrappers over [`swarm_core::commands::git`].

use swarm_core::commands::Registry;
use swarm_core::git::{self, ShipContext, ShipError, ShipErrorKind, StagingMode};

use crate::commands::{call, call_typed_err};

fn ship_error_fallback(message: String) -> ShipError {
    ShipError {
        kind: ShipErrorKind::Unknown,
        message,
        remedy: None,
    }
}

#[tauri::command]
#[tracing::instrument(skip(registry, ctx))]
pub async fn validate_repo_root(
    registry: tauri::State<'_, std::sync::Arc<Registry>>,
    ctx: tauri::State<'_, swarm_core::commands::Ctx>,
    path: String,
) -> Result<String, String> {
    call(
        &registry,
        ctx.inner().clone(),
        "validate_repo_root",
        serde_json::json!({ "path": path }),
    )
    .await
}

#[tauri::command]
#[tracing::instrument(skip(registry, ctx))]
pub async fn git_ship_preflight(
    registry: tauri::State<'_, std::sync::Arc<Registry>>,
    ctx: tauri::State<'_, swarm_core::commands::Ctx>,
    worker_id: String,
    mode: Option<StagingMode>,
) -> Result<git::ShipPreflight, ShipError> {
    call_typed_err(
        &registry,
        ctx.inner().clone(),
        "git_ship_preflight",
        serde_json::json!({ "workerId": worker_id, "mode": mode }),
        ship_error_fallback,
    )
    .await
}

#[tauri::command]
#[tracing::instrument(skip(registry, ctx, message))]
pub async fn git_stage_commit(
    registry: tauri::State<'_, std::sync::Arc<Registry>>,
    ctx: tauri::State<'_, swarm_core::commands::Ctx>,
    worker_id: String,
    ship_id: String,
    message: String,
    mode: StagingMode,
    final_step: bool,
) -> Result<git::CommitOutcome, ShipError> {
    call_typed_err(
        &registry,
        ctx.inner().clone(),
        "git_stage_commit",
        serde_json::json!({
            "workerId": worker_id, "shipId": ship_id, "message": message,
            "mode": mode, "finalStep": final_step
        }),
        ship_error_fallback,
    )
    .await
}

#[tauri::command]
#[tracing::instrument(skip(registry, ctx))]
pub async fn git_push(
    registry: tauri::State<'_, std::sync::Arc<Registry>>,
    ctx: tauri::State<'_, swarm_core::commands::Ctx>,
    worker_id: String,
    ship_id: String,
    final_step: bool,
) -> Result<git::PushOutcome, ShipError> {
    call_typed_err(
        &registry,
        ctx.inner().clone(),
        "git_push",
        serde_json::json!({ "workerId": worker_id, "shipId": ship_id, "finalStep": final_step }),
        ship_error_fallback,
    )
    .await
}

#[tauri::command]
#[tracing::instrument(skip(registry, ctx, title, body))]
#[expect(
    clippy::too_many_arguments,
    reason = "Tauri IPC command: two injected States plus one parameter per wire argument"
)]
pub async fn ship_compare_url(
    registry: tauri::State<'_, std::sync::Arc<Registry>>,
    ctx: tauri::State<'_, swarm_core::commands::Ctx>,
    worker_id: String,
    ship_id: String,
    commit_sha: String,
    pushed_ref: String,
    title: String,
    body: String,
) -> Result<String, ShipError> {
    call_typed_err(
        &registry,
        ctx.inner().clone(),
        "ship_compare_url",
        serde_json::json!({
            "workerId": worker_id, "shipId": ship_id, "commitSha": commit_sha,
            "pushedRef": pushed_ref, "title": title, "body": body
        }),
        ship_error_fallback,
    )
    .await
}

/// Unlike the other ship commands, `ship_context` never itself fails
/// mid-mutation (it's read-only) — but its error path is still a mix of
/// a structured `ShipError` (an invalid `workerId`) and a plain string
/// (an `EventLog`/task-panic failure), so it uses [`call_typed_err`] with
/// the same [`ship_error_fallback`] every other ship command uses, rather
/// than [`call`]'s plain-string convention.
#[tauri::command]
#[tracing::instrument(skip(registry, ctx))]
pub async fn ship_context(
    registry: tauri::State<'_, std::sync::Arc<Registry>>,
    ctx: tauri::State<'_, swarm_core::commands::Ctx>,
    worker_id: String,
) -> Result<ShipContext, ShipError> {
    call_typed_err(
        &registry,
        ctx.inner().clone(),
        "ship_context",
        serde_json::json!({ "workerId": worker_id }),
        ship_error_fallback,
    )
    .await
}
