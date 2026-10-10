//! The concurrent store of live workers.
//!
//! [`WorkerRegistry`] maps worker ids to their [`WorkerHandle`]s in a
//! `DashMap` (a sharded map: every access takes one shard's read or
//! write lock, never a global lock) and holds the system-wide
//! [`SystemConfig`] behind a `parking_lot::RwLock`. Capacity is admitted
//! through [`WorkerRegistry::reserve`], so a spawn the registry would
//! reject is refused before it creates anything.

use std::path::PathBuf;
use std::sync::Arc;

use dashmap::DashMap;
use parking_lot::{Mutex, RwLock};
use uuid::Uuid;

use super::handle::{WorkerHandle, WorkerInfo, WorkerState};
use crate::error::AppError;

/// Unique identifier of a worker (a UUID v4).
pub type WorkerId = Uuid;

/// Lowest accepted `max_workers` value.
pub const MIN_MAX_WORKERS: usize = 1;
/// Highest accepted `max_workers` value. Every worker is a shell on its
/// own PTY plus two threads; anything beyond this is almost certainly a
/// misconfiguration.
pub const MAX_MAX_WORKERS: usize = 256;

/// Default `max_workers`.
const DEFAULT_MAX_WORKERS: usize = 64;

/// System-wide configuration shared by every worker.
///
/// # Examples
///
/// ```
/// use swarm_core::worker::registry::SystemConfig;
///
/// let config = SystemConfig::default();
/// assert_eq!(config.max_workers, 64);
/// assert!(config.worktrees_root.is_none());
/// ```
#[derive(Debug, Clone)]
pub struct SystemConfig {
    /// Most workers that may be registered at once (default 64,
    /// configurable within [`MIN_MAX_WORKERS`]..=[`MAX_MAX_WORKERS`]).
    pub max_workers: usize,
    /// Directory isolated workers' git worktrees are created under.
    /// `None` (the default) means `~/.swarm/worktrees`.
    pub worktrees_root: Option<PathBuf>,
}

impl Default for SystemConfig {
    fn default() -> Self {
        Self {
            max_workers: DEFAULT_MAX_WORKERS,
            worktrees_root: None,
        }
    }
}

/// Count of registered workers in each [`WorkerState`], computed by
/// [`WorkerRegistry::aggregate_metrics`].
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AggregateMetrics {
    /// Total number of registered workers.
    pub total_workers: usize,
    /// Workers in [`WorkerState::Running`].
    pub running: usize,
    /// Workers in [`WorkerState::Paused`].
    pub paused: usize,
    /// Workers in [`WorkerState::Idle`].
    pub idle: usize,
    /// Workers in [`WorkerState::Error`] (their shell exited).
    pub errored: usize,
}

/// Thread-safe registry of every live worker: the single source of
/// truth for worker state in the backend.
///
/// Cloning is cheap (three `Arc` bumps) and every clone shares the same
/// map, config and admission state.
///
/// # Concurrency
///
/// - Reads (`get_worker`, `list_workers`, `count`) take shard read
///   locks, so they can wait behind a writer on the same shard. Hold a
///   `workers` guard only for as long as it takes to copy what you need
///   out of it; never across blocking I/O.
/// - Writes (`spawn_worker`, `remove_worker`, the state transitions)
///   take one shard's write lock.
/// - Admission ([`Self::reserve`]) is serialized by its own lock, so
///   concurrent spawns can never exceed `max_workers`.
///
/// # Examples
///
/// ```
/// use swarm_core::worker::registry::WorkerRegistry;
///
/// let registry = WorkerRegistry::new();
/// assert_eq!(registry.count(), 0);
/// ```
#[derive(Clone)]
pub struct WorkerRegistry {
    /// Worker id to handle.
    pub workers: Arc<DashMap<WorkerId, WorkerHandle>>,
    /// Shared system configuration.
    pub config: Arc<RwLock<SystemConfig>>,
    /// Slots reserved by [`Self::reserve`] and not yet filled or
    /// released. Its lock is the admission lock.
    pending: Arc<Mutex<usize>>,
}

/// A capacity slot reserved by [`WorkerRegistry::reserve`].
///
/// Holding one guarantees the worker it is for can be registered with
/// [`Self::fill`], which cannot fail. Dropping it unfilled (the spawn
/// failed) gives the slot back.
#[must_use = "a reserved slot is given back as soon as it is dropped"]
pub struct SpawnSlot<'r> {
    registry: &'r WorkerRegistry,
    filled: bool,
}

