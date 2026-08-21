//! `read_file`/`write_file` Tauri IPC commands — thin wrappers over
//! [`swarm_core::commands::fs`]. `tauri-plugin-fs` itself continues to
//! back non-tool UI file access (`#lib/fs.ts`).

use swarm_core::commands::Registry;

use crate::commands::call;

#[tauri::command]
#[tracing::instrument(skip(registry, ctx))]
pub async fn read_file(
    registry: tauri::State<'_, std::sync::Arc<Registry>>,
    ctx: tauri::State<'_, swarm_core::commands::Ctx>,
    path: String,
) -> Result<String, String> {
    call(
        &registry,
        ctx.inner().clone(),
        "read_file",
        serde_json::json!({ "path": path }),
    )
    .await
}

#[tauri::command]
#[tracing::instrument(skip(registry, ctx, content))]
pub async fn write_file(
    registry: tauri::State<'_, std::sync::Arc<Registry>>,
    ctx: tauri::State<'_, swarm_core::commands::Ctx>,
    path: String,
    content: String,
    origin_worker: Option<String>,
    cause_seq: Option<u64>,
) -> Result<(), String> {
    call(
        &registry,
        ctx.inner().clone(),
        "write_file",
        serde_json::json!({
            "path": path, "content": content,
            "originWorker": origin_worker, "causeSeq": cause_seq
        }),
    )
    .await
}
