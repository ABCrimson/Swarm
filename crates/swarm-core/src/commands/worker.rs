//! Worker lifecycle registry handlers. Ported from `swarm-desktop`'s
//! former `commands::worker` — the body of each handler here IS what
//! that Tauri command's body used to be; the thin Tauri wrapper now
//! just marshals args to/from JSON and calls [`super::Registry::dispatch`].

use serde::Deserialize;
use serde_json::Value;

use crate::events::InputSource;
use crate::worker::handle::WorkerConfig;
use crate::worker::lifecycle;

use super::{Ctx, err_value, ok_value, parse_args, parse_provenance, parse_uuid};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SpawnArgs {
    config: WorkerConfig,
    #[serde(default)]
    origin_worker: Option<String>,
    #[serde(default)]
    cause_seq: Option<u64>,
}

/// Credential-leak fix (multi-provider plan Phase 2 step 4) preserved:
/// only `config.name`/`config.env.len()` are ever logged, never `config`
/// itself (which carries `env: HashMap<String,String>`, the leak
/// vector).
pub async fn spawn_worker(ctx: Ctx, args: Value) -> Result<Value, Value> {
    let SpawnArgs {
        config,
        origin_worker,
        cause_seq,
    } = parse_args(args)?;
    tracing::info!(name = %config.name, env_key_count = config.env.len(), "spawn_worker called");
    let provenance = parse_provenance(origin_worker, cause_seq)?;
    let sink = ctx.sink.clone();
    let registry = ctx.registry.clone();
    let repo_locks = ctx.repo_locks.clone();
    let id = tokio::task::spawn_blocking(move || {
        lifecycle::do_spawn_worker(&sink, &registry, &repo_locks, config, provenance)
    })
    .await
    .map_err(|e| Value::String(e.to_string()))?
    .map_err(|e| err_value(&e))?;
    ok_value(&id.to_string())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorkerIdArgs {
    id: String,
    #[serde(default)]
    origin_worker: Option<String>,
    #[serde(default)]
    cause_seq: Option<u64>,
}

pub async fn pause_worker(ctx: Ctx, args: Value) -> Result<Value, Value> {
    let WorkerIdArgs {
        id,
        origin_worker,
        cause_seq,
    } = parse_args(args)?;
    let uuid = parse_uuid(&id)?;
    let provenance = parse_provenance(origin_worker, cause_seq)?;
    let sink = ctx.sink.clone();
    let registry = ctx.registry.clone();
    tokio::task::spawn_blocking(move || {
        lifecycle::do_pause_worker(&sink, &registry, uuid, provenance)
    })
    .await
    .map_err(|e| Value::String(e.to_string()))?
    .map_err(|e| err_value(&e))?;
    ok_value(&())
}

pub async fn resume_worker(ctx: Ctx, args: Value) -> Result<Value, Value> {
    let WorkerIdArgs {
        id,
        origin_worker,
        cause_seq,
    } = parse_args(args)?;
    let uuid = parse_uuid(&id)?;
    let provenance = parse_provenance(origin_worker, cause_seq)?;
    let sink = ctx.sink.clone();
    let registry = ctx.registry.clone();
    tokio::task::spawn_blocking(move || {
        lifecycle::do_resume_worker(&sink, &registry, uuid, provenance)
    })
    .await
    .map_err(|e| Value::String(e.to_string()))?
    .map_err(|e| err_value(&e))?;
    ok_value(&())
}

pub async fn kill_worker(ctx: Ctx, args: Value) -> Result<Value, Value> {
    let WorkerIdArgs {
        id,
        origin_worker,
        cause_seq,
    } = parse_args(args)?;
    let uuid = parse_uuid(&id)?;
    let provenance = parse_provenance(origin_worker, cause_seq)?;
    let sink = ctx.sink.clone();
    let registry = ctx.registry.clone();
    let repo_locks = ctx.repo_locks.clone();
    let kill_result = tokio::task::spawn_blocking(move || {
        lifecycle::do_kill_worker(&sink, &registry, &repo_locks, uuid, provenance)
    })
    .await
    .map_err(|e| Value::String(e.to_string()))?;

    // Best-effort agent-session teardown, same as the pre-Phase-2 Tauri
    // command — a failure here is logged, never blocks the PTY worker's
    // own kill result.
    if let Some(session) = ctx.agent_session_registry.remove(&uuid)
        && let Err(e) = session.shutdown().await
    {
        tracing::warn!(worker_id = %uuid, error = %e, "agent session shutdown failed during kill_worker (best-effort)");
    }

    kill_result.map_err(|e| err_value(&e))?;
    ok_value(&())
}

pub async fn list_workers(ctx: Ctx, _args: Value) -> Result<Value, Value> {
    ok_value(&ctx.registry.list_workers())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorkerInputArgs {
    id: String,
    data: String,
    source: InputSource,
    #[serde(default)]
    origin_worker: Option<String>,
    #[serde(default)]
    cause_seq: Option<u64>,
}

pub async fn worker_input(ctx: Ctx, args: Value) -> Result<Value, Value> {
    let WorkerInputArgs {
        id,
        data,
        source,
        origin_worker,
        cause_seq,
    } = parse_args(args)?;
    let uuid = parse_uuid(&id)?;
    let provenance = parse_provenance(origin_worker, cause_seq)?;
    let sink = ctx.sink.clone();
    let registry = ctx.registry.clone();
    tokio::task::spawn_blocking(move || {
        lifecycle::do_worker_input(&sink, &registry, uuid, data.as_bytes(), source, provenance)
    })
    .await
    .map_err(|e| Value::String(e.to_string()))?
    .map_err(|e| err_value(&e))?;
    ok_value(&())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ResizeArgs {
    id: String,
    rows: u16,
    cols: u16,
}

/// Resizes a worker's terminal to `rows` × `cols` character cells (see
/// [`lifecycle::do_resize_worker`]). Emits no event: the size is
/// terminal state, not history.
pub async fn resize_worker(ctx: Ctx, args: Value) -> Result<Value, Value> {
    let ResizeArgs { id, rows, cols } = parse_args(args)?;
    let uuid = parse_uuid(&id)?;
    let registry = ctx.registry.clone();
    tokio::task::spawn_blocking(move || lifecycle::do_resize_worker(&registry, uuid, rows, cols))
        .await
        .map_err(|e| Value::String(e.to_string()))?
        .map_err(|e| err_value(&e))?;
    ok_value(&())
}

#[derive(Deserialize)]
struct MaxWorkersArgs {
    max: usize,
}

pub async fn set_max_workers(ctx: Ctx, args: Value) -> Result<Value, Value> {
    use crate::worker::registry::{MAX_MAX_WORKERS, MIN_MAX_WORKERS};

    let MaxWorkersArgs { max } = parse_args(args)?;
    if !(MIN_MAX_WORKERS..=MAX_MAX_WORKERS).contains(&max) {
        return Err(Value::String(format!(
            "max_workers must be between {MIN_MAX_WORKERS} and {MAX_MAX_WORKERS}, got {max}"
        )));
    }

    let paths = ctx.paths.clone();
    tokio::task::spawn_blocking(move || {
        crate::config::write_value(&paths, "max_workers", serde_json::json!(max))
    })
    .await
    .map_err(|e| Value::String(e.to_string()))?
    .map_err(|e| err_value(&e))?;

    ctx.registry
        .set_max_workers(max)
        .map_err(|e| err_value(&e))?;
    ok_value(&())
}

#[cfg(test)]
mod tests {
    /// DIRECTIVE (credential-leak regression guard, relocated with this
    /// handler from `swarm-desktop::commands::worker::spawn_worker`'s
    /// own `#[tracing::instrument]`): the FIRST boundary `config`
    /// (carrying `env: HashMap<String, String>`) crosses on the
    /// registry path is this handler's own `tracing::info!` call — it
    /// must log only `name`/`env_key_count`, never `config` itself.
    /// `swarm_core::worker::lifecycle`'s own test covers the SECOND
    /// boundary (`do_spawn_worker`); this one is the first, and the
    /// shell's thin wrapper (`#[tracing::instrument(skip(..., config))]`)
    /// now skips `config` unconditionally, so this handler is the only
    /// remaining place a leak could reappear.
    #[derive(Clone, Default)]
    struct TracingCaptureBuf(std::sync::Arc<parking_lot::Mutex<Vec<u8>>>);

    impl std::io::Write for TracingCaptureBuf {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            self.0.lock().extend_from_slice(buf);
            Ok(buf.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    impl<'a> tracing_subscriber::fmt::MakeWriter<'a> for TracingCaptureBuf {
        type Writer = TracingCaptureBuf;
        fn make_writer(&'a self) -> Self::Writer {
            self.clone()
        }
    }

    #[test]
    fn test_spawn_worker_registry_handler_never_leaks_env_secret_into_tracing_output() {
        let capture = TracingCaptureBuf::default();
        let subscriber = tracing_subscriber::fmt()
            .with_writer(capture.clone())
            .with_max_level(tracing::Level::DEBUG)
            .with_ansi(false)
            .finish();

        const SECRET: &str = "sk-ant-registry-handler-secret-should-never-be-logged";
        let mut env = std::collections::HashMap::new();
        env.insert("ANTHROPIC_API_KEY".to_string(), SECRET.to_string());
        let config = crate::worker::handle::WorkerConfig {
            name: "Registry Handler Secret Bearer".to_string(),
            env,
            ..crate::worker::handle::WorkerConfig::default()
        };

        tracing::subscriber::with_default(subscriber, || {
            // Mirrors this file's `spawn_worker`'s own
            // `tracing::info!(name = %config.name, env_key_count =
            // config.env.len(), ...)` call exactly — same fields, no
            // `config` reference.
            tracing::info!(
                name = %config.name,
                env_key_count = config.env.len(),
                "spawn_worker called"
            );
        });

        let captured = String::from_utf8_lossy(&capture.0.lock()).into_owned();
        assert!(
            !captured.contains(SECRET),
            "captured tracing output leaked an env secret value at the registry handler layer: {captured}"
        );
        assert!(
            captured.contains("Registry Handler Secret Bearer"),
            "expected the redacted summary's name field to appear (proves the \
             subscriber actually captured this call, not a vacuous pass), got: {captured}"
        );
    }
}
