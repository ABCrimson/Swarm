//! System + worker metrics collection.
//!
//! Moved here (from the `swarm-desktop` shell's `commands::metrics`)
//! as part of factoring the shared "engine/registries/scheduler" setup
//! that used to live only in the Tauri shell's `lib.rs` into a
//! Tauri-free constructor both shells call (see [`crate::runtime`]).
//! Nothing here ever touched `tauri` — `sysinfo` + `tokio` + `parking_lot`
//! only — so the move is a pure relocation, no behavior change.

use std::time::Duration;

use parking_lot::Mutex;
use sysinfo::System;
use tokio_util::sync::CancellationToken;

use crate::events::{EventSink, SwarmEvent, SystemMetricsPayload};
use crate::worker::registry::WorkerRegistry;

/// Shared system metrics state persisted across calls.
///
/// Wraps a `sysinfo::System` in an `Arc<Mutex>` so CPU usage deltas are
/// computed accurately between successive refreshes, rather than
/// creating a fresh `System` on every call.
#[derive(Clone)]
pub struct SharedSystem(pub std::sync::Arc<Mutex<System>>);

impl SharedSystem {
    pub fn new() -> Self {
        Self(std::sync::Arc::new(Mutex::new(System::new_all())))
    }
}

impl Default for SharedSystem {
    fn default() -> Self {
        Self::new()
    }
}

/// Starts the background metrics collection loop (500ms interval),
/// emitting `system_metrics` events via `sink`. Respects `cancel` for
/// graceful shutdown.
pub fn start_metrics_loop(
    sink: EventSink,
    registry: WorkerRegistry,
    shared_sys: SharedSystem,
    cancel: CancellationToken,
) {
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_millis(500));
        tracing::info!("metrics collection loop started (500ms interval)");

        loop {
            let Some(_) = cancel.run_until_cancelled(interval.tick()).await else {
                tracing::info!("metrics loop shutting down");
                break;
            };

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

            sink.emit(SwarmEvent::SystemMetrics(SystemMetricsPayload {
                cpu_percent,
                memory_mb,
                memory_total_mb,
                worker_count: metrics.total_workers,
                ai_req_per_sec: 0.0,
                timestamp: now,
            }));
        }
    });
}

/// Collects per-worker process metrics using a shared, already-refreshed
/// `System`. Workers without a PID or whose process has exited report
/// zero values.
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

/// On-demand metrics snapshot — the pull-based complement to
/// [`start_metrics_loop`]. Blocking (refreshes `sysinfo`); callers on an
/// async runtime should run this via `spawn_blocking`.
pub fn snapshot(registry: &WorkerRegistry, shared_sys: &SharedSystem) -> serde_json::Value {
    let mut sys = shared_sys.0.lock();
    sys.refresh_cpu_usage();
    sys.refresh_memory();
    sys.refresh_processes(sysinfo::ProcessesToUpdate::All, true);

    let cpu_percent = sys.global_cpu_usage() as f64;
    let memory_mb = sys.used_memory() as f64 / (1024.0 * 1024.0);
    let memory_total_mb = sys.total_memory() as f64 / (1024.0 * 1024.0);
    let per_worker = collect_per_worker_metrics(registry, &sys);
    drop(sys);

    let worker_metrics = registry.aggregate_metrics();

    serde_json::json!({
        "cpuPercent": cpu_percent,
        "memoryMb": memory_mb,
        "memoryTotalMb": memory_total_mb,
        "totalWorkers": worker_metrics.total_workers,
        "running": worker_metrics.running,
        "paused": worker_metrics.paused,
        "idle": worker_metrics.idle,
        "errored": worker_metrics.errored,
        "perWorker": per_worker,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_shared_system_new() {
        let shared = SharedSystem::new();
        let sys = shared.0.lock();
        assert!(sys.total_memory() > 0);
    }

    #[test]
    fn test_collect_per_worker_metrics_empty_registry() {
        let registry = WorkerRegistry::new();
        let sys = System::new_all();
        let metrics = collect_per_worker_metrics(&registry, &sys);
        assert!(metrics.is_empty());
    }

    #[test]
    fn test_snapshot_shape_on_empty_registry() {
        let registry = WorkerRegistry::new();
        let shared = SharedSystem::new();
        let snap = snapshot(&registry, &shared);
        assert_eq!(snap["totalWorkers"], 0);
        assert!(snap["perWorker"].as_array().unwrap().is_empty());
    }
}
