//! Worker lifecycle: spawn, pause, resume, resize, input and kill.
//!
//! Called by the worker handlers in [`crate::commands::worker`] (and by
//! `agent_spawn` in [`crate::commands::agent`]), which both shells
//! dispatch through [`crate::commands::Registry`]. Every function here
//! blocks (git, process spawn and reap, PTY writes), so the handlers run
//! them on `tokio::task::spawn_blocking`.
//!
//! # Worktree isolation
//!
//! When `WorkerConfig::repo_root` is present and `isolation` is
//! `worktree` (the default), [`do_spawn_worker`] creates a fresh
//! `git worktree` for the worker under
//! [`SystemConfig::worktrees_root`](super::registry::SystemConfig::worktrees_root)
//! (default `~/.swarm/worktrees`) and starts the shell there instead of
//! at `config.cwd`. Any failure in that pipeline (repo discovery, `HEAD`
//! resolution, `worktree add`, `worktree lock`) fails the whole spawn:
//! there is no silent fallback to a shared cwd. [`do_kill_worker`]
//! mirrors this on the way out: unlock, then `worktree remove` *without*
//! `--force`, since git's own refusal on a dirty worktree is the
//! preserve-on-dirty guarantee (see `git::worktree`'s module doc).
//!
//! # A spawn completes or leaves nothing behind
//!
//! [`do_spawn_worker`] reserves registry capacity before it creates
//! anything, so a spawn the registry would refuse fails without side
//! effects. A failure after that point rolls back whatever exists: the
//! shell is killed and reaped, and the worktree is unlocked, removed and
//! its (still unchanged) branch deleted.

#[cfg(test)]
mod tests;

use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock};

use parking_lot::Mutex;
use portable_pty::{Child, ExitStatus, PtySize};
use regex::Regex;
use uuid::Uuid;

use super::handle::{PtyChild, WorkerConfig, WorkerHandle, WorkerIsolation, WorkerState};
use super::pty::{self, Parked, PtySpawn};
use super::registry::WorkerRegistry;
use super::short_id8;
use crate::error::AppError;
use crate::events::{
    EventSink, InputSource, Provenance, SwarmEvent, WorkerInputPayload, WorkerKilledPayload,
    WorkerSpawnedPayload, WorkerStatePayload, WorktreeCreatedPayload, WorktreeRemovedPayload,
};
use crate::git::{self, RemoveOutcome, RepoLocks};

/// A worker's git worktree: what [`do_spawn_worker`] records on the
/// handle and announces in `worktree_created`.
struct WorktreeIsolation {
    repo_root: String,
    worktree_path: String,
    branch: String,
    base_commit: String,
}

impl WorktreeIsolation {
    /// Creates and locks a fresh worktree for `worker_id`.
    ///
    /// Resolves the repository's toplevel from `repo_root_input` and its
    /// `HEAD`, `git worktree add`s a new `swarm/<slug>-<id8>` branch at
    /// `<worktrees_root>/<repo>-<hash8>/w-<id8>`, then `git worktree
    /// lock`s it with the worker's id as the reason, so an orphan can be
    /// attributed. Every mutating git call is serialized per repository
    /// through `repo_locks`.
    ///
    /// # Errors
    ///
    /// [`AppError::Git`] from any step. If the lock fails after the add
    /// succeeded, the new worktree and branch are rolled back first.
    fn create(
        repo_locks: &RepoLocks,
        worktrees_root: &Path,
        worker_id: Uuid,
        worker_name: &str,
        repo_root_input: &str,
    ) -> Result<Self, AppError> {
        let repo_root = git::repo::discover_toplevel(Path::new(repo_root_input))?;
        let base_commit = git::repo::head_sha(&repo_root)?;

        let id8 = short_id8(worker_id);
        let branch = format!("swarm/{}-{id8}", git::slugify(worker_name));
        let repo_name = repo_root
            .file_name()
            .map_or_else(|| "repo".into(), |name| name.to_string_lossy());
        let worktree_path = worktrees_root
            .join(format!(
                "{}-{}",
                git::slugify(&repo_name),
                git::short_hash8(&repo_root.display().to_string())
            ))
            .join(format!("w-{id8}"));

        repo_locks.run_serialized(&repo_root, || {
            git::worktree::add(&repo_root, &worktree_path, &branch, &base_commit)
        })?;
        let isolation = Self {
            repo_root: repo_root.display().to_string(),
            worktree_path: worktree_path.display().to_string(),
            branch,
            base_commit,
        };

        let reason = format!("swarm worker {worker_id}");
        if let Err(e) = repo_locks.run_serialized(&repo_root, || {
            git::worktree::lock(&repo_root, &worktree_path, &reason)
        }) {
            isolation.roll_back(repo_locks, worker_id);
            return Err(e);
        }
        Ok(isolation)
    }

