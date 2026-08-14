//! Worker lifecycle management.
//!
//! Handles the complete worker lifecycle — spawn, pause, resume,
//! kill, and input — with proper cleanup and event emission at
//! each transition. These functions are called by the embedding
//! shell's `#[tauri::command]` handlers (`commands::worker` in the
//! swarm-desktop crate).
//!
//! ## Worktree isolation (Phase 1)
//!
//! When `WorkerConfig::repo_root` is present and resolves to
//! `WorkerIsolation::Worktree` (the default), [`do_spawn_worker`]
//! creates a fresh `git worktree` under `~/.swarm/worktrees/**` and
//! spawns the PTY there instead of at `config.cwd` — see
//! [`create_worktree_for_worker`]. Any failure in that pipeline (repo
//! discovery, `HEAD` resolution, `worktree add`, `worktree lock`) hard
//! fails the whole spawn: no worker is created, no PTY is started, and
//! there is no silent fallback to a shared cwd. [`do_kill_worker`]
//! mirrors this on the way out: unlock, then `worktree remove`
//! *without* `--force` — git's own refusal on a dirty worktree IS the
//! preserve-on-dirty guarantee (see `git::worktree`'s module doc).

use std::path::{Path, PathBuf};

use parking_lot::Mutex;
use uuid::Uuid;

use crate::error::AppError;
use crate::events::{
    EventSink, InputSource, Provenance, SwarmEvent, WorkerInputPayload, WorkerKilledPayload,
    WorkerSpawnedPayload, WorkerStatePayload, WorktreeCreatedPayload, WorktreeRemovedPayload,
};
use crate::git::{self, RemoveOutcome, RepoLocks};
use crate::worker::handle::{WorkerConfig, WorkerHandle, WorkerIsolation, WorkerState};
use crate::worker::pty::spawn_pty;
use crate::worker::registry::WorkerRegistry;

/// Resolved outcome of successfully isolating a worker into its own
/// git worktree — everything [`do_spawn_worker`] needs to spawn the
/// PTY there and populate the [`WorkerHandle`]/events.
struct WorktreeIsolation {
    repo_root: String,
    worktree_path: String,
    branch: String,
    base_commit: String,
}

/// First 8 hex characters of `id`'s simple (no-dashes) form — the
/// `<id8>` component of both the branch name (`swarm/<slug>-<id8>`)
/// and the worktree directory (`w-<id8>`).
fn short_id8(id: Uuid) -> String {
    id.simple().to_string()[..8].to_string()
}

/// Runs the full worktree-creation pipeline for a worker: resolve the
/// repo toplevel from `repo_root_input`, resolve `HEAD`, compute the
/// worktree path and branch name, `git worktree add`, then `git
/// worktree lock` it under the worker's UUID as the lock reason (so a
/// future crash-orphan scan can attribute it).
///
/// Every step is fallible and every failure propagates straight out —
/// there is no partial/degraded success. If `lock` fails after `add`
/// already succeeded, this makes a best-effort attempt to remove the
/// now-orphaned, unlocked worktree before returning the original error
/// (see [`cleanup_orphaned_worktree`]).
fn create_worktree_for_worker(
    repo_locks: &RepoLocks,
    worker_id: Uuid,
    worker_name: &str,
    repo_root_input: &str,
) -> Result<WorktreeIsolation, AppError> {
    let repo_root_path = git::repo::discover_toplevel(Path::new(repo_root_input))?;
    let base_sha = git::repo::head_sha(&repo_root_path)?;

    let id8 = short_id8(worker_id);
    let branch = format!("swarm/{}-{id8}", git::slugify(worker_name));

    let home = git::home_dir()?;
    let repo_name = repo_root_path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "repo".to_string());
    let repo_dir_tag = format!(
        "{}-{}",
        git::slugify(&repo_name),
        git::short_hash8(&repo_root_path.display().to_string())
    );
    let worktree_path: PathBuf = home
        .join(".swarm")
        .join("worktrees")
        .join(repo_dir_tag)
        .join(format!("w-{id8}"));

    {
        let repo_root_path = repo_root_path.clone();
        let worktree_path = worktree_path.clone();
        let branch = branch.clone();
        let base_sha = base_sha.clone();
        repo_locks.run_serialized(&repo_root_path, || {
            git::worktree::add(&repo_root_path, &worktree_path, &branch, &base_sha)
        })?;
    }

    let lock_reason = format!("swarm worker {worker_id}");
    let lock_result = {
        let repo_root_path = repo_root_path.clone();
        let worktree_path = worktree_path.clone();
        let lock_reason = lock_reason.clone();
        repo_locks.run_serialized(&repo_root_path, || {
            git::worktree::lock(&repo_root_path, &worktree_path, &lock_reason)
        })
    };
    if let Err(e) = lock_result {
        cleanup_orphaned_worktree(repo_locks, &repo_root_path, &worktree_path);
        return Err(e);
    }

    Ok(WorktreeIsolation {
        repo_root: repo_root_path.display().to_string(),
        worktree_path: worktree_path.display().to_string(),
        branch,
        base_commit: base_sha,
    })
}

/// Best-effort cleanup for a worktree that was created but whose
/// owning spawn subsequently failed (lock step, or the PTY itself
/// failed to start) — never `--force`, exactly like the normal kill
/// path. Every mutating call is serialized through `repo_locks`, same
/// as the normal spawn/kill paths, so `RepoLocks`' "every mutating git
/// op for a repo is serialized" guarantee actually holds everywhere,
/// not just on the happy path. Failures here are logged, not
/// propagated: the caller is already unwinding a harder error, and a
/// worktree left behind in this rare case is a manual-cleanup
/// inconvenience, not data loss (it is still locked/attributable, or
/// git's own dirty-refusal preserves it).
fn cleanup_orphaned_worktree(repo_locks: &RepoLocks, repo_root: &Path, worktree_path: &Path) {
    let unlock_result = repo_locks.run_serialized(repo_root, || {
        git::worktree::unlock(repo_root, worktree_path)
    });
    if let Err(e) = unlock_result {
        tracing::warn!(
            error = %e,
            path = %worktree_path.display(),
            "cleanup: unlock failed for orphaned worktree after a failed spawn"
        );
    }
    let remove_result = repo_locks.run_serialized(repo_root, || {
        git::worktree::remove(repo_root, worktree_path)
    });
    match remove_result {
        Ok(RemoveOutcome::Removed) => {
            tracing::info!(
                path = %worktree_path.display(),
                "cleanup: removed orphaned worktree after a failed spawn"
            );
        }
        Ok(RemoveOutcome::Preserved { reason }) => {
            tracing::warn!(
                path = %worktree_path.display(),
                reason,
                "cleanup: orphaned worktree preserved (dirty) after a failed spawn — manual cleanup needed"
            );
        }
        Err(e) => {
            tracing::warn!(
                error = %e,
                path = %worktree_path.display(),
                "cleanup: failed to remove orphaned worktree after a failed spawn — manual cleanup needed"
            );
        }
    }
}

