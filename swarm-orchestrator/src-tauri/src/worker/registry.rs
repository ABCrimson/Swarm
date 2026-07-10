//! Thread-safe concurrent worker registry.
//!
//! The [`WorkerRegistry`] is the central data structure for all active
//! workers in the SWARM Orchestrator. It uses `DashMap` for lock-free
//! concurrent reads and `parking_lot::RwLock` for system configuration.
//!
//! Aggregate metrics are computed via sequential iteration over the
//! worker state snapshots (max 64 workers makes parallelism unnecessary).

use dashmap::DashMap;
use parking_lot::RwLock;
use std::sync::Arc;
use uuid::Uuid;

use super::handle::{WorkerHandle, WorkerInfo, WorkerState};
use crate::error::AppError;

/// Unique identifier for a worker instance.
///
/// Aliases `uuid::Uuid` (v4) for type clarity throughout the codebase.
pub type WorkerId = Uuid;

/// System-wide configuration shared across all workers.
///
/// Controls the maximum number of concurrent workers and the
/// default shell used when a worker config does not specify one.
///
/// # Defaults
///
/// | Field           | Windows              | Unix         |
/// |-----------------|----------------------|--------------|
/// | `max_workers`   | 64                   | 64           |
/// | `default_shell` | `powershell.exe`     | `/bin/bash`  |
///
/// # Examples
///
/// ```
/// use swarm_core::worker::registry::SystemConfig;
///
/// let config = SystemConfig::default();
/// assert_eq!(config.max_workers, 64);
/// ```
#[derive(Debug, Clone)]
pub struct SystemConfig {
    /// Maximum number of workers that can be registered simultaneously.
    pub max_workers: usize,
    /// Default shell executable path when a worker config omits it.
    pub default_shell: String,
}

impl Default for SystemConfig {
    fn default() -> Self {
        Self {
            max_workers: 64,
            default_shell: if cfg!(windows) {
                "powershell.exe".to_string()
            } else {
                "/bin/bash".to_string()
            },
        }
    }
}

/// Aggregated metrics snapshot for all workers in the registry.
///
/// Computed via [`WorkerRegistry::aggregate_metrics`] using sequential
/// iteration. Sent to the frontend as part of the
/// `system:metrics` event payload.
///
/// # Fields
///
/// * `total_workers` - Total number of registered workers
/// * `running` - Count of workers in [`WorkerState::Running`]
/// * `paused` - Count of workers in [`WorkerState::Paused`]
/// * `idle` - Count of workers in [`WorkerState::Idle`]
/// * `errored` - Count of workers in [`WorkerState::Error`]
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AggregateMetrics {
    /// Total number of registered workers.
    pub total_workers: usize,
    /// Number of workers currently running.
    pub running: usize,
    /// Number of workers currently paused.
    pub paused: usize,
    /// Number of workers in idle state.
    pub idle: usize,
    /// Number of workers in error state.
    pub errored: usize,
}

/// Thread-safe registry of all active workers.
///
/// Uses `DashMap` for lock-free concurrent reads and
/// `parking_lot::RwLock` for system configuration.
/// This is the single source of truth for worker state
/// in the SWARM Orchestrator backend.
///
/// # Concurrency
///
/// - Read operations (`get_worker`, `list_workers`, `count`) are lock-free
/// - Write operations (`spawn_worker`, `remove_worker`, `update_state`)
///   use per-shard locks internally via DashMap
/// - `aggregate_metrics` iterates sequentially over worker state snapshots
///
/// # Capacity
///
/// The registry enforces a configurable maximum worker count
/// (default: 64). Attempts to exceed this limit return
/// [`AppError::RegistryFull`].
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
    /// Concurrent map of worker ID to worker handle.
    pub workers: Arc<DashMap<WorkerId, WorkerHandle>>,
    /// Shared system configuration (max workers, default shell).
    pub config: Arc<RwLock<SystemConfig>>,
}

