//! `get_metrics`: one on-demand metrics sample, the pull complement to
//! the `system_metrics` events [`crate::runtime::Runtime::start`]'s
//! background loop emits.

use serde_json::Value;

use super::Ctx;

/// A fresh system and per-worker metrics snapshot.
pub async fn get_metrics(ctx: Ctx, _args: Value) -> Result<Value, Value> {
    let registry = ctx.registry.clone();
    let shared_system = ctx.shared_system.clone();
    tokio::task::spawn_blocking(move || crate::metrics::snapshot(&registry, &shared_system))
        .await
        .map_err(|e| Value::String(e.to_string()))
}
