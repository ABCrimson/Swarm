//! `get_metrics` registry handler — the pull-based complement to the
//! background loop [`crate::runtime::Runtime::start`] already spawns
//! via [`crate::metrics::start_metrics_loop`].

use serde_json::Value;

use super::Ctx;

pub async fn get_metrics(ctx: Ctx, _args: Value) -> Result<Value, Value> {
    let registry = ctx.registry.clone();
    let shared_system = ctx.shared_system.clone();
    tokio::task::spawn_blocking(move || crate::metrics::snapshot(&registry, &shared_system))
        .await
        .map_err(|e| Value::String(e.to_string()))
}
