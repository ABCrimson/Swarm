//! Single-writer orchestration engine: seq assignment, persistence, emission.

use std::path::{Path, PathBuf};
use std::sync::mpsc::{Receiver, Sender};

use serde::Serialize;
use tauri::Emitter;

use super::log::EventLog;
use crate::events::SwarmEvent;

/// The single Tauri channel every backend event is pushed on.
pub const EVENT_CHANNEL: &str = "swarm://events";

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
/// `record` is fire-and-forget from any thread; the dedicated writer
/// thread assigns seq, persists (per policy), and emits — guaranteeing
/// total order on the wire.
#[derive(Clone)]
pub struct OrchestrationEngine {
    tx: Sender<SwarmEvent>,
    db_path: Option<PathBuf>,
}

impl OrchestrationEngine {
    /// Spawns the writer thread and returns the engine handle.
    ///
    /// `db_path` is retained so read-only connections (e.g. the
    /// `events_since` command) can be opened against the same file;
    /// pass `None` for in-memory logs.
    pub fn start(app: tauri::AppHandle, log: EventLog, db_path: Option<PathBuf>) -> Self {
        let (tx, rx) = std::sync::mpsc::channel::<SwarmEvent>();
        std::thread::Builder::new()
            .name("swarm-event-writer".to_string())
            .spawn(move || {
                run_writer_loop(rx, log, move |envelope| {
                    if let Err(e) = app.emit(EVENT_CHANNEL, envelope) {
                        tracing::error!(error = %e, "failed to emit domain event");
                    }
                });
            })
            .expect("failed to spawn event writer thread");
        Self { tx, db_path }
    }

    /// Enqueues an event for ordering, persistence, and emission.
    pub fn record(&self, event: SwarmEvent) {
        if self.tx.send(event).is_err() {
            tracing::error!("event writer thread is gone; event dropped");
        }
    }

    /// Path of the SQLite log, when file-backed.
    pub fn db_path(&self) -> Option<&Path> {
        self.db_path.as_deref()
    }
}

/// The writer loop. Extracted from the thread body so unit tests can
/// drive it synchronously without a Tauri `AppHandle`.
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
        AiStreamSettledPayload, SwarmEvent, SystemMetricsPayload, WorkerOutputPayload,
        WorkerSpawnedPayload,
    };
    use uuid::Uuid;

    fn spawned() -> SwarmEvent {
        SwarmEvent::WorkerSpawned(WorkerSpawnedPayload {
            worker_id: Uuid::nil(),
            name: "w".to_string(),
            pid: None,
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