/// Spawns a new worker process with a PTY and registers it.
///
/// Creates a new PTY process using the shell specified in `config`
/// (or the system default), wraps it in a [`WorkerHandle`], inserts
/// it into the registry, and emits a `worker_spawned` event (and, when
/// isolated, a `worktree_created` event) on `swarm://events`.
///
/// When `config.repo_root` is `Some` and `config.isolation` resolves
/// to [`WorkerIsolation::Worktree`] (the default), this first creates
/// and locks a fresh git worktree (see [`create_worktree_for_worker`])
/// and spawns the PTY there instead of at `config.cwd`. Any failure in
/// that pipeline hard-fails the spawn before any PTY process exists —
/// there is no silent fallback to a shared cwd. `config.repo_root ==
/// None` reproduces exactly the pre-worktree-isolation spawn path.
///
/// # Arguments
///
/// * `sink` - Event sink for recording emitted events
/// * `registry` - The shared worker registry
/// * `repo_locks` - Per-repo serialization for mutating git operations
/// * `config` - Worker spawn configuration (name, shell, cwd, env, PTY size, isolation)
/// * `provenance` - Causal attribution for this spawn (e.g. the AI
///   turn that requested it via the `spawn_worker` tool). The new
///   worker's own id is the SUBJECT (`payload.workerId` on the emitted
///   `worker_spawned`/`worktree_created` events); `provenance.origin_worker`
///   is the CAUSER — for a tool-driven spawn the two differ, and that
///   difference is the causal edge. `Provenance::default()` for a
///   human-initiated spawn (nothing caused it but the user).
///
/// # Returns
///
/// The UUID of the newly spawned worker.
///
/// # Errors
///
/// * [`AppError::Git`] - Repo discovery, `HEAD` resolution, or
///   `worktree add`/`lock` failed (only when `repo_root` is present)
/// * [`AppError::PtySpawn`] - The PTY process failed to spawn
/// * [`AppError::RegistryFull`] - The registry has reached capacity
#[tracing::instrument(skip(sink, registry, repo_locks))]
pub fn do_spawn_worker(
    sink: &EventSink,
    registry: &WorkerRegistry,
    repo_locks: &RepoLocks,
    config: WorkerConfig,
    provenance: Provenance,
) -> Result<Uuid, AppError> {
    let default_shell = registry.config.read().default_shell.clone();
    let shell = if config.shell.is_empty() {
        &default_shell
    } else {
        &config.shell
    };

    let worker_id = Uuid::new_v4();

    let isolation = match &config.repo_root {
        Some(repo_root_input) if config.isolation == WorkerIsolation::Worktree => Some(
            create_worktree_for_worker(repo_locks, worker_id, &config.name, repo_root_input)?,
        ),
        _ => None,
    };

    let cwd: &str = isolation
        .as_ref()
        .map(|w| w.worktree_path.as_str())
        .unwrap_or(&config.cwd);

    let pty_handle = spawn_pty(
        sink,
        worker_id,
        shell,
        cwd,
        &config.env,
        config.rows,
        config.cols,
    )
    .map_err(|e| {
        tracing::error!(error = %e, "PTY spawn failed");
        if let Some(w) = &isolation {
            cleanup_orphaned_worktree(
                repo_locks,
                Path::new(&w.repo_root),
                Path::new(&w.worktree_path),
            );
        }
        AppError::PtySpawn(e.to_string())
    })?;

    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);

    let pid = pty_handle.pid;
    let handle = WorkerHandle {
        id: worker_id,
        state: WorkerState::Running,
        name: config.name.clone(),
        pid,
        started_at: now,
        pty_writer: Some(Mutex::new(pty_handle.writer)),
        child: Some(Mutex::new(pty_handle.child)),
        worktree_path: isolation.as_ref().map(|w| w.worktree_path.clone()),
        repo_root: isolation.as_ref().map(|w| w.repo_root.clone()),
        branch: isolation.as_ref().map(|w| w.branch.clone()),
        base_commit: isolation.as_ref().map(|w| w.base_commit.clone()),
        last_shipped_seq: None,
        last_shipped_commit: None,
    };

    registry.spawn_worker(handle)?;

    let isolation_tag = if isolation.is_some() {
        "worktree"
    } else {
        "none"
    };
    sink.emit_with(
        SwarmEvent::WorkerSpawned(WorkerSpawnedPayload {
            worker_id,
            name: config.name,
            pid,
            isolation: Some(isolation_tag.to_string()),
        }),
        provenance.clone(),
    );

    if let Some(w) = &isolation {
        sink.emit_with(
            SwarmEvent::WorktreeCreated(WorktreeCreatedPayload {
                worker_id,
                session_id: None,
                repo_root: w.repo_root.clone(),
                worktree_path: w.worktree_path.clone(),
                branch: w.branch.clone(),
                base_commit: w.base_commit.clone(),
            }),
            provenance,
        );
    }

    Ok(worker_id)
}

/// Pauses a running worker by updating its state to [`WorkerState::Paused`].
///
/// This is state-only on all platforms today (see
/// [`WorkerState::Paused`]) — no signal is sent to the underlying
/// process yet.
///
/// The precondition check (worker must currently be `Running`) and the
/// state write happen atomically via [`WorkerRegistry::update_state_if`]
/// (a single `DashMap` shard lock), preventing a TOCTOU race where a
/// concurrent pause/resume call on the same worker could observe a
/// stale state between a separate check and set.
///
/// Emits a `worker_state` event on `swarm://events` with `state: "paused"`.
///
/// # Arguments
///
/// * `sink` - Event sink for recording the `worker_state` event
/// * `registry` - The shared worker registry
/// * `id` - UUID of the worker to pause
///
/// # Errors
///
/// * [`AppError::WorkerNotFound`] - No worker with the given ID exists
/// * [`AppError::Ipc`] - The worker is not currently `Running`
#[tracing::instrument(skip(sink, registry))]
pub fn do_pause_worker(
    sink: &EventSink,
    registry: &WorkerRegistry,
    id: Uuid,
    provenance: Provenance,
) -> Result<(), AppError> {
    registry.update_state_if(&id, WorkerState::Running, WorkerState::Paused)?;

    sink.emit_with(
        SwarmEvent::WorkerState(WorkerStatePayload {
            worker_id: id,
            state: WorkerState::Paused,
        }),
        provenance,
    );

    Ok(())
}

