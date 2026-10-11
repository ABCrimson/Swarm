//! Host and per-worker resource metrics.
//!
//! [`start_metrics_loop`] pushes a `system_metrics` event every
//! `METRICS_INTERVAL` (host CPU and RAM plus the worker count);
//! [`MetricsSnapshot::collect`] answers `get_metrics` on demand with the same host
//! figures, the worker count per state, and each worker's CPU and memory
//! summed over its whole process tree.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::Duration;

use parking_lot::Mutex;
use serde::Serialize;
use sysinfo::{
    CpuRefreshKind, MemoryRefreshKind, Pid, ProcessRefreshKind, ProcessesToUpdate, RefreshKind,
    System,
};
use tokio::time::MissedTickBehavior;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use crate::events::{EventSink, SwarmEvent, SystemMetricsPayload};
use crate::worker::registry::{AggregateMetrics, WorkerRegistry};

/// How often [`start_metrics_loop`] samples the host.
const METRICS_INTERVAL: Duration = Duration::from_millis(500);

const BYTES_PER_MIB: f64 = 1024.0 * 1024.0;

/// The `sysinfo` state shared by the metrics loop and [`MetricsSnapshot::collect`].
///
/// CPU usage is a delta between two refreshes of the same `System`, so
/// one instance lives for the whole run instead of a fresh one per
/// sample.
#[derive(Clone)]
pub struct SharedSystem(Arc<Mutex<System>>);

impl SharedSystem {
    /// Loads only what the host metrics read (global CPU usage and RAM);
    /// the process table is read on demand by [`MetricsSnapshot::collect`].
    pub fn new() -> Self {
        let host = RefreshKind::nothing()
            .with_cpu(CpuRefreshKind::nothing().with_cpu_usage())
            .with_memory(MemoryRefreshKind::nothing().with_ram());
        Self(Arc::new(Mutex::new(System::new_with_specifics(host))))
    }
}

impl Default for SharedSystem {
    fn default() -> Self {
        Self::new()
    }
}

/// Host-wide CPU and RAM usage.
#[derive(Debug, Clone, Copy)]
struct HostUsage {
    cpu_percent: f64,
    memory_mb: f64,
    memory_total_mb: f64,
}

impl HostUsage {
    /// Refreshes `sys`'s CPU and RAM figures and reads them. Blocking.
    fn refresh(sys: &mut System) -> Self {
        sys.refresh_cpu_usage();
        sys.refresh_memory_specifics(MemoryRefreshKind::nothing().with_ram());
        Self {
            cpu_percent: f64::from(sys.global_cpu_usage()),
            memory_mb: sys.used_memory() as f64 / BYTES_PER_MIB,
            memory_total_mb: sys.total_memory() as f64 / BYTES_PER_MIB,
        }
    }
}

/// Starts the background loop that emits a `system_metrics` event every
/// `METRICS_INTERVAL` until `cancel` fires.
///
/// After a stall (a busy blocking pool, a suspended machine) the next
/// sample waits a full interval rather than catching up with
/// back-to-back refreshes, whose CPU deltas would be meaningless. A
/// sample whose refresh panics is logged and skipped, never reported as
/// zeros.
pub fn start_metrics_loop(
    sink: EventSink,
    registry: WorkerRegistry,
    shared_sys: SharedSystem,
    cancel: CancellationToken,
) {
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(METRICS_INTERVAL);
        interval.set_missed_tick_behavior(MissedTickBehavior::Delay);
        tracing::info!(
            interval_ms = METRICS_INTERVAL.as_millis(),
            "metrics loop started"
        );

        while cancel.run_until_cancelled(interval.tick()).await.is_some() {
            let sys = Arc::clone(&shared_sys.0);
            let host = match tokio::task::spawn_blocking(move || {
                HostUsage::refresh(&mut sys.lock())
            })
            .await
            {
                Ok(host) => host,
                Err(e) => {
                    tracing::error!(error = %e, "host metrics refresh failed; sample skipped");
                    continue;
                }
            };
            sink.emit(SwarmEvent::SystemMetrics(SystemMetricsPayload {
                cpu_percent: host.cpu_percent,
                memory_mb: host.memory_mb,
                memory_total_mb: host.memory_total_mb,
                worker_count: registry.count(),
                timestamp: crate::clock::unix_millis(),
            }));
        }
        tracing::info!("metrics loop shutting down");
    });
}

