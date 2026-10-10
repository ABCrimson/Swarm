//! Registry handlers for repo-root validation and the ship chain:
//! `git_ship_preflight`, `git_stage_commit`, `git_push`,
//! `ship_compare_url`, and the read-only causal record `ship_context`.
//!
//! The git layer blocks, so every git call runs inside
//! `tokio::task::spawn_blocking`; the handlers themselves only do
//! registry reads and event emission on the async thread. Ship errors
//! are [`ShipError`] objects, not strings (see its doc).
//!
//! # Receipts
//!
//! The mutating handlers report each step as a `ship_progress` event and
//! end a ship attempt with exactly one `ship_settled` receipt: on any
//! failure, or on success of the call the client marked `finalStep`
//! (`ship_compare_url` is always final). A `nothingToCommit` failure of
//! `git_stage_commit` is the one exception — it settles nothing,
//! because the client recovers from it by pushing commits that already
//! exist.
//!
//! # The seq range
//!
//! A commit's `Swarm-Seq-Range` trailer and `ship_context` cover
//! `(seqFrom, seqTo]`: from the worker's last shipped seq (or, before its
//! first ship, its `worktree_created` row) to the event log's current
//! maximum. `git_push` records the maximum it read before pushing as the
//! next `seqFrom`.

use std::path::{Path, PathBuf};

use serde::Deserialize;
use serde_json::Value;
use uuid::Uuid;

use super::{Ctx, err_value, ok_value, parse_args};
use crate::error::AppError;
use crate::events::{
    CommitCreatedPayload, EventSink, ShipProgressPayload, ShipSettledPayload, SwarmEvent,
};
use crate::git::{self, CommitRequest, ShipContext, ShipError, ShipErrorKind, StagingMode};
use crate::orchestration::{EventLog, OrchestrationEngine};
use crate::worker::registry::WorkerRegistry;

/// Cap on rows fetched per `ship_context` call — deliberately generous
/// (well above `commands::orchestration::events_since`'s IPC-facing
/// `PAGE_LIMIT` of 5000): each tool use costs three rows (`agent_block` +
/// `agent_tool_call` + `agent_tool_result`) plus the turn's text blocks,
/// and nothing bounds tool uses per turn tightly — the Claude Code
/// adapter's `--max-turns 50` caps round-trips, each of which can issue
/// parallel calls, and the Codex adapter sets no cap — so 200 turns' worth
/// (`git::causal::MAX_TURNS`) can pass tens of thousands of rows. Hitting
/// this cap is reported as `truncated`, and `git::causal::build_ship_context`
/// caps the returned turn count regardless.
const SHIP_CONTEXT_EVENT_LIMIT: u32 = 50_000;

/// The config key holding the `Co-Authored-By` identity for ship
/// commits (see `docs/api.md`).
const CO_AUTHOR_CONFIG_KEY: &str = "shipCoAuthoredBy";

fn parse_worker_id(raw: &str) -> Result<Uuid, ShipError> {
    Uuid::parse_str(raw).map_err(|_| ShipError {
        kind: ShipErrorKind::WorkerNotFound,
        message: format!("`{raw}` Is Not A Valid Worker ID."),
        remedy: None,
    })
}

/// A ship id is the client's correlation key for every event of the
/// attempt, so a malformed one is rejected outright — nothing could
/// ever match its receipts.
fn parse_ship_id(raw: &str) -> Result<Uuid, ShipError> {
    Uuid::parse_str(raw).map_err(|_| ShipError {
        kind: ShipErrorKind::Unknown,
        message: format!("`{raw}` Is Not A Valid Ship ID."),
        remedy: None,
    })
}

/// Emits one ship attempt's `ship_progress` events and `ship_settled`
/// receipt.
struct ShipReporter<'a> {
    sink: &'a EventSink,
    ship_id: Uuid,
    worker_id: Uuid,
}