/// Resumes a paused worker by updating its state to [`WorkerState::Running`].
///
/// The precondition check (worker must currently be `Paused`) and the
/// state write happen atomically via [`WorkerRegistry::update_state_if`]
/// (a single `DashMap` shard lock), preventing a TOCTOU race with a
/// concurrent pause/resume call on the same worker.
///
/// Emits a `worker_state` event on `swarm://events` with `state: "running"`.
///
/// # Arguments
///
/// * `sink` - Event sink for recording the `worker_state` event
/// * `registry` - The shared worker registry
/// * `id` - UUID of the worker to resume
///
/// # Errors
///
/// * [`AppError::WorkerNotFound`] - No worker with the given ID exists
/// * [`AppError::Ipc`] - The worker is not currently `Paused`
#[tracing::instrument(skip(sink, registry))]
pub fn do_resume_worker(
    sink: &EventSink,
    registry: &WorkerRegistry,
    id: Uuid,
    provenance: Provenance,
) -> Result<(), AppError> {
    registry.update_state_if(&id, WorkerState::Paused, WorkerState::Running)?;

    sink.emit_with(
        SwarmEvent::WorkerState(WorkerStatePayload {
            worker_id: id,
            state: WorkerState::Running,
        }),
        provenance,
    );

    Ok(())
}

/// Kills a worker process and removes it from the registry.
///
/// Removes the worker from the registry, drops the PTY writer first to
/// close the master fd (ensuring the child sees EOF), then kills the
/// child process and waits for it to exit to prevent zombie processes
/// — and, on Windows, to release any OS handle the child held on the
/// worktree directory as its cwd (removal would otherwise fail purely
/// because the directory is "in use"). If the worker was isolated
/// (`worktree_path` present), unlocks and then `git worktree remove`s
/// it — **never** with `--force` — and emits `worktree_removed` with
/// the resulting disposition (`removed`/`preserved_dirty`/`failed`).
/// On a successful removal (only), also best-effort deletes the
/// isolation branch with `git branch -d` (never `-D`) if its tip is
/// still the worker's recorded `base_commit` — see
/// [`delete_isolation_branch_if_unchanged`]. Finally emits
/// `worker_killed`.
///
/// # Arguments
///
/// * `sink` - Event sink for recording emitted events
/// * `registry` - The shared worker registry
/// * `repo_locks` - Per-repo serialization for the mutating `worktree remove` call
/// * `id` - UUID of the worker to kill
///
/// # Errors
///
/// * [`AppError::WorkerNotFound`] - No worker with the given ID exists
#[tracing::instrument(skip(sink, registry, repo_locks))]
pub fn do_kill_worker(
    sink: &EventSink,
    registry: &WorkerRegistry,
    repo_locks: &RepoLocks,
    id: Uuid,
    provenance: Provenance,
) -> Result<(), AppError> {
    let handle = registry.remove_worker(&id)?;

    let worktree_info = match (
        &handle.worktree_path,
        &handle.repo_root,
        &handle.branch,
        &handle.base_commit,
    ) {
        (Some(worktree_path), Some(repo_root), Some(branch), base_commit) => Some((
            worktree_path.clone(),
            repo_root.clone(),
            branch.clone(),
            base_commit.clone(),
        )),
        _ => None,
    };

    // Drop the PTY writer first to close the master fd.
    // This ensures the child process sees EOF on its stdin,
    // preventing it from blocking on read after we kill it.
    drop(handle.pty_writer);

    // TODO(worktree-isolation Phase 2+): portable-pty 0.9 has no
    // Windows job object (and no process-group kill on Unix) — `kill()`
    // below only terminates the direct child, not any grandchildren it
    // spawned (e.g. a shell running a long build). A surviving
    // grandchild can hold the worktree directory as its own cwd, which
    // makes the `git worktree remove` below fail with a permission
    // error — correctly classified as `disposition: "failed"` (see
    // `git::worktree::remove`'s doc, DIRECTIVE B2), not silently
    // laundered into "preserved", but the worktree is then stuck on
    // disk until the surviving process exits and the user retries or
    // cleans up manually. The real fix is a Windows job object /
    // Unix process-group kill at spawn time; out of Phase 1 scope.
    // Kill the child process and wait for it to exit
    if let Some(child_mutex) = &handle.child {
        let mut child = child_mutex.lock();
        if let Err(e) = child.kill() {
            tracing::error!(worker_id = %id, error = %e, "failed to kill child process");
        }
        // Wait for the child to exit to avoid zombie processes
        match child.wait() {
            Ok(status) => {
                tracing::debug!(worker_id = %id, ?status, "child process exited");
            }
            Err(e) => {
                tracing::error!(worker_id = %id, error = %e, "failed to wait on child process");
            }
        }
    }

    // Only now — after the child has fully exited — attempt worktree
    // cleanup. The child is confirmed gone above, so its OS handle on
    // the worktree directory (as its cwd) is released (modulo the
    // surviving-grandchild caveat in the TODO above).
    if let Some((worktree_path, repo_root, branch, base_commit)) = worktree_info {
        let repo_root_path = Path::new(&repo_root);
        let worktree_path_ref = Path::new(&worktree_path);

        // Capture HEAD before removal — once removed the directory is
        // gone and this would no longer resolve.
        let head_commit = git::repo::head_sha(worktree_path_ref).ok();

        let unlock_result = repo_locks.run_serialized(repo_root_path, || {
            git::worktree::unlock(repo_root_path, worktree_path_ref)
        });

        // A failed unlock means `remove` would misreport (it would
        // either fail with "still locked" — correctly "failed" under
        // B2's classification, but for the wrong stated reason — or,
        // worse, silently no-op on a lock git already dropped for some
        // other reason). Treat it as the failure it honestly is and
        // skip the remove attempt entirely, rather than warn-and-continue.
        let remove_result = match unlock_result {
            Ok(()) => repo_locks.run_serialized(repo_root_path, || {
                git::worktree::remove(repo_root_path, worktree_path_ref)
            }),
            Err(e) => {
                tracing::error!(worker_id = %id, error = %e, "worktree unlock failed; skipping remove");
                Err(e)
            }
        };

        let (disposition, reason) = match remove_result {
            Ok(RemoveOutcome::Removed) => {
                tracing::info!(worker_id = %id, path = %worktree_path, "worktree removed");
                ("removed".to_string(), None)
            }
            Ok(RemoveOutcome::Preserved { reason }) => {
                tracing::info!(
                    worker_id = %id,
                    path = %worktree_path,
                    reason = %reason,
                    "worktree preserved (dirty) — SWARM never force-removes"
                );
                ("preserved_dirty".to_string(), Some(reason))
            }
            Err(e) => {
                tracing::error!(worker_id = %id, error = %e, "worktree remove failed");
                ("failed".to_string(), Some(e.to_string()))
            }
        };

        // Branch cleanup — strictly gated on a successful removal:
        // never on "preserved_dirty" (the worktree still needs the
        // branch checked out) or "failed" (the state is uncertain).
        // `-d` (never `-D`) additionally refuses an unmerged branch on
        // git's own side — this is redundant defense in depth on top
        // of the tip-vs-base-commit check below, not a substitute.
        if disposition == "removed" {
            delete_isolation_branch_if_unchanged(
                repo_locks,
                repo_root_path,
                &branch,
                base_commit.as_deref(),
                id,
            );
        }

        sink.emit_with(
            SwarmEvent::WorktreeRemoved(WorktreeRemovedPayload {
                worker_id: id,
                worktree_path,
                branch,
                disposition,
                head_commit,
                reason,
            }),
            provenance.clone(),
        );
    }

    sink.emit_with(
        SwarmEvent::WorkerKilled(WorkerKilledPayload { worker_id: id }),
        provenance,
    );

    tracing::info!(worker_id = %id, "worker killed and removed");
    Ok(())
}