/// One worker's resource usage, summed over its shell and every process
/// descended from it.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkerProcessMetrics {
    /// The worker.
    pub worker_id: Uuid,
    /// OS process ID of the worker's shell, if the OS reported one.
    pub pid: Option<u32>,
    /// CPU usage of the process tree, in percent of one core (so it can
    /// exceed 100 on a multi-core machine).
    pub cpu_percent: f64,
    /// Resident memory of the process tree, in bytes.
    pub memory_bytes: u64,
}

/// The `get_metrics` result, built by [`Self::collect`].
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MetricsSnapshot {
    /// Host CPU usage across all cores, in percent.
    pub cpu_percent: f64,
    /// Host RAM in use, in MiB.
    pub memory_mb: f64,
    /// Host RAM installed, in MiB.
    pub memory_total_mb: f64,
    /// Registered workers per state (flattened: `totalWorkers`,
    /// `running`, `paused`, `idle`, `errored`).
    #[serde(flatten)]
    pub workers: AggregateMetrics,
    /// Each worker's process-tree usage.
    pub per_worker: Vec<WorkerProcessMetrics>,
}

impl MetricsSnapshot {
    /// Refreshes the host figures and the process table, then measures
    /// every registered worker. Blocking.
    ///
    /// Per-process CPU usage is a delta since the previous refresh of
    /// the same [`SharedSystem`], so the first snapshot reports 0 for
    /// every worker.
    pub fn collect(registry: &WorkerRegistry, shared_sys: &SharedSystem) -> Self {
        let mut sys = shared_sys.0.lock();
        let host = HostUsage::refresh(&mut sys);
        // Every process, not only the workers' shells: their
        // descendants are only found through the parent links of the
        // whole table. CPU and memory only, no command lines; tasks stay
        // on (the sysinfo default), so ProcessTree::new skips the thread
        // entries.
        sys.refresh_processes_specifics(
            ProcessesToUpdate::All,
            true,
            ProcessRefreshKind::nothing().with_cpu().with_memory(),
        );
        let per_worker = collect_per_worker_metrics(registry, &sys);
        drop(sys);

        Self {
            cpu_percent: host.cpu_percent,
            memory_mb: host.memory_mb,
            memory_total_mb: host.memory_total_mb,
            workers: registry.aggregate_metrics(),
            per_worker,
        }
    }
}

/// Measures every registered worker's process tree in `sys`, whose
/// process table the caller has already refreshed. A worker without a
/// PID, or whose shell has exited, reports zeros.
fn collect_per_worker_metrics(
    registry: &WorkerRegistry,
    sys: &System,
) -> Vec<WorkerProcessMetrics> {
    let tree = ProcessTree::new(sys);
    registry
        .list_workers()
        .into_iter()
        .map(|worker| {
            let (cpu_percent, memory_bytes) = worker
                .pid
                .map_or((0.0, 0), |pid| tree.usage(Pid::from_u32(pid)));
            WorkerProcessMetrics {
                worker_id: worker.id,
                pid: worker.pid,
                cpu_percent,
                memory_bytes,
            }
        })
        .collect()
}

/// The parent-to-children links of a process table.
struct ProcessTree<'s> {
    sys: &'s System,
    children: HashMap<Pid, Vec<Pid>>,
}

impl<'s> ProcessTree<'s> {
    fn new(sys: &'s System) -> Self {
        let mut children = HashMap::<Pid, Vec<Pid>>::new();
        for (&pid, process) in sys.processes() {
            // Threads listed as tasks share their process's memory.
            if process.thread_kind().is_none()
                && let Some(parent) = process.parent()
            {
                children.entry(parent).or_default().push(pid);
            }
        }
        Self { sys, children }
    }

    /// CPU percent and memory bytes of `root` and all its descendants;
    /// zeros when `root` is not running.
    fn usage(&self, root: Pid) -> (f64, u64) {
        let (mut cpu, mut memory) = (0.0, 0);
        if self.sys.process(root).is_none() {
            return (cpu, memory);
        }
        let mut seen = HashSet::new();
        let mut pending = vec![root];
        while let Some(pid) = pending.pop() {
            // A reused PID could close a loop in the parent links.
            if !seen.insert(pid) {
                continue;
            }
            if let Some(process) = self.sys.process(pid) {
                cpu += f64::from(process.cpu_usage());
                memory += process.memory();
            }
            pending.extend(self.children.get(&pid).into_iter().flatten());
        }
        (cpu, memory)
    }
}

#[cfg(test)]
mod tests {
    use std::process::{Child, Command, Stdio};
    use std::time::Instant;

    use super::*;
    use crate::worker::handle::{WorkerHandle, WorkerState};

