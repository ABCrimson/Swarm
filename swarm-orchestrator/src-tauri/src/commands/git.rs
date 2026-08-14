//! Git repo-root validation and the ship chain's Tauri IPC commands.
//!
//! `validate_repo_root` is a thin wrapper over
//! `swarm_core::git::repo::discover_toplevel` — lets the frontend's
//! Project Root picker (Workers page) confirm a chosen directory is
//! actually inside a git repository *before* persisting it as the
//! `default_repo_root` config value, instead of silently accepting
//! anything and letting every subsequent isolated spawn hard-fail with
//! a raw git error.
//!
//! The ship commands (`git_ship_preflight`, `git_stage_commit`,
//! `git_push`, `ship_compare_url`) are thin `#[tauri::command]`
//! wrappers over `swarm_core::git::ship` — all git mutation logic
//! lives there; this module's job is IPC plumbing: UUID parsing,
//! `spawn_blocking`, `ship_progress`/`ship_settled`/`commit_created`
//! event emission, and resolving the `Swarm-Seq-Range` trailer's
//! `seqFrom`/`seqTo` from the event log (see [`resolve_seq_range`]) —
//! swarm-core's ship module has no event-log access of its own (it
//! stays as git-plumbing-only as the rest of `swarm-core::git`); the
//! actual per-repo `RepoLocks::run_serialized` wrapping for the
//! mutating git calls happens *inside*
//! `swarm_core::git::ship::stage_and_commit`/`push` themselves, one
//! level down, matching how `worker::lifecycle` already does it for
//! worktree creation/removal.
//!
//! # B2: `git_push` never requires a fresh `stage_and_commit` result
//!
//! `git_push` takes no `commitSha` from the caller — it resolves
//! `HEAD` itself (see `swarm_core::git::ship::push`'s doc). This is
//! what lets the frontend push a worker's *already-committed, unpushed*
//! work (e.g. an earlier "Commit Only") straight from "Commit + Push"
//! without re-staging anything: `git_stage_commit` returning
//! `nothingToCommit` is not automatically terminal (see below) —
//! `useShip.ts` checks `ShipPreflight.ahead` and, when positive, skips
//! straight to `git_push`.

use tauri::AppHandle;
use uuid::Uuid;

use swarm_core::events::{
    CommitCreatedPayload, EventSink, ShipProgressPayload, ShipSettledPayload, SwarmEvent,
};
use swarm_core::git::{self, RepoLocks, ShipError, ShipErrorKind, StagingMode};
use swarm_core::orchestration::{EventLog, OrchestrationEngine};
use swarm_core::worker::registry::WorkerRegistry;

/// Validates that `path` is inside a git repository, returning its
/// canonical toplevel absolute path on success.
///
/// # Arguments
///
/// * `path` - Candidate directory to validate (e.g. from a directory picker)
///
/// # Returns
///
/// The repo's toplevel absolute path (may differ from `path` if
/// `path` was a subdirectory of the repo).
///
/// # Errors
///
/// Returns a `String` error if `path` is not inside a git repository,
/// `git` could not be spawned, or the operation timed out.
#[tauri::command]
#[tracing::instrument]
pub async fn validate_repo_root(path: String) -> Result<String, String> {
    tokio::task::spawn_blocking(move || git::repo::discover_toplevel(std::path::Path::new(&path)))
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "validate_repo_root task panicked");
            e.to_string()
        })?
        .map(|toplevel| toplevel.display().to_string())
        .map_err(|e| {
            tracing::debug!(error = %e, "repo root validation failed");
            e.to_string()
        })
}

// ── Ship chain ───────────────────────────────────────────────────────

fn parse_worker_id(raw: &str) -> Result<Uuid, ShipError> {
    Uuid::parse_str(raw).map_err(|_| ShipError {
        kind: ShipErrorKind::WorkerNotFound,
        message: format!("`{raw}` Is Not A Valid Worker ID."),
        remedy: None,
    })
}

