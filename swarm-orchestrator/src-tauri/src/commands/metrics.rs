//! Metrics collection Tauri IPC command and background loop.
//!
//! Provides real-time system metrics to the frontend through
//! two mechanisms:
//!
//! 1. **Push:** A background loop emits `system_metrics` events on
//!    `swarm://events` every 500ms via [`start_metrics_loop`]
//! 2. **Pull:** The [`get_metrics`] command returns an on-demand
//!    metrics snapshot, including a `perWorker` breakdown
//!
//! Both mechanisms share the same [`SharedSystem`] managed state
//! (a single `sysinfo::System` behind a mutex) so there is one
//! CPU-usage-delta tracker for the whole app, rather than each
//! mechanism refreshing its own independent `System`.
//!
//! Uses `sysinfo` for real CPU and memory data, and per-worker
//! process-level metrics when worker PIDs are available (see
//! [`collect_per_worker_metrics`], wired into [`get_metrics`]).

use parking_lot::Mutex;
use std::time::Duration;

use sysinfo::System;
use tauri::AppHandle;
use tokio_util::sync::CancellationToken;

use crate::events::{SwarmEvent, SystemMetricsPayload, emit_event};
use crate::worker::registry::WorkerRegistry;

/// Shared system metrics state persisted across Tauri command calls.
///
/// Wraps a `sysinfo::System` in an `Arc<Mutex>` so that CPU usage deltas
/// are computed accurately between successive refreshes, rather than
/// creating a fresh `System` on every invocation.
#[derive(Clone)]
pub struct SharedSystem(pub std::sync::Arc<Mutex<System>>);

impl SharedSystem {
    pub fn new() -> Self {
        Self(std::sync::Arc::new(Mutex::new(System::new_all())))
    }
}

/// Starts the background metrics collection loop.
///
/// Spawns a Tokio task that runs every 500ms, collecting real system
/// metrics via `sysinfo` (offloaded to `spawn_blocking` since
/// `sysinfo` refresh is CPU-bound) and worker aggregate metrics,
/// then emitting them as `system_metrics` events on `swarm://events`.
///
/// Reuses the app-wide [`SharedSystem`] managed state (the same
/// `sysinfo::System` instance used by [`get_metrics`]) so CPU usage
/// deltas are computed from a single source of truth instead of a
/// second, independent tracker.
///
/// The loop respects the provided `CancellationToken` for graceful
/// shutdown via `tokio::select!`.
///
/// # Arguments
///
/// * `app` - Tauri app handle for event emission
/// * `registry` - The shared worker registry to collect metrics from
/// * `shared_sys` - The app-wide shared `sysinfo::System` (managed state)
/// * `cancel` - Cancellation token for graceful shutdown
///
/// # Metrics Collected
///
/// | Field                | Source                              |
/// |----------------------|-------------------------------------|
/// | `cpu_percent`        | `sysinfo::System::global_cpu_usage` |
/// | `memory_mb`          | `sysinfo::System::used_memory`      |
/// | `memory_total_mb`    | `sysinfo::System::total_memory`     |
/// | `worker_count`       | `registry.aggregate_metrics()`      |
/// | `ai_req_per_sec`| Placeholder (0.0)                   |
/// | `timestamp`          | Current Unix time (ms)              |
pub fn start_metrics_loop(
    app: AppHandle,
    registry: WorkerRegistry,
    shared_sys: SharedSystem,
    cancel: CancellationToken,
) {
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_millis(500));
        tracing::info!("metrics collection loop started (500ms interval)");

        loop {
            // A single future (the interval tick) racing against
            // cancellation — `run_until_cancelled` expresses this more
            // directly than a two-armed `tokio::select!`.
            let Some(_) = cancel.run_until_cancelled(interval.tick()).await else {
                tracing::info!("metrics loop shutting down");
                break;
            };

            // Offload sysinfo refresh to spawn_blocking (CPU-bound),
            // reusing the shared System for accurate CPU deltas.
            let sys_arc = shared_sys.0.clone();
            let (cpu_percent, memory_mb, memory_total_mb) =
                tokio::task::spawn_blocking(move || {
                    let mut sys = sys_arc.lock();
                    sys.refresh_cpu_usage();
                    sys.refresh_memory();
                    (
                        sys.global_cpu_usage() as f64,
                        sys.used_memory() as f64 / (1024.0 * 1024.0),
                        sys.total_memory() as f64 / (1024.0 * 1024.0),
                    )
                })
                .await
                .unwrap_or((0.0, 0.0, 0.0));

            let registry_clone = registry.clone();
            let metrics =
                tokio::task::spawn_blocking(move || registry_clone.aggregate_metrics()).await;

            let metrics = match metrics {
                Ok(m) => m,
                Err(e) => {
                    tracing::error!(error = %e, "failed to collect aggregate metrics");
                    continue;
                }
            };

            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis() as i64)
                .unwrap_or(0);

            let payload = SystemMetricsPayload {
                cpu_percent,
                memory_mb,
                memory_total_mb,
                worker_count: metrics.total_workers,
                ai_req_per_sec: 0.0, // placeholder — future AI queue integration
                timestamp: now,
            };

            emit_event(&app, SwarmEvent::SystemMetrics(payload));
        }
    });
}