impl WorkerRegistry {
    /// Creates a new empty registry with default configuration.
    ///
    /// # Returns
    ///
    /// A `WorkerRegistry` with zero workers and [`SystemConfig::default`].
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
        }
    }

    /// Returns the number of currently registered workers.
    ///
    /// # Returns
    ///
    /// The count of active workers in the registry.
    pub fn count(&self) -> usize {
        self.workers.len()
    }

    /// Inserts a worker handle into the registry.
    ///
    /// # Arguments
    ///
    /// * `handle` - The [`WorkerHandle`] to register
    ///
    /// # Returns
    ///
    /// The UUID of the newly registered worker on success.
    ///
    /// # Errors
    ///
    /// * [`AppError::RegistryFull`] - The registry has reached its
    ///   configured `max_workers` capacity
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
    ///     name: "test".to_string(),
    ///     pid: None,
    ///     started_at: 0,
    ///     pty_writer: None,
    ///     child: None,
    /// };
    /// let id = registry.spawn_worker(handle).unwrap();
    /// assert_eq!(registry.count(), 1);
    /// ```
    pub fn spawn_worker(&self, handle: WorkerHandle) -> Result<Uuid, AppError> {
        let max = self.config.read().max_workers;
        if self.workers.len() >= max {
            return Err(AppError::RegistryFull { max });
        }
        let id = handle.id;
        self.workers.insert(id, handle);
        tracing::info!(worker_id = %id, "worker registered");
        Ok(id)
    }

    /// Retrieves a serializable snapshot of a worker by ID.
    ///
    /// # Arguments
    ///
    /// * `id` - The UUID of the worker to retrieve
    ///
    /// # Returns
    ///
    /// A [`WorkerInfo`] snapshot of the worker's current state.
    ///
    /// # Errors
    ///
    /// * [`AppError::WorkerNotFound`] - No worker with the given ID exists
    pub fn get_worker(&self, id: &WorkerId) -> Result<WorkerInfo, AppError> {
        self.workers
            .get(id)
            .map(|entry| entry.to_info())
            .ok_or_else(|| AppError::WorkerNotFound { id: id.to_string() })
    }

    /// Removes a worker from the registry by ID.
    ///
    /// The returned [`WorkerHandle`] contains the PTY writer and child
    /// process handle, which the caller is responsible for cleaning up.
    ///
    /// # Arguments
    ///
    /// * `id` - The UUID of the worker to remove
    ///
    /// # Returns
    ///
    /// The removed [`WorkerHandle`] for cleanup.
    ///
    /// # Errors
    ///
    /// * [`AppError::WorkerNotFound`] - No worker with the given ID exists
    pub fn remove_worker(&self, id: &WorkerId) -> Result<WorkerHandle, AppError> {
        self.workers
            .remove(id)
            .map(|(_, handle)| handle)
            .ok_or_else(|| AppError::WorkerNotFound { id: id.to_string() })
    }

    /// Updates the lifecycle state of a worker in the registry.
    ///
    /// # Arguments
    ///
    /// * `id` - The UUID of the worker to update
    /// * `state` - The new [`WorkerState`] to set
    ///
    /// # Errors
    ///
    /// * [`AppError::WorkerNotFound`] - No worker with the given ID exists
    pub fn update_state(&self, id: &WorkerId, state: WorkerState) -> Result<(), AppError> {
        let mut entry = self
            .workers
            .get_mut(id)
            .ok_or_else(|| AppError::WorkerNotFound { id: id.to_string() })?;
        entry.state = state;
        tracing::debug!(worker_id = %id, new_state = %state, "worker state updated");
        Ok(())
    }

    /// Atomically checks and updates a worker's lifecycle state.
    ///
    /// Performs the expected-state check and the write inside a single
    /// `DashMap` shard lock (via one `get_mut` guard), eliminating the
    /// check-then-set race that exists when a caller separately reads
    /// the current state and then calls [`Self::update_state`] — two
    /// concurrent callers (e.g. a pause and a resume racing on the same
    /// worker) could otherwise both pass their precondition check before
    /// either applies its update.
    ///
    /// # Arguments
    ///
    /// * `id` - The UUID of the worker to update
    /// * `expected` - The state the worker must currently be in
    /// * `new_state` - The state to transition to if the check passes
    ///
    /// # Returns
    ///
    /// `Ok(())` if the worker was in `expected` state and was updated.
    ///
    /// # Errors
    ///
    /// * [`AppError::WorkerNotFound`] - No worker with the given ID exists
    /// * [`AppError::Ipc`] - The worker's current state does not match
    ///   `expected` (includes the actual state in the error message)
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
    ///     name: "test".to_string(),
    ///     pid: None,
    ///     started_at: 0,
    ///     pty_writer: None,
    ///     child: None,
    /// };
    /// let id = registry.spawn_worker(handle).unwrap();
    ///
    /// // Succeeds: worker is Running as expected.
    /// registry.update_state_if(&id, WorkerState::Running, WorkerState::Paused).unwrap();
    ///
    /// // Fails: worker is now Paused, not Running.
    /// assert!(registry.update_state_if(&id, WorkerState::Running, WorkerState::Paused).is_err());
    /// ```
    pub fn update_state_if(
        &self,
        id: &WorkerId,
        expected: WorkerState,
        new_state: WorkerState,
    ) -> Result<(), AppError> {
        let mut entry = self
            .workers
            .get_mut(id)
            .ok_or_else(|| AppError::WorkerNotFound { id: id.to_string() })?;

        if entry.state != expected {
            return Err(AppError::Ipc(format!(
                "cannot transition worker {} from {} to {} (expected {})",
                id, entry.state, new_state, expected
            )));
        }

        entry.state = new_state;
        tracing::debug!(worker_id = %id, new_state = %new_state, "worker state updated (CAS)");
        Ok(())
    }

    /// Collects aggregate metrics across all workers using sequential iteration.
    ///
    /// Snapshots all worker states and counts workers in each state.
    /// With a maximum of 64 workers, sequential iteration is faster
    /// than parallel dispatch overhead.
    ///
    /// # Returns
    ///
    /// An [`AggregateMetrics`] snapshot of all worker state counts.
    ///
    /// # Examples
    ///
    /// ```
    /// use swarm_core::worker::registry::WorkerRegistry;
    ///
    /// let registry = WorkerRegistry::new();
    /// let metrics = registry.aggregate_metrics();
    /// assert_eq!(metrics.total_workers, 0);
    /// ```
    pub fn aggregate_metrics(&self) -> AggregateMetrics {
        let mut total_workers = 0usize;
        let mut running = 0usize;
        let mut paused = 0usize;
        let mut idle = 0usize;
        let mut errored = 0usize;

        for entry in self.workers.iter() {
            total_workers += 1;
            match entry.state {
                WorkerState::Running => running += 1,
                WorkerState::Paused => paused += 1,
                WorkerState::Idle => idle += 1,
                WorkerState::Error => errored += 1,
            }
        }

        AggregateMetrics {
            total_workers,
            running,
            paused,
            idle,
            errored,
        }
    }

    /// Lists all workers as serializable [`WorkerInfo`] snapshots.
    ///
    /// Iterates over all entries in the DashMap and clones
    /// their lightweight info representation.
    ///
    /// # Returns
    ///
    /// A `Vec<WorkerInfo>` of all registered workers.
    pub fn list_workers(&self) -> Vec<WorkerInfo> {
        self.workers.iter().map(|entry| entry.to_info()).collect()
    }
}