    /// Removes the worktree of a spawn that failed, never with
    /// `--force`, and deletes its branch while it still points at the
    /// base commit.
    ///
    /// Best effort: failures are logged, not returned, because the
    /// caller is already returning the error that made this necessary.
    /// Whatever cannot be removed stays attributable (locked with the
    /// worker's id) or is preserved by git's own dirty-refusal.
    fn roll_back(&self, repo_locks: &RepoLocks, worker_id: Uuid) {
        let repo_root = Path::new(&self.repo_root);
        let worktree_path = Path::new(&self.worktree_path);

        if let Err(e) = repo_locks.run_serialized(repo_root, || {
            git::worktree::unlock(repo_root, worktree_path)
        }) {
            tracing::warn!(%worker_id, error = %e, path = %self.worktree_path, "rollback: unlocking the worktree failed");
        }
        match repo_locks.run_serialized(repo_root, || {
            git::worktree::remove(repo_root, worktree_path)
        }) {
            Ok(RemoveOutcome::Removed) => {
                tracing::info!(%worker_id, path = %self.worktree_path, "rollback: worktree removed");
                delete_isolation_branch_if_unchanged(
                    repo_locks,
                    repo_root,
                    &self.branch,
                    Some(&self.base_commit),
                    worker_id,
                );
            }
            Ok(RemoveOutcome::Preserved { reason }) => {
                tracing::warn!(%worker_id, path = %self.worktree_path, reason, "rollback: worktree preserved (dirty); manual cleanup needed");
            }
            Err(e) => {
                tracing::warn!(%worker_id, error = %e, path = %self.worktree_path, "rollback: removing the worktree failed; manual cleanup needed");
            }
        }
    }
}

/// What happened to an isolated worker's worktree when it was killed:
/// the `disposition` of `worktree_removed`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum WorktreeDisposition {
    /// `git worktree remove` succeeded.
    Removed,
    /// git refused because the worktree has uncommitted or untracked
    /// changes; it stays on disk.
    PreservedDirty,
    /// The unlock or the removal failed for another reason.
    Failed,
}

impl WorktreeDisposition {
    /// The wire name.
    const fn as_str(self) -> &'static str {
        match self {
            Self::Removed => "removed",
            Self::PreservedDirty => "preserved_dirty",
            Self::Failed => "failed",
        }
    }
}

/// A shell started on its PTY whose threads are still parked.
struct StartedShell {
    pid: Option<u32>,
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    pty: PtyChild,
    pump: Parked,
    watcher: Parked,
}

/// Starts `shell` on a new PTY with its output pump and exit watcher
/// (both parked). If a thread cannot be created, the shell is killed and
/// reaped before the error is returned.
fn start_shell(
    sink: &EventSink,
    registry: &WorkerRegistry,
    worker_id: Uuid,
    shell: Option<&str>,
    cwd: &str,
    config: &WorkerConfig,
) -> Result<StartedShell, AppError> {
    let size = PtySize {
        rows: config.rows,
        cols: config.cols,
        pixel_width: 0,
        pixel_height: 0,
    };
    let PtySpawn {
        master,
        writer,
        reader,
        child,
        pid,
    } = pty::spawn_pty(worker_id, shell, cwd, &config.env, size).map_err(|e| {
        tracing::error!(%worker_id, error = %format!("{e:#}"), "PTY spawn failed");
        AppError::PtySpawn(format!("{e:#}"))
    })?;

    let process = Arc::new(Mutex::new(child));
    let (pump, watcher) = spawn_worker_threads(sink, registry, worker_id, &process, reader)
        .map_err(|e| {
            reap(process.lock().as_mut(), worker_id);
            AppError::PtySpawn(format!("cannot start the worker's threads: {e}"))
        })?;

    Ok(StartedShell {
        pid,
        writer: Arc::new(Mutex::new(writer)),
        pty: PtyChild {
            process,
            master: Arc::new(Mutex::new(master)),
        },
        pump,
        watcher,
    })
}