/// Returns a snapshot of the current system metrics.
///
/// Collects real CPU and memory data via `sysinfo` plus aggregate
/// worker metrics via `spawn_blocking`, and returns them as a JSON
/// value. This is the pull-based complement to the push-based
/// [`start_metrics_loop`].
///
/// # Arguments
///
/// * `registry` - Shared worker registry (managed state)
///
/// # Returns
///
/// A `serde_json::Value` containing system and worker metrics:
/// - `cpuPercent` - Global CPU usage percentage
/// - `memoryMb` - Used memory in megabytes
/// - `memoryTotalMb` - Total physical memory in megabytes (real hardware
///   capacity, from `sysinfo::System::total_memory`)
/// - `totalWorkers`, `running`, `paused`, `idle`, `errored` - Worker counts
/// - `perWorker` - Array of per-worker process metrics (see
///   [`collect_per_worker_metrics`]), each with `workerId`, `pid`,
///   `cpuPercent`, and `memoryBytes`
///
/// # Errors
///
/// Returns a `String` error if:
/// - The `spawn_blocking` task panics
/// - JSON serialization fails
#[tauri::command]
#[tracing::instrument(skip(registry, shared_sys))]
pub async fn get_metrics(
    registry: tauri::State<'_, WorkerRegistry>,
    shared_sys: tauri::State<'_, SharedSystem>,
) -> Result<serde_json::Value, String> {
    tracing::debug!("get_metrics called");

    // Collect system metrics and per-worker process metrics using the
    // same shared System instance (offload to spawn_blocking).
    let sys_arc = shared_sys.0.clone();
    let registry_for_sys = registry.inner().clone();
    let (sys_metrics, per_worker) = tokio::task::spawn_blocking(move || {
        let mut sys = sys_arc.lock();
        sys.refresh_cpu_usage();
        sys.refresh_memory();
        sys.refresh_processes(sysinfo::ProcessesToUpdate::All, true);
        let sys_metrics = (
            sys.global_cpu_usage() as f64,
            sys.used_memory() as f64 / (1024.0 * 1024.0),
            sys.total_memory() as f64 / (1024.0 * 1024.0),
        );
        let per_worker = collect_per_worker_metrics(&registry_for_sys, &sys);
        (sys_metrics, per_worker)
    })
    .await
    .map_err(|e| {
        tracing::error!(error = %e, "failed to collect system metrics");
        e.to_string()
    })?;

    let registry_clone = registry.inner().clone();
    let worker_metrics = tokio::task::spawn_blocking(move || registry_clone.aggregate_metrics())
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "failed to collect worker metrics");
            e.to_string()
        })?;

    let combined = serde_json::json!({
        "cpuPercent": sys_metrics.0,
        "memoryMb": sys_metrics.1,
        "memoryTotalMb": sys_metrics.2,
        "totalWorkers": worker_metrics.total_workers,
        "running": worker_metrics.running,
        "paused": worker_metrics.paused,
        "idle": worker_metrics.idle,
        "errored": worker_metrics.errored,
        "perWorker": per_worker,
    });

    Ok(combined)
}