impl Default for WorkerRegistry {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::worker::handle::{WorkerHandle, WorkerState};

    fn make_handle(name: &str) -> WorkerHandle {
        WorkerHandle {
            id: Uuid::new_v4(),
            state: WorkerState::Running,
            name: name.to_string(),
            pid: Some(1234),
            started_at: 0,
            // No PTY resources in tests
            pty_writer: None,
            child: None,
        }
    }

    #[test]
    fn test_registry_insert_get_remove() {
        let reg = WorkerRegistry::new();
        let handle = make_handle("test-worker");
        let id = handle.id;

        // Insert
        let result = reg.spawn_worker(handle);
        assert!(result.is_ok());
        assert_eq!(reg.count(), 1);

        // Get
        let info = reg.get_worker(&id).unwrap();
        assert_eq!(info.name, "test-worker");
        assert_eq!(info.state, WorkerState::Running);

        // Remove
        let removed = reg.remove_worker(&id);
        assert!(removed.is_ok());
        assert_eq!(reg.count(), 0);
    }

    #[test]
    fn test_registry_worker_not_found() {
        let reg = WorkerRegistry::new();
        let fake_id = Uuid::new_v4();
        let result = reg.get_worker(&fake_id);
        assert!(result.is_err());
    }

    #[test]
    fn test_registry_update_state() {
        let reg = WorkerRegistry::new();
        let handle = make_handle("stateful");
        let id = handle.id;
        reg.spawn_worker(handle).unwrap();

        reg.update_state(&id, WorkerState::Paused).unwrap();
        let info = reg.get_worker(&id).unwrap();
        assert_eq!(info.state, WorkerState::Paused);
    }