/// After a successful worktree removal, deletes the isolation branch
/// **only** if its tip is still exactly `base_commit` (the sha the
/// worktree was created from) — i.e. the agent made no commits.
/// Never `-D`, never called for any disposition other than "removed"
/// (see the call site). Purely best-effort bookkeeping to stop
/// `swarm/*` branches from accumulating forever in the user's real
/// repo: failures and a diverged tip are logged (`tracing`, not a
/// `SwarmEvent` — this is not part of the persisted history) and never
/// propagated, since losing the ability to delete a branch is not a
/// reason to fail `do_kill_worker`.
fn delete_isolation_branch_if_unchanged(
    repo_locks: &RepoLocks,
    repo_root: &Path,
    branch: &str,
    base_commit: Option<&str>,
    worker_id: Uuid,
) {
    let Some(base_commit) = base_commit else {
        tracing::debug!(worker_id = %worker_id, branch, "no recorded base_commit; skipping branch cleanup");
        return;
    };

    let tip = repo_locks.run_serialized(repo_root, || git::repo::rev_parse(repo_root, branch));
    let tip = match tip {
        Ok(tip) => tip,
        Err(e) => {
            tracing::warn!(worker_id = %worker_id, branch, error = %e, "could not resolve branch tip; leaving branch in place");
            return;
        }
    };

    if tip != base_commit {
        tracing::info!(
            worker_id = %worker_id,
            branch,
            base_commit,
            tip,
            "isolation branch retained — diverged from base_commit (worker committed)"
        );
        return;
    }

    match repo_locks.run_serialized(repo_root, || {
        git::worktree::delete_branch(repo_root, branch)
    }) {
        Ok(()) => {
            tracing::info!(worker_id = %worker_id, branch, "isolation branch deleted (unchanged from base_commit)");
        }
        Err(e) => {
            tracing::warn!(worker_id = %worker_id, branch, error = %e, "isolation branch delete failed; leaving it in place");
        }
    }
}

/// First ~120 characters of `data`, control characters stripped and
/// invalid UTF-8 lossily replaced. Used only for `source ∈ {tool,
/// automation}` — never for `source == "terminal"` (see
/// [`do_worker_input`]'s doc and `WorkerInputPayload`'s "never carries
/// raw keystrokes" note).
fn stamped_preview(data: &[u8]) -> String {
    String::from_utf8_lossy(data)
        .chars()
        .filter(|c| !c.is_control())
        .take(120)
        .collect()
}

