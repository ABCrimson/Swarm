//! Single-writer orchestration engine: seq assignment, persistence, emission.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::mpsc::Receiver;
use std::time::{Duration, Instant};

use serde::Serialize;
use tokio::sync::broadcast;

use super::log::EventLog;
use crate::events::{EventSink, SwarmEvent};

/// The single ordered channel name every backend event is logically
/// pushed on. Not a Tauri-specific mechanism — the primary delivery
/// path is the `emit` closure passed to [`OrchestrationEngine::start`]
/// (the Tauri shell's closure emits under this name on the webview
/// event channel).
pub const EVENT_CHANNEL: &str = "swarm://events";

/// Buffer capacity for the SECONDARY broadcast fanout (see the
/// `broadcast_tx` field doc) — future multi-client use, not exercised
/// by the desktop shell today.
const BROADCAST_CAPACITY: usize = 4096;

/// Minimum interval between "broadcast send failed" log lines. A send
/// only fails when every receiver disconnected between the
/// `receiver_count() > 0` check and the send itself — rare, racy, and
/// diagnostic rather than routine, so it's rate-limited instead of
/// logged on every occurrence.
const BROADCAST_WARN_INTERVAL: Duration = Duration::from_secs(30);

/// Ordered envelope wrapping every [`SwarmEvent`] on the wire.
///
/// Serializes as `{"seq": n, "ts": n, "type": "...", "payload": {...}}` —
/// the flattened `SwarmEvent` contributes `type` + `payload` (its existing
/// adjacently-tagged representation), preserving all payload shapes.
#[derive(Debug, Clone, Serialize)]
pub struct DomainEvent {
    /// Monotonic sequence number. Wire order == seq order.
    pub seq: u64,
    /// Unix timestamp in milliseconds, assigned by the writer thread.
    pub ts: i64,
    #[serde(flatten)]
    pub event: SwarmEvent,
}

/// Whether an event belongs in the durable log.
///
/// High-frequency telemetry flows through the ordered stream (it still
/// consumes sequence numbers) but is not history: it cannot be backfilled
/// after a gap and is not replayed.
pub fn is_persistent(event: &SwarmEvent) -> bool {
    !matches!(
        event,
        SwarmEvent::WorkerOutput(_) | SwarmEvent::SystemMetrics(_) | SwarmEvent::SystemLog(_)
    )
}

/// Handle to the single-writer orchestration engine.
///
/// [`Self::record`] (via [`EventSink`]) is fire-and-forget from any
/// thread; the dedicated writer thread assigns seq, persists (per
/// policy), and emits — guaranteeing total order on the wire.
#[derive(Clone)]
pub struct OrchestrationEngine {
    sink: EventSink,
    db_path: Option<PathBuf>,
    /// Secondary fanout; lossy under lag by design. The primary shell
    /// path is the synchronous `emit` closure passed to [`Self::start`],
    /// which never drops an event — this broadcast channel exists only
    /// for future multi-client use (Phase 2's `swarmd`, per the
    /// headless-daemon plan), where a per-connection two-lane
    /// backpressure scheme handles lag by design. Remote subscribers
    /// must heal lag via `events_since` replay; the desktop shell does
    /// not subscribe to this at all today.
    broadcast_tx: broadcast::Sender<Arc<DomainEvent>>,
}

impl OrchestrationEngine {
    /// Spawns the writer thread and returns the engine handle.
    ///
    /// `emit` is the PRIMARY delivery path: called synchronously, in
    /// sequence-number order, for every event (persisted or not) —
    /// exactly mirroring the pre-split direct `app.emit` call. It must
    /// not be lossy; a slow consumer should back up the (unbounded)
    /// writer channel rather than have events silently vanish, since
    /// ephemeral event types (`worker_output`, `system_metrics`,
    /// `system_log`) are never persisted and can never be backfilled
    /// once dropped.
    ///
    /// Every event is additionally offered to a SECONDARY broadcast
    /// fanout (see the `broadcast_tx` field and [`Self::subscribe`])
    /// for future multi-client use — that path is intentionally lossy
    /// under lag and is skipped entirely (no clone, no send) when
    /// nothing is subscribed, which is the common case for a
    /// desktop-only shell.
    ///
    /// `db_path` is retained so read-only connections (e.g. the
    /// `events_since` command) can be opened against the same file;
    /// pass `None` for in-memory logs.
    pub fn start(
        log: EventLog,
        db_path: Option<PathBuf>,
        mut emit: impl FnMut(&DomainEvent) + Send + 'static,
    ) -> Self {
        let (tx, rx) = std::sync::mpsc::channel::<SwarmEvent>();
        let (broadcast_tx, _) = broadcast::channel::<Arc<DomainEvent>>(BROADCAST_CAPACITY);
        let writer_broadcast_tx = broadcast_tx.clone();
        std::thread::Builder::new()
            .name("swarm-event-writer".to_string())
            .spawn(move || {
                let mut last_broadcast_warn: Option<Instant> = None;
                run_writer_loop(rx, log, move |envelope| {
                    // Primary path first, synchronous and lossless.
                    emit(envelope);

                    // Secondary path: only pay for the Arc + clone when
                    // someone is actually subscribed.
                    if writer_broadcast_tx.receiver_count() > 0 {
                        let arc = Arc::new(envelope.clone());
                        if writer_broadcast_tx.send(arc).is_err() {
                            let now = Instant::now();
                            let should_warn = last_broadcast_warn
                                .is_none_or(|t| now.duration_since(t) >= BROADCAST_WARN_INTERVAL);
                            if should_warn {
                                tracing::warn!(
                                    "broadcast fanout send failed (all receivers disconnected \
                                     between the receiver_count check and send)"
                                );
                                last_broadcast_warn = Some(now);
                            }
                        }
                    }
                });
            })
            .expect("failed to spawn event writer thread");
        Self {
            sink: EventSink::new(tx),
            db_path,
            broadcast_tx,
        }
    }

