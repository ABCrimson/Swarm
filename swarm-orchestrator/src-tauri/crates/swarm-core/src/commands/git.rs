//! Git repo-root validation and the ship chain's registry handlers.
//! Ported verbatim from `swarm-desktop`'s former `commands::git` — see
//! that module's original doc for the full design rationale (B2's
//! `git_push` HEAD-resolution behavior, the `Swarm-Seq-Range` trailer,
//! etc.), unchanged here.

use serde::Deserialize;
use serde_json::Value;
use uuid::Uuid;

use crate::events::{
    CommitCreatedPayload, EventSink, ShipProgressPayload, ShipSettledPayload, SwarmEvent,
};
use crate::git::{self, ShipContext, ShipError, ShipErrorKind, StagingMode};
use crate::orchestration::{EventLog, OrchestrationEngine};
use crate::worker::registry::WorkerRegistry;

use super::{Ctx, err_value, ok_value, parse_args};

/// Cap on rows fetched per `ship_context` call — deliberately generous
/// (well above `commands::orchestration::events_since`'s IPC-facing
/// `PAGE_LIMIT` of 5000): a single busy turn can emit a dozen-plus rows
/// (block + tool_call + tool_result per tool use), so 200 turns'
/// worth easily exceeds 5000 raw event rows even though
/// `git::causal::build_ship_context`'s own `MAX_TURNS` cap keeps the
/// *returned* turn count bounded regardless of how many rows this
/// fetches.
const SHIP_CONTEXT_EVENT_LIMIT: u32 = 50_000;

fn parse_worker_id(raw: &str) -> Result<Uuid, ShipError> {
    Uuid::parse_str(raw).map_err(|_| ShipError {
        kind: ShipErrorKind::WorkerNotFound,
        message: format!("`{raw}` Is Not A Valid Worker ID."),
        remedy: None,
    })
}

fn parse_ship_id(raw: &str) -> Uuid {
    Uuid::parse_str(raw).unwrap_or_else(|_| Uuid::new_v4())
}

fn parse_worker_id_or_settle(
    sink: &EventSink,
    ship_id: Uuid,
    raw: &str,
    step: &str,
) -> Result<Uuid, ShipError> {
    match parse_worker_id(raw) {
        Ok(id) => Ok(id),
        Err(err) => {
            emit_progress(
                sink,
                ship_id,
                Uuid::nil(),
                step,
                "error",
                Some(err.message.clone()),
            );
            emit_settled(
                sink,
                ship_id,
                Uuid::nil(),
                None,
                None,
                None,
                Some(err.clone()),
            );
            Err(err)
        }
    }
}

fn find_worktree_created_seq(db_path: &std::path::Path, worker_id: &str) -> Option<u64> {
    EventLog::open_readonly(db_path)
        .ok()?
        .find_first_for_worker("worktree_created", worker_id)
        .ok()?
}

fn current_max_seq(db_path: &std::path::Path) -> u64 {
    EventLog::open_readonly(db_path)
        .and_then(|l| l.max_seq())
        .unwrap_or(0)
}

async fn resolve_seq_range(
    engine: &OrchestrationEngine,
    registry: &WorkerRegistry,
    worker_id: Uuid,
) -> (u64, u64) {
    let last_shipped = git::ship::worktree_info_for_worker(registry, worker_id)
        .ok()
        .and_then(|info| info.last_shipped_seq);

    let Some(db_path) = engine.db_path().map(std::path::Path::to_path_buf) else {
        return (last_shipped.unwrap_or(0), 0);
    };
    let worker_id_str = worker_id.to_string();
    tokio::task::spawn_blocking(move || {
        let seq_to = current_max_seq(&db_path);
        let seq_from = last_shipped
            .unwrap_or_else(|| find_worktree_created_seq(&db_path, &worker_id_str).unwrap_or(0));
        (seq_from, seq_to)
    })
    .await
    .unwrap_or((last_shipped.unwrap_or(0), 0))
}

async fn current_max_seq_for_engine(engine: &OrchestrationEngine) -> u64 {
    let Some(db_path) = engine.db_path().map(std::path::Path::to_path_buf) else {
        return 0;
    };
    tokio::task::spawn_blocking(move || current_max_seq(&db_path))
        .await
        .unwrap_or(0)
}