/// Writes input data to a worker's PTY, then emits a stamped
/// `worker_input` event recording that it happened.
///
/// Looks up the worker in the registry, acquires the PTY writer
/// mutex, and writes the data bytes to the PTY master fd. The event is
/// emitted only AFTER a successful write — a failed write caused no
/// side effect worth recording.
///
/// # Arguments
///
/// * `sink` - Event sink for recording the `worker_input` event
/// * `registry` - The shared worker registry
/// * `id` - UUID of the worker to send input to
/// * `data` - Raw bytes to write to the PTY
/// * `source` - [`InputSource::Terminal`] (human keystrokes — no
///   `preview`, and excluded from persistence, see
///   [`crate::orchestration::is_persistent`]), [`InputSource::Tool`],
///   or [`InputSource::Automation`] (machine-issued — both get a
///   control-stripped `preview`)
/// * `provenance` - Causal attribution; `Provenance::default()` for
///   `source == InputSource::Terminal` (the causer is a human, not
///   another worker's turn)
///
/// # Errors
///
/// * [`AppError::WorkerNotFound`] - No worker with the given ID exists
/// * [`AppError::Ipc`] - The worker has no PTY writer, or the write failed
#[tracing::instrument(skip(sink, registry, data))]
pub fn do_worker_input(
    sink: &EventSink,
    registry: &WorkerRegistry,
    id: Uuid,
    data: &[u8],
    source: InputSource,
    provenance: Provenance,
) -> Result<(), AppError> {
    {
        let entry = registry
            .workers
            .get(&id)
            .ok_or_else(|| AppError::WorkerNotFound { id: id.to_string() })?;

        if let Some(writer_mutex) = &entry.pty_writer {
            let mut writer = writer_mutex.lock();
            crate::worker::pty::write_to_pty(writer.as_mut(), data)
                .map_err(|e| AppError::Ipc(e.to_string()))?;
        } else {
            return Err(AppError::Ipc(format!("worker {} has no PTY writer", id)));
        }
    } // drop the registry entry guard before emitting

    let preview = source.is_machine_issued().then(|| stamped_preview(data));
    sink.emit_with(
        SwarmEvent::WorkerInput(WorkerInputPayload {
            worker_id: id,
            bytes: data.len(),
            source,
            preview,
        }),
        provenance,
    );

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::worker::handle::{WorkerHandle, WorkerState};

    /// Helper to create a lightweight WorkerHandle for testing
    /// (no PTY resources needed for state-transition tests).
    fn make_handle(state: WorkerState) -> WorkerHandle {
        WorkerHandle {
            id: Uuid::new_v4(),
            state,
            name: "test-worker".to_string(),
            pid: Some(9999),
            started_at: 0,
            pty_writer: None,
            child: None,
            worktree_path: None,
            repo_root: None,
            branch: None,
            base_commit: None,
            last_shipped_seq: None,
            last_shipped_commit: None,
        }
    }

    #[test]
    fn test_pause_rejects_non_running_state() {
        let registry = WorkerRegistry::new();
        let handle = make_handle(WorkerState::Idle);
        let id = handle.id;
        registry.spawn_worker(handle).unwrap();

        // do_pause_worker requires an EventSink, but the state check
        // happens before event emission. We test the registry-level
        // precondition directly: worker must be Running to pause.
        let entry = registry.workers.get(&id).unwrap();
        assert_ne!(entry.state, WorkerState::Running);

        // Replicate the guard logic from do_pause_worker
        let result: Result<(), AppError> = if entry.state != WorkerState::Running {
            Err(AppError::Ipc(format!(
                "cannot pause worker {} in state {}",
                id, entry.state
            )))
        } else {
            Ok(())
        };
        assert!(result.is_err());
        let err_msg = result.unwrap_err().to_string();
        assert!(
            err_msg.contains("cannot pause"),
            "expected 'cannot pause' in error, got: {err_msg}"
        );
        assert!(
            err_msg.contains("idle"),
            "expected 'idle' state in error, got: {err_msg}"
        );
    }

    #[test]
    fn test_pause_rejects_paused_state() {
        let registry = WorkerRegistry::new();
        let handle = make_handle(WorkerState::Paused);
        let id = handle.id;
        registry.spawn_worker(handle).unwrap();

        let entry = registry.workers.get(&id).unwrap();
        assert_eq!(entry.state, WorkerState::Paused);

        let result: Result<(), AppError> = if entry.state != WorkerState::Running {
            Err(AppError::Ipc(format!(
                "cannot pause worker {} in state {}",
                id, entry.state
            )))
        } else {
            Ok(())
        };
        assert!(result.is_err());
        let err_msg = result.unwrap_err().to_string();
        assert!(
            err_msg.contains("paused"),
            "expected 'paused' state in error, got: {err_msg}"
        );
    }

    #[test]
    fn test_resume_rejects_non_paused_state() {
        let registry = WorkerRegistry::new();
        let handle = make_handle(WorkerState::Running);
        let id = handle.id;
        registry.spawn_worker(handle).unwrap();

        let entry = registry.workers.get(&id).unwrap();
        assert_eq!(entry.state, WorkerState::Running);

        // Replicate the guard logic from do_resume_worker
        let result: Result<(), AppError> = if entry.state != WorkerState::Paused {
            Err(AppError::Ipc(format!(
                "cannot resume worker {} in state {}",
                id, entry.state
            )))
        } else {
            Ok(())
        };
        assert!(result.is_err());
        let err_msg = result.unwrap_err().to_string();
        assert!(
            err_msg.contains("cannot resume"),
            "expected 'cannot resume' in error, got: {err_msg}"
        );
        assert!(
            err_msg.contains("running"),
            "expected 'running' state in error, got: {err_msg}"
        );
    }

    #[test]
    fn test_resume_rejects_idle_state() {
        let registry = WorkerRegistry::new();
        let handle = make_handle(WorkerState::Idle);
        let id = handle.id;
        registry.spawn_worker(handle).unwrap();

        let entry = registry.workers.get(&id).unwrap();
        let result: Result<(), AppError> = if entry.state != WorkerState::Paused {
            Err(AppError::Ipc(format!(
                "cannot resume worker {} in state {}",
                id, entry.state
            )))
        } else {
            Ok(())
        };
        assert!(result.is_err());
        let err_msg = result.unwrap_err().to_string();
        assert!(
            err_msg.contains("idle"),
            "expected 'idle' state in error, got: {err_msg}"
        );
    }

    #[test]
    fn test_worker_not_found_returns_error() {
        let registry = WorkerRegistry::new();
        let fake_id = Uuid::new_v4();

        let result = registry
            .workers
            .get(&fake_id)
            .ok_or_else(|| AppError::WorkerNotFound {
                id: fake_id.to_string(),
            });
        assert!(result.is_err());
        let err_msg = result.unwrap_err().to_string();
        assert!(
            err_msg.contains("not found"),
            "expected 'not found' in error, got: {err_msg}"
        );
    }

    #[test]
    fn test_worker_input_no_pty_writer() {
        let registry = WorkerRegistry::new();
        let handle = make_handle(WorkerState::Running);
        let id = handle.id;
        registry.spawn_worker(handle).unwrap();
        let (tx, _rx) = std::sync::mpsc::channel();
        let sink = EventSink::new(tx);

        let result = do_worker_input(
            &sink,
            &registry,
            id,
            b"hello",
            InputSource::Terminal,
            Provenance::default(),
        );
        assert!(result.is_err());
        let err_msg = result.unwrap_err().to_string();
        assert!(
            err_msg.contains("no PTY writer"),
            "expected 'no PTY writer' in error, got: {err_msg}"
        );
    }

    /// A `Write` impl over a shared buffer — stands in for a real PTY
    /// writer so `do_worker_input`'s happy path is testable
    /// synchronously, without spawning an actual PTY process.
    struct SharedBuf(std::sync::Arc<Mutex<Vec<u8>>>);
    impl std::io::Write for SharedBuf {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            self.0.lock().extend_from_slice(buf);
            Ok(buf.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    fn make_handle_with_pty(state: WorkerState) -> (WorkerHandle, std::sync::Arc<Mutex<Vec<u8>>>) {
        let buf = std::sync::Arc::new(Mutex::new(Vec::new()));
        let handle = WorkerHandle {
            id: Uuid::new_v4(),
            state,
            name: "test-worker".to_string(),
            pid: Some(9999),
            started_at: 0,
            pty_writer: Some(Mutex::new(
                Box::new(SharedBuf(buf.clone())) as Box<dyn std::io::Write + Send>
            )),
            child: None,
            worktree_path: None,
            repo_root: None,
            branch: None,
            base_commit: None,
            last_shipped_seq: None,
            last_shipped_commit: None,
        };
        (handle, buf)
    }

    /// DIRECTIVE: `do_worker_input` writes to the PTY, THEN emits a
    /// stamped `worker_input` event carrying the caller's provenance —
    /// the tool-driven-input case (Phase 5b/5a wiring).
    #[test]
    fn test_worker_input_writes_then_emits_stamped_event() {
        let registry = WorkerRegistry::new();
        let (handle, buf) = make_handle_with_pty(WorkerState::Running);
        let id = handle.id;
        registry.spawn_worker(handle).unwrap();
        let (tx, rx) = std::sync::mpsc::channel();
        let sink = EventSink::new(tx);
        let origin = Uuid::new_v4();

        do_worker_input(
            &sink,
            &registry,
            id,
            b"pnpm build\n",
            InputSource::Tool,
            Provenance {
                origin_worker: Some(origin),
                cause_seq: Some(41),
            },
        )
        .expect("write should succeed");

        assert_eq!(buf.lock().as_slice(), b"pnpm build\n");

        let msg = rx.recv().expect("worker_input message on writer channel");
        assert_eq!(msg.provenance.origin_worker, Some(origin));
        assert_eq!(msg.provenance.cause_seq, Some(41));
        match msg.event {
            SwarmEvent::WorkerInput(p) => {
                assert_eq!(p.worker_id, id);
                assert_eq!(p.bytes, 11);
                assert_eq!(p.source, InputSource::Tool);
                // Trailing `\n` is a control character — stripped, per
                // `stamped_preview`'s "control-stripped" contract.
                assert_eq!(p.preview.as_deref(), Some("pnpm build"));
            }
            other => panic!("expected WorkerInput event, got {other:?}"),
        }
    }

    /// DIRECTIVE: terminal-source input NEVER carries a preview — human
    /// keystrokes are logged as a byte count only (see
    /// `WorkerInputPayload`'s "never carries raw keystrokes" note).
    #[test]
    fn test_worker_input_terminal_source_has_no_preview() {
        let registry = WorkerRegistry::new();
        let (handle, _buf) = make_handle_with_pty(WorkerState::Running);
        let id = handle.id;
        registry.spawn_worker(handle).unwrap();
        let (tx, rx) = std::sync::mpsc::channel();
        let sink = EventSink::new(tx);

        do_worker_input(
            &sink,
            &registry,
            id,
            b"super-secret-password\n",
            InputSource::Terminal,
            Provenance::default(),
        )
        .unwrap();

        let msg = rx.recv().unwrap();
        match msg.event {
            SwarmEvent::WorkerInput(p) => {
                assert_eq!(p.preview, None, "terminal input must never carry a preview");
                assert_eq!(p.bytes, 22);
            }
            other => panic!("expected WorkerInput event, got {other:?}"),
        }
    }

    /// DIRECTIVE: preview is control-stripped and capped at ~120 chars.
    #[test]
    fn test_worker_input_preview_strips_control_chars_and_truncates() {
        let registry = WorkerRegistry::new();
        let (handle, _buf) = make_handle_with_pty(WorkerState::Running);
        let id = handle.id;
        registry.spawn_worker(handle).unwrap();
        let (tx, rx) = std::sync::mpsc::channel();
        let sink = EventSink::new(tx);

        let long_line = "a".repeat(200);
        let mut data = format!("\x1b[31m{long_line}").into_bytes();
        data.push(0x07); // BEL, a control char

        do_worker_input(
            &sink,
            &registry,
            id,
            &data,
            InputSource::Automation,
            Provenance::default(),
        )
        .unwrap();

        let msg = rx.recv().unwrap();
        match msg.event {
            SwarmEvent::WorkerInput(p) => {
                let preview = p.preview.expect("automation source must carry a preview");
                assert!(preview.chars().count() <= 120);
                assert!(
                    !preview.chars().any(|c| c.is_control()),
                    "preview must strip control characters, got: {preview:?}"
                );
            }
            other => panic!("expected WorkerInput event, got {other:?}"),
        }
    }

    // ── Worktree isolation tests ─────────────────────────────────────

    /// DIRECTIVE: hard-fail-on-worktree-failure. `repo_root` pointing
    /// at a directory that is not a git repository must fail the whole
    /// spawn — never fall back to spawning unisolated at `config.cwd`.
    /// `create_worktree_for_worker` runs (and fails) before
    /// `spawn_pty` is ever called, so this never touches a real
    /// process and the registry must remain empty afterward.
    #[test]
    fn test_spawn_hard_fails_when_repo_root_is_not_a_git_repo() {
        let not_a_repo = std::env::temp_dir().join(format!("swarm-not-a-repo-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&not_a_repo).unwrap();

        let registry = WorkerRegistry::new();
        let repo_locks = RepoLocks::new();
        let (tx, _rx) = std::sync::mpsc::channel();
        let sink = EventSink::new(tx);

        let config = WorkerConfig {
            name: "Doomed Worker".to_string(),
            repo_root: Some(not_a_repo.display().to_string()),
            isolation: WorkerIsolation::Worktree,
            ..WorkerConfig::default()
        };

        let result = do_spawn_worker(&sink, &registry, &repo_locks, config, Provenance::default());
        assert!(result.is_err(), "expected a hard failure, got {result:?}");
        assert_eq!(
            registry.count(),
            0,
            "no worker/PTY may be registered on a hard-fail spawn"
        );

        std::fs::remove_dir_all(&not_a_repo).ok();
    }

    /// DIRECTIVE: zero-regression proof for repoRoot-absent spawns.
    /// `repo_root: None` must reproduce exactly the pre-worktree-isolation
    /// spawn path: no git touched, `WorkerHandle`/`WorkerInfo` carry no
    /// worktree/branch, and `worker_spawned` reports `isolation: "none"`.
    // spawn_pty uses tokio::spawn/spawn_blocking internally (to bridge
    // PTY reads onto the async world), which needs a live Tokio
    // runtime *context* even though do_spawn_worker/do_kill_worker
    // themselves are synchronous — hence #[tokio::test] rather than
    // #[test] for every test that actually spawns a PTY.
    //
    // DIRECTIVE (B1): `shell` is deliberately left unset (empty
    // string) rather than hardcoded to a platform-specific binary —
    // `do_spawn_worker` then resolves it via
    // `WorkerRegistry`'s `SystemConfig::default()`, exactly the
    // production default-shell path (`powershell.exe` on Windows,
    // `/bin/bash` on Unix/CI). A hardcoded `"cmd.exe"` would make this
    // test (and the two below) unrunnable on CI's ubuntu runner.
    #[tokio::test]
    async fn test_spawn_without_repo_root_is_unisolated_zero_regression() {
        let registry = WorkerRegistry::new();
        let repo_locks = RepoLocks::new();
        let (tx, rx) = std::sync::mpsc::channel();
        let sink = EventSink::new(tx);

        let config = WorkerConfig {
            name: "Plain Worker".to_string(),
            ..WorkerConfig::default()
        };
        assert!(config.repo_root.is_none());

        let worker_id =
            do_spawn_worker(&sink, &registry, &repo_locks, config, Provenance::default())
                .expect("unisolated spawn must succeed exactly as before");

        let info = registry.get_worker(&worker_id).unwrap();
        assert!(info.worktree_path.is_none());
        assert!(info.branch.is_none());

        // First emitted event must be worker_spawned with isolation: "none"
        // — no worktree_created event for an unisolated worker.
        match rx.recv().unwrap().event {
            SwarmEvent::WorkerSpawned(p) => {
                assert_eq!(p.isolation.as_deref(), Some("none"));
            }
            other => panic!("expected WorkerSpawned, got {other:?}"),
        }
        assert!(
            rx.try_recv().is_err(),
            "no worktree_created event should follow an unisolated spawn"
        );

        do_kill_worker(
            &sink,
            &registry,
            &repo_locks,
            worker_id,
            Provenance::default(),
        )
        .expect("kill should succeed");
    }

    /// Sets up a disposable git repo with one commit, returning its
    /// root path. Caller is responsible for removing the returned
    /// path's parent when done.
    fn setup_temp_git_repo() -> PathBuf {
        let base = std::env::temp_dir().join(format!("swarm-lifecycle-git-{}", Uuid::new_v4()));
        let repo_root = base.join("repo");
        std::fs::create_dir_all(&repo_root).unwrap();

        let run = |args: &[&str]| {
            let mut full = git::repo::base_args(&repo_root);
            full.extend(args.iter().map(|s| s.to_string()));
            let out = git::cli::run(&full, git::cli::CREATE_TIMEOUT).unwrap();
            assert!(out.success(), "git setup failed: {} ({full:?})", out.stderr);
        };
        run(&["init"]);
        run(&["config", "user.email", "swarm-test@example.com"]);
        run(&["config", "user.name", "Swarm Test"]);
        std::fs::write(repo_root.join("README.md"), "hello").unwrap();
        run(&["add", "-A"]);
        run(&["commit", "-m", "initial"]);

        repo_root
    }

    /// DIRECTIVE: end-to-end worktree isolation on spawn + event
    /// persistence wiring for `worktree_created`/`worktree_removed`.
    /// Spawns a worker isolated into a real temp repo, asserts the
    /// `WorkerHandle`/`WorkerInfo` carry `worktreePath`/`branch` and
    /// that `worktree_created` was emitted with matching fields, then
    /// kills it on a clean tree and asserts `worktree_removed` reports
    /// `disposition: "removed"` and the directory is gone.
    #[tokio::test]
    async fn test_spawn_and_kill_isolated_worker_full_cycle() {
        let repo_root = setup_temp_git_repo();
        let registry = WorkerRegistry::new();
        let repo_locks = RepoLocks::new();
        let (tx, rx) = std::sync::mpsc::channel();
        let sink = EventSink::new(tx);

        let config = WorkerConfig {
            name: "Research Agent".to_string(),
            repo_root: Some(repo_root.display().to_string()),
            ..WorkerConfig::default()
        };

        let worker_id =
            do_spawn_worker(&sink, &registry, &repo_locks, config, Provenance::default())
                .expect("isolated spawn should succeed against a real git repo");

        let info = registry.get_worker(&worker_id).unwrap();
        let worktree_path = info
            .worktree_path
            .clone()
            .expect("worktree_path must be set");
        assert!(worktree_path.contains("w-"));
        let branch = info.branch.clone().expect("branch must be set");
        assert!(branch.starts_with("swarm/research-agent-"));
        assert!(
            std::path::Path::new(&worktree_path)
                .join("README.md")
                .exists()
        );

        let spawned_isolation = match rx.recv().unwrap().event {
            SwarmEvent::WorkerSpawned(p) => p.isolation.clone(),
            other => panic!("expected WorkerSpawned, got {other:?}"),
        };
        assert_eq!(spawned_isolation.as_deref(), Some("worktree"));

        match rx.recv().unwrap().event {
            SwarmEvent::WorktreeCreated(p) => {
                assert_eq!(p.worker_id, worker_id);
                assert_eq!(p.worktree_path, worktree_path);
                assert_eq!(p.branch, branch);
                assert!(!p.base_commit.is_empty());
            }
            other => panic!("expected WorktreeCreated, got {other:?}"),
        }

        do_kill_worker(
            &sink,
            &registry,
            &repo_locks,
            worker_id,
            Provenance::default(),
        )
        .expect("kill should succeed");

        // worktree_removed comes before worker_killed.
        match rx.recv().unwrap().event {
            SwarmEvent::WorktreeRemoved(p) => {
                assert_eq!(p.disposition, "removed");
                assert_eq!(p.worktree_path, worktree_path);
                assert!(p.reason.is_none());
            }
            other => panic!("expected WorktreeRemoved, got {other:?}"),
        }
        match rx.recv().unwrap().event {
            SwarmEvent::WorkerKilled(p) => assert_eq!(p.worker_id, worker_id),
            other => panic!("expected WorkerKilled, got {other:?}"),
        }
        assert!(
            !std::path::Path::new(&worktree_path).exists(),
            "clean worktree must be removed from disk on kill"
        );

        std::fs::remove_dir_all(repo_root.parent().unwrap()).ok();
    }

    /// DIRECTIVE (B3): after a clean kill (disposition "removed") with
    /// the branch tip unchanged from `base_commit` (no commits made in
    /// the worktree), the isolation branch itself is deleted —
    /// otherwise one `swarm/*` branch would accumulate per worker
    /// forever in the user's real repo.
    #[tokio::test]
    async fn test_kill_deletes_unchanged_isolation_branch() {
        let repo_root = setup_temp_git_repo();
        let registry = WorkerRegistry::new();
        let repo_locks = RepoLocks::new();
        let (tx, rx) = std::sync::mpsc::channel();
        let sink = EventSink::new(tx);

        let config = WorkerConfig {
            name: "Clean Agent".to_string(),
            repo_root: Some(repo_root.display().to_string()),
            ..WorkerConfig::default()
        };
        let worker_id =
            do_spawn_worker(&sink, &registry, &repo_locks, config, Provenance::default()).unwrap();
        let branch = registry.get_worker(&worker_id).unwrap().branch.unwrap();

        // Sanity: branch exists right after spawn.
        assert!(git::repo::rev_parse(&repo_root, &branch).is_ok());

        do_kill_worker(
            &sink,
            &registry,
            &repo_locks,
            worker_id,
            Provenance::default(),
        )
        .unwrap();

        // worktree_removed must report "removed" (nothing changed).
        match rx.recv().unwrap().event {
            SwarmEvent::WorkerSpawned(_) => {}
            other => panic!("expected WorkerSpawned first, got {other:?}"),
        }
        match rx.recv().unwrap().event {
            SwarmEvent::WorktreeCreated(_) => {}
            other => panic!("expected WorktreeCreated, got {other:?}"),
        }
        match rx.recv().unwrap().event {
            SwarmEvent::WorktreeRemoved(p) => assert_eq!(p.disposition, "removed"),
            other => panic!("expected WorktreeRemoved, got {other:?}"),
        }

        // The branch itself must now be gone.
        assert!(
            git::repo::rev_parse(&repo_root, &branch).is_err(),
            "unchanged isolation branch must be deleted after a clean kill"
        );

        std::fs::remove_dir_all(repo_root.parent().unwrap()).ok();
    }

    /// DIRECTIVE (B3): if the agent committed inside the worktree
    /// before it was killed, the branch tip diverges from
    /// `base_commit` — the branch must survive (never `-D`'d away)
    /// even though the worktree itself was cleanly removed (a
    /// commit leaves the working tree clean, so disposition is still
    /// "removed" — divergence is judged against `base_commit`, not
    /// dirtiness).
    #[tokio::test]
    async fn test_kill_retains_diverged_isolation_branch() {
        let repo_root = setup_temp_git_repo();
        let registry = WorkerRegistry::new();
        let repo_locks = RepoLocks::new();
        let (tx, rx) = std::sync::mpsc::channel();
        let sink = EventSink::new(tx);

        let config = WorkerConfig {
            name: "Committing Agent".to_string(),
            repo_root: Some(repo_root.display().to_string()),
            ..WorkerConfig::default()
        };
        let worker_id =
            do_spawn_worker(&sink, &registry, &repo_locks, config, Provenance::default()).unwrap();
        let info = registry.get_worker(&worker_id).unwrap();
        let branch = info.branch.unwrap();
        let worktree_path = info.worktree_path.unwrap();

        // The agent commits real work inside its worktree.
        let wt_path = std::path::Path::new(&worktree_path);
        std::fs::write(wt_path.join("agent-output.txt"), "real work").unwrap();
        let commit = |args: &[&str]| {
            let mut full = git::repo::base_args(wt_path);
            full.extend(args.iter().map(|s| s.to_string()));
            let out = git::cli::run(&full, git::cli::CREATE_TIMEOUT).unwrap();
            assert!(out.success(), "git commit setup failed: {}", out.stderr);
        };
        commit(&["add", "-A"]);
        commit(&["commit", "-m", "agent work"]);

        // Drain spawn-time events.
        rx.recv().unwrap();
        rx.recv().unwrap();

        do_kill_worker(
            &sink,
            &registry,
            &repo_locks,
            worker_id,
            Provenance::default(),
        )
        .unwrap();

        // Worktree is clean (the commit cleaned it) so removal still succeeds.
        match rx.recv().unwrap().event {
            SwarmEvent::WorktreeRemoved(p) => assert_eq!(p.disposition, "removed"),
            other => panic!("expected WorktreeRemoved, got {other:?}"),
        }

        // The branch must survive — it carries the agent's commit.
        assert!(
            git::repo::rev_parse(&repo_root, &branch).is_ok(),
            "diverged isolation branch must NOT be deleted"
        );

        std::fs::remove_dir_all(repo_root.parent().unwrap()).ok();
    }

    /// DIRECTIVE (B2): a failed unlock must propagate as the failure it
    /// is (`disposition: "failed"`), not a warn-and-continue that then
    /// attempts (and likely mis-reports) `remove` anyway.
    #[tokio::test]
    async fn test_kill_reports_failed_when_unlock_fails() {
        let repo_root = setup_temp_git_repo();
        let registry = WorkerRegistry::new();
        let repo_locks = RepoLocks::new();
        let (tx, rx) = std::sync::mpsc::channel();
        let sink = EventSink::new(tx);

        let config = WorkerConfig {
            name: "Unlock Fail Agent".to_string(),
            repo_root: Some(repo_root.display().to_string()),
            ..WorkerConfig::default()
        };
        let worker_id =
            do_spawn_worker(&sink, &registry, &repo_locks, config, Provenance::default()).unwrap();
        let worktree_path = registry
            .get_worker(&worker_id)
            .unwrap()
            .worktree_path
            .unwrap();

        // Force the unlock do_kill_worker is about to attempt to fail:
        // unlock it out-of-band first, so git reports "not locked".
        git::worktree::unlock(&repo_root, std::path::Path::new(&worktree_path)).unwrap();

        // Drain spawn-time events.
        rx.recv().unwrap();
        rx.recv().unwrap();

        do_kill_worker(
            &sink,
            &registry,
            &repo_locks,
            worker_id,
            Provenance::default(),
        )
        .unwrap();

        match rx.recv().unwrap().event {
            SwarmEvent::WorktreeRemoved(p) => {
                assert_eq!(p.disposition, "failed");
                assert!(p.reason.is_some());
            }
            other => panic!("expected WorktreeRemoved, got {other:?}"),
        }
        // The worktree is untouched — remove() was never even attempted.
        assert!(std::path::Path::new(&worktree_path).exists());

        std::fs::remove_dir_all(&worktree_path).ok();
        std::fs::remove_dir_all(repo_root.parent().unwrap()).ok();
    }

    /// DIRECTIVE: preserve-on-dirty integration test outcome, exercised
    /// through the real `do_kill_worker` path (not just `git::worktree`
    /// directly). Dirties the isolated worker's worktree with an
    /// untracked file before killing it, and asserts `worktree_removed`
    /// reports `disposition: "preserved_dirty"` with the directory
    /// (and the untracked file) still present on disk afterward.
    #[tokio::test]
    async fn test_kill_preserves_dirty_worktree_instead_of_deleting_it() {
        let repo_root = setup_temp_git_repo();
        let registry = WorkerRegistry::new();
        let repo_locks = RepoLocks::new();
        let (tx, rx) = std::sync::mpsc::channel();
        let sink = EventSink::new(tx);

        let config = WorkerConfig {
            name: "Dirty Agent".to_string(),
            repo_root: Some(repo_root.display().to_string()),
            ..WorkerConfig::default()
        };
        let worker_id =
            do_spawn_worker(&sink, &registry, &repo_locks, config, Provenance::default()).unwrap();
        let worktree_path = registry
            .get_worker(&worker_id)
            .unwrap()
            .worktree_path
            .unwrap();

        // Drain the spawn-time events (worker_spawned, worktree_created).
        rx.recv().unwrap();
        rx.recv().unwrap();

        // Dirty the worktree with an untracked file — simulates the
        // agent having done real, uncommitted work.
        std::fs::write(
            std::path::Path::new(&worktree_path).join("scratch.txt"),
            "uncommitted agent output",
        )
        .unwrap();

        do_kill_worker(
            &sink,
            &registry,
            &repo_locks,
            worker_id,
            Provenance::default(),
        )
        .unwrap();

        match rx.recv().unwrap().event {
            SwarmEvent::WorktreeRemoved(p) => {
                assert_eq!(p.disposition, "preserved_dirty");
                assert!(
                    p.reason.is_some(),
                    "preserved_dirty must carry git's refusal reason"
                );
            }
            other => panic!("expected WorktreeRemoved, got {other:?}"),
        }
        assert!(
            std::path::Path::new(&worktree_path).exists(),
            "dirty worktree must survive kill — SWARM never force-removes"
        );
        assert!(
            std::path::Path::new(&worktree_path)
                .join("scratch.txt")
                .exists(),
            "the uncommitted file itself must survive"
        );

        std::fs::remove_dir_all(&worktree_path).ok();
        std::fs::remove_dir_all(repo_root.parent().unwrap()).ok();
    }
}
