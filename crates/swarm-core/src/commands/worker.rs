//! PTY worker commands: spawn, pause, resume, kill, list, input, resize,
//! and the worker cap. The blocking PTY work runs on Tokio's blocking pool.

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

/// Spawns a PTY worker and resolves to its id.
///
/// Logs only the worker's name and how many environment variables it
/// gets, never `config` itself: its `env` carries secrets such as API
/// keys.
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

/// Marks a running worker paused (state only: no signal reaches its process; see [`lifecycle::do_pause_worker`]).
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

/// Marks a paused worker running again (state only; see [`lifecycle::do_resume_worker`]).
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

/// Kills a worker, removes it (and its worktree, per its isolation
/// policy), then shuts down its agent session if it has one.
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

    // Best-effort: a failed agent-session shutdown is logged and never
    // changes the kill's own result.
    if let Some(session) = ctx.agent_session_registry.remove(&uuid)
        && let Err(e) = session.shutdown().await
    {
        tracing::warn!(worker_id = %uuid, error = %e, "agent session shutdown failed during kill_worker");
    }

    kill_result.map_err(|e| err_value(&e))?;
    ok_value(&())
}

/// Every live worker.
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

/// Writes `data` to a worker's terminal, recording who typed it.
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

/// Sets how many workers may run at once: persisted to
/// `swarm-config.json` (`max_workers`, re-applied by
/// [`crate::runtime::Runtime::start`]), then applied live.
pub async fn set_max_workers(ctx: Ctx, args: Value) -> Result<Value, Value> {
    use crate::worker::registry::{MAX_MAX_WORKERS, MIN_MAX_WORKERS};

    let MaxWorkersArgs { max } = parse_args(args)?;
    if !(MIN_MAX_WORKERS..=MAX_MAX_WORKERS).contains(&max) {
        return Err(Value::String(format!(
            "Max Workers Must Be Between {MIN_MAX_WORKERS} And {MAX_MAX_WORKERS}, Got {max}."
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
    use std::sync::Arc;

    use serde_json::json;

    use super::*;
    use crate::commands::test_support::test_ctx;

    /// Collects formatted tracing output in memory.
    #[derive(Clone, Default)]
    struct Capture(Arc<parking_lot::Mutex<Vec<u8>>>);

    impl std::io::Write for Capture {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            self.0.lock().extend_from_slice(buf);
            Ok(buf.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    impl<'a> tracing_subscriber::fmt::MakeWriter<'a> for Capture {
        type Writer = Self;
        fn make_writer(&'a self) -> Self {
            self.clone()
        }
    }

    /// `spawn_worker` is the first place a worker's `config` (and its
    /// secret-bearing `env`) is logged on the command path. Drives the
    /// real handler; an invalid `originWorker` makes it fail right after
    /// its log line, so no process is spawned.
    #[tokio::test]
    async fn test_spawn_worker_never_logs_an_env_secret() {
        const SECRET: &str = "sk-ant-registry-handler-secret-should-never-be-logged";
        let capture = Capture::default();
        let _subscriber = tracing::subscriber::set_default(
            tracing_subscriber::fmt()
                .with_writer(capture.clone())
                .with_max_level(tracing::Level::TRACE)
                .with_ansi(false)
                .finish(),
        );
        let (ctx, _dir, _events) = test_ctx();

        let result = spawn_worker(
            ctx.clone(),
            json!({
                "config": {
                    "name": "Registry Handler Secret Bearer",
                    "env": {"ANTHROPIC_API_KEY": SECRET},
                },
                "originWorker": "not-a-uuid",
            }),
        )
        .await;

        assert!(
            result.is_err(),
            "the bogus originWorker must stop the spawn"
        );
        assert!(ctx.registry.list_workers().is_empty());
        let captured = String::from_utf8_lossy(&capture.0.lock()).into_owned();
        assert!(!captured.contains(SECRET), "leaked: {captured}");
        assert!(
            captured.contains("Registry Handler Secret Bearer")
                && captured.contains("env_key_count=1"),
            "the handler's own log line must have been captured: {captured}"
        );
    }

    #[tokio::test]
    async fn test_set_max_workers_rejects_out_of_range_in_title_case() {
        let (ctx, _dir, _events) = test_ctx();
        let err = set_max_workers(ctx, json!({"max": 0})).await.unwrap_err();
        assert!(
            err.as_str()
                .unwrap()
                .starts_with("Max Workers Must Be Between "),
            "{err}"
        );
    }

    /// Persists `max_workers` and applies it live; both bounds are
    /// inclusive and a rejected value changes nothing.
    #[tokio::test]
    async fn test_set_max_workers_persists_and_applies_live() {
        use crate::worker::registry::{MAX_MAX_WORKERS, MIN_MAX_WORKERS};
        let (ctx, _dir, _events) = test_ctx();
        let persisted = || crate::config::read_value(&ctx.paths, "max_workers");
        set_max_workers(ctx.clone(), json!({"max": 3}))
            .await
            .unwrap();
        assert_eq!(ctx.registry.config.read().max_workers, 3);
        assert_eq!(persisted(), Some(json!(3)));
        set_max_workers(ctx.clone(), json!({"max": MIN_MAX_WORKERS}))
            .await
            .unwrap();
        assert_eq!(ctx.registry.config.read().max_workers, MIN_MAX_WORKERS);
        assert_eq!(persisted(), Some(json!(MIN_MAX_WORKERS)));
        set_max_workers(ctx.clone(), json!({"max": MAX_MAX_WORKERS}))
            .await
            .unwrap();
        assert_eq!(ctx.registry.config.read().max_workers, MAX_MAX_WORKERS);
        let err = set_max_workers(ctx.clone(), json!({"max": MAX_MAX_WORKERS + 1}))
            .await
            .unwrap_err();
        assert!(
            err.as_str()
                .unwrap()
                .starts_with("Max Workers Must Be Between "),
            "{err}"
        );
        assert_eq!(ctx.registry.config.read().max_workers, MAX_MAX_WORKERS);
        assert_eq!(persisted(), Some(json!(MAX_MAX_WORKERS)));
    }
}