fn parse_ship_id(raw: &str) -> Uuid {
    // A malformed shipId is a frontend bug, not a ship failure worth
    // surfacing as a ShipError — fall back to a fresh id so event
    // correlation still degrades gracefully (progress rows just won't
    // match up for that one malformed call) rather than aborting the
    // whole ship attempt over a correlation id.
    Uuid::parse_str(raw).unwrap_or_else(|_| Uuid::new_v4())
}

/// Parses `raw` as a worker id, and — on failure — emits `ship_progress`
/// (`step`, `"error"`) + the terminal `ship_settled` receipt *before*
/// returning `Err`. Without this, a caller that already armed a
/// `waitFor("ship_settled", shipId)` listener (as `useShip.ts` does
/// immediately before calling `git_push`/`ship_compare_url`) would be
/// left holding a promise that only resolves via its own 30s timeout —
/// this early-return path is exactly as "terminal" as any other
/// failure and must say so immediately. `workerId` in the emitted
/// payloads is `Uuid::nil()` in this one case (there is no valid
/// worker id to key them under); `waitFor`'s predicate only checks
/// `shipId`, so this still unblocks the correct listener.
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

/// Indexed lookup for the `seq` of `worker_id`'s `worktree_created`
/// event — the fallback `seqFrom` source when a worker has never
/// shipped before (`last_shipped_seq` is `None`). See the module doc
/// and `swarm_core::git::ship`'s doc for why this can't be a
/// synchronous field on `WorkerHandle`: the single-writer engine
/// assigns `seq` to `worktree_created` asynchronously, after
/// `do_spawn_worker`'s `emit()` call already returned. Backed by
/// `EventLog::find_first_for_worker`, which uses the
/// `idx_events_type_seq` index to narrow to `worktree_created` rows
/// before filtering by `workerId` — no full-log scan.
fn find_worktree_created_seq(db_path: &std::path::Path, worker_id: &str) -> Option<u64> {
    EventLog::open(db_path)
        .ok()?
        .find_first_for_worker("worktree_created", worker_id)
        .ok()?
}

fn current_max_seq(db_path: &std::path::Path) -> u64 {
    EventLog::open(db_path)
        .and_then(|l| l.max_seq())
        .unwrap_or(0)
}

/// Resolves `(seqFrom, seqTo)` for the `Swarm-Seq-Range` trailer:
/// `seqFrom` is the worker's `last_shipped_seq` if it has shipped
/// before, else its `worktree_created` seq (an indexed lookup — see
/// [`find_worktree_created_seq`]), else `0`. `seqTo` is the log's
/// current max seq at the moment of staging (a snapshot taken
/// *before* the commit — the resulting `commit_created` event's own
/// seq is therefore always `> seqTo`, correctly excluding "the record
/// of shipping" from the range it describes).
///
/// **Phase 1 scope note:** `last_shipped_seq`/`last_shipped_commit`
/// live only on the in-memory `WorkerHandle` (never persisted to
/// disk), so a restart of the app loses that bookkeeping — the very
/// next ship after a restart falls back to the (now indexed, cheap)
/// `worktree_created` scan instead, which re-covers the *entire*
/// worktree lifetime in the new commit's `Swarm-Seq-Range` trailer
/// rather than just the range since the last real ship. This is
/// harmless: the trailer is provenance metadata for a future causal
/// query, not something Phase 1 itself reads back. Durable
/// `last_shipped_seq` persistence is deferred to the provenance phase.
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

/// Computes the ship preflight for `worker_id`, evaluated for `mode`
/// (defaults to `"all"` when omitted — the app default, and what the
/// very first preflight of a session is always computed for before
/// the user has picked anything): branch/remote/tracking state,
/// working-tree status, the deny-list preview, and the `canShip`/
/// `blockers` verdict. Read-only — emits no events.
///
/// # Errors
///
/// [`ShipError`] with kind `workerNotFound`/`noWorktree` if `worker_id`
/// doesn't resolve to an isolated worker.
#[tauri::command]
#[tracing::instrument(skip(registry))]
pub async fn git_ship_preflight(
    registry: tauri::State<'_, WorkerRegistry>,
    worker_id: String,
    mode: Option<StagingMode>,
) -> Result<git::ShipPreflight, ShipError> {
    let id = parse_worker_id(&worker_id)?;
    let mode = mode.unwrap_or(StagingMode::All);
    let registry = registry.inner().clone();
    tokio::task::spawn_blocking(move || git::ship::preflight(&registry, id, mode))
        .await
        .map_err(|e| ShipError {
            kind: ShipErrorKind::Unknown,
            message: format!("git_ship_preflight task panicked: {e}"),
            remedy: None,
        })?
}