    #[test]
    fn test_shared_system_loads_host_memory_but_no_process_table() {
        let shared = SharedSystem::new();
        let sys = shared.0.lock();
        assert!(sys.total_memory() > 0);
        assert!(
            sys.processes().is_empty(),
            "the process table loads on demand"
        );
    }

    #[test]
    fn test_collect_per_worker_metrics_empty_registry() {
        let registry = WorkerRegistry::new();
        let sys = System::new();
        assert!(collect_per_worker_metrics(&registry, &sys).is_empty());
    }

    #[test]
    fn test_snapshot_shape_on_empty_registry() {
        let registry = WorkerRegistry::new();
        let snap = serde_json::to_value(MetricsSnapshot::collect(&registry, &SharedSystem::new()))
            .unwrap();
        assert_eq!(snap["totalWorkers"], 0);
        assert_eq!(snap["running"], 0);
        assert!(snap["memoryTotalMb"].as_f64().unwrap() > 0.0);
        assert!(snap["perWorker"].as_array().unwrap().is_empty());
    }

    /// A shell that runs one long-lived child and waits for it.
    fn spawn_parent_with_child() -> Child {
        let mut cmd = if cfg!(windows) {
            let mut cmd = Command::new("cmd.exe");
            cmd.args(["/d", "/c", "ping -n 60 127.0.0.1 >nul"]);
            cmd
        } else {
            let mut cmd = Command::new("/bin/sh");
            cmd.args(["-c", "sleep 60 & wait"]);
            cmd
        };
        cmd.stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("the test shell spawns")
    }

    /// A worker's usage is summed over its shell and every descendant
    /// process, so the programs it runs (builds, agents) are counted.
    #[test]
    fn test_worker_usage_includes_the_shells_descendants() {
        let parent = std::mem::DropGuard::new(spawn_parent_with_child(), |mut parent: Child| {
            let _ = parent.kill();
            let _ = parent.wait();
        });
        let parent_pid = Pid::from_u32(parent.id());

        let registry = WorkerRegistry::new();
        let worker_id = registry
            .register(WorkerHandle {
                id: Uuid::new_v4(),
                state: WorkerState::Running,
                name: "tree".to_owned(),
                pid: Some(parent_pid.as_u32()),
                started_at: 0,
                pty_writer: None,
                child: None,
                worktree_path: None,
                repo_root: None,
                branch: None,
                base_commit: None,
                last_shipped_seq: None,
                last_shipped_commit: None,
            })
            .unwrap();

        let mut sys = System::new();
        let deadline = Instant::now() + Duration::from_secs(10);
        let child_pid = loop {
            sys.refresh_processes_specifics(
                ProcessesToUpdate::All,
                true,
                ProcessRefreshKind::nothing().with_memory(),
            );
            let child = sys
                .processes()
                .iter()
                .find(|(_, process)| process.parent() == Some(parent_pid))
                .map(|(&pid, _)| pid);
            if let Some(child) = child {
                break child;
            }
            assert!(
                Instant::now() < deadline,
                "the shell never started its child"
            );
            std::thread::sleep(Duration::from_millis(20));
        };

        let own = sys.process(parent_pid).unwrap().memory();
        let child = sys.process(child_pid).unwrap().memory();
        let metrics = collect_per_worker_metrics(&registry, &sys);
        assert_eq!(metrics.len(), 1);
        assert_eq!(metrics[0].worker_id, worker_id);
        assert!(child > 0, "the child has resident memory");
        assert!(
            metrics[0].memory_bytes >= own + child,
            "{} < shell {own} + child {child}",
            metrics[0].memory_bytes
        );
    }

    /// A worker without a PID, or whose PID is not in the process table
    /// (its shell has exited), reports zeros and keeps its PID.
    #[test]
    fn test_a_worker_without_a_live_shell_reports_zeros() {
        for pid in [None, Some(u32::MAX - 1)] {
            let registry = WorkerRegistry::new();
            registry
                .register(WorkerHandle {
                    id: Uuid::new_v4(),
                    state: WorkerState::Error,
                    name: "gone".to_owned(),
                    pid,
                    started_at: 0,
                    pty_writer: None,
                    child: None,
                    worktree_path: None,
                    repo_root: None,
                    branch: None,
                    base_commit: None,
                    last_shipped_seq: None,
                    last_shipped_commit: None,
                })
                .unwrap();
            let metrics = collect_per_worker_metrics(&registry, &System::new());
            assert_eq!(metrics.len(), 1);
            assert_eq!(metrics[0].pid, pid);
            assert_eq!(
                (metrics[0].cpu_percent, metrics[0].memory_bytes),
                (0.0, 0),
                "{pid:?}"
            );
        }
    }
}