/// Creates a worker's output pump and exit watcher, both parked. The
/// pump wakes the watcher when the output ends, so an exit that closes
/// the terminal is noticed at once rather than at the next poll.
fn spawn_worker_threads(
    sink: &EventSink,
    registry: &WorkerRegistry,
    worker_id: Uuid,
    process: &Arc<Mutex<Box<dyn Child + Send + Sync>>>,
    reader: Box<dyn Read + Send>,
) -> io::Result<(Parked, Parked)> {
    let watcher = pty::spawn_exit_watcher(worker_id, Arc::downgrade(process), {
        let (sink, registry) = (sink.clone(), registry.clone());
        move |status| on_shell_exit(&sink, &registry, worker_id, &status)
    })?;
    let wake = watcher.thread().clone();
    let pump = pty::spawn_output_pump(sink.clone(), worker_id, reader, move || wake.unpark())?;
    Ok((pump, watcher))
}

/// Records a shell that exited on its own: the worker moves to
/// [`WorkerState::Error`] and a `worker_state` event announces it, sent
/// while the registry entry is still locked so the event order matches
/// the mutation order.
/// Nothing happens for a worker that is gone (the kill path reaps its
/// shell itself) or already marked.
fn on_shell_exit(
    sink: &EventSink,
    registry: &WorkerRegistry,
    worker_id: Uuid,
    status: &ExitStatus,
) {
    let announce = || {
        tracing::info!(
            %worker_id,
            exit_code = status.exit_code(),
            signal = status.signal(),
            "worker shell exited on its own"
        );
        sink.emit(SwarmEvent::WorkerState(WorkerStatePayload {
            worker_id,
            state: WorkerState::Error,
        }));
    };
    registry.mark_exited(&worker_id, announce);
}