/// Stages (per `mode`) and commits `worker_id`'s worktree, appending
/// the `Swarm-Seq-Range`/`Co-Authored-By` trailers, then emits
/// `ship_progress` (`"staging"` then `"commit"`), `commit_created` on
/// success, and the terminal `ship_settled` receipt — **except** when
/// the failure is `nothingToCommit`, which is not automatically
/// terminal (see the module doc's B2 note): the frontend may recover
/// by pushing an already-committed, unpushed change instead, so this
/// command reports `ship_progress` for visibility but leaves
/// `ship_settled` to whichever call actually ends the chain. Runs
/// under `RepoLocks::run_serialized` for the resolved repo root
/// (inside `stage_and_commit` itself), same as every other mutating
/// git operation in this codebase.
///
/// # Errors
///
/// See `swarm_core::git::ship::stage_and_commit`'s `Errors` section.
#[tauri::command]
#[tracing::instrument(skip(app, sink, registry, repo_locks, engine, message))]
#[allow(clippy::too_many_arguments)]
pub async fn git_stage_commit(
    app: AppHandle,
    sink: tauri::State<'_, EventSink>,
    registry: tauri::State<'_, WorkerRegistry>,
    repo_locks: tauri::State<'_, RepoLocks>,
    engine: tauri::State<'_, OrchestrationEngine>,
    worker_id: String,
    ship_id: String,
    message: String,
    mode: StagingMode,
    final_step: bool,
) -> Result<git::CommitOutcome, ShipError> {
    let sid = parse_ship_id(&ship_id);
    let sink = sink.inner().clone();
    let id = parse_worker_id_or_settle(&sink, sid, &worker_id, "staging")?;
    let registry = registry.inner().clone();
    let repo_locks = repo_locks.inner().clone();

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
            return Err(err);
        }
    };

    let (seq_from, seq_to) = resolve_seq_range(&engine, &registry, id).await;
    let co_authored_by = crate::commands::config::read_config_value_sync(&app, "shipCoAuthoredBy")
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
    .map_err(|e| ShipError {
        kind: ShipErrorKind::Unknown,
        message: format!("git_stage_commit task panicked: {e}"),
        remedy: None,
    })?;

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
            Ok(outcome)
        }
        Err(err) => {
            emit_progress(&sink, sid, id, "commit", "error", Some(err.message.clone()));
            // DIRECTIVE (B2): nothingToCommit is not automatically
            // terminal — the frontend may recover by pushing an
            // already-committed, unpushed change instead (see the
            // module doc). Every other failure kind ends the chain
            // here, same as before.
            if err.kind != ShipErrorKind::NothingToCommit {
                emit_settled(&sink, sid, id, None, None, None, Some(err.clone()));
            }
            Err(err)
        }
    }
}

