//! App configuration Tauri IPC commands — thin wrappers over
//! [`swarm_core::commands::config`].
//!
//! Startup config reads (`max_workers`, `default_repo_root`) no longer
//! need a shell-side sync helper — `swarm_core::runtime::Runtime::start`
//! reads them itself, directly via `swarm_core::config`, before any
//! `Registry`/`Ctx` exists.

use serde_json::Value;

use swarm_core::commands::Registry;

use crate::commands::call;

#[tauri::command]
#[tracing::instrument(skip(registry, ctx))]
pub async fn read_config(
    registry: tauri::State<'_, std::sync::Arc<Registry>>,
    ctx: tauri::State<'_, swarm_core::commands::Ctx>,
    key: String,
) -> Result<Option<Value>, String> {
    call(
        &registry,
        ctx.inner().clone(),
        "read_config",
        serde_json::json!({ "key": key }),
    )
    .await
}

#[tauri::command]
#[tracing::instrument(skip(registry, ctx, value))]
pub async fn write_config(
    registry: tauri::State<'_, std::sync::Arc<Registry>>,
    ctx: tauri::State<'_, swarm_core::commands::Ctx>,
    key: String,
    value: Value,
) -> Result<(), String> {
    call(
        &registry,
        ctx.inner().clone(),
        "write_config",
        serde_json::json!({ "key": key, "value": value }),
    )
    .await
}