    /// Enqueues an event for ordering, persistence, and emission.
    pub fn record(&self, event: SwarmEvent) {
        self.sink.emit(event);
    }

    /// Returns a cloneable [`EventSink`] for callers that only need to
    /// record events (workers, the AI client/queue, metrics loop, bus
    /// forwarding) without the rest of the engine's surface.
    pub fn sink(&self) -> EventSink {
        self.sink.clone()
    }

    /// Subscribes to the SECONDARY broadcast fanout — see the doc on
    /// the `broadcast_tx` field. Not used by the desktop shell; exists
    /// for future multi-client (Phase 2 `swarmd`) use.
    pub fn subscribe(&self) -> broadcast::Receiver<Arc<DomainEvent>> {
        self.broadcast_tx.subscribe()
    }

    /// Path of the SQLite log, when file-backed.
    pub fn db_path(&self) -> Option<&Path> {
        self.db_path.as_deref()
    }
}

/// The writer loop. Extracted from the thread body so unit tests can
/// drive it synchronously with a plain closure instead of a live
/// broadcast channel.
fn run_writer_loop(
    rx: Receiver<SwarmEvent>,
    mut log: EventLog,
    mut emit: impl FnMut(&DomainEvent),
) -> EventLog {
    let mut seq = log.max_seq().unwrap_or(0);
    while let Ok(event) = rx.recv() {
        seq += 1;
        let ts = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0);
        let envelope = DomainEvent { seq, ts, event };

        if is_persistent(&envelope.event) {
            match serde_json::to_value(&envelope.event) {
                Ok(tagged) => {
                    let event_type = tagged["type"].as_str().unwrap_or("unknown").to_string();
                    let payload = tagged["payload"].to_string();
                    if let Err(e) = log.append(seq, ts, &event_type, &payload) {
                        tracing::error!(seq, error = %e, "failed to persist event");
                    }
                }
                Err(e) => tracing::error!(seq, error = %e, "failed to serialize event"),
            }
        }

        emit(&envelope);
    }
    log
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::events::{
        AiStreamSettledPayload, CommitCreatedPayload, ShipProgressPayload, ShipSettledPayload,
        SwarmEvent, SystemMetricsPayload, WorkerOutputPayload, WorkerSpawnedPayload,
        WorktreeCreatedPayload, WorktreeRemovedPayload,
    };
    use uuid::Uuid;

    fn spawned() -> SwarmEvent {
        SwarmEvent::WorkerSpawned(WorkerSpawnedPayload {
            worker_id: Uuid::nil(),
            name: "w".to_string(),
            pid: None,
            isolation: None,
        })
    }

    #[test]
    fn test_persistence_policy() {
        assert!(is_persistent(&spawned()));
        assert!(!is_persistent(&SwarmEvent::WorkerOutput(
            WorkerOutputPayload {
                worker_id: Uuid::nil(),
                data: "x".to_string(),
            }
        )));
        assert!(!is_persistent(&SwarmEvent::SystemMetrics(
            SystemMetricsPayload {
                cpu_percent: 0.0,
                memory_mb: 0.0,
                memory_total_mb: 0.0,
                worker_count: 0,
                ai_req_per_sec: 0.0,
                timestamp: 0,
            }
        )));
        assert!(is_persistent(&SwarmEvent::AiStreamSettled(
            AiStreamSettledPayload {
                request_id: "req-1".to_string(),
                status: "ok".to_string(),
                error: None,
            }
        )));
    }

    /// DIRECTIVE: worktree_created and worktree_removed both persist —
    /// `is_persistent` excludes by name (`WorkerOutput`, `SystemMetrics`,
    /// `SystemLog`), so any new variant is persistent by construction
    /// unless explicitly added to that list. These pin the outcome down
    /// so a future refactor of the exclusion list can't silently drop
    /// worktree lifecycle events out of the durable log.
    #[test]
    fn test_worktree_events_are_persistent() {
        assert!(is_persistent(&SwarmEvent::WorktreeCreated(
            WorktreeCreatedPayload {
                worker_id: Uuid::nil(),
                session_id: None,
                repo_root: "/repo".to_string(),
                worktree_path: "/repo-wt".to_string(),
                branch: "swarm/x-abcd1234".to_string(),
                base_commit: "sha".to_string(),
            }
        )));
        assert!(is_persistent(&SwarmEvent::WorktreeRemoved(
            WorktreeRemovedPayload {
                worker_id: Uuid::nil(),
                worktree_path: "/repo-wt".to_string(),
                branch: "swarm/x-abcd1234".to_string(),
                disposition: "removed".to_string(),
                head_commit: None,
                reason: None,
            }
        )));
    }

    /// DIRECTIVE: `ship_progress`/`ship_settled`/`commit_created` all
    /// persist — same "excluded by name, persistent by construction"
    /// guarantee as the worktree events (see the test above).
    #[test]
    fn test_ship_events_are_persistent() {
        assert!(is_persistent(&SwarmEvent::ShipProgress(
            ShipProgressPayload {
                ship_id: Uuid::nil(),
                worker_id: Uuid::nil(),
                step: "commit".to_string(),
                status: "running".to_string(),
                detail: None,
            }
        )));
        assert!(is_persistent(&SwarmEvent::ShipSettled(
            ShipSettledPayload {
                ship_id: Uuid::nil(),
                worker_id: Uuid::nil(),
                commit_sha: None,
                pushed_ref: None,
                pr_url: None,
                status: "ok".to_string(),
                error: None,
            }
        )));
        assert!(is_persistent(&SwarmEvent::CommitCreated(
            CommitCreatedPayload {
                worker_id: Uuid::nil(),
                sha: "sha".to_string(),
                branch: "swarm/x-abcd1234".to_string(),
                seq_from: 0,
                seq_to: 1,
            }
        )));
    }

    #[test]
    fn test_domain_event_envelope_shape() {
        let envelope = DomainEvent {
            seq: 7,
            ts: 123,
            event: spawned(),
        };
        let json = serde_json::to_value(&envelope).unwrap();
        assert_eq!(json["seq"], 7);
        assert_eq!(json["ts"], 123);
        assert_eq!(json["type"], "worker_spawned");
        assert_eq!(
            json["payload"]["workerId"],
            "00000000-0000-0000-0000-000000000000"
        );
    }

    #[test]
    fn test_writer_persists_with_monotonic_seq() {
        // Drive the writer loop directly (no Tauri AppHandle in unit tests).
        let log = EventLog::open_in_memory().unwrap();
        let (tx, rx) = std::sync::mpsc::channel::<SwarmEvent>();
        tx.send(spawned()).unwrap();
        tx.send(SwarmEvent::WorkerOutput(WorkerOutputPayload {
            worker_id: Uuid::nil(),
            data: "ephemeral".to_string(),
        }))
        .unwrap();
        tx.send(spawned()).unwrap();
        drop(tx);

        let log = run_writer_loop(rx, log, |_envelope| {});
        let stored = log.events_since(0, 100).unwrap();
        // WorkerOutput consumed seq 2 but was not persisted.
        assert_eq!(stored.iter().map(|e| e.seq).collect::<Vec<_>>(), vec![1, 3]);
        assert_eq!(stored[0].event_type, "worker_spawned");
    }

    #[test]
    fn test_writer_resumes_seq_after_restart() {
        let log = EventLog::open_in_memory().unwrap();
        let (tx, rx) = std::sync::mpsc::channel::<SwarmEvent>();
        tx.send(spawned()).unwrap();
        drop(tx);
        let mut log = run_writer_loop(rx, log, |_| {});
        // Simulate a prior run reaching seq 41.
        log.append(41, 1, "session_created", "{}").unwrap();

        let (tx2, rx2) = std::sync::mpsc::channel::<SwarmEvent>();
        let mut seen = Vec::new();
        tx2.send(spawned()).unwrap();
        drop(tx2);
        let log = run_writer_loop(rx2, log, |envelope| seen.push(envelope.seq));
        assert_eq!(seen, vec![42]);
        assert_eq!(log.max_seq().unwrap(), 42);
    }
}