fn emit_progress(
    sink: &EventSink,
    ship_id: Uuid,
    worker_id: Uuid,
    step: &str,
    status: &str,
    detail: Option<String>,
) {
    sink.emit(SwarmEvent::ShipProgress(ShipProgressPayload {
        ship_id,
        worker_id,
        step: step.to_string(),
        status: status.to_string(),
        detail,
    }));
}

#[allow(clippy::too_many_arguments)]
fn emit_settled(
    sink: &EventSink,
    ship_id: Uuid,
    worker_id: Uuid,
    commit_sha: Option<String>,
    pushed_ref: Option<String>,
    pr_url: Option<String>,
    error: Option<ShipError>,
) {
    let status = if error.is_some() { "error" } else { "ok" };
    sink.emit(SwarmEvent::ShipSettled(ShipSettledPayload {
        ship_id,
        worker_id,
        commit_sha,
        pushed_ref,
        pr_url,
        status: status.to_string(),
        error,
    }));
}

#[derive(Deserialize)]
struct PathArgs {
    path: String,
}

pub async fn validate_repo_root(_ctx: Ctx, args: Value) -> Result<Value, Value> {
    let PathArgs { path } = parse_args(args)?;
    let toplevel = tokio::task::spawn_blocking(move || {
        git::repo::discover_toplevel(std::path::Path::new(&path))
    })
    .await
    .map_err(|e| Value::String(e.to_string()))?
    .map_err(|e| Value::String(e.to_string()))?;
    ok_value(&toplevel.display().to_string())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PreflightArgs {
    worker_id: String,
    #[serde(default)]
    mode: Option<StagingMode>,
}

pub async fn git_ship_preflight(ctx: Ctx, args: Value) -> Result<Value, Value> {
    let PreflightArgs { worker_id, mode } = parse_args(args)?;
    let id = parse_worker_id(&worker_id).map_err(|e| err_value(&e))?;
    let mode = mode.unwrap_or(StagingMode::All);
    let registry = ctx.registry.clone();
    let result = tokio::task::spawn_blocking(move || git::ship::preflight(&registry, id, mode))
        .await
        .map_err(|e| Value::String(format!("git_ship_preflight task panicked: {e}")))?;
    result
        .map(|p| ok_value(&p))
        .unwrap_or_else(|e| Err(err_value(&e)))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct StageCommitArgs {
    worker_id: String,
    ship_id: String,
    message: String,
    mode: StagingMode,
    final_step: bool,
}

pub async fn git_stage_commit(ctx: Ctx, args: Value) -> Result<Value, Value> {
    let StageCommitArgs {
        worker_id,
        ship_id,
        message,
        mode,
        final_step,
    } = parse_args(args)?;
    let sid = parse_ship_id(&ship_id);
    let sink = ctx.sink.clone();
    let id =
        parse_worker_id_or_settle(&sink, sid, &worker_id, "staging").map_err(|e| err_value(&e))?;
    let registry = ctx.registry.clone();
    let repo_locks = ctx.repo_locks.clone();

    emit_progress(&sink, sid, id, "staging", "running", None);

    let branch = match git::ship::worktree_info_for_worker(&registry, id) {
        Ok(info) => info.branch,
        Err(err) => {
            emit_progress(
                &sink,
                sid,
                id,
                "staging",
                "error",
                Some(err.message.clone()),
            );
            emit_settled(&sink, sid, id, None, None, None, Some(err.clone()));
            return Err(err_value(&err));
        }
    };

    let (seq_from, seq_to) = resolve_seq_range(&ctx.engine, &registry, id).await;
    let co_authored_by = crate::config::read_value(&ctx.paths, "shipCoAuthoredBy")
        .and_then(|v| v.as_str().map(str::to_string));

    let result = tokio::task::spawn_blocking(move || {
        git::ship::stage_and_commit(
            &registry,
            &repo_locks,
            id,
            &message,
            mode,
            seq_from,
            seq_to,
            co_authored_by.as_deref(),
        )
    })
    .await
    .map_err(|e| Value::String(format!("git_stage_commit task panicked: {e}")))?;

    match result {
        Ok(outcome) => {
            emit_progress(
                &sink,
                sid,
                id,
                "staging",
                "ok",
                Some(format!("{} File(s) Skipped", outcome.skipped.len())),
            );
            emit_progress(&sink, sid, id, "commit", "ok", Some(outcome.sha.clone()));
            sink.emit(SwarmEvent::CommitCreated(CommitCreatedPayload {
                worker_id: id,
                sha: outcome.sha.clone(),
                branch: branch.clone(),
                seq_from: outcome.seq_from,
                seq_to: outcome.seq_to,
            }));
            if final_step {
                emit_settled(&sink, sid, id, Some(outcome.sha.clone()), None, None, None);
            }
            ok_value(&outcome)
        }
        Err(err) => {
            emit_progress(&sink, sid, id, "commit", "error", Some(err.message.clone()));
            if err.kind != ShipErrorKind::NothingToCommit {
                emit_settled(&sink, sid, id, None, None, None, Some(err.clone()));
            }
            Err(err_value(&err))
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PushArgs {
    worker_id: String,
    ship_id: String,
    final_step: bool,
}

pub async fn git_push(ctx: Ctx, args: Value) -> Result<Value, Value> {
    let PushArgs {
        worker_id,
        ship_id,
        final_step,
    } = parse_args(args)?;
    let sid = parse_ship_id(&ship_id);
    let sink = ctx.sink.clone();
    let id =
        parse_worker_id_or_settle(&sink, sid, &worker_id, "push").map_err(|e| err_value(&e))?;
    let registry = ctx.registry.clone();
    let repo_locks = ctx.repo_locks.clone();

    emit_progress(&sink, sid, id, "push", "running", None);

    let seq_to = current_max_seq_for_engine(&ctx.engine).await;

    let registry_for_task = registry.clone();
    let result =
        tokio::task::spawn_blocking(move || git::ship::push(&registry_for_task, &repo_locks, id))
            .await
            .map_err(|e| Value::String(format!("git_push task panicked: {e}")))?;

    match result {
        Ok(outcome) => {
            if let Err(e) = registry.set_last_shipped(&id, seq_to, &outcome.sha) {
                tracing::warn!(worker_id = %id, error = %e, "failed to record last_shipped after a successful push");
            }
            emit_progress(
                &sink,
                sid,
                id,
                "push",
                "ok",
                Some(outcome.pushed_ref.clone()),
            );
            if final_step {
                emit_settled(
                    &sink,
                    sid,
                    id,
                    Some(outcome.sha.clone()),
                    Some(outcome.pushed_ref.clone()),
                    None,
                    None,
                );
            }
            ok_value(&outcome)
        }
        Err(err) => {
            emit_progress(&sink, sid, id, "push", "error", Some(err.message.clone()));
            emit_settled(&sink, sid, id, None, None, None, Some(err.clone()));
            Err(err_value(&err))
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CompareUrlArgs {
    worker_id: String,
    ship_id: String,
    commit_sha: String,
    pushed_ref: String,
    title: String,
    body: String,
}

pub async fn ship_compare_url(ctx: Ctx, args: Value) -> Result<Value, Value> {
    let CompareUrlArgs {
        worker_id,
        ship_id,
        commit_sha,
        pushed_ref,
        title,
        body,
    } = parse_args(args)?;
    let sid = parse_ship_id(&ship_id);
    let sink = ctx.sink.clone();
    let id =
        parse_worker_id_or_settle(&sink, sid, &worker_id, "compare").map_err(|e| err_value(&e))?;
    let registry = ctx.registry.clone();

    emit_progress(&sink, sid, id, "compare", "running", None);

    let result =
        tokio::task::spawn_blocking(move || git::ship::compare_url(&registry, id, &title, &body))
            .await
            .map_err(|e| Value::String(format!("ship_compare_url task panicked: {e}")))?;

    match result {
        Ok(url) => {
            emit_progress(&sink, sid, id, "compare", "ok", Some(url.clone()));
            emit_settled(
                &sink,
                sid,
                id,
                Some(commit_sha),
                Some(pushed_ref),
                Some(url.clone()),
                None,
            );
            ok_value(&url)
        }
        Err(err) => {
            emit_progress(
                &sink,
                sid,
                id,
                "compare",
                "error",
                Some(err.message.clone()),
            );
            emit_settled(&sink, sid, id, None, None, None, Some(err.clone()));
            Err(err_value(&err))
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ShipContextArgs {
    worker_id: String,
}

/// Read-only: the causal record for a worker's ship range. Resolves
/// `(seqFrom, seqTo]` via the exact same [`resolve_seq_range`] algorithm
/// `git_stage_commit` uses (`lastShippedSeq ?? worktree_created seq ..
/// current max`) — so a `ship_context` call made just before "Commit +
/// Push" describes the same range the resulting commit's `Swarm-Seq-Range`
/// trailer will (barring new events landing in the gap between preview
/// and commit, which is unavoidable and harmless: the trailer is always
/// the source of truth, this is a preview of it).
///
/// Runs on a [`EventLog::open_readonly`] connection inside `spawn_blocking`
/// — the identical pattern `commands::orchestration::events_since` already
/// uses for a read-only backfill query. Emits no events (a query, not a
/// mutation) — `RemotePolicy::Allowed` in the registry, same as every
/// other ship command (`git_ship_preflight` is the closest analog: also
/// read-only, also `Allowed`, and a remote client legitimately previewing
/// a ship it's about to trigger needs this exactly as much as it needs
/// the preflight).
pub async fn ship_context(ctx: Ctx, args: Value) -> Result<Value, Value> {
    let ShipContextArgs { worker_id } = parse_args(args)?;
    let id = parse_worker_id(&worker_id).map_err(|e| err_value(&e))?;
    let registry = ctx.registry.clone();

    let (seq_from, seq_to) = resolve_seq_range(&ctx.engine, &registry, id).await;

    let Some(db_path) = ctx.engine.db_path().map(std::path::Path::to_path_buf) else {
        return ok_value(&ShipContext::empty(id, seq_from, seq_to));
    };

    let context = tokio::task::spawn_blocking(move || -> Result<ShipContext, String> {
        let log = EventLog::open_readonly(&db_path).map_err(|e| e.to_string())?;
        let events = log
            .events_between(seq_from, seq_to, SHIP_CONTEXT_EVENT_LIMIT)
            .map_err(|e| e.to_string())?;
        Ok(git::build_ship_context(events, id, seq_from, seq_to))
    })
    .await
    .map_err(|e| Value::String(format!("ship_context task panicked: {e}")))?
    .map_err(Value::String)?;

    ok_value(&context)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::events::Provenance;

    /// DIRECTIVE: exercises the exact two-step composition
    /// `ship_context` performs — `EventLog::events_between` then
    /// `git::build_ship_context` — against a real (in-memory) `EventLog`,
    /// proving the seam between the data layer and the pure builder
    /// works end-to-end, not just each half in isolation (the data-layer
    /// half is covered in `orchestration::log`'s own tests; the builder
    /// half in `git::causal`'s). Goes around the full `Ctx`/registry
    /// wiring deliberately: `resolve_seq_range` and the worker-lookup
    /// plumbing above are already exercised by the ship command tests in
    /// `git::ship`, and standing up a fake `WorkerHandle` here would
    /// duplicate that coverage without adding anything this seam test
    /// doesn't already prove.
    #[test]
    fn test_ship_context_composition_seeded_log_excludes_other_worker() {
        let mut log = EventLog::open_in_memory().unwrap();
        let me = uuid::Uuid::new_v4();
        let other = uuid::Uuid::new_v4();

        log.append(
            1,
            1,
            "worktree_created",
            &serde_json::json!({ "workerId": me }).to_string(),
            &Provenance::default(),
        )
        .unwrap();
        log.append(
            2,
            2,
            "agent_tool_call",
            &serde_json::json!({
                "workerId": other, "turnId": "ot1", "toolUseId": "ou1",
                "name": "Read", "input": {}
            })
            .to_string(),
            &Provenance::default(),
        )
        .unwrap();
        log.append(
            3,
            3,
            "agent_tool_call",
            &serde_json::json!({
                "workerId": me, "turnId": "t1", "toolUseId": "u1",
                "name": "Bash", "input": { "command": "pnpm build" }
            })
            .to_string(),
            &Provenance::default(),
        )
        .unwrap();

        let events = log.events_between(0, 3, SHIP_CONTEXT_EVENT_LIMIT).unwrap();
        let context = git::build_ship_context(events, me, 0, 3);

        assert_eq!(context.turns.len(), 1);
        assert_eq!(context.turns[0].turn_id, "t1");
        assert_eq!(context.turns[0].tool_calls[0].name, "Bash");
        assert_eq!(
            context.turns[0].tool_calls[0].target.as_deref(),
            Some("pnpm build")
        );
    }

    #[test]
    fn test_ship_context_empty_range_has_no_turns() {
        let log = EventLog::open_in_memory().unwrap();
        let me = uuid::Uuid::new_v4();
        let events = log.events_between(5, 5, SHIP_CONTEXT_EVENT_LIMIT).unwrap();
        let context = git::build_ship_context(events, me, 5, 5);
        assert!(context.turns.is_empty());
        assert!(context.commits.is_empty());
    }
}