/// Kills a worker's shell unless it has already exited, then reaps it.
///
/// Checks with `try_wait` first: once a shell has been reaped its pid
/// can be reused, and `portable-pty`'s Unix `kill` signals the pid
/// directly. Failures are logged; the worker is being torn down either
/// way. `portable-pty` 0.9.0's Windows `Child::kill` always returns `Ok`
/// and its Unix `kill` (SIGHUP, about 200 ms of `try_wait`, then SIGKILL)
/// errors only if a signal cannot be delivered, so the `kill` result is
/// advisory: after it, `try_wait` (polled briefly) is the authority on
/// whether the shell is gone, and `wait` reaps it either way.
fn reap(child: &mut dyn Child, worker_id: Uuid) {
    match child.try_wait() {
        Ok(Some(status)) => {
            tracing::debug!(%worker_id, ?status, "worker shell had already exited");
            return;
        }
        Ok(None) => {}
        Err(e) => {
            tracing::warn!(%worker_id, error = %e, "cannot check the worker's shell before killing it")
        }
    }
    let killed = child.kill();
    // 0.9.0's Windows Child::kill discards TerminateProcess's result and
    // always returns Ok, so try_wait is the authority on whether the shell is gone.
    let exited = (0..10).find_map(|i| {
        if i > 0 {
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        child.try_wait().ok().flatten()
    });
    match (exited, killed) {
        (Some(status), _) => tracing::debug!(%worker_id, ?status, "worker shell exited after kill"),
        (None, Err(e)) => {
            tracing::warn!(%worker_id, error = %e, "failed to kill the worker's shell")
        }
        (None, Ok(())) => {
            tracing::warn!(%worker_id, "kill reported success but the shell is still running; waiting")
        }
    }
    match child.wait() {
        Ok(status) => tracing::debug!(%worker_id, ?status, "worker shell reaped"),
        Err(e) => tracing::error!(%worker_id, error = %e, "failed to reap the worker's shell"),
    }
}

/// The directory isolated workers' worktrees are created under.
fn worktrees_root(registry: &WorkerRegistry) -> Result<PathBuf, AppError> {
    let configured = registry.config.read().worktrees_root.clone();
    match configured {
        Some(root) => Ok(root),
        None => Ok(crate::paths::home_dir()?.join(".swarm").join("worktrees")),
    }
}

/// Spawns a worker: a shell on its own PTY, optionally isolated in a
/// fresh git worktree, registered and announced.
///
/// In order:
///
/// 1. Reserves registry capacity ([`WorkerRegistry::reserve`]).
/// 2. When `config.repo_root` is present and `config.isolation` is
///    [`WorkerIsolation::Worktree`], creates and locks the worker's
///    worktree; the shell then starts there instead of at `config.cwd`.
/// 3. Starts the shell (`config.shell`, or the platform default when it
///    is empty) on a PTY of `config.rows` × `config.cols`.
/// 4. Registers the worker as [`WorkerState::Running`] and emits
///    `worker_spawned` (and `worktree_created` when isolated).
/// 5. Starts the worker's output pump (`worker_output` events) and exit
///    watcher: a shell that exits on its own moves the worker to
///    [`WorkerState::Error`] with a `worker_state` event.
///
/// `provenance` attributes the spawn: the new worker's id is the
/// subject (`payload.workerId`), `provenance.origin_worker` the causer
/// (for a tool-driven spawn, the worker whose turn asked for it).
/// `Provenance::default()` for a spawn the user started.
///
/// `config.env` may carry credentials: only its key count is ever
/// logged, and `config` never enters a tracing span.
///
/// # Errors
///
/// - [`AppError::RegistryFull`]: the registry is at capacity; nothing
///   was created.
/// - [`AppError::Git`]: repo discovery, `HEAD` resolution, or `worktree
///   add`/`lock` failed (only with `repo_root`).
/// - [`AppError::Io`]: worktree isolation with no configured
///   `worktrees_root` on a host with no resolvable home directory
///   ([`std::io::ErrorKind::NotFound`]); nothing was created.
/// - [`AppError::PtySpawn`]: the shell could not be started; the
///   worktree, if any, was rolled back.
#[tracing::instrument(skip_all)]
pub fn do_spawn_worker(
    sink: &EventSink,
    registry: &WorkerRegistry,
    repo_locks: &RepoLocks,
    config: WorkerConfig,
    provenance: Provenance,
) -> Result<Uuid, AppError> {
    tracing::info!(
        name = %config.name,
        env_key_count = config.env.len(),
        has_repo_root = config.repo_root.is_some(),
        "spawning worker (env values are never logged)"
    );

    let slot = registry.reserve()?;
    let worker_id = Uuid::new_v4();

    let isolation = match &config.repo_root {
        Some(repo_root) if config.isolation == WorkerIsolation::Worktree => {
            Some(WorktreeIsolation::create(
                repo_locks,
                &worktrees_root(registry)?,
                worker_id,
                &config.name,
                repo_root,
            )?)
        }
        _ => None,
    };

    let cwd = isolation
        .as_ref()
        .map_or(config.cwd.as_str(), |w| w.worktree_path.as_str());
    let shell = Some(config.shell.as_str()).filter(|shell| !shell.trim().is_empty());
    let StartedShell {
        pid,
        writer,
        pty,
        pump,
        watcher,
    } = start_shell(sink, registry, worker_id, shell, cwd, &config).inspect_err(|_| {
        if let Some(w) = &isolation {
            w.roll_back(repo_locks, worker_id);
        }
    })?;

    slot.fill(WorkerHandle {
        id: worker_id,
        state: WorkerState::Running,
        name: config.name.clone(),
        pid,
        started_at: crate::clock::unix_secs(),
        pty_writer: Some(writer),
        child: Some(pty),
        worktree_path: isolation.as_ref().map(|w| w.worktree_path.clone()),
        repo_root: isolation.as_ref().map(|w| w.repo_root.clone()),
        branch: isolation.as_ref().map(|w| w.branch.clone()),
        base_commit: isolation.as_ref().map(|w| w.base_commit.clone()),
        last_shipped_seq: None,
        last_shipped_commit: None,
    });

    let isolation_mode = if isolation.is_some() {
        WorkerIsolation::Worktree
    } else {
        WorkerIsolation::None
    };
    sink.emit_with(
        SwarmEvent::WorkerSpawned(WorkerSpawnedPayload {
            worker_id,
            name: config.name,
            pid,
            isolation: Some(isolation_mode.to_string()),
        }),
        provenance.clone(),
    );
    if let Some(w) = isolation {
        sink.emit_with(
            SwarmEvent::WorktreeCreated(WorktreeCreatedPayload {
                worker_id,
                session_id: None,
                repo_root: w.repo_root,
                worktree_path: w.worktree_path,
                branch: w.branch,
                base_commit: w.base_commit,
            }),
            provenance,
        );
    }

    // Only now may the worker act: its output must follow
    // `worker_spawned`, and its exit must find it registered.
    pump.start();
    watcher.start();
    Ok(worker_id)
}

/// Pauses a running worker: [`WorkerState::Running`] to
/// [`WorkerState::Paused`], then a `worker_state` event.
///
/// State-only on every platform (see [`WorkerState::Paused`]): no signal
/// reaches the process. The check and the write are one atomic
/// [`WorkerRegistry::update_state_if_then`], so a racing resume can
/// never observe a stale state, and the event is sent under the same
/// lock.
///
/// # Errors
///
/// - [`AppError::WorkerNotFound`]: no worker has this id.
/// - [`AppError::Ipc`]: the worker is not running.
#[tracing::instrument(skip(sink, registry))]
pub fn do_pause_worker(
    sink: &EventSink,
    registry: &WorkerRegistry,
    id: Uuid,
    provenance: Provenance,
) -> Result<(), AppError> {
    set_state(
        sink,
        registry,
        id,
        (WorkerState::Running, WorkerState::Paused),
        provenance,
    )
}

/// Resumes a paused worker: [`WorkerState::Paused`] to
/// [`WorkerState::Running`], then a `worker_state` event.
///
/// The check and the write are one atomic
/// [`WorkerRegistry::update_state_if_then`], with the event sent under
/// the same lock.
///
/// # Errors
///
/// - [`AppError::WorkerNotFound`]: no worker has this id.
/// - [`AppError::Ipc`]: the worker is not paused.
#[tracing::instrument(skip(sink, registry))]
pub fn do_resume_worker(
    sink: &EventSink,
    registry: &WorkerRegistry,
    id: Uuid,
    provenance: Provenance,
) -> Result<(), AppError> {
    set_state(
        sink,
        registry,
        id,
        (WorkerState::Paused, WorkerState::Running),
        provenance,
    )
}

/// Moves a worker from `from` to `to` and sends the `worker_state`
/// event under the registry entry lock, so a racing transition (a shell
/// exit, a resume) cannot reorder the events relative to the mutations.
fn set_state(
    sink: &EventSink,
    registry: &WorkerRegistry,
    id: Uuid,
    (from, to): (WorkerState, WorkerState),
    provenance: Provenance,
) -> Result<(), AppError> {
    registry.update_state_if_then(&id, from, to, || {
        sink.emit_with(
            SwarmEvent::WorkerState(WorkerStatePayload {
                worker_id: id,
                state: to,
            }),
            provenance,
        );
    })
}

/// Resizes a worker's terminal to `rows` × `cols` character cells.
///
/// The shell sees the new size at once (`SIGWINCH` on Unix, a
/// pseudoconsole resize on Windows). Allowed in every state, since the
/// terminal outlives an exited shell. No event is emitted: the size is
/// terminal state the frontend owns, not history.
///
/// # Errors
///
/// - [`AppError::WorkerNotFound`]: no worker has this id.
/// - [`AppError::Ipc`]: `rows` or `cols` is zero, the worker has no
///   PTY, or the OS refused the resize.
#[tracing::instrument(skip(registry))]
pub fn do_resize_worker(
    registry: &WorkerRegistry,
    id: Uuid,
    rows: u16,
    cols: u16,
) -> Result<(), AppError> {
    if rows == 0 || cols == 0 {
        return Err(AppError::Ipc(format!(
            "cannot resize worker {id} to {rows}x{cols}: rows and columns must be at least 1"
        )));
    }
    // Clone the master out so the map's shard lock is released before
    // the resize call.
    let master = registry
        .workers
        .get(&id)
        .ok_or_else(|| AppError::WorkerNotFound { id: id.to_string() })?
        .child
        .as_ref()
        .map(|pty| Arc::clone(&pty.master))
        .ok_or_else(|| AppError::Ipc(format!("worker {id} has no PTY")))?;
    let resized = master.lock().resize(PtySize {
        rows,
        cols,
        pixel_width: 0,
        pixel_height: 0,
    });
    resized.map_err(|e| AppError::Ipc(format!("cannot resize worker {id}: {e:#}")))
}

/// Kills a worker and removes it from the registry.
///
/// 1. Removes the worker, so nothing else can reach it.
/// 2. Kills and reaps its shell (unless the shell already exited). Only
///    the shell is signalled; its jobs normally go down with it (Unix:
///    the terminal's session is hung up; Windows: closing the
///    pseudoconsole closes every console client). A process that
///    detached from the terminal can survive and keep the worktree
///    busy, in which case its removal below reports `failed`.
/// 3. Releases the PTY writer and master, only now that the shell is
///    gone: the Unix writer's drop writes to the terminal, and the
///    Windows master's drop closes the pseudoconsole.
/// 4. If the worker was isolated: unlocks and `git worktree remove`s its
///    worktree (never `--force`) and emits `worktree_removed` with the
///    disposition (`removed`/`preserved_dirty`/`failed`). After a clean
///    removal only, deletes the isolation branch if it still points at
///    the worker's base commit (see
///    [`delete_isolation_branch_if_unchanged`]).
/// 5. Emits `worker_killed`.
///
/// # Errors
///
/// [`AppError::WorkerNotFound`]: no worker has this id.
#[tracing::instrument(skip(sink, registry, repo_locks))]
pub fn do_kill_worker(
    sink: &EventSink,
    registry: &WorkerRegistry,
    repo_locks: &RepoLocks,
    id: Uuid,
    provenance: Provenance,
) -> Result<(), AppError> {
    let WorkerHandle {
        pty_writer,
        child,
        worktree_path,
        repo_root,
        branch,
        base_commit,
        ..
    } = registry.remove_worker(&id)?;

    if let Some(pty) = &child {
        reap(pty.process.lock().as_mut(), id);
    }
    drop(pty_writer);
    drop(child);

    if let (Some(worktree_path), Some(repo_root), Some(branch)) = (worktree_path, repo_root, branch)
    {
        let (disposition, head_commit, reason) = remove_worktree(
            repo_locks,
            id,
            Path::new(&repo_root),
            Path::new(&worktree_path),
            &branch,
            base_commit.as_deref(),
        );
        sink.emit_with(
            SwarmEvent::WorktreeRemoved(WorktreeRemovedPayload {
                worker_id: id,
                worktree_path,
                branch,
                disposition: disposition.as_str().to_owned(),
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

/// Unlocks and removes a killed worker's worktree, then deletes its
/// branch after a clean removal if it is unchanged. Returns the
/// disposition, the worktree's `HEAD` before removal, and a reason for
/// anything but a clean removal.
fn remove_worktree(
    repo_locks: &RepoLocks,
    worker_id: Uuid,
    repo_root: &Path,
    worktree_path: &Path,
    branch: &str,
    base_commit: Option<&str>,
) -> (WorktreeDisposition, Option<String>, Option<String>) {
    // Once removed, the directory is gone and `HEAD` no longer resolves.
    let head_commit = git::repo::head_sha(worktree_path).ok();

    // A failed unlock would make `remove` fail for the wrong stated
    // reason (or no-op on a lock git already dropped), so it is reported
    // as the failure it is and the removal is not attempted.
    let removal = repo_locks
        .run_serialized(repo_root, || {
            git::worktree::unlock(repo_root, worktree_path)
        })
        .inspect_err(
            |e| tracing::error!(%worker_id, error = %e, "worktree unlock failed; not removing it"),
        )
        .and_then(|()| {
            repo_locks.run_serialized(repo_root, || {
                git::worktree::remove(repo_root, worktree_path)
            })
        });

    let path = worktree_path.display();
    let (disposition, reason) = match removal {
        Ok(RemoveOutcome::Removed) => {
            tracing::info!(%worker_id, %path, "worktree removed");
            (WorktreeDisposition::Removed, None)
        }
        Ok(RemoveOutcome::Preserved { reason }) => {
            tracing::info!(%worker_id, %path, %reason, "worktree preserved (dirty); SWARM never force-removes");
            (WorktreeDisposition::PreservedDirty, Some(reason))
        }
        Err(e) => {
            tracing::error!(%worker_id, %path, error = %e, "worktree removal failed");
            (WorktreeDisposition::Failed, Some(e.to_string()))
        }
    };

    // Never after `preserved_dirty` (the worktree still has the branch
    // checked out) or `failed` (the state is uncertain). `-d` (never
    // `-D`) additionally makes git refuse an unmerged branch: defense in
    // depth on top of the tip-vs-base check, not a substitute for it.
    if disposition == WorktreeDisposition::Removed {
        delete_isolation_branch_if_unchanged(repo_locks, repo_root, branch, base_commit, worker_id);
    }
    (disposition, head_commit, reason)
}

/// Deletes an isolation branch whose worktree is gone, but only while
/// its tip is still exactly `base_commit` (the worker made no commits),
/// and only with `git branch -d`.
///
/// Best-effort bookkeeping that keeps `swarm/*` branches from piling up
/// in the user's repository: a diverged tip or a failure is logged
/// (`tracing`, not an event; this is not history) and never returned.
fn delete_isolation_branch_if_unchanged(
    repo_locks: &RepoLocks,
    repo_root: &Path,
    branch: &str,
    base_commit: Option<&str>,
    worker_id: Uuid,
) {
    let Some(base_commit) = base_commit else {
        tracing::debug!(%worker_id, branch, "no recorded base commit; branch left in place");
        return;
    };

    let tip = match repo_locks.run_serialized(repo_root, || git::repo::rev_parse(repo_root, branch))
    {
        Ok(tip) => tip,
        Err(e) => {
            tracing::warn!(%worker_id, branch, error = %e, "cannot resolve the branch tip; branch left in place");
            return;
        }
    };
    if tip != base_commit {
        tracing::info!(%worker_id, branch, base_commit, tip, "isolation branch kept: the worker committed to it");
        return;
    }

    match repo_locks.run_serialized(repo_root, || {
        git::worktree::delete_branch(repo_root, branch)
    }) {
        Ok(()) => tracing::info!(%worker_id, branch, "unchanged isolation branch deleted"),
        Err(e) => {
            tracing::warn!(%worker_id, branch, error = %e, "deleting the isolation branch failed; branch left in place");
        }
    }
}

/// Preview text for input a line editor or terminal would act on instead
/// of inserting: no static transform of the bytes can say what the shell
/// saw, so the preview is withheld rather than guessed.
const PREVIEW_WITHHELD: &str = "[preview withheld: line editing]";

/// Characters of a preview kept after redaction.
const PREVIEW_CHARS: usize = 120;

/// Code points that render as nothing yet can split a token the terminal
/// shows whole: every format character (Cf) and every default-ignorable
/// code point (soft hyphen, combining grapheme joiner, variation
/// selectors, tag characters, ...).
static INVISIBLE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"[\p{Cf}\p{Default_Ignorable_Code_Point}]").expect("valid regex"));

/// `true` when `text` holds a control a line editor or terminal acts on
/// instead of inserting: every C0 control except LF and CR, DEL, and every
/// C1 control. BS, DEL and TAB edit or complete the line, ESC starts a
/// sequence (readline's `ESC b`, a CSI cursor key, an OSC title), and the
/// C1 range holds 8-bit forms of the same sequence introducers.
fn is_line_edited(text: &str) -> bool {
    text.chars()
        .any(|c| c.is_control() && !matches!(c, '\n' | '\r'))
}

/// At most 120 characters of `data`, redacted, for the durable
/// `worker_input` event.
///
/// The terminal and the shell read the bytes differently from a static
/// reader, and the redactor must not be fooled by that gap. Input
/// holding any control other than CR or LF is withheld outright
/// ([`PREVIEW_WITHHELD`]): `sk-ant-XX\b\bapi03-…`, a CSI fragment, or
/// readline's Ctrl-A and arrow keys all make the shell receive a key
/// the stored text does not show, and emulating the line discipline is
/// not this function's job. Otherwise [`git::redact::redact`] runs on the
/// raw lossy text (CR and LF are still word breaks there), invisible
/// code points are dropped (they can split a token the shell sees
/// whole), line ends become spaces so they stay word breaks, and
/// redaction runs again on the joined text. All of it precedes the
/// 120-character cut so no fragment survives it. CR overwrite is not
/// modelled: readline and the normal tty mode end the line at CR, so the
/// shell receives two lines. Only for machine-issued input (`tool`,
/// `automation`); `terminal` input never gets one (see
/// `WorkerInputPayload`'s "never carries raw keystrokes" note).
fn stamped_preview(data: &[u8]) -> String {
    let raw = String::from_utf8_lossy(data);
    if is_line_edited(&raw) {
        return PREVIEW_WITHHELD.to_owned();
    }
    let first = git::redact::redact(&raw);
    let visible = INVISIBLE.replace_all(&first, "");
    let flat = visible.replace(['\r', '\n'], " ");
    git::redact::redact(flat.trim_end())
        .chars()
        .take(PREVIEW_CHARS)
        .collect()
}

/// Writes `data` to a worker's PTY, then emits a `worker_input` event
/// recording it (only after a successful write: a failed write had no
/// effect worth recording).
///
/// The writer is cloned out of the registry before the write, which can
/// block while the foreground program is not reading its input: holding
/// the registry's shard lock across it would stall every other operation
/// on that shard, including the kill that would unblock it.
///
/// `source` is [`InputSource::Terminal`] for human keystrokes (no
/// `preview`, and never persisted, see
/// [`crate::orchestration::is_persistent`]), [`InputSource::Tool`] or
/// [`InputSource::Automation`] for machine-issued input (both get a
/// credential-redacted `preview`, or a withheld notice when the input
/// contains any control other than CR or LF). `provenance` is `Provenance::default()`
/// for terminal input: its causer is a person, not a worker's turn.
///
/// # Errors
///
/// - [`AppError::WorkerNotFound`]: no worker has this id.
/// - [`AppError::Ipc`]: the worker's shell has exited, the worker has
///   no PTY writer, or the write failed.
#[tracing::instrument(skip(sink, registry, data))]
pub fn do_worker_input(
    sink: &EventSink,
    registry: &WorkerRegistry,
    id: Uuid,
    data: &[u8],
    source: InputSource,
    provenance: Provenance,
) -> Result<(), AppError> {
    let writer = {
        let entry = registry
            .workers
            .get(&id)
            .ok_or_else(|| AppError::WorkerNotFound { id: id.to_string() })?;
        if entry.state == WorkerState::Error {
            return Err(AppError::Ipc(format!(
                "worker {id} has exited and accepts no input"
            )));
        }
        entry
            .pty_writer
            .clone()
            .ok_or_else(|| AppError::Ipc(format!("worker {id} has no PTY writer")))?
    };
    pty::write_to_pty(writer.lock().as_mut(), data).map_err(|e| AppError::Ipc(format!("{e:#}")))?;

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
