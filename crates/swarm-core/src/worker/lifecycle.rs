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

use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use parking_lot::Mutex;
use portable_pty::{Child, ExitStatus, PtySize};
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
        None => Ok(git::home_dir()?.join(".swarm").join("worktrees")),
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

/// First 120 characters of `data`, control characters stripped and
/// invalid UTF-8 replaced, and recognized credentials replaced with
/// `[REDACTED]` by [`git::redact::redact`] on the full text before
/// truncation, so no fragment survives the cut. Only for machine-issued
/// input (`tool`, `automation`); `terminal` input never gets one (see
/// `WorkerInputPayload`'s "never carries raw keystrokes" note).
fn stamped_preview(data: &[u8]) -> String {
    let printable: String = String::from_utf8_lossy(data)
        .chars()
        .filter(|c| !c.is_control())
        .collect();
    git::redact::redact(&printable).chars().take(120).collect()
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
/// control-stripped, credential-redacted `preview`). `provenance` is `Provenance::default()`
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

#[cfg(test)]
mod tests {
    use std::assert_matches;
    use std::mem::DropGuard;
    use std::sync::mpsc::{Receiver, RecvTimeoutError, channel};
    use std::time::{Duration, Instant};

    use tracing_subscriber::fmt::format::FmtSpan;

    use super::*;
    use crate::events::emitter::WriterMsg;

    /// How long a test waits for a real shell to react.
    const SHELL_TIMEOUT: Duration = Duration::from_secs(30);

    fn test_sink() -> (EventSink, Receiver<WriterMsg>) {
        let (tx, rx) = channel();
        (EventSink::new(tx), rx)
    }

    /// A handle with no PTY, for state and input tests.
    fn make_handle(state: WorkerState) -> WorkerHandle {
        WorkerHandle {
            id: Uuid::new_v4(),
            state,
            name: "test-worker".to_owned(),
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

    /// A `Write` over a shared buffer: a stand-in PTY writer.
    struct SharedBuf(Arc<Mutex<Vec<u8>>>);

    impl Write for SharedBuf {
        fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
            self.0.lock().extend_from_slice(buf);
            Ok(buf.len())
        }
        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    fn make_handle_with_writer(
        state: WorkerState,
        writer: impl Write + Send + 'static,
    ) -> WorkerHandle {
        WorkerHandle {
            pty_writer: Some(Arc::new(Mutex::new(Box::new(writer)))),
            ..make_handle(state)
        }
    }

    fn make_handle_with_pty(state: WorkerState) -> (WorkerHandle, Arc<Mutex<Vec<u8>>>) {
        let buf = Arc::new(Mutex::new(Vec::new()));
        (
            make_handle_with_writer(state, SharedBuf(Arc::clone(&buf))),
            buf,
        )
    }

    /// The next event on `rx` that is not `worker_output` (a real shell
    /// prints its prompt concurrently with everything else).
    fn next_event(rx: &Receiver<WriterMsg>) -> WriterMsg {
        let deadline = Instant::now() + SHELL_TIMEOUT;
        loop {
            let msg = rx
                .recv_timeout(deadline.saturating_duration_since(Instant::now()))
                .expect("timed out waiting for an event");
            if !matches!(msg.event, SwarmEvent::WorkerOutput(_)) {
                return msg;
            }
        }
    }

    /// Every non-output event already queued on `rx`.
    fn queued_events(rx: &Receiver<WriterMsg>) -> Vec<SwarmEvent> {
        rx.try_iter()
            .map(|msg| msg.event)
            .filter(|event| !matches!(event, SwarmEvent::WorkerOutput(_)))
            .collect()
    }

    /// Reads `worker_output` from `rx` until it contains `needle`;
    /// panics with everything read on timeout.
    fn wait_for_output(rx: &Receiver<WriterMsg>, needle: &str) -> String {
        let deadline = Instant::now() + SHELL_TIMEOUT;
        let mut output = String::new();
        while !output.contains(needle) {
            match rx.recv_timeout(deadline.saturating_duration_since(Instant::now())) {
                Ok(WriterMsg {
                    event: SwarmEvent::WorkerOutput(p),
                    ..
                }) => output.push_str(&p.data),
                Ok(_) => {}
                Err(RecvTimeoutError::Timeout | RecvTimeoutError::Disconnected) => {
                    panic!("never saw {needle:?} in the worker's output: {output:?}")
                }
            }
        }
        output
    }

    /// Writes `data` to a worker as terminal input.
    fn type_into(sink: &EventSink, registry: &WorkerRegistry, id: Uuid, data: &str) {
        do_worker_input(
            sink,
            registry,
            id,
            data.as_bytes(),
            InputSource::Terminal,
            Provenance::default(),
        )
        .expect("the worker accepts input");
    }

    /// Makes a freshly spawned default shell ready for input: on
    /// Windows, answers the pseudoconsole's cursor-position query (see
    /// the `pty` module doc), which xterm.js would otherwise answer.
    fn attach_headless_terminal(sink: &EventSink, registry: &WorkerRegistry, id: Uuid) {
        if cfg!(windows) {
            type_into(sink, registry, id, "\x1b[1;1R");
        }
    }

    /// A command line for the default shell that prints `swarm-42-ok`
    /// without that text appearing in the echoed input.
    const fn marker_command() -> (&'static str, &'static str) {
        if cfg!(windows) {
            ("echo \"swarm-$(40+2)-ok\"\r", "swarm-42-ok")
        } else {
            ("echo swarm-$((40+2))-ok\r", "swarm-42-ok")
        }
    }

    // ── state transitions ────────────────────────────────────────────

    #[test]
    fn test_pause_then_resume_transition_and_emit_worker_state() {
        let registry = WorkerRegistry::new();
        let id = registry
            .spawn_worker(make_handle(WorkerState::Running))
            .unwrap();
        let (sink, rx) = test_sink();
        let provenance = Provenance {
            origin_worker: Some(Uuid::new_v4()),
            cause_seq: Some(7),
        };

        do_pause_worker(&sink, &registry, id, provenance.clone()).unwrap();
        assert_eq!(registry.get_worker(&id).unwrap().state, WorkerState::Paused);
        let msg = rx.try_recv().unwrap();
        assert_eq!(msg.provenance.cause_seq, Some(7));
        assert_matches!(
            msg.event,
            SwarmEvent::WorkerState(WorkerStatePayload { worker_id, state: WorkerState::Paused }) if worker_id == id
        );

        do_resume_worker(&sink, &registry, id, Provenance::default()).unwrap();
        assert_eq!(
            registry.get_worker(&id).unwrap().state,
            WorkerState::Running
        );
        assert_matches!(
            rx.try_recv().unwrap().event,
            SwarmEvent::WorkerState(WorkerStatePayload {
                state: WorkerState::Running,
                ..
            })
        );
    }

    /// Emitting under the registry entry lock keeps event order equal to
    /// mutation order: whichever of a pause and a shell exit mutates
    /// last also emits last, so the final `worker_state` event always
    /// names the worker's final state.
    #[test]
    fn test_pause_racing_shell_exit_emits_in_mutation_order() {
        let status = ExitStatus::with_exit_code(0);
        for _ in 0..500 {
            let registry = WorkerRegistry::new();
            let id = registry
                .spawn_worker(make_handle(WorkerState::Running))
                .unwrap();
            let (sink, rx) = test_sink();
            let barrier = std::sync::Barrier::new(2);
            std::thread::scope(|s| {
                s.spawn(|| {
                    barrier.wait();
                    let _ = do_pause_worker(&sink, &registry, id, Provenance::default());
                });
                s.spawn(|| {
                    barrier.wait();
                    on_shell_exit(&sink, &registry, id, &status);
                });
            });

            let last = rx
                .try_iter()
                .filter_map(|m| match m.event {
                    SwarmEvent::WorkerState(p) => Some(p.state),
                    _ => None,
                })
                .last()
                .expect("the exit always announces");
            assert_eq!(last, registry.get_worker(&id).unwrap().state);
            assert_eq!(last, WorkerState::Error, "an exit is never overwritten");
        }
    }

    #[test]
    fn test_pause_rejects_a_worker_that_is_not_running() {
        for state in [WorkerState::Paused, WorkerState::Idle, WorkerState::Error] {
            let registry = WorkerRegistry::new();
            let id = registry.spawn_worker(make_handle(state)).unwrap();
            let (sink, rx) = test_sink();

            let err = do_pause_worker(&sink, &registry, id, Provenance::default()).unwrap_err();
            assert_matches!(err, AppError::Ipc(_));
            assert!(err.to_string().contains(&format!("from {state}")), "{err}");
            assert_eq!(registry.get_worker(&id).unwrap().state, state, "unchanged");
            assert!(rx.try_recv().is_err(), "a refused pause emits nothing");
        }
    }

    #[test]
    fn test_resume_rejects_a_worker_that_is_not_paused() {
        for state in [WorkerState::Running, WorkerState::Idle, WorkerState::Error] {
            let registry = WorkerRegistry::new();
            let id = registry.spawn_worker(make_handle(state)).unwrap();
            let (sink, rx) = test_sink();

            let err = do_resume_worker(&sink, &registry, id, Provenance::default()).unwrap_err();
            assert!(err.to_string().contains(&format!("from {state}")), "{err}");
            assert_eq!(registry.get_worker(&id).unwrap().state, state, "unchanged");
            assert!(rx.try_recv().is_err(), "a refused resume emits nothing");
        }
    }

    #[test]
    fn test_every_operation_reports_an_unknown_worker() {
        let registry = WorkerRegistry::new();
        let repo_locks = RepoLocks::new();
        let (sink, _rx) = test_sink();
        let id = Uuid::new_v4();
        let none = Provenance::default;

        assert_matches!(
            do_pause_worker(&sink, &registry, id, none()),
            Err(AppError::WorkerNotFound { .. })
        );
        assert_matches!(
            do_resume_worker(&sink, &registry, id, none()),
            Err(AppError::WorkerNotFound { .. })
        );
        assert_matches!(
            do_resize_worker(&registry, id, 24, 80),
            Err(AppError::WorkerNotFound { .. })
        );
        assert_matches!(
            do_worker_input(&sink, &registry, id, b"x", InputSource::Terminal, none()),
            Err(AppError::WorkerNotFound { .. })
        );
        assert_matches!(
            do_kill_worker(&sink, &registry, &repo_locks, id, none()),
            Err(AppError::WorkerNotFound { .. })
        );
    }

    // ── input ────────────────────────────────────────────────────────

    #[test]
    fn test_worker_input_no_pty_writer() {
        let registry = WorkerRegistry::new();
        let id = registry
            .spawn_worker(make_handle(WorkerState::Running))
            .unwrap();
        let (sink, _rx) = test_sink();

        let err = do_worker_input(
            &sink,
            &registry,
            id,
            b"hello",
            InputSource::Terminal,
            Provenance::default(),
        )
        .unwrap_err();
        assert!(err.to_string().contains("no PTY writer"), "{err}");
    }

    #[test]
    fn test_worker_input_rejects_a_worker_whose_shell_exited() {
        let registry = WorkerRegistry::new();
        let (handle, buf) = make_handle_with_pty(WorkerState::Error);
        let id = registry.spawn_worker(handle).unwrap();
        let (sink, rx) = test_sink();

        let err = do_worker_input(
            &sink,
            &registry,
            id,
            b"ls\n",
            InputSource::Tool,
            Provenance::default(),
        )
        .unwrap_err();
        assert!(err.to_string().contains("has exited"), "{err}");
        assert!(buf.lock().is_empty(), "nothing was written");
        assert!(rx.try_recv().is_err(), "nothing was recorded");
    }

    /// `do_worker_input` writes to the PTY, then emits a `worker_input`
    /// event carrying the caller's provenance (tool-driven input).
    #[test]
    fn test_worker_input_writes_then_emits_stamped_event() {
        let registry = WorkerRegistry::new();
        let (handle, buf) = make_handle_with_pty(WorkerState::Running);
        let id = registry.spawn_worker(handle).unwrap();
        let (sink, rx) = test_sink();
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
        let SwarmEvent::WorkerInput(p) = msg.event else {
            panic!("expected WorkerInput, got {:?}", msg.event);
        };
        assert_eq!(p.worker_id, id);
        assert_eq!(p.bytes, 11);
        assert_eq!(p.source, InputSource::Tool);
        // The trailing `\n` is a control character, so it is stripped.
        assert_eq!(p.preview.as_deref(), Some("pnpm build"));
    }

    /// Terminal input never carries a preview: human keystrokes are
    /// recorded as a byte count only.
    #[test]
    fn test_worker_input_terminal_source_has_no_preview() {
        let registry = WorkerRegistry::new();
        let (handle, _buf) = make_handle_with_pty(WorkerState::Running);
        let id = registry.spawn_worker(handle).unwrap();
        let (sink, rx) = test_sink();

        do_worker_input(
            &sink,
            &registry,
            id,
            b"super-secret-password\n",
            InputSource::Terminal,
            Provenance::default(),
        )
        .unwrap();

        let SwarmEvent::WorkerInput(p) = rx.recv().unwrap().event else {
            panic!("expected WorkerInput");
        };
        assert_eq!(p.preview, None, "terminal input must never carry a preview");
        assert_eq!(p.bytes, 22);
    }

    /// The preview is control-stripped and capped at 120 characters.
    #[test]
    fn test_worker_input_preview_strips_control_chars_and_truncates() {
        let registry = WorkerRegistry::new();
        let (handle, _buf) = make_handle_with_pty(WorkerState::Running);
        let id = registry.spawn_worker(handle).unwrap();
        let (sink, rx) = test_sink();

        let mut data = format!("\x1b[31m{}", "a".repeat(200)).into_bytes();
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

        let SwarmEvent::WorkerInput(p) = rx.recv().unwrap().event else {
            panic!("expected WorkerInput");
        };
        let preview = p.preview.expect("automation input carries a preview");
        assert_eq!(preview.chars().count(), 120);
        assert!(
            !preview.chars().any(char::is_control),
            "preview must strip control characters, got: {preview:?}"
        );
    }

    /// Machine-issued input can carry a typed credential; the preview is
    /// the only durable copy, so it is redacted before it is stamped.
    #[test]
    fn test_worker_input_preview_redacts_credentials() {
        let registry = WorkerRegistry::new();
        let (handle, _buf) = make_handle_with_pty(WorkerState::Running);
        let id = registry.spawn_worker(handle).unwrap();
        let (sink, rx) = test_sink();

        do_worker_input(
            &sink,
            &registry,
            id,
            b"export K=sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789\n",
            InputSource::Tool,
            Provenance::default(),
        )
        .unwrap();

        let SwarmEvent::WorkerInput(p) = rx.recv().unwrap().event else {
            panic!("expected WorkerInput");
        };
        let preview = p.preview.expect("tool input carries a preview");
        assert!(preview.contains("[REDACTED]"), "got: {preview:?}");
        assert!(!preview.contains("sk-ant-api03"), "got: {preview:?}");
    }

    /// A writer that blocks until released, like a PTY whose
    /// foreground program stopped reading its input.
    struct BlockedWriter {
        entered: std::sync::mpsc::Sender<()>,
        release: Receiver<()>,
    }

    impl Write for BlockedWriter {
        fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
            let _ = self.entered.send(());
            let _ = self.release.recv();
            Ok(buf.len())
        }
        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    /// A write blocked on a full PTY input queue must not hold the
    /// registry's shard lock, or the kill that would unblock it could
    /// never run.
    #[test]
    fn test_kill_is_not_blocked_by_an_input_write_in_progress() {
        let registry = WorkerRegistry::new();
        let repo_locks = RepoLocks::new();
        let (sink, rx) = test_sink();
        let (entered_tx, entered) = channel();
        let (release, release_rx) = channel();
        let id = registry
            .spawn_worker(make_handle_with_writer(
                WorkerState::Running,
                BlockedWriter {
                    entered: entered_tx,
                    release: release_rx,
                },
            ))
            .unwrap();

        std::thread::scope(|scope| {
            let writing = scope.spawn(|| {
                do_worker_input(
                    &sink,
                    &registry,
                    id,
                    b"a large paste",
                    InputSource::Terminal,
                    Provenance::default(),
                )
            });
            entered
                .recv_timeout(SHELL_TIMEOUT)
                .expect("the write started");

            let (killed_tx, killed) = channel();
            let (sink, registry, repo_locks) = (&sink, &registry, &repo_locks);
            scope.spawn(move || {
                let result = do_kill_worker(sink, registry, repo_locks, id, Provenance::default());
                killed_tx.send(result).unwrap();
            });
            let kill_result = killed.recv_timeout(Duration::from_secs(10));
            // Unblock the writer whatever happened, so the scope can end.
            release.send(()).unwrap();

            kill_result
                .expect("the kill must not wait for the blocked write")
                .expect("the kill succeeds");
            writing.join().unwrap().expect("the write itself completes");
        });

        assert_eq!(registry.count(), 0);
        assert!(
            queued_events(&rx)
                .iter()
                .any(|e| matches!(e, SwarmEvent::WorkerKilled(_)))
        );
    }

    // ── resize ───────────────────────────────────────────────────────

    #[test]
    fn test_resize_rejects_zero_dimensions_and_workers_without_a_pty() {
        let registry = WorkerRegistry::new();
        let id = registry
            .spawn_worker(make_handle(WorkerState::Running))
            .unwrap();

        for (rows, cols) in [(0, 80), (24, 0)] {
            let err = do_resize_worker(&registry, id, rows, cols).unwrap_err();
            assert!(err.to_string().contains("at least 1"), "{err}");
        }
        let err = do_resize_worker(&registry, id, 24, 80).unwrap_err();
        assert!(err.to_string().contains("has no PTY"), "{err}");
    }

    // ── tracing never records env values ─────────────────────────────

    /// `Write` + `MakeWriter` over a shared buffer, so a
    /// `tracing_subscriber::fmt` subscriber writes into memory the test
    /// can inspect.
    #[derive(Clone, Default)]
    struct TracingCaptureBuf(Arc<Mutex<Vec<u8>>>);

    impl Write for TracingCaptureBuf {
        fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
            self.0.lock().extend_from_slice(buf);
            Ok(buf.len())
        }
        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    impl<'a> tracing_subscriber::fmt::MakeWriter<'a> for TracingCaptureBuf {
        type Writer = Self;
        fn make_writer(&'a self) -> Self::Writer {
            self.clone()
        }
    }

    const SECRET: &str = "sk-ant-super-secret-value-should-never-be-logged";

    /// Runs `do_spawn_worker` with a secret-bearing env under a
    /// subscriber that prints every event and every span's fields as
    /// the span opens, and returns the spawn result and all output.
    fn spawn_under_capture(shell: &str) -> (Result<Uuid, AppError>, String, WorkerRegistry) {
        let capture = TracingCaptureBuf::default();
        let subscriber = tracing_subscriber::fmt()
            .with_writer(capture.clone())
            .with_max_level(tracing::Level::DEBUG)
            .with_span_events(FmtSpan::NEW)
            .with_ansi(false)
            .finish();

        let registry = WorkerRegistry::new();
        let repo_locks = RepoLocks::new();
        let (sink, _rx) = test_sink();
        let config = WorkerConfig {
            name: "Secret Bearer".to_owned(),
            shell: shell.to_owned(),
            env: [("ANTHROPIC_API_KEY".to_owned(), SECRET.to_owned())].into(),
            ..WorkerConfig::default()
        };

        let result = tracing::subscriber::with_default(subscriber, || {
            do_spawn_worker(&sink, &registry, &repo_locks, config, Provenance::default())
        });
        if let Ok(id) = result {
            do_kill_worker(&sink, &registry, &repo_locks, id, Provenance::default()).unwrap();
        }
        let captured = String::from_utf8_lossy(&capture.0.lock()).into_owned();
        (result, captured, registry)
    }

    /// `spawn_pty`'s span records `env_key_count`, never `env` values, so
    /// nothing logged inside it, and no span-printing layer, can leak
    /// per-profile API keys. Asserted with span fields printed, so the
    /// test cannot pass vacuously.
    #[test]
    fn test_spawn_never_records_env_values_in_events_or_spans() {
        let (result, captured, _) = spawn_under_capture("");
        result.expect("the default shell spawns");
        assert!(
            !captured.contains(SECRET),
            "tracing output leaked an env value: {captured}"
        );
        assert!(
            captured.contains("spawn_pty") && captured.contains("env_key_count=1"),
            "spawn_pty's span (with its redacted fields) must have been printed: {captured}"
        );
        assert!(
            captured.contains("Secret Bearer"),
            "the spawn's redacted summary must have been printed: {captured}"
        );
    }

    /// The failure path logs inside `spawn_pty`'s span: still no secret.
    #[test]
    fn test_a_failed_spawn_never_records_env_values() {
        let (result, captured, registry) = spawn_under_capture("swarm-no-such-shell-xyz");
        assert_matches!(result, Err(AppError::PtySpawn(_)));
        assert!(
            captured.contains("PTY spawn failed"),
            "the failure must have been logged: {captured}"
        );
        assert!(
            !captured.contains(SECRET),
            "tracing output leaked an env value: {captured}"
        );
        assert_eq!(registry.count(), 0);
    }

    // ── real shells ──────────────────────────────────────────────────

    /// On Windows the pseudoconsole outlives `spawn_pty`'s return: the
    /// shell must be alive after the spawn and answer input.
    #[test]
    fn test_spawned_shell_stays_alive_and_answers_input() {
        let registry = WorkerRegistry::new();
        let repo_locks = RepoLocks::new();
        let (sink, rx) = test_sink();

        let id = do_spawn_worker(
            &sink,
            &registry,
            &repo_locks,
            WorkerConfig::default(),
            Provenance::default(),
        )
        .expect("the default shell spawns");
        assert_matches!(
            next_event(&rx).event,
            SwarmEvent::WorkerSpawned(WorkerSpawnedPayload { worker_id, .. }) if worker_id == id
        );

        attach_headless_terminal(&sink, &registry, id);
        let (command, marker) = marker_command();
        type_into(&sink, &registry, id, command);
        wait_for_output(&rx, marker);

        let still_running = registry
            .workers
            .get(&id)
            .unwrap()
            .child
            .as_ref()
            .unwrap()
            .process
            .lock()
            .try_wait()
            .unwrap()
            .is_none();
        assert!(still_running, "the shell is still running after answering");
        assert_eq!(
            registry.get_worker(&id).unwrap().state,
            WorkerState::Running
        );

        do_kill_worker(&sink, &registry, &repo_locks, id, Provenance::default()).unwrap();
    }

    /// The PTY master is kept, so the terminal can be resized after the
    /// spawn and the shell sees the new size.
    #[test]
    fn test_resize_reaches_the_shell() {
        let registry = WorkerRegistry::new();
        let repo_locks = RepoLocks::new();
        let (sink, rx) = test_sink();
        let id = do_spawn_worker(
            &sink,
            &registry,
            &repo_locks,
            WorkerConfig::default(),
            Provenance::default(),
        )
        .unwrap();
        attach_headless_terminal(&sink, &registry, id);

        do_resize_worker(&registry, id, 33, 101).expect("resize succeeds");

        let size = registry
            .workers
            .get(&id)
            .unwrap()
            .child
            .as_ref()
            .unwrap()
            .master
            .lock()
            .get_size()
            .unwrap();
        assert_eq!((size.rows, size.cols), (33, 101));
        let (command, marker) = if cfg!(windows) {
            (
                "echo \"size-$([Console]::WindowHeight)x$([Console]::WindowWidth)\"\r",
                "size-33x101",
            )
        } else {
            ("echo size-$(stty size | tr ' ' x)\r", "size-33x101")
        };
        type_into(&sink, &registry, id, command);
        wait_for_output(&rx, marker);

        do_kill_worker(&sink, &registry, &repo_locks, id, Provenance::default()).unwrap();
    }

    /// A shell that exits on its own moves its worker to `error`,
    /// announced by a `worker_state` event; the worker then refuses input
    /// and is still killable.
    #[test]
    fn test_a_shell_that_exits_on_its_own_marks_its_worker_errored() {
        let registry = WorkerRegistry::new();
        let repo_locks = RepoLocks::new();
        let (sink, rx) = test_sink();
        let id = do_spawn_worker(
            &sink,
            &registry,
            &repo_locks,
            WorkerConfig::default(),
            Provenance::default(),
        )
        .unwrap();
        assert_matches!(next_event(&rx).event, SwarmEvent::WorkerSpawned(_));

        attach_headless_terminal(&sink, &registry, id);
        type_into(&sink, &registry, id, "exit\r");
        loop {
            match next_event(&rx).event {
                SwarmEvent::WorkerInput(_) => {}
                SwarmEvent::WorkerState(p) => {
                    assert_eq!((p.worker_id, p.state), (id, WorkerState::Error));
                    break;
                }
                other => panic!("unexpected event {other:?}"),
            }
        }
        assert_eq!(registry.get_worker(&id).unwrap().state, WorkerState::Error);
        assert_eq!(registry.aggregate_metrics().errored, 1);
        let err = do_worker_input(
            &sink,
            &registry,
            id,
            b"echo hi\r",
            InputSource::Terminal,
            Provenance::default(),
        )
        .unwrap_err();
        assert!(err.to_string().contains("has exited"), "{err}");

        do_kill_worker(&sink, &registry, &repo_locks, id, Provenance::default()).unwrap();
        assert_matches!(next_event(&rx).event, SwarmEvent::WorkerKilled(_));
        assert_eq!(registry.count(), 0);
    }

    #[test]
    fn test_spawn_without_repo_root_is_unisolated() {
        let registry = WorkerRegistry::new();
        let repo_locks = RepoLocks::new();
        let (sink, rx) = test_sink();

        let config = WorkerConfig {
            name: "Plain Worker".to_owned(),
            ..WorkerConfig::default()
        };
        assert!(config.repo_root.is_none());
        let id = do_spawn_worker(&sink, &registry, &repo_locks, config, Provenance::default())
            .expect("an unisolated spawn succeeds");

        let info = registry.get_worker(&id).unwrap();
        assert!(info.worktree_path.is_none());
        assert!(info.branch.is_none());

        // `worker_spawned` says `none`, and no `worktree_created` follows
        // (it would have been emitted before the spawn returned).
        let events = queued_events(&rx);
        let [SwarmEvent::WorkerSpawned(p)] = events.as_slice() else {
            panic!("expected exactly worker_spawned, got {events:?}");
        };
        assert_eq!(p.isolation.as_deref(), Some("none"));

        do_kill_worker(&sink, &registry, &repo_locks, id, Provenance::default()).unwrap();
    }

    // ── worktree isolation ───────────────────────────────────────────

    /// A disposable git repository with one commit, plus a worktrees
    /// root next to it, both removed when the returned guard drops.
    struct TempRepo {
        root: PathBuf,
        worktrees: PathBuf,
    }

    fn temp_repo() -> DropGuard<TempRepo, impl FnOnce(TempRepo)> {
        let base = std::env::temp_dir().join(format!("swarm-lifecycle-git-{}", Uuid::new_v4()));
        let root = base.join("repo");
        std::fs::create_dir_all(&root).unwrap();

        let run = |args: &[&str]| {
            let mut full = git::repo::base_args(&root);
            full.extend(args.iter().map(ToString::to_string));
            let out = git::cli::run(&full, git::cli::CREATE_TIMEOUT).unwrap();
            assert!(out.success(), "git setup failed: {} ({full:?})", out.stderr);
        };
        run(&["init"]);
        run(&["config", "user.email", "swarm-test@example.com"]);
        run(&["config", "user.name", "Swarm Test"]);
        std::fs::write(root.join("README.md"), "hello").unwrap();
        run(&["add", "-A"]);
        run(&["commit", "-m", "initial"]);

        DropGuard::new(
            TempRepo {
                root,
                worktrees: base.join("worktrees"),
            },
            move |_| {
                let _ = std::fs::remove_dir_all(base);
            },
        )
    }

    /// A registry whose isolated workers live under `repo.worktrees`
    /// instead of the real `~/.swarm/worktrees`.
    fn registry_for(repo: &TempRepo) -> WorkerRegistry {
        let registry = WorkerRegistry::new();
        registry.config.write().worktrees_root = Some(repo.worktrees.clone());
        registry
    }

    fn isolated_config(repo: &TempRepo, name: &str) -> WorkerConfig {
        WorkerConfig {
            name: name.to_owned(),
            repo_root: Some(repo.root.display().to_string()),
            ..WorkerConfig::default()
        }
    }

    /// Output lines of `git <args>` run in `repo`.
    fn git_lines(repo: &Path, args: &[&str]) -> Vec<String> {
        let mut full = git::repo::base_args(repo);
        full.extend(args.iter().map(ToString::to_string));
        let out = git::cli::run(&full, git::cli::CREATE_TIMEOUT).unwrap();
        assert!(out.success(), "git {args:?} failed: {}", out.stderr);
        String::from_utf8_lossy(&out.stdout)
            .lines()
            .map(str::to_owned)
            .collect()
    }

    fn swarm_branches(repo: &Path) -> Vec<String> {
        git_lines(repo, &["branch", "--list", "swarm/*"])
    }

    /// Every `w-*` worktree directory under `worktrees`.
    fn worktree_dirs(worktrees: &Path) -> Vec<PathBuf> {
        let Ok(repos) = std::fs::read_dir(worktrees) else {
            return Vec::new();
        };
        repos
            .flatten()
            .flat_map(|repo| {
                std::fs::read_dir(repo.path())
                    .into_iter()
                    .flatten()
                    .flatten()
            })
            .map(|entry| entry.path())
            .collect()
    }

    /// `repo_root` that is not a git repository fails the whole spawn;
    /// there is no fallback to an unisolated worker at `config.cwd`.
    #[test]
    fn test_spawn_hard_fails_when_repo_root_is_not_a_git_repo() {
        let not_a_repo = std::env::temp_dir().join(format!("swarm-not-a-repo-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&not_a_repo).unwrap();
        let _cleanup = DropGuard::new(not_a_repo.clone(), |dir| {
            let _ = std::fs::remove_dir_all(dir);
        });

        let registry = WorkerRegistry::new();
        registry.set_max_workers(1).unwrap();
        let repo_locks = RepoLocks::new();
        let (sink, rx) = test_sink();
        let config = WorkerConfig {
            name: "Doomed Worker".to_owned(),
            repo_root: Some(not_a_repo.display().to_string()),
            isolation: WorkerIsolation::Worktree,
            ..WorkerConfig::default()
        };

        let result = do_spawn_worker(&sink, &registry, &repo_locks, config, Provenance::default());
        assert_matches!(result, Err(AppError::Git(_)));
        assert_eq!(registry.count(), 0, "nothing may be registered");
        assert!(rx.try_recv().is_err(), "nothing may be announced");
        assert!(
            registry.reserve().is_ok(),
            "the reserved slot was given back"
        );
    }

    /// `RegistryFull` is detected before any side effect, so a spawn at
    /// capacity creates nothing: no worktree, branch or shell.
    #[test]
    fn test_spawn_at_capacity_creates_no_worktree_branch_or_shell() {
        let repo = temp_repo();
        let registry = registry_for(&repo);
        registry.set_max_workers(1).unwrap();
        let repo_locks = RepoLocks::new();
        let (sink, rx) = test_sink();

        let first = do_spawn_worker(
            &sink,
            &registry,
            &repo_locks,
            isolated_config(&repo, "First"),
            Provenance::default(),
        )
        .unwrap();
        let before = queued_events(&rx).len();

        let second = do_spawn_worker(
            &sink,
            &registry,
            &repo_locks,
            isolated_config(&repo, "Second"),
            Provenance::default(),
        );
        assert_matches!(second, Err(AppError::RegistryFull { max: 1 }));

        assert_eq!(registry.count(), 1);
        assert_eq!(
            worktree_dirs(&repo.worktrees).len(),
            1,
            "no second worktree"
        );
        assert_eq!(swarm_branches(&repo.root).len(), 1, "no second branch");
        assert_eq!(
            git_lines(&repo.root, &["worktree", "list", "--porcelain"])
                .iter()
                .filter(|line| line.starts_with("worktree "))
                .count(),
            2,
            "the main worktree and the first worker's only"
        );
        assert_eq!(before, 2, "worker_spawned + worktree_created for the first");
        assert!(
            queued_events(&rx).is_empty(),
            "the refused spawn announced nothing"
        );

        do_kill_worker(&sink, &registry, &repo_locks, first, Provenance::default()).unwrap();
        assert!(worktree_dirs(&repo.worktrees).is_empty());
        assert!(swarm_branches(&repo.root).is_empty());
    }

    /// A shell that cannot start rolls back the worktree it was going to
    /// run in, including its branch, and gives the reserved slot back.
    #[test]
    fn test_failed_shell_spawn_rolls_back_worktree_branch_and_slot() {
        let repo = temp_repo();
        let registry = registry_for(&repo);
        registry.set_max_workers(1).unwrap();
        let repo_locks = RepoLocks::new();
        let (sink, rx) = test_sink();

        let result = do_spawn_worker(
            &sink,
            &registry,
            &repo_locks,
            WorkerConfig {
                shell: "swarm-no-such-shell-xyz".to_owned(),
                ..isolated_config(&repo, "Broken Shell")
            },
            Provenance::default(),
        );
        assert_matches!(result, Err(AppError::PtySpawn(_)));
        assert_eq!(registry.count(), 0);
        assert!(
            worktree_dirs(&repo.worktrees).is_empty(),
            "worktree rolled back"
        );
        assert!(swarm_branches(&repo.root).is_empty(), "branch rolled back");
        assert!(rx.try_recv().is_err(), "nothing was announced");

        let id = do_spawn_worker(
            &sink,
            &registry,
            &repo_locks,
            WorkerConfig::default(),
            Provenance::default(),
        )
        .expect("the only slot is free again");
        do_kill_worker(&sink, &registry, &repo_locks, id, Provenance::default()).unwrap();
    }

    /// End to end: an isolated worker gets its worktree and branch,
    /// `worktree_created` describes them, and a clean kill removes the
    /// worktree (`worktree_removed` `removed`) before `worker_killed`.
    #[test]
    fn test_spawn_and_kill_isolated_worker_full_cycle() {
        let repo = temp_repo();
        let registry = registry_for(&repo);
        let repo_locks = RepoLocks::new();
        let (sink, rx) = test_sink();

        let id = do_spawn_worker(
            &sink,
            &registry,
            &repo_locks,
            isolated_config(&repo, "Research Agent"),
            Provenance::default(),
        )
        .expect("an isolated spawn succeeds against a real git repo");

        let info = registry.get_worker(&id).unwrap();
        let worktree_path = info.worktree_path.clone().expect("worktree_path is set");
        assert!(Path::new(&worktree_path).starts_with(&repo.worktrees));
        assert!(worktree_path.contains("w-"));
        let branch = info.branch.clone().expect("branch is set");
        assert!(branch.starts_with("swarm/research-agent-"));
        assert!(Path::new(&worktree_path).join("README.md").exists());

        let SwarmEvent::WorkerSpawned(spawned) = next_event(&rx).event else {
            panic!("expected worker_spawned");
        };
        assert_eq!(spawned.isolation.as_deref(), Some("worktree"));
        let SwarmEvent::WorktreeCreated(created) = next_event(&rx).event else {
            panic!("expected worktree_created");
        };
        assert_eq!(created.worker_id, id);
        assert_eq!(created.worktree_path, worktree_path);
        assert_eq!(created.branch, branch);
        assert!(!created.base_commit.is_empty());

        do_kill_worker(&sink, &registry, &repo_locks, id, Provenance::default()).unwrap();

        let SwarmEvent::WorktreeRemoved(removed) = next_event(&rx).event else {
            panic!("expected worktree_removed before worker_killed");
        };
        assert_eq!(removed.disposition, "removed");
        assert_eq!(removed.worktree_path, worktree_path);
        assert!(removed.reason.is_none());
        assert_matches!(
            next_event(&rx).event,
            SwarmEvent::WorkerKilled(WorkerKilledPayload { worker_id }) if worker_id == id
        );
        assert!(
            !Path::new(&worktree_path).exists(),
            "a clean worktree is removed from disk on kill"
        );
    }

    /// A clean kill whose branch tip is still the base commit (no
    /// commits made) also deletes the branch, so `swarm/*` branches do
    /// not pile up in the user's repository.
    #[test]
    fn test_kill_deletes_unchanged_isolation_branch() {
        let repo = temp_repo();
        let registry = registry_for(&repo);
        let repo_locks = RepoLocks::new();
        let (sink, rx) = test_sink();

        let id = do_spawn_worker(
            &sink,
            &registry,
            &repo_locks,
            isolated_config(&repo, "Clean Agent"),
            Provenance::default(),
        )
        .unwrap();
        let branch = registry.get_worker(&id).unwrap().branch.unwrap();
        assert!(git::repo::rev_parse(&repo.root, &branch).is_ok());

        do_kill_worker(&sink, &registry, &repo_locks, id, Provenance::default()).unwrap();

        let removed = queued_events(&rx).into_iter().find_map(|e| match e {
            SwarmEvent::WorktreeRemoved(p) => Some(p),
            _ => None,
        });
        assert_eq!(removed.unwrap().disposition, "removed");
        assert!(
            git::repo::rev_parse(&repo.root, &branch).is_err(),
            "an unchanged isolation branch is deleted after a clean kill"
        );
    }

    /// A worker that committed in its worktree keeps its branch: the
    /// commit leaves the tree clean (disposition `removed`), but the tip
    /// has moved past the base commit. The commit is also merged into the
    /// repo root's HEAD, so `git branch -d` alone would not keep it.
    #[test]
    fn test_kill_retains_diverged_isolation_branch() {
        let repo = temp_repo();
        let registry = registry_for(&repo);
        let repo_locks = RepoLocks::new();
        let (sink, rx) = test_sink();

        let id = do_spawn_worker(
            &sink,
            &registry,
            &repo_locks,
            isolated_config(&repo, "Committing Agent"),
            Provenance::default(),
        )
        .unwrap();
        let info = registry.get_worker(&id).unwrap();
        let branch = info.branch.unwrap();
        let worktree = PathBuf::from(info.worktree_path.unwrap());

        std::fs::write(worktree.join("agent-output.txt"), "real work").unwrap();
        git_lines(&worktree, &["add", "-A"]);
        git_lines(&worktree, &["commit", "-m", "agent work"]);
        // Fast-forward the repo root's HEAD onto the worker's commit:
        // `git branch -d` would now delete the branch, so only the
        // tip-vs-base check can keep it.
        git_lines(&repo.root, &["merge", "--ff-only", branch.as_str()]);

        do_kill_worker(&sink, &registry, &repo_locks, id, Provenance::default()).unwrap();

        let removed = queued_events(&rx).into_iter().find_map(|e| match e {
            SwarmEvent::WorktreeRemoved(p) => Some(p),
            _ => None,
        });
        assert_eq!(removed.unwrap().disposition, "removed");
        assert!(
            git::repo::rev_parse(&repo.root, &branch).is_ok(),
            "a diverged isolation branch must not be deleted"
        );
    }

    /// A failed unlock is reported as `failed` and the removal is not
    /// attempted.
    #[test]
    fn test_kill_reports_failed_when_unlock_fails() {
        let repo = temp_repo();
        let registry = registry_for(&repo);
        let repo_locks = RepoLocks::new();
        let (sink, rx) = test_sink();

        let id = do_spawn_worker(
            &sink,
            &registry,
            &repo_locks,
            isolated_config(&repo, "Unlock Fail Agent"),
            Provenance::default(),
        )
        .unwrap();
        let worktree_path = registry.get_worker(&id).unwrap().worktree_path.unwrap();

        // Unlock out of band first, so git reports "not locked".
        git::worktree::unlock(&repo.root, Path::new(&worktree_path)).unwrap();

        do_kill_worker(&sink, &registry, &repo_locks, id, Provenance::default()).unwrap();

        let removed = queued_events(&rx).into_iter().find_map(|e| match e {
            SwarmEvent::WorktreeRemoved(p) => Some(p),
            _ => None,
        });
        let removed = removed.expect("worktree_removed is emitted");
        assert_eq!(removed.disposition, "failed");
        assert!(removed.reason.is_some());
        assert!(
            Path::new(&worktree_path).exists(),
            "remove() was never attempted"
        );
    }

    /// Preserve-on-dirty through the real kill path: a worktree with
    /// uncommitted work survives the kill (`preserved_dirty`, with git's
    /// refusal as the reason), and so does the work.
    #[test]
    fn test_kill_preserves_dirty_worktree_instead_of_deleting_it() {
        let repo = temp_repo();
        let registry = registry_for(&repo);
        let repo_locks = RepoLocks::new();
        let (sink, rx) = test_sink();

        let id = do_spawn_worker(
            &sink,
            &registry,
            &repo_locks,
            isolated_config(&repo, "Dirty Agent"),
            Provenance::default(),
        )
        .unwrap();
        let worktree = PathBuf::from(registry.get_worker(&id).unwrap().worktree_path.unwrap());
        std::fs::write(worktree.join("scratch.txt"), "uncommitted agent output").unwrap();

        do_kill_worker(&sink, &registry, &repo_locks, id, Provenance::default()).unwrap();

        let removed = queued_events(&rx).into_iter().find_map(|e| match e {
            SwarmEvent::WorktreeRemoved(p) => Some(p),
            _ => None,
        });
        let removed = removed.expect("worktree_removed is emitted");
        assert_eq!(removed.disposition, "preserved_dirty");
        assert!(
            removed.reason.is_some(),
            "preserved_dirty carries git's refusal"
        );
        assert!(
            worktree.join("scratch.txt").exists(),
            "SWARM never force-removes"
        );
    }
}