impl ShipReporter<'_> {
    fn progress(&self, step: &str, status: &str, detail: Option<String>) {
        self.sink
            .emit(SwarmEvent::ShipProgress(ShipProgressPayload {
                ship_id: self.ship_id,
                worker_id: self.worker_id,
                step: step.to_owned(),
                status: status.to_owned(),
                detail,
            }));
    }

    fn settle_ok(
        &self,
        commit_sha: Option<String>,
        pushed_ref: Option<String>,
        pr_url: Option<String>,
    ) {
        self.settle(commit_sha, pushed_ref, pr_url, None);
    }

    fn settle(
        &self,
        commit_sha: Option<String>,
        pushed_ref: Option<String>,
        pr_url: Option<String>,
        error: Option<ShipError>,
    ) {
        let status = if error.is_some() { "error" } else { "ok" };
        self.sink.emit(SwarmEvent::ShipSettled(ShipSettledPayload {
            ship_id: self.ship_id,
            worker_id: self.worker_id,
            commit_sha,
            pushed_ref,
            pr_url,
            status: status.to_owned(),
            error,
        }));
    }

    /// Reports `error` as `step`'s failure, settles the attempt with it,
    /// and returns it as the handler's error value.
    fn fail(&self, step: &str, error: ShipError) -> Value {
        self.progress(step, "error", Some(error.message.clone()));
        let value = err_value(&error);
        self.settle(None, None, None, Some(error));
        value
    }
}

/// Parses the ship and worker ids of a mutating call. An invalid worker
/// id is still reported and settled (under a nil worker id), since the
/// ship id is valid.
fn parse_ids(
    sink: &EventSink,
    ship_id: &str,
    worker_id: &str,
    step: &str,
) -> Result<(Uuid, Uuid), Value> {
    let ship_id = parse_ship_id(ship_id).map_err(|e| err_value(&e))?;
    let worker_id = parse_worker_id(worker_id).map_err(|error| {
        ShipReporter {
            sink,
            ship_id,
            worker_id: Uuid::nil(),
        }
        .fail(step, error)
    })?;
    Ok((ship_id, worker_id))
}

/// `(seq_from, seq_to)` for `worker_id` read from `log`: `seq_from` is
/// `last_shipped`, or else the worker's `worktree_created` seq (`0` if
/// none is logged); `seq_to` is the log's current maximum.
fn seq_range_from_log(
    log: &EventLog,
    worker_id: Uuid,
    last_shipped: Option<u64>,
) -> Result<(u64, u64), AppError> {
    let seq_to = log.max_seq()?;
    let seq_from = match last_shipped {
        Some(seq) => seq,
        None => log
            .find_first_for_worker("worktree_created", &worker_id.to_string())?
            .unwrap_or(0),
    };
    Ok((seq_from, seq_to))
}

/// Resolves the worker's ship range (see the module doc) on a blocking
/// thread. An engine without a database (an in-memory test engine) has
/// no range: `(0, 0)`, which the commit trailer treats as unknown.
async fn resolve_seq_range(
    engine: &OrchestrationEngine,
    registry: &WorkerRegistry,
    worker_id: Uuid,
) -> Result<(u64, u64), AppError> {
    let last_shipped = git::ship::worktree_info_for_worker(registry, worker_id)
        .ok()
        .and_then(|info| info.last_shipped_seq);
    let Some(db_path) = engine.db_path().map(Path::to_path_buf) else {
        return Ok((0, 0));
    };
    tokio::task::spawn_blocking(move || {
        seq_range_from_log(&EventLog::open_readonly(&db_path)?, worker_id, last_shipped)
    })
    .await
    .map_err(|e| AppError::EventLog(format!("seq range task failed: {e}")))?
}

/// The event log's current maximum seq, read on a blocking thread.
async fn current_max_seq(engine: &OrchestrationEngine) -> Result<u64, AppError> {
    let Some(db_path) = engine.db_path().map(Path::to_path_buf) else {
        return Ok(0);
    };
    tokio::task::spawn_blocking(move || EventLog::open_readonly(&db_path)?.max_seq())
        .await
        .map_err(|e| AppError::EventLog(format!("max seq task failed: {e}")))?
}

fn task_panicked(command: &str, error: &tokio::task::JoinError) -> Value {
    Value::String(format!("{command} task panicked: {error}"))
}

#[derive(Deserialize)]
struct PathArgs {
    path: String,
}