/// Collects per-worker process metrics using a shared sysinfo System.
///
/// Looks up each worker's PID in the system process table and
/// returns CPU and memory usage for each. Workers without a PID
/// or whose process has exited are reported with zero values.
///
/// Accepts a `&System` reference to reuse an existing System
/// instance rather than creating a new `System::new_all()` on
/// every call (which is expensive and resets CPU usage deltas).
///
/// # Arguments
///
/// * `registry` - The shared worker registry
/// * `sys` - A shared sysinfo System instance (already refreshed)
///
/// # Returns
///
/// A `Vec` of JSON objects with per-worker metrics:
/// - `workerId` - Worker UUID
/// - `pid` - OS process ID
/// - `cpuPercent` - CPU usage percentage for this process
/// - `memoryBytes` - Memory usage in bytes for this process
pub fn collect_per_worker_metrics(
    registry: &WorkerRegistry,
    sys: &System,
) -> Vec<serde_json::Value> {
    let workers = registry.list_workers();
    workers
        .iter()
        .map(|w| {
            let (cpu, mem) = if let Some(pid) = w.pid {
                let sysinfo_pid = sysinfo::Pid::from_u32(pid);
                if let Some(proc_info) = sys.process(sysinfo_pid) {
                    (proc_info.cpu_usage() as f64, proc_info.memory())
                } else {
                    (0.0, 0)
                }
            } else {
                (0.0, 0)
            };

            serde_json::json!({
                "workerId": w.id,
                "pid": w.pid,
                "cpuPercent": cpu,
                "memoryBytes": mem,
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_shared_system_new() {
        // SharedSystem wraps sysinfo::System in a parking_lot::Mutex.
        // Verify construction succeeds and the lock is accessible.
        let shared = SharedSystem::new();
        let sys = shared.0.lock();
        // sysinfo::System should report some memory (even in CI)
        let total = sys.total_memory();
        // On any real system, total memory is non-zero
        assert!(total > 0, "expected non-zero total memory");
    }

    #[test]
    fn test_shared_system_lock_no_poisoning() {
        // parking_lot::Mutex does not poison on panic.
        // Verify we can lock, drop, and re-lock without error.
        let shared = SharedSystem::new();

        {
            let _guard = shared.0.lock();
            // hold and release
        }

        // Second lock should succeed (no poisoning)
        let guard = shared.0.lock();
        let _ = guard.total_memory();
    }

    #[test]
    fn test_shared_system_cpu_refresh() {
        let shared = SharedSystem::new();
        let mut sys = shared.0.lock();
        // First refresh primes the CPU data; second gives a delta.
        sys.refresh_cpu_usage();
        let cpu = sys.global_cpu_usage();
        // CPU usage is a percentage [0.0, 100.0+] — just verify it's finite
        assert!(cpu.is_finite(), "expected finite CPU usage, got: {cpu}");
    }

    #[test]
    fn test_collect_per_worker_metrics_empty_registry() {
        let registry = WorkerRegistry::new();
        let sys = System::new_all();
        let metrics = collect_per_worker_metrics(&registry, &sys);
        assert!(
            metrics.is_empty(),
            "expected empty metrics for empty registry"
        );
    }

    #[test]
    fn test_collect_per_worker_metrics_with_workers() {
        use crate::worker::handle::{WorkerHandle, WorkerState};
        use uuid::Uuid;

        let registry = WorkerRegistry::new();

        // Worker with no PID
        let h1 = WorkerHandle {
            id: Uuid::new_v4(),
            state: WorkerState::Running,
            name: "no-pid".to_string(),
            pid: None,
            started_at: 0,
            pty_writer: None,
            child: None,
        };
        registry.spawn_worker(h1).unwrap();

        // Worker with a fake PID (won't match any real process)
        let h2 = WorkerHandle {
            id: Uuid::new_v4(),
            state: WorkerState::Running,
            name: "fake-pid".to_string(),
            pid: Some(999_999),
            started_at: 0,
            pty_writer: None,
            child: None,
        };
        registry.spawn_worker(h2).unwrap();

        let sys = System::new_all();
        let metrics = collect_per_worker_metrics(&registry, &sys);

        assert_eq!(metrics.len(), 2, "expected 2 worker metric entries");

        // Both should have zero/default cpu and memory since PIDs don't match
        for entry in &metrics {
            let cpu = entry["cpuPercent"].as_f64().unwrap();
            let mem = entry["memoryBytes"].as_u64().unwrap();
            assert!(cpu.is_finite(), "expected finite cpuPercent");
            // For a non-existent PID, memory should be 0
            assert_eq!(mem, 0, "expected 0 bytes for non-existent PID");
        }
    }
}