impl std::fmt::Debug for SpawnSlot<'_> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SpawnSlot")
            .field("filled", &self.filled)
            .finish_non_exhaustive()
    }
}

impl SpawnSlot<'_> {
    /// Registers `handle` in the reserved slot and returns its id.
    pub fn fill(mut self, handle: WorkerHandle) -> WorkerId {
        let id = handle.id;
        // Insert and release the reservation under the admission lock,
        // so a concurrent `reserve` never counts this worker twice.
        let mut pending = self.registry.pending.lock();
        self.registry.workers.insert(id, handle);
        *pending -= 1;
        self.filled = true;
        tracing::info!(worker_id = %id, "worker registered");
        id
    }
}

impl Drop for SpawnSlot<'_> {
    fn drop(&mut self) {
        if !self.filled {
            *self.registry.pending.lock() -= 1;
        }
    }
}

impl WorkerRegistry {
    /// Creates an empty registry with [`SystemConfig::default`].
    ///
    /// # Examples
    ///
    /// ```
    /// use swarm_core::worker::registry::WorkerRegistry;
    ///
    /// let registry = WorkerRegistry::new();
    /// assert_eq!(registry.count(), 0);
    /// ```
    pub fn new() -> Self {
        Self {
            workers: Arc::new(DashMap::new()),
            config: Arc::new(RwLock::new(SystemConfig::default())),
            pending: Arc::new(Mutex::new(0)),
        }
    }

    /// Number of registered workers (reserved but unfilled slots are
    /// not counted).
    pub fn count(&self) -> usize {
        self.workers.len()
    }

    /// Updates the maximum concurrent worker cap.
    ///
    /// Applies to every later [`Self::reserve`]. Shrinking below the
    /// current worker count is allowed: running workers are never
    /// evicted, new spawns are refused until the count drops below the
    /// cap.
    ///
    /// # Errors
    ///
    /// [`AppError::Config`] if `max` is outside
    /// [`MIN_MAX_WORKERS`]..=[`MAX_MAX_WORKERS`].
    ///
    /// # Examples
    ///
    /// ```
    /// use swarm_core::worker::registry::WorkerRegistry;
    ///
    /// let registry = WorkerRegistry::new();
    /// registry.set_max_workers(8).unwrap();
    /// assert_eq!(registry.config.read().max_workers, 8);
    /// assert!(registry.set_max_workers(0).is_err());
    /// assert!(registry.set_max_workers(1000).is_err());
    /// ```
    pub fn set_max_workers(&self, max: usize) -> Result<(), AppError> {
        if !(MIN_MAX_WORKERS..=MAX_MAX_WORKERS).contains(&max) {
            return Err(AppError::Config(format!(
                "max_workers must be between {MIN_MAX_WORKERS} and {MAX_MAX_WORKERS}, got {max}"
            )));
        }
        self.config.write().max_workers = max;
        tracing::info!(max_workers = max, "worker registry cap updated");
        Ok(())
    }