/// `validate_repo_root { path }` → the canonical toplevel path of the
/// repository containing `path`. Errors are strings (`AppError`
/// display): not inside a repository, `git` unavailable, or a timeout.
pub async fn validate_repo_root(_ctx: Ctx, args: Value) -> Result<Value, Value> {
    let PathArgs { path } = parse_args(args)?;
    let toplevel =
        tokio::task::spawn_blocking(move || git::repo::discover_toplevel(Path::new(&path)))
            .await
            .map_err(|e| task_panicked("validate_repo_root", &e))?
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

/// `git_ship_preflight { workerId, mode? }` → `ShipPreflight` for
/// `mode` (default `"all"`). Read-only; emits no events. Errors are
/// `ShipError` objects.
pub async fn git_ship_preflight(ctx: Ctx, args: Value) -> Result<Value, Value> {
    let PreflightArgs { worker_id, mode } = parse_args(args)?;
    let id = parse_worker_id(&worker_id).map_err(|e| err_value(&e))?;
    let mode = mode.unwrap_or(StagingMode::All);
    let registry = ctx.registry.clone();
    tokio::task::spawn_blocking(move || git::ship::preflight(&registry, id, mode))
        .await
        .map_err(|e| task_panicked("git_ship_preflight", &e))?
        .map_err(|e| err_value(&e))
        .and_then(|preflight| ok_value(&preflight))
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

/// `git_stage_commit { workerId, shipId, message, mode, finalStep }` →
/// `CommitOutcome`. Stages per `mode` (deny list enforced), commits with
/// the `Swarm-Seq-Range` and configured `Co-Authored-By` trailers, and
/// emits `commit_created`. Errors are `ShipError` objects.
pub async fn git_stage_commit(ctx: Ctx, args: Value) -> Result<Value, Value> {
    let StageCommitArgs {
        worker_id,
        ship_id,
        message,
        mode,
        final_step,
    } = parse_args(args)?;
    let sink = &ctx.sink;
    let (ship_id, id) = parse_ids(sink, &ship_id, &worker_id, "staging")?;
    let reporter = ShipReporter {
        sink,
        ship_id,
        worker_id: id,
    };
    reporter.progress("staging", "running", None);

    let branch = match git::ship::worktree_info_for_worker(&ctx.registry, id) {
        Ok(info) => info.branch,
        Err(error) => return Err(reporter.fail("staging", error)),
    };

    // An unreadable log must not block shipping: the commit goes ahead
    // with the trailer omitted (`0..0` is "unknown").
    let (seq_from, seq_to) = resolve_seq_range(&ctx.engine, &ctx.registry, id)
        .await
        .unwrap_or_else(|error| {
            tracing::warn!(worker_id = %id, %error, "ship: seq range unavailable; committing without a Swarm-Seq-Range trailer");
            (0, 0)
        });

    let registry = ctx.registry.clone();
    let repo_locks = ctx.repo_locks.clone();
    let paths = ctx.paths.clone();
    let result = tokio::task::spawn_blocking(move || {
        let request = CommitRequest {
            message,
            mode,
            seq_from,
            seq_to,
            co_authored_by: crate::config::read_value(&paths, CO_AUTHOR_CONFIG_KEY)
                .and_then(|value| value.as_str().map(str::to_owned)),
        };
        git::ship::stage_and_commit(&registry, &repo_locks, id, &request)
    })
    .await
    .map_err(|e| task_panicked("git_stage_commit", &e))?;

    match result {
        Ok(outcome) => {
            reporter.progress(
                "staging",
                "ok",
                Some(format!("{} File(s) Skipped", outcome.skipped.len())),
            );
            reporter.progress("commit", "ok", Some(outcome.sha.clone()));
            sink.emit(SwarmEvent::CommitCreated(CommitCreatedPayload {
                worker_id: id,
                sha: outcome.sha.clone(),
                branch,
                seq_from: outcome.seq_from,
                seq_to: outcome.seq_to,
            }));
            if final_step {
                reporter.settle_ok(Some(outcome.sha.clone()), None, None);
            }
            ok_value(&outcome)
        }
        Err(error) if error.kind == ShipErrorKind::NothingToCommit => {
            reporter.progress("commit", "error", Some(error.message.clone()));
            Err(err_value(&error))
        }
        Err(error) => Err(reporter.fail("commit", error)),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PushArgs {
    worker_id: String,
    ship_id: String,
    final_step: bool,
}

/// `git_push { workerId, shipId, finalStep }` → `PushOutcome`. Pushes
/// the branch checked out now (never forced) and records the ship
/// range's end as the worker's last shipped seq. Errors are `ShipError`
/// objects.
pub async fn git_push(ctx: Ctx, args: Value) -> Result<Value, Value> {
    let PushArgs {
        worker_id,
        ship_id,
        final_step,
    } = parse_args(args)?;
    let sink = &ctx.sink;
    let (ship_id, id) = parse_ids(sink, &ship_id, &worker_id, "push")?;
    let reporter = ShipReporter {
        sink,
        ship_id,
        worker_id: id,
    };
    reporter.progress("push", "running", None);

    // Read before pushing: everything up to here is what this push ships.
    let seq_to = current_max_seq(&ctx.engine).await;

    let registry = ctx.registry.clone();
    let repo_locks = ctx.repo_locks.clone();
    let result = tokio::task::spawn_blocking(move || git::ship::push(&registry, &repo_locks, id))
        .await
        .map_err(|e| task_panicked("git_push", &e))?;

    match result {
        Ok(outcome) => {
            // Record only a seq that was actually read: a stale `0` would
            // widen the next ship's range to the whole log.
            match seq_to {
                Ok(seq_to) => {
                    if let Err(error) = ctx.registry.set_last_shipped(&id, seq_to, &outcome.sha) {
                        tracing::warn!(worker_id = %id, %error, "ship: failed to record last_shipped after a successful push");
                    }
                }
                Err(error) => {
                    tracing::warn!(worker_id = %id, %error, "ship: event log unreadable; last_shipped left unchanged after a successful push");
                }
            }
            reporter.progress("push", "ok", Some(outcome.pushed_ref.clone()));
            if final_step {
                reporter.settle_ok(
                    Some(outcome.sha.clone()),
                    Some(outcome.pushed_ref.clone()),
                    None,
                );
            }
            ok_value(&outcome)
        }
        Err(error) => Err(reporter.fail("push", error)),
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

/// `ship_compare_url { workerId, shipId, commitSha, pushedRef, title,
/// body }` → the prefilled GitHub compare URL. Always the ship
/// attempt's final step: it settles with `commitSha`/`pushedRef`/the
/// URL. Errors are `ShipError` objects.
pub async fn ship_compare_url(ctx: Ctx, args: Value) -> Result<Value, Value> {
    let CompareUrlArgs {
        worker_id,
        ship_id,
        commit_sha,
        pushed_ref,
        title,
        body,
    } = parse_args(args)?;
    let sink = &ctx.sink;
    let (ship_id, id) = parse_ids(sink, &ship_id, &worker_id, "compare")?;
    let reporter = ShipReporter {
        sink,
        ship_id,
        worker_id: id,
    };
    reporter.progress("compare", "running", None);

    let registry = ctx.registry.clone();
    let result =
        tokio::task::spawn_blocking(move || git::ship::compare_url(&registry, id, &title, &body))
            .await
            .map_err(|e| task_panicked("ship_compare_url", &e))?;

    match result {
        Ok(url) => {
            reporter.progress("compare", "ok", Some(url.clone()));
            reporter.settle_ok(Some(commit_sha), Some(pushed_ref), Some(url.clone()));
            ok_value(&url)
        }
        Err(error) => Err(reporter.fail("compare", error)),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ShipContextArgs {
    worker_id: String,
}

/// `ship_context { workerId }` → the `ShipContext` causal record for the
/// worker's pending ship range. Read-only; emits no events.
///
/// Resolves `(seqFrom, seqTo]` with the same algorithm
/// `git_stage_commit` uses, so a preview taken just before "Commit +
/// Push" describes the range the commit's `Swarm-Seq-Range` trailer
/// will (events landing in between are unavoidable and harmless — the
/// trailer is the source of truth). Fetches with
/// [`EventLog::events_for_worker_between`], which filters to this worker
/// and the relevant types in SQL and keeps the newest rows when capped,
/// and threads its truncation flag into
/// [`ShipContext::events_truncated`]. Errors are strings: an unreadable
/// event log is reported, never papered over with an empty record.
pub async fn ship_context(ctx: Ctx, args: Value) -> Result<Value, Value> {
    let ShipContextArgs { worker_id } = parse_args(args)?;
    let id = parse_worker_id(&worker_id).map_err(|e| err_value(&e))?;

    let (seq_from, seq_to) = resolve_seq_range(&ctx.engine, &ctx.registry, id)
        .await
        .map_err(|e| Value::String(e.to_string()))?;
    let Some(db_path) = ctx.engine.db_path().map(PathBuf::from) else {
        return ok_value(&ShipContext::empty(id, seq_from, seq_to));
    };

    let context = tokio::task::spawn_blocking(move || -> Result<ShipContext, AppError> {
        let log = EventLog::open_readonly(&db_path)?;
        let (events, truncated) = log.events_for_worker_between(
            git::causal::RELEVANT_EVENT_TYPES,
            &id.to_string(),
            seq_from,
            seq_to,
            SHIP_CONTEXT_EVENT_LIMIT,
        )?;
        Ok(git::build_ship_context(
            events, id, seq_from, seq_to, truncated,
        ))
    })
    .await
    .map_err(|e| task_panicked("ship_context", &e))?
    .map_err(|e| Value::String(e.to_string()))?;

    ok_value(&context)
}

#[cfg(test)]
mod tests {
    use std::sync::mpsc::Receiver;

    use super::*;
    use crate::commands::test_support::test_ctx;
    use crate::events::Provenance;
    use crate::git::test_support::{TempRepo, git_in, write_file};
    use crate::orchestration::DomainEvent;
    use crate::worker::handle::{WorkerHandle, WorkerState};

    fn append(log: &mut EventLog, seq: u64, event_type: &str, payload: &Value) {
        log.append(
            seq,
            seq.cast_signed(),
            event_type,
            &payload.to_string(),
            &Provenance::default(),
        )
        .unwrap();
    }

    fn append_agent_tool_call(log: &mut EventLog, seq: u64, worker_id: Uuid, command: &str) {
        append(
            log,
            seq,
            "agent_tool_call",
            &serde_json::json!({
                "workerId": worker_id, "turnId": format!("t{seq}"), "toolUseId": format!("u{seq}"),
                "name": "Bash", "input": { "command": command }
            }),
        );
    }

    #[test]
    fn test_parse_ship_id_rejects_a_malformed_id() {
        let err = parse_ship_id("not-a-uuid").unwrap_err();
        assert!(
            err.message.contains("Not A Valid Ship ID"),
            "{}",
            err.message
        );
        let id = Uuid::new_v4();
        assert_eq!(parse_ship_id(&id.to_string()).unwrap(), id);
    }

    #[test]
    fn test_parse_worker_id_rejects_a_malformed_id() {
        let err = parse_worker_id("nope").unwrap_err();
        assert_eq!(err.kind, ShipErrorKind::WorkerNotFound);
    }

    /// Before the first ship the range starts at `worktree_created`;
    /// after it, at the recorded last shipped seq.
    #[test]
    fn test_seq_range_from_log() {
        let mut log = EventLog::open_in_memory().unwrap();
        let me = Uuid::new_v4();
        append(
            &mut log,
            1,
            "worker_spawned",
            &serde_json::json!({ "workerId": me }),
        );
        append(
            &mut log,
            2,
            "worktree_created",
            &serde_json::json!({ "workerId": me }),
        );
        append_agent_tool_call(&mut log, 3, me, "pnpm build");

        assert_eq!(seq_range_from_log(&log, me, None).unwrap(), (2, 3));
        assert_eq!(seq_range_from_log(&log, me, Some(3)).unwrap(), (3, 3));
        assert_eq!(
            seq_range_from_log(&log, Uuid::new_v4(), None).unwrap(),
            (0, 3),
            "no worktree_created row: the range starts at the log's beginning"
        );
    }

    /// DIRECTIVE: exercises the exact two-step composition `ship_context`
    /// performs — `EventLog::events_for_worker_between` then
    /// `git::build_ship_context` — against a real (in-memory) `EventLog`,
    /// proving the seam between the data layer and the pure builder works
    /// end to end, not just each half in isolation (the data-layer half is
    /// covered in `orchestration::log`'s own tests, the builder half in
    /// `git::causal`'s).
    #[test]
    fn test_ship_context_composition_seeded_log_excludes_other_worker() {
        let mut log = EventLog::open_in_memory().unwrap();
        let me = Uuid::new_v4();
        let other = Uuid::new_v4();

        append(
            &mut log,
            1,
            "worktree_created",
            &serde_json::json!({ "workerId": me }),
        );
        append_agent_tool_call(&mut log, 2, other, "npm test");
        append_agent_tool_call(&mut log, 3, me, "pnpm build");

        let (events, truncated) = log
            .events_for_worker_between(
                git::causal::RELEVANT_EVENT_TYPES,
                &me.to_string(),
                0,
                3,
                SHIP_CONTEXT_EVENT_LIMIT,
            )
            .unwrap();
        let context = git::build_ship_context(events, me, 0, 3, truncated);

        assert!(!truncated);
        assert_eq!(context.turns.len(), 1);
        assert_eq!(context.turns[0].turn_id, "t3");
        assert_eq!(context.turns[0].tool_calls[0].name, "Bash");
        assert_eq!(
            context.turns[0].tool_calls[0].target.as_deref(),
            Some("pnpm build")
        );
    }

    #[test]
    fn test_ship_context_empty_range_has_no_turns() {
        let log = EventLog::open_in_memory().unwrap();
        let me = Uuid::new_v4();
        let (events, truncated) = log
            .events_for_worker_between(
                git::causal::RELEVANT_EVENT_TYPES,
                &me.to_string(),
                5,
                5,
                SHIP_CONTEXT_EVENT_LIMIT,
            )
            .unwrap();
        let context = git::build_ship_context(events, me, 5, 5, truncated);
        assert!(context.turns.is_empty());
        assert!(context.commits.is_empty());
        assert!(!context.events_truncated);
    }

    /// DIRECTIVE (review FIX-1): a range where OTHER workers' rows vastly
    /// outnumber the shipping worker's own — enough that a range-wide cap
    /// would fill on cross-worker rows before reaching this worker's
    /// newest turn. `events_for_worker_between` filters to the worker in
    /// SQL before capping, so its one turn survives, untruncated.
    #[test]
    fn test_ship_context_worker_scoping_survives_heavy_cross_worker_noise() {
        let mut log = EventLog::open_in_memory().unwrap();
        let me = Uuid::new_v4();
        let other = Uuid::new_v4();

        for seq in 1..=20 {
            append_agent_tool_call(&mut log, seq, other, "noise");
        }
        append_agent_tool_call(&mut log, 21, me, "pnpm build");

        let (events, truncated) = log
            .events_for_worker_between(git::causal::RELEVANT_EVENT_TYPES, &me.to_string(), 0, 21, 3)
            .unwrap();
        let context = git::build_ship_context(events, me, 0, 21, truncated);

        assert!(
            !truncated,
            "only one matching row for `me` — never truncated"
        );
        assert_eq!(context.turns.len(), 1);
        assert_eq!(
            context.turns[0].tool_calls[0].target.as_deref(),
            Some("pnpm build")
        );
    }

    // ── Ship handlers: receipts and last_shipped ─────────────────────────

    /// Registers a worker on `worktree` (a linked worktree of `repo` on
    /// `branch`), forked from `repo`'s current `HEAD`.
    fn register_worker(ctx: &Ctx, repo: &TempRepo, worktree: &Path, branch: &str) -> Uuid {
        let id = Uuid::new_v4();
        ctx.registry
            .spawn_worker(WorkerHandle {
                id,
                state: WorkerState::Running,
                name: "ship".to_owned(),
                pid: None,
                started_at: 0,
                pty_writer: None,
                child: None,
                worktree_path: Some(worktree.display().to_string()),
                repo_root: Some(repo.root().display().to_string()),
                branch: Some(branch.to_owned()),
                base_commit: Some(git::repo::head_sha(repo.root()).unwrap()),
                last_shipped_seq: None,
                last_shipped_commit: None,
            })
            .unwrap();
        id
    }

    /// Every `ship_progress` / `ship_settled` event emitted since the
    /// last call.
    async fn ship_events(ctx: &Ctx, events: &Receiver<DomainEvent>) -> Vec<SwarmEvent> {
        ctx.engine.flush().await.unwrap();
        events
            .try_iter()
            .map(|envelope| envelope.event)
            .filter(|event| {
                matches!(
                    event,
                    SwarmEvent::ShipProgress(_) | SwarmEvent::ShipSettled(_)
                )
            })
            .collect()
    }

    fn receipts(events: &[SwarmEvent]) -> Vec<&ShipSettledPayload> {
        events
            .iter()
            .filter_map(|event| match event {
                SwarmEvent::ShipSettled(payload) => Some(payload),
                _ => None,
            })
            .collect()
    }

    fn has_progress(events: &[SwarmEvent], step: &str, status: &str) -> bool {
        events.iter().any(|event| {
            matches!(event, SwarmEvent::ShipProgress(p) if p.step == step && p.status == status)
        })
    }

    /// A successful push settles exactly once when it is the final step
    /// and not at all otherwise, and records the pushed sha as the
    /// worker's last shipped commit.
    #[tokio::test]
    async fn test_git_push_settles_once_only_on_the_final_step_and_records_last_shipped() {
        let (ctx, _dir, events) = test_ctx();
        let repo = TempRepo::new("cmd-push");
        repo.add_bare_origin();
        let branch = "swarm/cmd-push-abcd1234";
        let worktree = repo.add_worktree("wt", branch);
        let id = register_worker(&ctx, &repo, &worktree, branch);
        write_file(&worktree, "a.txt", "a");
        git_in(&worktree, &["add", "a.txt"]);
        git_in(&worktree, &["commit", "-m", "a"]);
        let sha = git::repo::head_sha(&worktree).unwrap();

        for final_step in [false, true] {
            let ship_id = Uuid::new_v4();
            git_push(
                ctx.clone(),
                serde_json::json!({
                    "workerId": id.to_string(), "shipId": ship_id.to_string(), "finalStep": final_step
                }),
            )
            .await
            .unwrap();

            let emitted = ship_events(&ctx, &events).await;
            assert!(has_progress(&emitted, "push", "ok"), "{final_step}");
            let settled = receipts(&emitted);
            if final_step {
                assert_eq!(settled.len(), 1, "exactly one receipt per attempt");
                assert_eq!(settled[0].ship_id, ship_id);
                assert_eq!(settled[0].status, "ok");
                assert_eq!(settled[0].commit_sha.as_deref(), Some(sha.as_str()));
                assert_eq!(
                    settled[0].pushed_ref.as_deref(),
                    Some("origin/swarm/cmd-push-abcd1234")
                );
            } else {
                assert!(settled.is_empty(), "a non-final push must not settle");
            }
        }

        let info = ctx.registry.get_worker(&id).unwrap();
        assert_eq!(info.last_shipped_commit.as_deref(), Some(sha.as_str()));
        // The in-memory engine has no database, so the max seq read is 0.
        assert_eq!(info.last_shipped_seq, Some(0));
    }

    /// A failed step settles the attempt with its error even when the
    /// client did not mark it final.
    #[tokio::test]
    async fn test_git_push_failure_settles_once_with_the_error() {
        let (ctx, _dir, events) = test_ctx();
        let ship_id = Uuid::new_v4();
        let err = git_push(
            ctx.clone(),
            serde_json::json!({
                "workerId": Uuid::new_v4().to_string(), "shipId": ship_id.to_string(), "finalStep": false
            }),
        )
        .await
        .unwrap_err();
        assert_eq!(err["kind"], "workerNotFound");

        let emitted = ship_events(&ctx, &events).await;
        assert!(has_progress(&emitted, "push", "error"));
        let settled = receipts(&emitted);
        assert_eq!(settled.len(), 1, "exactly one receipt per attempt");
        assert_eq!(settled[0].ship_id, ship_id);
        assert_eq!(settled[0].status, "error");
        assert_eq!(
            settled[0].error.as_ref().map(|error| error.kind),
            Some(ShipErrorKind::WorkerNotFound)
        );
    }

    /// `nothingToCommit` is the one failure that settles nothing: the
    /// client recovers by pushing commits that already exist.
    #[tokio::test]
    async fn test_git_stage_commit_nothing_to_commit_settles_nothing() {
        let (ctx, _dir, events) = test_ctx();
        let repo = TempRepo::new("cmd-nothing");
        let branch = "swarm/cmd-nothing-abcd1234";
        let worktree = repo.add_worktree("wt", branch);
        let id = register_worker(&ctx, &repo, &worktree, branch);

        let err = git_stage_commit(
            ctx.clone(),
            serde_json::json!({
                "workerId": id.to_string(), "shipId": Uuid::new_v4().to_string(),
                "message": "feat: nothing", "mode": "all", "finalStep": true
            }),
        )
        .await
        .unwrap_err();
        assert_eq!(err["kind"], "nothingToCommit");

        let emitted = ship_events(&ctx, &events).await;
        assert!(has_progress(&emitted, "commit", "error"));
        assert!(receipts(&emitted).is_empty(), "{emitted:?}");
    }
}
