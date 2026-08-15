//! `get_metrics` Tauri IPC command — thin wrapper over
//! [`swarm_core::commands::metrics`]. The background 500ms push loop is
//! started by `swarm_core::runtime::Runtime::start` itself now (see
//! `crate::run`'s setup) — nothing left for this shell to spawn.

use swarm_core::commands::Registry;

use crate::commands::call;

#[tauri::command]
#[tracing::instrument(skip(registry, ctx))]
pub async fn get_metrics(
    registry: tauri::State<'_, std::sync::Arc<Registry>>,
    ctx: tauri::State<'_, swarm_core::commands::Ctx>,
) -> Result<serde_json::Value, String> {
    call(
        &registry,
        ctx.inner().clone(),
        "get_metrics",
        serde_json::json!({}),
    )
    .await
}