    #[test]
    fn test_update_state_if_succeeds_when_expected_matches() {
        let reg = WorkerRegistry::new();
        let handle = make_handle("cas-worker");
        let id = handle.id;
        reg.spawn_worker(handle).unwrap();

        let result = reg.update_state_if(&id, WorkerState::Running, WorkerState::Paused);
        assert!(result.is_ok());
        assert_eq!(reg.get_worker(&id).unwrap().state, WorkerState::Paused);
    }

    #[test]
    fn test_update_state_if_fails_when_expected_mismatches() {
        let reg = WorkerRegistry::new();
        let handle = make_handle("cas-worker-2");
        let id = handle.id;
        reg.spawn_worker(handle).unwrap();

        // Worker is Running, but we expect Paused — should fail without mutating.
        let result = reg.update_state_if(&id, WorkerState::Paused, WorkerState::Running);
        assert!(result.is_err());
        // State must remain unchanged (no partial/racy mutation).
        assert_eq!(reg.get_worker(&id).unwrap().state, WorkerState::Running);
    }

    #[test]
    fn test_update_state_if_worker_not_found() {
        let reg = WorkerRegistry::new();
        let fake_id = Uuid::new_v4();
        let result = reg.update_state_if(&fake_id, WorkerState::Running, WorkerState::Paused);
        assert!(result.is_err());
    }

    #[test]
    fn test_registry_capacity_limit() {
        let reg = WorkerRegistry::new();
        {
            let mut cfg = reg.config.write();
            cfg.max_workers = 2;
        }
        reg.spawn_worker(make_handle("w1")).unwrap();
        reg.spawn_worker(make_handle("w2")).unwrap();
        let result = reg.spawn_worker(make_handle("w3"));
        assert!(result.is_err());
    }

    #[test]
    fn test_aggregate_metrics() {
        let reg = WorkerRegistry::new();
        let h1 = make_handle("r1");
        let h2_id;
        {
            let mut h2 = make_handle("p1");
            h2.state = WorkerState::Paused;
            h2_id = h2.id;
            reg.spawn_worker(h2).unwrap();
        }
        let _ = h2_id;
        reg.spawn_worker(h1).unwrap();

        let metrics = reg.aggregate_metrics();
        assert_eq!(metrics.total_workers, 2);
        assert_eq!(metrics.running, 1);
        assert_eq!(metrics.paused, 1);
    }

    #[test]
    fn test_list_workers() {
        let reg = WorkerRegistry::new();
        reg.spawn_worker(make_handle("a")).unwrap();
        reg.spawn_worker(make_handle("b")).unwrap();

        let list = reg.list_workers();
        assert_eq!(list.len(), 2);
    }
}
