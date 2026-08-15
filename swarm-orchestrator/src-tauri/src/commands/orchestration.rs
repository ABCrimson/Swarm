//! `events_since` Tauri IPC command — thin wrapper over
//! [`swarm_core::commands::orchestration`].

use swarm_core::commands::Registry;

use crate::commands::call;

#[tauri::command]
#[tracing::instrument(skip(registry, ctx))]
pub async fn events_since(
    registry: tauri::State<'_, std::sync::Arc<Registry>>,
    ctx: tauri::State<'_, swarm_core::commands::Ctx>,
    after_seq: u64,
    limit: Option<u32>,
) -> Result<Vec<serde_json::Value>, String> {
    call(
        &registry,
        ctx.inner().clone(),
        "events_since",
        serde_json::json!({ "afterSeq": after_seq, "limit": limit }),
    )
    .await
}