/// Pushes `worker_id`'s branch (`origin <branch> --set-upstream`,
/// fixed argv, never force; the branch itself and the sha pushed are
/// both resolved live, server-side — see
/// `swarm_core::git::ship::push`'s doc). On success, records
/// `last_shipped_seq`/`last_shipped_commit` via
/// `WorkerRegistry::set_last_shipped` (the ship chain is the only
/// writer of those two fields, using a `seqTo` snapshotted here — the
/// same "current max seq at this moment" resolution `git_stage_commit`
/// uses, so the sequel to *this* push starts its own `seqFrom` from a
/// real snapshot even when no `git_stage_commit` call preceded it) and
/// emits `ship_progress` + (when `final_step`, the common case)
/// `ship_settled`. On failure, always emits `ship_settled` — a push
/// failure always ends the chain there.
///
/// # Errors
///
/// See `swarm_core::git::ship::push`'s `Errors` section.
#[tauri::command]
#[tracing::instrument(skip(sink, registry, repo_locks, engine))]
pub async fn git_push(
    sink: tauri::State<'_, EventSink>,
    registry: tauri::State<'_, WorkerRegistry>,
    repo_locks: tauri::State<'_, RepoLocks>,
    engine: tauri::State<'_, OrchestrationEngine>,
    worker_id: String,
    ship_id: String,
    final_step: bool,
) -> Result<git::PushOutcome, ShipError> {
    let sid = parse_ship_id(&ship_id);
    let sink = sink.inner().clone();
    let id = parse_worker_id_or_settle(&sink, sid, &worker_id, "push")?;
    let registry = registry.inner().clone();
    let repo_locks = repo_locks.inner().clone();

    emit_progress(&sink, sid, id, "push", "running", None);

    let seq_to = current_max_seq_for_engine(&engine).await;

    let registry_for_task = registry.clone();
    let result =
        tokio::task::spawn_blocking(move || git::ship::push(&registry_for_task, &repo_locks, id))
            .await
            .map_err(|e| ShipError {
                kind: ShipErrorKind::Unknown,
                message: format!("git_push task panicked: {e}"),
                remedy: None,
            })?;

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
            Ok(outcome)
        }
        Err(err) => {
            emit_progress(&sink, sid, id, "push", "error", Some(err.message.clone()));
            emit_settled(&sink, sid, id, None, None, None, Some(err.clone()));
            Err(err)
        }
    }
}

async fn current_max_seq_for_engine(engine: &OrchestrationEngine) -> u64 {
    let Some(db_path) = engine.db_path().map(std::path::Path::to_path_buf) else {
        return 0;
    };
    tokio::task::spawn_blocking(move || current_max_seq(&db_path))
        .await
        .unwrap_or(0)
}

/// Builds the GitHub-style compare URL for `worker_id`'s worktree,
/// prefilled with `title`/`body` via `quick_pull=1` query params
/// (capped per `swarm_core::git::remote::MAX_COMPARE_URL_LEN`).
/// `commitSha`/`pushedRef` are carried through into the `ship_settled`
/// receipt only — sourced from the preceding `git_push` call's
/// `PushOutcome`, which always has a real sha regardless of whether a
/// `git_stage_commit` call preceded it in this ship attempt (see the
/// module doc's B2 note). Emits `ship_progress`/`ship_settled` for the
/// `"compare"` step — the terminal receipt for the frontend's "Commit
/// + Push + Open Compare Page" action.
///
/// The frontend is expected to pre-check
/// `ShipPreflight.hostSupportsCompare` and disable this action
/// entirely for a non-GitHub remote — this command's own
/// `nonGitHubHost` error is the defensive fallback for a stale
/// preflight, not the primary UX (see
/// `swarm_core::git::ship::compare_url`'s doc).
///
/// # Errors
///
/// [`ShipError`] with kind `noRemote`/`nonGitHubHost`/`invalidBranch`
/// — see `swarm_core::git::ship::compare_url`'s `Errors` section.
#[tauri::command]
#[tracing::instrument(skip(sink, registry, title, body))]
#[allow(clippy::too_many_arguments)]
pub async fn ship_compare_url(
    sink: tauri::State<'_, EventSink>,
    registry: tauri::State<'_, WorkerRegistry>,
    worker_id: String,
    ship_id: String,
    commit_sha: String,
    pushed_ref: String,
    title: String,
    body: String,
) -> Result<String, ShipError> {
    let sid = parse_ship_id(&ship_id);
    let sink = sink.inner().clone();
    let id = parse_worker_id_or_settle(&sink, sid, &worker_id, "compare")?;
    let registry = registry.inner().clone();

    emit_progress(&sink, sid, id, "compare", "running", None);

    let result =
        tokio::task::spawn_blocking(move || git::ship::compare_url(&registry, id, &title, &body))
            .await
            .map_err(|e| ShipError {
                kind: ShipErrorKind::Unknown,
                message: format!("ship_compare_url task panicked: {e}"),
                remedy: None,
            })?;

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
            Ok(url)
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
            Err(err)
        }
    }
}