    /// Reserves capacity for one worker.
    ///
    /// Call this before creating anything for a new worker (worktree,
    /// process): a spawn the registry would refuse then fails without
    /// side effects. Registered workers and outstanding reservations both
    /// count against `max_workers`, checked and taken under one lock, so
    /// concurrent spawns can never exceed the cap.
    ///
    /// # Errors
    ///
    /// [`AppError::RegistryFull`] if the registry is at capacity.
    ///
    /// # Examples
    ///
    /// ```
    /// use swarm_core::worker::registry::WorkerRegistry;
    ///
    /// let registry = WorkerRegistry::new();
    /// registry.set_max_workers(1).unwrap();
    /// let slot = registry.reserve().unwrap();
    /// assert!(registry.reserve().is_err(), "the only slot is reserved");
    /// drop(slot);
    /// assert!(registry.reserve().is_ok(), "a dropped slot is given back");
    /// ```
    pub fn reserve(&self) -> Result<SpawnSlot<'_>, AppError> {
        let max = self.config.read().max_workers;
        let mut pending = self.pending.lock();
        if self.workers.len() + *pending >= max {
            return Err(AppError::RegistryFull { max });
        }
        *pending += 1;
        Ok(SpawnSlot {
            registry: self,
            filled: false,
        })
    }

    /// Registers a worker: [`Self::reserve`] followed by
    /// [`SpawnSlot::fill`].
    ///
    /// # Errors
    ///
    /// [`AppError::RegistryFull`] if the registry is at capacity.
    ///
    /// # Examples
    ///
    /// ```
    /// use swarm_core::worker::registry::WorkerRegistry;
    /// use swarm_core::worker::handle::{WorkerHandle, WorkerState};
    /// use uuid::Uuid;
    ///
    /// let registry = WorkerRegistry::new();
    /// let handle = WorkerHandle {
    ///     id: Uuid::new_v4(),
    ///     state: WorkerState::Running,
    ///     name: "test".to_owned(),
    ///     pid: None,
    ///     started_at: 0,
    ///     pty_writer: None,
    ///     child: None,
    ///     worktree_path: None,
    ///     repo_root: None,
    ///     branch: None,
    ///     base_commit: None,
    ///     last_shipped_seq: None,
    ///     last_shipped_commit: None,
    /// };
    /// registry.spawn_worker(handle).unwrap();
    /// assert_eq!(registry.count(), 1);
    /// ```
    pub fn spawn_worker(&self, handle: WorkerHandle) -> Result<WorkerId, AppError> {
        Ok(self.reserve()?.fill(handle))
    }

    /// A [`WorkerInfo`] snapshot of one worker.
    ///
    /// # Errors
    ///
    /// [`AppError::WorkerNotFound`] if no worker has this id.
    pub fn get_worker(&self, id: &WorkerId) -> Result<WorkerInfo, AppError> {
        self.workers
            .get(id)
            .map(|entry| entry.to_info())
            .ok_or_else(|| not_found(id))
    }

    /// Removes a worker and hands back its handle, whose PTY resources
    /// the caller must release (see
    /// [`crate::worker::lifecycle::do_kill_worker`]).
    ///
    /// # Errors
    ///
    /// [`AppError::WorkerNotFound`] if no worker has this id.
    pub fn remove_worker(&self, id: &WorkerId) -> Result<WorkerHandle, AppError> {
        self.workers
            .remove(id)
            .map(|(_, handle)| handle)
            .ok_or_else(|| not_found(id))
    }

    /// Atomically moves a worker from `expected` to `new_state`.
    ///
    /// The check and the write happen under one shard write lock, so two
    /// racing transitions (a pause and a resume on the same worker) can
    /// never both pass their precondition.
    ///
    /// # Errors
    ///
    /// - [`AppError::WorkerNotFound`] if no worker has this id.
    /// - [`AppError::Ipc`] if the worker is not in `expected` (the
    ///   message names the actual state).
    ///
    /// # Examples
    ///
    /// ```
    /// use swarm_core::worker::registry::WorkerRegistry;
    /// use swarm_core::worker::handle::{WorkerHandle, WorkerState};
    /// use uuid::Uuid;
    ///
    /// let registry = WorkerRegistry::new();
    /// let handle = WorkerHandle {
    ///     id: Uuid::new_v4(),
    ///     state: WorkerState::Running,
    ///     name: "test".to_owned(),
    ///     pid: None,
    ///     started_at: 0,
    ///     pty_writer: None,
    ///     child: None,
    ///     worktree_path: None,
    ///     repo_root: None,
    ///     branch: None,
    ///     base_commit: None,
    ///     last_shipped_seq: None,
    ///     last_shipped_commit: None,
    /// };
    /// let id = registry.spawn_worker(handle).unwrap();
    ///
    /// // Succeeds: the worker is Running as expected.
    /// registry.update_state_if(&id, WorkerState::Running, WorkerState::Paused).unwrap();
    ///
    /// // Fails: the worker is now Paused, not Running.
    /// assert!(registry.update_state_if(&id, WorkerState::Running, WorkerState::Paused).is_err());
    /// ```
    pub fn update_state_if(
        &self,
        id: &WorkerId,
        expected: WorkerState,
        new_state: WorkerState,
    ) -> Result<(), AppError> {
        self.update_state_if_then(id, expected, new_state, || {})
    }

    /// [`Self::update_state_if`], additionally running `announce` while
    /// the shard write lock is still held, once the transition has been
    /// written (and not at all when it is refused).
    ///
    /// Announcing under the lock makes the order events reach the sink
    /// match the order the state changed: a racing pause and shell exit
    /// can never emit `worker_state` in the opposite order from the one
    /// they mutated the state in. `announce` must therefore be cheap
    /// and non-blocking (an [`crate::events::EventSink`] send is), and
    /// must not call back into this registry for the same worker.
    ///
    /// # Errors
    ///
    /// As [`Self::update_state_if`].
    pub fn update_state_if_then(
        &self,
        id: &WorkerId,
        expected: WorkerState,
        new_state: WorkerState,
        announce: impl FnOnce(),
    ) -> Result<(), AppError> {
        let mut entry = self.workers.get_mut(id).ok_or_else(|| not_found(id))?;
        if entry.state != expected {
            return Err(AppError::Ipc(format!(
                "cannot transition worker {id} from {} to {new_state} (expected {expected})",
                entry.state
            )));
        }
        entry.state = new_state;
        tracing::debug!(worker_id = %id, %new_state, "worker state updated");
        announce();
        Ok(())
    }

    /// Records that a worker's shell exited on its own: moves it to
    /// [`WorkerState::Error`] from any other state, running `announce`
    /// under the shard write lock when this call made the transition
    /// (see [`Self::update_state_if_then`] for why, and for what
    /// `announce` may do).
    ///
    /// Returns `true` if this call made the transition, `false` if the
    /// worker is gone (it was killed, which reaps the shell itself) or
    /// already marked.
    pub fn mark_exited(&self, id: &WorkerId, announce: impl FnOnce()) -> bool {
        self.workers.get_mut(id).is_some_and(|mut entry| {
            let live = entry.state != WorkerState::Error;
            entry.state = WorkerState::Error;
            if live {
                announce();
            }
            live
        })
    }

    /// Counts registered workers by state.
    ///
    /// # Examples
    ///
    /// ```
    /// use swarm_core::worker::registry::WorkerRegistry;
    ///
    /// let registry = WorkerRegistry::new();
    /// assert_eq!(registry.aggregate_metrics().total_workers, 0);
    /// ```
    pub fn aggregate_metrics(&self) -> AggregateMetrics {
        let mut metrics = AggregateMetrics {
            total_workers: 0,
            running: 0,
            paused: 0,
            idle: 0,
            errored: 0,
        };
        for entry in self.workers.iter() {
            metrics.total_workers += 1;
            *match entry.state {
                WorkerState::Running => &mut metrics.running,
                WorkerState::Paused => &mut metrics.paused,
                WorkerState::Idle => &mut metrics.idle,
                WorkerState::Error => &mut metrics.errored,
            } += 1;
        }
        metrics
    }

    /// [`WorkerInfo`] snapshots of every registered worker, in no
    /// particular order.
    pub fn list_workers(&self) -> Vec<WorkerInfo> {
        self.workers.iter().map(|entry| entry.to_info()).collect()
    }

    /// Records a successful ship for `id`. The only writer of
    /// `WorkerHandle::last_shipped_seq`/`last_shipped_commit`: the ship
    /// command layer calls it after a successful `git_push`, never after
    /// a preflight or a failed push.
    ///
    /// # Errors
    ///
    /// [`AppError::WorkerNotFound`] if no worker has this id.
    pub fn set_last_shipped(&self, id: &WorkerId, seq: u64, commit: &str) -> Result<(), AppError> {
        let mut entry = self.workers.get_mut(id).ok_or_else(|| not_found(id))?;
        entry.last_shipped_seq = Some(seq);
        entry.last_shipped_commit = Some(commit.to_owned());
        tracing::info!(worker_id = %id, seq, commit, "ship: last_shipped recorded");
        Ok(())
    }
}

impl Default for WorkerRegistry {
    fn default() -> Self {
        Self::new()
    }
}

fn not_found(id: &WorkerId) -> AppError {
    AppError::WorkerNotFound { id: id.to_string() }
}

#[cfg(test)]
mod tests {
    use std::assert_matches;

    use super::*;

    fn make_handle(name: &str) -> WorkerHandle {
        WorkerHandle {
            id: Uuid::new_v4(),
            state: WorkerState::Running,
            name: name.to_owned(),
            pid: Some(1234),
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
    fn test_set_max_workers_validates_and_applies_live() {
        let reg = WorkerRegistry::new();

        // Out-of-range values are rejected, leaving the default intact.
        assert!(reg.set_max_workers(0).is_err());
        assert!(reg.set_max_workers(MAX_MAX_WORKERS + 1).is_err());
        assert_eq!(reg.config.read().max_workers, DEFAULT_MAX_WORKERS);

        // A valid cap applies to subsequent spawns immediately.
        reg.set_max_workers(2).unwrap();
        reg.spawn_worker(make_handle("a")).unwrap();
        reg.spawn_worker(make_handle("b")).unwrap();
        let err = reg.spawn_worker(make_handle("c")).unwrap_err();
        assert_matches!(err, AppError::RegistryFull { max: 2 });

        // Shrinking below the live count never evicts running workers —
        // it only blocks new spawns.
        reg.set_max_workers(1).unwrap();
        assert_eq!(reg.count(), 2);
        assert!(reg.spawn_worker(make_handle("d")).is_err());

        // Raising the cap unblocks spawning again.
        reg.set_max_workers(3).unwrap();
        assert!(reg.spawn_worker(make_handle("e")).is_ok());
    }

    #[test]
    fn test_reservations_count_against_the_cap_until_filled_or_dropped() {
        let reg = WorkerRegistry::new();
        reg.set_max_workers(2).unwrap();

        let first = reg.reserve().unwrap();
        let second = reg.reserve().unwrap();
        assert_matches!(reg.reserve(), Err(AppError::RegistryFull { max: 2 }));
        assert_eq!(reg.count(), 0, "a reservation is not a registered worker");

        // Filling keeps the slot taken; dropping unfilled gives it back.
        first.fill(make_handle("filled"));
        drop(second);
        assert_eq!(reg.count(), 1);
        let third = reg.reserve().expect("the dropped slot is free again");
        assert_matches!(reg.reserve(), Err(AppError::RegistryFull { max: 2 }));
        drop(third);
    }

    #[test]
    fn test_concurrent_spawns_never_exceed_the_cap() {
        let reg = WorkerRegistry::new();
        reg.set_max_workers(5).unwrap();
        let barrier = std::sync::Barrier::new(32);

        let admitted = std::thread::scope(|scope| {
            let spawns: Vec<_> = (0..32)
                .map(|i| {
                    let (reg, barrier) = (&reg, &barrier);
                    scope.spawn(move || {
                        barrier.wait();
                        reg.spawn_worker(make_handle(&format!("w{i}"))).is_ok()
                    })
                })
                .collect();
            spawns
                .into_iter()
                .map(|spawn| spawn.join().unwrap())
                .filter(|&admitted| admitted)
                .count()
        });

        assert_eq!(admitted, 5);
        assert_eq!(reg.count(), 5);
    }

    #[test]
    fn test_registry_insert_get_remove() {
        let reg = WorkerRegistry::new();
        let handle = make_handle("test-worker");
        let id = handle.id;

        assert_eq!(reg.spawn_worker(handle).unwrap(), id);
        assert_eq!(reg.count(), 1);

        let info = reg.get_worker(&id).unwrap();
        assert_eq!(info.name, "test-worker");
        assert_eq!(info.state, WorkerState::Running);

        assert_eq!(reg.remove_worker(&id).unwrap().id, id);
        assert_eq!(reg.count(), 0);
        assert_matches!(reg.remove_worker(&id), Err(AppError::WorkerNotFound { .. }));
    }

    #[test]
    fn test_registry_worker_not_found() {
        let reg = WorkerRegistry::new();
        assert_matches!(
            reg.get_worker(&Uuid::new_v4()),
            Err(AppError::WorkerNotFound { .. })
        );
    }

    #[test]
    fn test_update_state_if_succeeds_when_expected_matches() {
        let reg = WorkerRegistry::new();
        let id = reg.spawn_worker(make_handle("cas-worker")).unwrap();

        reg.update_state_if(&id, WorkerState::Running, WorkerState::Paused)
            .unwrap();
        assert_eq!(reg.get_worker(&id).unwrap().state, WorkerState::Paused);
    }

    #[test]
    fn test_update_state_if_fails_when_expected_mismatches() {
        let reg = WorkerRegistry::new();
        let id = reg.spawn_worker(make_handle("cas-worker-2")).unwrap();

        // Running, but Paused is expected: fails without mutating.
        let err = reg
            .update_state_if(&id, WorkerState::Paused, WorkerState::Running)
            .unwrap_err();
        assert!(err.to_string().contains("from running"), "{err}");
        assert_eq!(reg.get_worker(&id).unwrap().state, WorkerState::Running);
    }

    #[test]
    fn test_update_state_if_worker_not_found() {
        let reg = WorkerRegistry::new();
        assert_matches!(
            reg.update_state_if(&Uuid::new_v4(), WorkerState::Running, WorkerState::Paused),
            Err(AppError::WorkerNotFound { .. })
        );
    }

    #[test]
    fn test_mark_exited_transitions_once_and_ignores_unknown_workers() {
        let reg = WorkerRegistry::new();
        let mut paused = make_handle("paused");
        paused.state = WorkerState::Paused;
        let id = reg.spawn_worker(paused).unwrap();

        let announced = std::cell::Cell::new(0);
        let announce = || announced.set(announced.get() + 1);
        assert!(
            reg.mark_exited(&id, announce),
            "a paused worker's exit is recorded"
        );
        assert_eq!(reg.get_worker(&id).unwrap().state, WorkerState::Error);
        assert!(!reg.mark_exited(&id, announce), "already marked");
        assert!(
            !reg.mark_exited(&Uuid::new_v4(), announce),
            "unknown (killed) worker"
        );
        assert_eq!(announced.get(), 1, "only the transition announces");
    }

    #[test]
    fn test_aggregate_metrics_counts_every_state() {
        let reg = WorkerRegistry::new();
        for state in [
            WorkerState::Running,
            WorkerState::Running,
            WorkerState::Paused,
            WorkerState::Idle,
            WorkerState::Error,
        ] {
            let mut handle = make_handle("w");
            handle.state = state;
            reg.spawn_worker(handle).unwrap();
        }

        let metrics = reg.aggregate_metrics();
        assert_eq!(metrics.total_workers, 5);
        assert_eq!(
            (
                metrics.running,
                metrics.paused,
                metrics.idle,
                metrics.errored
            ),
            (2, 1, 1, 1)
        );
    }

    #[test]
    fn test_set_last_shipped_updates_only_the_target_worker() {
        let reg = WorkerRegistry::new();
        let a_id = reg.spawn_worker(make_handle("a")).unwrap();
        let b_id = reg.spawn_worker(make_handle("b")).unwrap();

        reg.set_last_shipped(&a_id, 42, "cafef00d").unwrap();

        let a_info = reg.get_worker(&a_id).unwrap();
        assert_eq!(a_info.last_shipped_seq, Some(42));
        assert_eq!(a_info.last_shipped_commit.as_deref(), Some("cafef00d"));
        assert_eq!(reg.get_worker(&b_id).unwrap().last_shipped_seq, None);
    }

    #[test]
    fn test_set_last_shipped_worker_not_found() {
        let reg = WorkerRegistry::new();
        assert_matches!(
            reg.set_last_shipped(&Uuid::new_v4(), 1, "sha"),
            Err(AppError::WorkerNotFound { .. })
        );
    }

    #[test]
    fn test_list_workers() {
        let reg = WorkerRegistry::new();
        reg.spawn_worker(make_handle("a")).unwrap();
        reg.spawn_worker(make_handle("b")).unwrap();

        let mut names: Vec<_> = reg.list_workers().into_iter().map(|w| w.name).collect();
        names.sort_unstable();
        assert_eq!(names, ["a", "b"]);
    }

    #[test]
    fn test_announce_runs_under_the_entry_lock() {
        let reg = WorkerRegistry::new();
        let id = reg.spawn_worker(make_handle("locked-announce")).unwrap();
        let locked = std::cell::Cell::new(None);
        let probe = || locked.set(Some(reg.workers.try_get(&id).is_locked()));
        reg.update_state_if_then(&id, WorkerState::Running, WorkerState::Paused, probe)
            .unwrap();
        assert_eq!(locked.take(), Some(true));
        assert!(
            reg.update_state_if_then(&id, WorkerState::Running, WorkerState::Paused, probe)
                .is_err()
        );
        assert_eq!(locked.take(), None);
        assert!(reg.mark_exited(&id, probe));
        assert_eq!(locked.take(), Some(true));
    }
}
