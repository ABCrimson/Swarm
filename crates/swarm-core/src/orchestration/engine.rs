//! Single-writer orchestration engine: seq assignment, persistence,
//! emission.
//!
//! Every [`SwarmEvent`] recorded through an [`EventSink`] lands on one
//! FIFO channel drained by one OS thread (`swarm-event-writer`). For each
//! event that thread assigns the next seq, persists the event when
//! [`is_persistent`] says so, and only then emits the envelope — so the
//! wire order is the seq order, and every persisted event a client sees
//! live is already readable from the log.
//!
//! # Failing closed
//!
//! A write failure never leaks: an event whose seq cannot be reserved,
//! or which cannot be appended to the log, reaches no delivery path (not
//! the `emit` closure, not the broadcast fanout), does not move
//! [`OrchestrationEngine::head_seq`], and resolves its
//! [`EventSink::emit_awaiting_seq`] receiver to a `RecvError`. A failed
//! append leaves a one-seq gap that one ephemeral `system_log` error
//! event explains; clients backfill an empty page and skip it.
//!
//! # Seq guarantees
//!
//! Seqs are unique and strictly increasing for the lifetime of the data
//! directory, across restarts and crashes: the writer reserves seqs in
//! the log in blocks of `SEQ_RESERVATION_BLOCK` (1024) BEFORE issuing them,
//! and a restarted engine resumes after the highest seq any earlier run
//! could have issued ([`EventLog::resume_seq`]). A crash therefore costs
//! at most one unused block of seqs, never a reused one; a clean
//! [`OrchestrationEngine::shutdown`] records its exact head, so a clean
//! restart continues without a gap.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use parking_lot::Mutex;
use serde::Serialize;
use tokio::sync::{broadcast, oneshot};
use uuid::Uuid;

use super::log::EventLog;
use crate::error::AppError;
use crate::events::{EventSink, Provenance, SwarmEvent, SystemLogPayload, WriterCmd, WriterMsg};

/// The single ordered channel name every backend event is logically
/// pushed on. The desktop shell's `emit` closure (see
/// [`OrchestrationEngine::try_start`]) emits each envelope under this name
/// on its webview event channel.
pub const EVENT_CHANNEL: &str = "swarm://events";

/// Buffer capacity of the secondary broadcast fanout
/// ([`OrchestrationEngine::subscribe`]).
const BROADCAST_CAPACITY: usize = 4096;

/// Minimum interval between "broadcast send failed" log lines. A send
/// only fails when every receiver disconnected between the
/// `receiver_count() > 0` check and the send itself — rare and
/// diagnostic, so it is rate-limited rather than logged every time.
const BROADCAST_WARN_INTERVAL: Duration = Duration::from_secs(30);

/// How many seqs one reservation write covers. A crash skips at most
/// this many seqs; a busy writer pays one tiny `meta` write per block.
const SEQ_RESERVATION_BLOCK: u64 = 1024;

/// Ordered envelope wrapping every [`SwarmEvent`] on the wire.
///
/// Serializes as `{"seq", "ts", "originWorker"?, "causeSeq"?, "type",
/// "payload"}` — the flattened `SwarmEvent` contributes `type` and
/// `payload` (its adjacently-tagged representation). A replayed
/// [`super::StoredEvent`] serializes to the same JSON value, keys in
/// the same order (only the key order INSIDE `payload` can differ, as
/// the log hands it back as a [`serde_json::Value`]).
#[derive(Debug, Clone, Serialize)]
pub struct DomainEvent {
    /// Unique, monotonic sequence number. Wire order == seq order.
    pub seq: u64,
    /// Unix timestamp in milliseconds, assigned by the writer thread.
    pub ts: i64,
    /// UUID of the worker whose action caused this event (the CAUSER),
    /// when known. Absent (not `null`) when unattributed — see
    /// [`Provenance`]'s doc — so the common unattributed case (e.g.
    /// every `worker_output` chunk) pays no wire tax for it.
    #[serde(rename = "originWorker", skip_serializing_if = "Option::is_none")]
    pub origin_worker: Option<Uuid>,
    /// Seq of the event this one is causally reacting to, when known.
    #[serde(rename = "causeSeq", skip_serializing_if = "Option::is_none")]
    pub cause_seq: Option<u64>,
    /// The event itself (`type` + `payload` on the wire).
    #[serde(flatten)]
    pub event: SwarmEvent,
}

/// Whether an event belongs in the durable log.
///
/// High-frequency telemetry flows through the ordered stream (it still
/// consumes seqs) but is not history: it cannot be backfilled after a
/// gap and is never replayed. Ephemeral: `worker_output`,
/// `system_metrics`, `system_log`, `agent_turn_delta` (its durable
/// counterpart is `agent_block`; persisting per-chunk rows would mean
/// hundreds of rows per second per streaming worker), and `worker_input`
/// whose source is [`crate::events::InputSource::Terminal`] — raw human
/// keystrokes, which would both flood the log and archive whatever the
/// user typed, secrets included. Machine-issued `worker_input` persists.
/// Every other variant persists, so a new variant is durable unless it
/// is added here.
pub fn is_persistent(event: &SwarmEvent) -> bool {
    match event {
        SwarmEvent::WorkerOutput(_)
        | SwarmEvent::SystemMetrics(_)
        | SwarmEvent::SystemLog(_)
        | SwarmEvent::AgentTurnDelta(_) => false,
        SwarmEvent::WorkerInput(p) => p.source.is_machine_issued(),
        _ => true,
    }
}

/// The engine is shut down, or its writer thread is gone.
fn writer_unavailable() -> AppError {
    AppError::EventLog("The Event Writer Is Shut Down.".to_string())
}

/// Handle to the single-writer orchestration engine. Cheap to clone:
/// every clone drives the same writer thread.
#[derive(Clone)]
pub struct OrchestrationEngine {
    sink: EventSink,
    db_path: Option<PathBuf>,
    /// Secondary fanout; lossy under lag by design. The primary path is
    /// the synchronous `emit` closure passed to [`Self::try_start`], which
    /// never drops an event. `swarmd` gives each WebSocket client a
    /// receiver and heals lag by replaying from the log.
    broadcast_tx: broadcast::Sender<Arc<DomainEvent>>,
    /// See [`Self::head_seq`].
    head: Arc<AtomicU64>,
    /// Shared with every [`EventSink`] clone; set by [`Self::shutdown`].
    closed: Arc<AtomicBool>,
    /// The writer thread, taken and joined by [`Self::shutdown`].
    writer: Arc<Mutex<Option<JoinHandle<()>>>>,
}

impl OrchestrationEngine {
    /// Starts the writer thread over `log` and returns the engine
    /// handle.
    ///
    /// `emit` is the PRIMARY delivery path: called on the writer thread,
    /// in seq order, for every event the writer issues a seq to and, if
    /// persistent, appends (see # Failing closed). It must not be
    /// lossy — a slow consumer should back up the (unbounded) writer
    /// channel rather than drop events, since ephemeral events can never
    /// be backfilled. Every delivered event is also offered to the secondary
    /// broadcast fanout ([`Self::subscribe`]), which costs nothing while
    /// nothing is subscribed.
    ///
    /// `db_path` lets readers ([`Self::db_path`]) open their own
    /// read-only connections to the same file; pass `None` for an
    /// in-memory log.
    ///
    /// # Errors
    ///
    /// [`AppError::EventLog`] if the log's resume seq cannot be read (a
    /// writer that guessed would reissue seqs clients have already
    /// seen) or the writer thread cannot be spawned.
    pub fn try_start(
        log: EventLog,
        db_path: Option<PathBuf>,
        emit: impl FnMut(&DomainEvent) + Send + 'static,
    ) -> Result<Self, AppError> {
        if let Err(e) = log.optimize_on_open() {
            tracing::warn!(error = %e, "event log PRAGMA optimize failed");
        }

        let (broadcast_tx, _) = broadcast::channel(BROADCAST_CAPACITY);
        let head = Arc::new(AtomicU64::new(0));
        let writer = Writer::new(
            log,
            Arc::clone(&head),
            emit,
            Fanout::new(broadcast_tx.clone()),
        )?;
        let (tx, rx) = mpsc::channel();
        let handle = std::thread::Builder::new()
            .name("swarm-event-writer".to_owned())
            .spawn(move || {
                writer.run(&rx);
            })
            .map_err(|e| {
                AppError::EventLog(format!("Failed To Spawn The Event Writer Thread: {e}"))
            })?;

        let closed = Arc::new(AtomicBool::new(false));
        Ok(Self {
            sink: EventSink::for_writer(tx, Arc::clone(&closed)),
            db_path,
            broadcast_tx,
            head,
            closed,
            writer: Arc::new(Mutex::new(Some(handle))),
        })
    }

    /// Test helper: [`Self::try_start`] that panics on failure.
    ///
    /// # Panics
    ///
    /// When [`Self::try_start`] fails.
    #[cfg(test)]
    pub(crate) fn start(
        log: EventLog,
        db_path: Option<PathBuf>,
        emit: impl FnMut(&DomainEvent) + Send + 'static,
    ) -> Self {
        Self::try_start(log, db_path, emit)
            .unwrap_or_else(|e| panic!("failed to start the orchestration engine: {e}"))
    }

    /// A cloneable [`EventSink`] for callers that only record events.
    pub fn sink(&self) -> EventSink {
        self.sink.clone()
    }

    /// Subscribes to the secondary broadcast fanout — see the
    /// `broadcast_tx` field. Lossy under lag: a receiver that falls
    /// behind gets `RecvError::Lagged` and must heal by replaying from
    /// the log.
    pub fn subscribe(&self) -> broadcast::Receiver<Arc<DomainEvent>> {
        self.broadcast_tx.subscribe()
    }

    /// Path of the SQLite log, when file-backed.
    pub fn db_path(&self) -> Option<&Path> {
        self.db_path.as_deref()
    }

    /// The seq of the newest event the writer has emitted — or, before
    /// the first one, the seq this engine resumed after. An in-memory
    /// read (no SQLite), safe on any thread.
    ///
    /// It counts every event, ephemeral ones included, so it can run
    /// ahead of [`EventLog::max_seq`]. The writer publishes it after
    /// persisting and emitting an event but BEFORE offering that event
    /// to the broadcast fanout, which gives two guarantees:
    ///
    /// - every persisted event with `seq <= head_seq()` is already
    ///   readable from the log;
    /// - a receiver from [`Self::subscribe`] obtained BEFORE this call
    ///   receives every event with a larger seq (lag aside) — so
    ///   "subscribe, then read the head" is a gap-free attach point.
    pub fn head_seq(&self) -> u64 {
        self.head.load(Ordering::Acquire)
    }

    /// Resolves once every event recorded before this call has been
    /// handled (persisted and emitted, or dropped fail-closed; see
    /// # Failing closed), with the head seq at that point.
    ///
    /// # Errors
    ///
    /// [`AppError::EventLog`] when the engine is shut down.
    pub async fn flush(&self) -> Result<u64, AppError> {
        let (done_tx, done_rx) = oneshot::channel();
        if !self.sink.send_command(WriterCmd::Flush(done_tx)) {
            return Err(writer_unavailable());
        }
        done_rx.await.map_err(|_| writer_unavailable())
    }

    /// Drains every event recorded before this call, finalizes the log
    /// (records the exact head as the seq reservation, runs `PRAGMA
    /// optimize`, checkpoints the WAL), and stops the writer thread.
    /// Returns the final head seq.
    ///
    /// Events recorded after shutdown begins are dropped (with a debug
    /// log), and [`EventSink::emit_awaiting_seq`] receivers for them
    /// resolve to an error. Calling it again returns the head without
    /// doing anything.
    ///
    /// # Blocking
    ///
    /// Waits up to `timeout` for the writer to drain. From async code,
    /// call it through `tokio::task::spawn_blocking` (as
    /// [`crate::runtime::Runtime::shutdown`] does).
    ///
    /// # Errors
    ///
    /// [`AppError::EventLog`] if the writer thread is already gone or
    /// does not drain within `timeout`.
    pub fn shutdown(&self, timeout: Duration) -> Result<u64, AppError> {
        if self.closed.swap(true, Ordering::AcqRel) {
            return Ok(self.head_seq());
        }
        let (done_tx, done_rx) = mpsc::sync_channel(1);
        if !self.sink.send_command(WriterCmd::Shutdown(done_tx)) {
            return Err(writer_unavailable());
        }
        let head = done_rx.recv_timeout(timeout).map_err(|_| {
            AppError::EventLog(format!(
                "The Event Writer Did Not Drain Within {} ms.",
                timeout.as_millis()
            ))
        })?;
        if let Some(handle) = self.writer.lock().take()
            && handle.join().is_err()
        {
            tracing::error!("the event writer thread panicked while shutting down");
        }
        Ok(head)
    }
}

/// The secondary broadcast fanout, as the writer thread drives it.
struct Fanout {
    tx: broadcast::Sender<Arc<DomainEvent>>,
    /// When the last "send failed" warning was logged.
    last_warn: Option<Instant>,
}

impl Fanout {
    const fn new(tx: broadcast::Sender<Arc<DomainEvent>>) -> Self {
        Self {
            tx,
            last_warn: None,
        }
    }

    /// Moves `envelope` into an `Arc` for every current subscriber.
    /// Costs nothing (no `Arc`) while nothing is subscribed.
    fn offer(&mut self, envelope: DomainEvent) {
        if self.tx.receiver_count() == 0 || self.tx.send(Arc::new(envelope)).is_ok() {
            return;
        }
        let now = Instant::now();
        if self
            .last_warn
            .is_none_or(|t| now.duration_since(t) >= BROADCAST_WARN_INTERVAL)
        {
            tracing::warn!(
                "broadcast fanout send failed (every receiver disconnected between \
                 the receiver_count check and the send)"
            );
            self.last_warn = Some(now);
        }
    }
}

/// The writer thread's state: the log, the seq counter, and both
/// delivery paths.
struct Writer<E> {
    log: EventLog,
    /// Seq of the last event issued.
    seq: u64,
    /// Highest seq already reserved in the log; seqs up to it may be
    /// issued without another reservation write.
    reserved: u64,
    /// Published copy of `seq` — see [`OrchestrationEngine::head_seq`].
    head: Arc<AtomicU64>,
    /// The primary, lossless delivery path.
    emit: E,
    fanout: Fanout,
    /// Whether the last seq reservation failed (to log an outage once).
    reserve_failing: bool,
}

impl<E: FnMut(&DomainEvent)> Writer<E> {
    fn new(log: EventLog, head: Arc<AtomicU64>, emit: E, fanout: Fanout) -> Result<Self, AppError> {
        let seq = log.resume_seq()?;
        head.store(seq, Ordering::Release);
        Ok(Self {
            log,
            seq,
            reserved: seq,
            head,
            emit,
            fanout,
            reserve_failing: false,
        })
    }

    /// Processes commands until a shutdown barrier arrives or every
    /// sender is gone, finalizes the log either way, and returns it.
    fn run(mut self, rx: &Receiver<WriterCmd>) -> EventLog {
        while let Ok(cmd) = rx.recv() {
            match cmd {
                WriterCmd::Record(msg) => self.record(msg),
                // Oneshot/sync-channel sends never block; a dropped
                // receiver (a cancelled caller) is simply ignored.
                WriterCmd::Flush(done) => {
                    let _ = done.send(self.seq);
                }
                WriterCmd::Shutdown(done) => {
                    self.finalize();
                    let _ = done.send(self.seq);
                    return self.log;
                }
            }
        }
        self.finalize();
        self.log
    }

    /// Orders one event: reserves its seq (when past the reservation),
    /// persists it (per [`is_persistent`]), emits it, publishes the new
    /// head, offers it to the fanout, and resolves its ack — in exactly
    /// that order (see [`OrchestrationEngine::head_seq`] for why the
    /// head is published between the emit and the fanout).
    ///
    /// # Fail closed
    ///
    /// A seq nobody can prove durable is never shown to anyone:
    ///
    /// - If the seq cannot be reserved in the log (after one retry) the
    ///   event is dropped whole — no emit, no head, no fanout — and the
    ///   seq counter is rolled back, so the next event retries the
    ///   reservation.
    /// - If a persistent event cannot be appended, nothing is emitted
    ///   on either delivery path and the head does not move; the ack
    ///   sender is dropped (the receiver resolves to a `RecvError`, the
    ///   same signal as a shut-down engine), and one ephemeral
    ///   `system_log` error event takes the next seq so clients see the
    ///   gap explained. A client treats the gap as ephemeral and
    ///   backfills an empty page.
    fn record(&mut self, msg: WriterMsg) {
        let WriterMsg {
            event,
            provenance,
            ack,
        } = msg;

        let Some(envelope) = self.issue(event, &provenance) else {
            // Dropping `ack` resolves its receiver to a `RecvError`.
            return;
        };
        if is_persistent(&envelope.event)
            && let Err(e) = self.persist(&envelope, &provenance)
        {
            tracing::error!(
                seq = envelope.seq,
                event_type = envelope.event.type_tag(),
                error = %e,
                "failed to persist event; it is not emitted"
            );
            drop(ack);
            self.report_persist_failure(&envelope, &e);
            return;
        }
        self.deliver(envelope);

        // Non-blocking by oneshot construction: a dropped receiver
        // (e.g. a cancelled IPC call) makes `send` return `Err`, which
        // is ignored — the writer never waits on a disinterested caller.
        if let Some(ack) = ack {
            let _ = ack.send(self.seq);
        }
    }

    /// Takes the next seq (reserving a block in the log when it passes
    /// the current reservation) and stamps `event` into an envelope.
    /// `None` — with the counter rolled back — when the reservation
    /// fails twice: handing out a seq the log has not reserved could
    /// reissue it after a crash.
    fn issue(&mut self, event: SwarmEvent, provenance: &Provenance) -> Option<DomainEvent> {
        self.seq += 1;
        if self.seq > self.reserved {
            let through = self.seq + SEQ_RESERVATION_BLOCK - 1;
            let reserved = self
                .log
                .reserve_seqs(through)
                .or_else(|_| self.log.reserve_seqs(through));
            match reserved {
                Ok(()) => {
                    self.reserved = through;
                    self.reserve_failing = false;
                }
                Err(e) => {
                    // One error line per outage, not one per event.
                    if self.reserve_failing {
                        tracing::debug!(seq = self.seq, error = %e, "event seq reservation still failing");
                    } else {
                        tracing::error!(
                            seq = self.seq,
                            error = %e,
                            "failed to reserve event seqs; events are dropped until the log recovers"
                        );
                        self.reserve_failing = true;
                    }
                    self.seq -= 1;
                    return None;
                }
            }
        }
        Some(DomainEvent {
            seq: self.seq,
            ts: crate::clock::unix_millis(),
            origin_worker: provenance.origin_worker,
            cause_seq: provenance.cause_seq,
            event,
        })
    }

    /// Delivers a durable-or-ephemeral envelope: primary emit, then the
    /// head, then the fanout (the order [`OrchestrationEngine::head_seq`]
    /// documents).
    fn deliver(&mut self, envelope: DomainEvent) {
        (self.emit)(&envelope);
        self.head.store(envelope.seq, Ordering::Release);
        self.fanout.offer(envelope);
    }

    /// Tells clients, with one ephemeral `system_log` error, that
    /// `failed`'s seq will never arrive. Best effort: if even this seq
    /// cannot be issued, the tracing line is all there is.
    fn report_persist_failure(&mut self, failed: &DomainEvent, error: &AppError) {
        let ts = crate::clock::unix_millis();
        let event = SwarmEvent::SystemLog(SystemLogPayload {
            level: "error".to_owned(),
            message: format!(
                "Event {} ({}) Could Not Be Saved And Was Dropped: {error}",
                failed.seq,
                failed.event.type_tag()
            ),
            target: module_path!().to_owned(),
            timestamp: ts,
        });
        if let Some(envelope) = self.issue(event, &Provenance::default()) {
            self.deliver(envelope);
        }
    }

    fn persist(&mut self, envelope: &DomainEvent, provenance: &Provenance) -> Result<(), AppError> {
        let payload = envelope.event.payload_json().map_err(AppError::from)?;
        self.log.append(
            envelope.seq,
            envelope.ts,
            envelope.event.type_tag(),
            &payload,
            provenance,
        )
    }

    fn finalize(&mut self) {
        if let Err(e) = self.log.finalize(self.seq) {
            tracing::warn!(error = %e, "failed to finalize the event log");
        }
    }
}

#[cfg(test)]
mod tests {
    use std::assert_matches;

    use super::*;
    use crate::events::{
        CommitCreatedPayload, InputSource, ShipProgressPayload, ShipSettledPayload,
        SystemMetricsPayload, WorkerInputPayload, WorkerOutputPayload, WorkerSpawnedPayload,
        WorktreeCreatedPayload, WorktreeRemovedPayload,
    };

    fn spawned() -> SwarmEvent {
        SwarmEvent::WorkerSpawned(WorkerSpawnedPayload {
            worker_id: Uuid::nil(),
            name: "w".to_string(),
            pid: None,
            isolation: None,
        })
    }

    fn output() -> SwarmEvent {
        SwarmEvent::WorkerOutput(WorkerOutputPayload {
            worker_id: Uuid::nil(),
            data: "ephemeral".to_string(),
        })
    }

    /// A bare event with unattributed provenance and no ack.
    fn bare(event: SwarmEvent) -> WriterMsg {
        WriterMsg {
            event,
            provenance: Provenance::default(),
            ack: None,
        }
    }

    fn msg(event: SwarmEvent) -> WriterCmd {
        WriterCmd::Record(bare(event))
    }

    /// Runs `cmds` through a writer over `log` on the current thread
    /// (the channel is closed after the last command), returning the
    /// finalized log and every emitted envelope.
    fn drive(log: EventLog, cmds: Vec<WriterCmd>) -> (EventLog, Vec<DomainEvent>) {
        let (tx, rx) = mpsc::channel();
        for cmd in cmds {
            tx.send(cmd).unwrap();
        }
        drop(tx);
        let mut seen = Vec::new();
        let log = Writer::new(
            log,
            Arc::default(),
            |e: &DomainEvent| seen.push(e.clone()),
            idle_fanout(),
        )
        .unwrap()
        .run(&rx);
        (log, seen)
    }

    /// A fanout nothing subscribes to.
    fn idle_fanout() -> Fanout {
        Fanout::new(broadcast::channel(1).0)
    }

    fn seqs(events: &[DomainEvent]) -> Vec<u64> {
        events.iter().map(|e| e.seq).collect()
    }

    // ── Persistence policy ───────────────────────────────────────────

    #[test]
    fn test_persistence_policy() {
        assert!(is_persistent(&spawned()));
        assert!(!is_persistent(&output()));
        assert!(!is_persistent(&SwarmEvent::SystemMetrics(
            SystemMetricsPayload {
                cpu_percent: 0.0,
                memory_mb: 0.0,
                memory_total_mb: 0.0,
                worker_count: 0,
                timestamp: 0,
            }
        )));
    }

    /// `worker_input` persistence depends on `source`: raw terminal
    /// keystrokes are excluded (they would flood the log AND archive
    /// typed secrets); machine-issued input persists.
    #[test]
    fn test_worker_input_persistence_depends_on_source() {
        let input = |source| {
            SwarmEvent::WorkerInput(WorkerInputPayload {
                worker_id: Uuid::nil(),
                bytes: 3,
                source,
                preview: None,
            })
        };
        assert!(!is_persistent(&input(InputSource::Terminal)));
        assert!(is_persistent(&input(InputSource::Tool)));
        assert!(is_persistent(&input(InputSource::Automation)));
    }

    /// Pins the durable events the causal graph, the ship chain and
    /// session replay depend on, so a change to the exclusion list
    /// cannot silently drop one of them out of the log.
    #[test]
    fn test_history_events_are_persistent() {
        use crate::agent::adapter::{
            AgentTurnStatus, CancelGranularity, Capabilities, PermissionDecision, ProviderId,
        };
        use crate::events::{
            AgentBlockPayload, AgentPermissionRequestPayload, AgentSessionExitedPayload,
            AgentSessionStartedPayload, AgentToolCallPayload, AgentToolResultPayload,
            AgentTurnSettledPayload, AgentTurnStartedPayload, FileWrittenPayload,
            SessionWorkerAddedPayload, SessionWorkerRemovedPayload,
        };

        let worker_id = Uuid::nil();
        let session_id = Uuid::nil();
        let durable = [
            SwarmEvent::FileWritten(FileWrittenPayload {
                path: "/home/user/.swarm/out.txt".to_string(),
                bytes: 7,
            }),
            SwarmEvent::AgentTurnStarted(AgentTurnStartedPayload {
                worker_id,
                model: "claude-sonnet-5".to_string(),
                request_id: "turn-1".to_string(),
            }),
            SwarmEvent::WorktreeCreated(WorktreeCreatedPayload {
                worker_id,
                session_id: None,
                repo_root: "/repo".to_string(),
                worktree_path: "/repo-wt".to_string(),
                branch: "swarm/x-abcd1234".to_string(),
                base_commit: "sha".to_string(),
            }),
            SwarmEvent::WorktreeRemoved(WorktreeRemovedPayload {
                worker_id,
                worktree_path: "/repo-wt".to_string(),
                branch: "swarm/x-abcd1234".to_string(),
                disposition: "removed".to_string(),
                head_commit: None,
                reason: None,
            }),
            SwarmEvent::ShipProgress(ShipProgressPayload {
                ship_id: Uuid::nil(),
                worker_id,
                step: "commit".to_string(),
                status: "running".to_string(),
                detail: None,
            }),
            SwarmEvent::ShipSettled(ShipSettledPayload {
                ship_id: Uuid::nil(),
                worker_id,
                commit_sha: None,
                pushed_ref: None,
                pr_url: None,
                status: "ok".to_string(),
                error: None,
            }),
            SwarmEvent::CommitCreated(CommitCreatedPayload {
                worker_id,
                sha: "sha".to_string(),
                branch: "swarm/x-abcd1234".to_string(),
                seq_from: 0,
                seq_to: 1,
            }),
            SwarmEvent::SessionWorkerAdded(SessionWorkerAddedPayload {
                session_id,
                worker_id,
            }),
            SwarmEvent::SessionWorkerRemoved(SessionWorkerRemovedPayload {
                session_id,
                worker_id,
            }),
            SwarmEvent::AgentSessionStarted(AgentSessionStartedPayload {
                worker_id,
                provider: ProviderId::ClaudeCode,
                session_key: "sess".to_string(),
                model: "m".to_string(),
                cwd: "/repo".to_string(),
                capabilities: Capabilities {
                    partial_deltas: true,
                    resume: true,
                    native_cost: true,
                    permission_modes: vec![],
                    cancel_granularity: CancelGranularity::KillOnly,
                    interrupt_midturn: false,
                    worktree_aware: true,
                    interactive_permissions: false,
                },
            }),
            SwarmEvent::AgentBlock(AgentBlockPayload {
                worker_id,
                turn_id: "t1".to_string(),
                block_index: 0,
                kind: "text".to_string(),
                content: serde_json::json!({}),
            }),
            SwarmEvent::AgentToolCall(AgentToolCallPayload {
                worker_id,
                turn_id: "t1".to_string(),
                tool_use_id: "tu1".to_string(),
                name: "run_command".to_string(),
                input: serde_json::json!({}),
            }),
            SwarmEvent::AgentToolResult(AgentToolResultPayload {
                worker_id,
                turn_id: "t1".to_string(),
                tool_use_id: "tu1".to_string(),
                is_error: false,
                content: serde_json::json!("ok"),
            }),
            SwarmEvent::AgentPermissionRequest(AgentPermissionRequestPayload {
                worker_id,
                turn_id: "t1".to_string(),
                request_id: "p1".to_string(),
                tool: "Bash".to_string(),
                input: serde_json::json!({}),
                suggested_decision: Some(PermissionDecision::Deny),
                denial_subclass: None,
                message: None,
            }),
            SwarmEvent::AgentTurnSettled(AgentTurnSettledPayload {
                worker_id,
                turn_id: "t1".to_string(),
                status: AgentTurnStatus::Ok,
                error: None,
                cost_usd: Some(0.01),
                usage: None,
                duration_ms: 10,
                num_turns: Some(1),
            }),
            SwarmEvent::AgentSessionExited(AgentSessionExitedPayload {
                worker_id,
                exit_code: Some(0),
                signal: None,
            }),
        ];
        for event in &durable {
            assert!(is_persistent(event), "{} must persist", event.type_tag());
        }
    }

    /// `agent_turn_delta` is ephemeral; its durable counterpart is
    /// `agent_block`.
    #[test]
    fn test_agent_turn_delta_is_ephemeral() {
        assert!(!is_persistent(&SwarmEvent::AgentTurnDelta(
            crate::events::AgentTurnDeltaPayload {
                worker_id: Uuid::nil(),
                turn_id: "t1".to_string(),
                block_index: 0,
                kind: "text".to_string(),
                text: "hi".to_string(),
            }
        )));
    }

    // ── Envelope shape ───────────────────────────────────────────────

    #[test]
    fn test_domain_event_envelope_shape() {
        let envelope = DomainEvent {
            seq: 7,
            ts: 123,
            origin_worker: None,
            cause_seq: None,
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
        // Unattributed provenance is absent from the wire, not `null`.
        assert!(json.get("originWorker").is_none());
        assert!(json.get("causeSeq").is_none());
    }

    /// A stamped envelope carries `originWorker`/`causeSeq` in camelCase.
    #[test]
    fn test_domain_event_envelope_shape_stamped() {
        let origin = Uuid::new_v4();
        let envelope = DomainEvent {
            seq: 9,
            ts: 456,
            origin_worker: Some(origin),
            cause_seq: Some(3),
            event: spawned(),
        };
        let json = serde_json::to_value(&envelope).unwrap();
        assert_eq!(json["originWorker"], origin.to_string());
        assert_eq!(json["causeSeq"], 3);
    }

    /// A replayed row serializes to the same JSON as the live envelope
    /// it records, stamped or not — the backfill path and the live path
    /// must be indistinguishable to a client.
    #[test]
    fn test_stored_event_json_matches_the_live_envelope() {
        for provenance in [
            Provenance::default(),
            Provenance {
                origin_worker: Some(Uuid::new_v4()),
                cause_seq: Some(3),
            },
        ] {
            let (tx, rx) = mpsc::channel();
            tx.send(WriterCmd::Record(WriterMsg {
                event: spawned(),
                provenance,
                ack: None,
            }))
            .unwrap();
            drop(tx);
            let mut live = Vec::new();
            let log = Writer::new(
                EventLog::open_in_memory().unwrap(),
                Arc::default(),
                |e: &DomainEvent| live.push(serde_json::to_value(e).unwrap()),
                idle_fanout(),
            )
            .unwrap()
            .run(&rx);

            let stored = log.events_since(0, 10).unwrap();
            assert_eq!(serde_json::to_value(&stored[0]).unwrap(), live[0]);
        }
    }

    // ── Writer loop ──────────────────────────────────────────────────

    #[test]
    fn test_writer_persists_with_monotonic_seq() {
        let (log, seen) = drive(
            EventLog::open_in_memory().unwrap(),
            vec![msg(spawned()), msg(output()), msg(spawned())],
        );
        assert_eq!(seqs(&seen), vec![1, 2, 3]);
        let stored = log.events_since(0, 100).unwrap();
        // worker_output consumed seq 2 but was not persisted.
        assert_eq!(stored.iter().map(|e| e.seq).collect::<Vec<_>>(), vec![1, 3]);
        assert_eq!(stored[0].event_type, "worker_spawned");
    }

    /// Seqs issued to ephemeral events after the last persisted row are
    /// never reissued after a crash: the writer resumes from `resume_seq()`,
    /// not `max_seq()`, so a client holding `lastSeq` = 5 drops no event.
    #[test]
    fn test_restart_after_a_crash_never_reissues_an_ephemeral_seq() {
        let mut writer = Writer::new(
            EventLog::open_in_memory().unwrap(),
            Arc::default(),
            |_: &DomainEvent| {},
            idle_fanout(),
        )
        .unwrap();
        writer.record(bare(spawned()));
        for _ in 0..4 {
            writer.record(bare(output()));
        }
        let issued = writer.seq;
        assert_eq!(issued, 5);
        // Crash: the writer stops without finalizing.
        let log = writer.log;
        assert_eq!(log.max_seq().unwrap(), 1, "the ephemeral tail left no rows");

        let (_, seen) = drive(log, vec![msg(spawned())]);
        assert!(
            seen[0].seq > issued,
            "resumed at {} but seq {issued} was already issued",
            seen[0].seq
        );
    }

    /// A clean stop records the exact head, so a clean restart continues
    /// at head + 1 with no gap.
    #[test]
    fn test_clean_restart_continues_without_a_gap() {
        let (log, seen) = drive(
            EventLog::open_in_memory().unwrap(),
            vec![msg(spawned()), msg(output()), msg(output())],
        );
        assert_eq!(seqs(&seen), vec![1, 2, 3]);
        let (_, seen) = drive(log, vec![msg(output())]);
        assert_eq!(seqs(&seen), vec![4]);
    }

    /// The writer stamps `provenance` onto the emitted envelope AND the
    /// persisted row.
    #[test]
    fn test_writer_stamps_provenance_onto_envelope_and_row() {
        let origin = Uuid::new_v4();
        let (log, seen) = drive(
            EventLog::open_in_memory().unwrap(),
            vec![WriterCmd::Record(WriterMsg {
                event: spawned(),
                provenance: Provenance {
                    origin_worker: Some(origin),
                    cause_seq: Some(5),
                },
                ack: None,
            })],
        );
        assert_eq!(seen[0].origin_worker, Some(origin));
        assert_eq!(seen[0].cause_seq, Some(5));

        let stored = log.events_since(0, 10).unwrap();
        assert_eq!(stored[0].origin_worker, Some(origin));
        assert_eq!(stored[0].cause_seq, Some(5));
    }

    /// A dropped `emit_awaiting_seq` receiver neither stalls nor skips
    /// anything in the writer loop.
    #[test]
    fn test_writer_loop_survives_dropped_ack_receiver() {
        let (ack_tx, ack_rx) = oneshot::channel::<u64>();
        drop(ack_rx);
        let (_, seen) = drive(
            EventLog::open_in_memory().unwrap(),
            vec![
                WriterCmd::Record(WriterMsg {
                    event: spawned(),
                    provenance: Provenance::default(),
                    ack: Some(ack_tx),
                }),
                msg(spawned()),
            ],
        );
        assert_eq!(seqs(&seen), vec![1, 2]);
    }

    type BoxedEmit = Box<dyn FnMut(&DomainEvent)>;

    /// A writer wired to record what reaches each delivery path.
    struct Probe {
        writer: Writer<BoxedEmit>,
        emitted: Arc<Mutex<Vec<DomainEvent>>>,
        fanout: broadcast::Receiver<Arc<DomainEvent>>,
        head: Arc<AtomicU64>,
    }

    fn probe() -> Probe {
        let emitted = Arc::new(Mutex::new(Vec::new()));
        let sink = Arc::clone(&emitted);
        let (tx, fanout) = broadcast::channel(64);
        let head = Arc::new(AtomicU64::new(0));
        let writer = Writer::new(
            EventLog::open_in_memory().unwrap(),
            Arc::clone(&head),
            Box::new(move |e: &DomainEvent| sink.lock().push(e.clone())) as BoxedEmit,
            Fanout::new(tx),
        )
        .unwrap();
        Probe {
            writer,
            emitted,
            fanout,
            head,
        }
    }

    fn acked(event: SwarmEvent) -> (WriterMsg, oneshot::Receiver<u64>) {
        let (tx, rx) = oneshot::channel();
        let msg = WriterMsg {
            event,
            provenance: Provenance::default(),
            ack: Some(tx),
        };
        (msg, rx)
    }

    /// A persist failure emits nothing on EITHER channel,
    /// leaves `head` where it was, and resolves the ack to `RecvError`;
    /// only one ephemeral `system_log` error takes the next seq.
    #[test]
    fn test_failed_persist_emits_nothing_and_holds_the_head() {
        let mut p = probe();
        p.writer.record(bare(spawned()));
        assert_eq!(p.head.load(Ordering::Acquire), 1);
        p.writer.log.break_table("events");

        let (msg, mut ack) = acked(spawned());
        p.writer.record(msg);

        // The failed seq (2) never reached the wire; the gap is explained
        // by one system_log at seq 3, which is what moved the head.
        let emitted = p.emitted.lock();
        assert_eq!(seqs(&emitted), vec![1, 3]);
        assert_matches!(emitted[1].event, SwarmEvent::SystemLog(ref l) if l.level == "error");
        assert_eq!(p.head.load(Ordering::Acquire), 3);
        drop(emitted);

        let mut delivered = Vec::new();
        while let Ok(e) = p.fanout.try_recv() {
            delivered.push(e.seq);
        }
        assert_eq!(delivered, vec![1, 3]);
        assert_matches!(ack.try_recv(), Err(oneshot::error::TryRecvError::Closed));
    }

    /// When even the explanatory `system_log` cannot take a seq, a
    /// failed persist leaves `head`, the wire and the fanout exactly as
    /// they were.
    #[test]
    fn test_failed_persist_alone_never_advances_the_head() {
        let mut p = probe();
        p.writer.record(bare(spawned()));
        p.writer.log.break_table("events");
        p.writer.log.break_table("meta");
        // Seq 2 is reserved but seq 3 (the system_log) is not.
        p.writer.reserved = 2;
        p.writer.record(bare(spawned()));

        assert_eq!(seqs(&p.emitted.lock()), vec![1]);
        assert_eq!(p.head.load(Ordering::Acquire), 1);
        assert_eq!(p.fanout.try_recv().unwrap().seq, 1);
        assert!(p.fanout.try_recv().is_err());
    }

    /// When the seq reservation fails the event is dropped
    /// whole (no seq above `reserved` is handed out), the counter rolls
    /// back, and the next event retries and succeeds once the log heals.
    #[test]
    fn test_failed_reservation_fails_closed_and_recovers() {
        let mut p = probe();
        p.writer.log.break_table("meta");
        let (msg, mut ack) = acked(spawned());
        p.writer.record(msg);
        p.writer.record(bare(output()));

        assert!(p.emitted.lock().is_empty());
        assert_eq!(p.head.load(Ordering::Acquire), 0);
        assert!(p.fanout.try_recv().is_err());
        assert_eq!(p.writer.seq, 0, "the counter rolls back");
        assert_matches!(ack.try_recv(), Err(oneshot::error::TryRecvError::Closed));

        // Heal the table and the very next event gets seq 1.
        p.writer.log.repair_table("meta");
        p.writer.record(bare(spawned()));
        assert_eq!(seqs(&p.emitted.lock()), vec![1]);
        assert!(p.writer.reserved >= 1);
    }

    // ── Live engine ──────────────────────────────────────────────────

    /// `emit_awaiting_seq` through a live engine resolves to the seq the
    /// event was actually given — the mechanism `agent_turn_started`
    /// relies on.
    #[tokio::test]
    async fn test_emit_awaiting_seq_resolves_to_the_assigned_seq() {
        let engine = OrchestrationEngine::start(EventLog::open_in_memory().unwrap(), None, |_| {});
        let sink = engine.sink();
        for expected in 1..=2 {
            let seq = sink
                .emit_awaiting_seq(spawned(), Provenance::default())
                .await
                .expect("a live engine resolves the ack");
            assert_eq!(seq, expected);
        }
        assert_eq!(engine.head_seq(), 2);
    }

    /// A subscriber never sees an event before the head covers it — the
    /// ordering that makes "subscribe, then read `head_seq`" gap-free.
    #[tokio::test]
    async fn test_head_seq_is_published_before_the_fanout_delivers() {
        let engine = OrchestrationEngine::start(EventLog::open_in_memory().unwrap(), None, |_| {});
        let mut rx = engine.subscribe();
        let sink = engine.sink();
        for _ in 0..200 {
            sink.emit(output());
        }
        for _ in 0..200 {
            let event = rx.recv().await.unwrap();
            assert!(engine.head_seq() >= event.seq);
        }
    }

    #[tokio::test]
    async fn test_flush_waits_for_every_queued_event() {
        let engine = OrchestrationEngine::start(EventLog::open_in_memory().unwrap(), None, |_| {});
        let sink = engine.sink();
        for _ in 0..50 {
            sink.emit(output());
        }
        assert_eq!(engine.flush().await.unwrap(), 50);
        assert_eq!(engine.head_seq(), 50);
    }

    /// A temp database file removed (with its WAL siblings) on drop.
    fn temp_db() -> (PathBuf, std::mem::DropGuard<PathBuf, impl FnOnce(PathBuf)>) {
        let path = std::env::temp_dir().join(format!("swarm-engine-test-{}.db", Uuid::new_v4()));
        let guard = std::mem::DropGuard::new(path.clone(), |path: PathBuf| {
            for suffix in ["-wal", "-shm"] {
                let mut sibling = path.clone().into_os_string();
                sibling.push(suffix);
                let _ = std::fs::remove_file(sibling);
            }
            let _ = std::fs::remove_file(&path);
        });
        (path, guard)
    }

    /// Shutdown drains everything queued before it
    /// (nothing lost on exit), later events are refused, and a restart
    /// on the same file continues exactly after the final head.
    #[tokio::test]
    async fn test_shutdown_drains_the_queue_and_a_restart_continues_after_it() {
        let (path, _cleanup) = temp_db();
        let engine = OrchestrationEngine::try_start(
            EventLog::open(&path).unwrap(),
            Some(path.clone()),
            |_| {},
        )
        .unwrap();
        let sink = engine.sink();
        for _ in 0..100 {
            sink.emit(spawned());
            sink.emit(output());
        }

        let head = tokio::task::spawn_blocking({
            let engine = engine.clone();
            move || engine.shutdown(Duration::from_secs(10))
        })
        .await
        .unwrap()
        .unwrap();
        assert_eq!(head, 200);
        assert_eq!(engine.head_seq(), 200);

        let reader = EventLog::open_readonly(&path).unwrap();
        assert_eq!(reader.events_since(0, 1000).unwrap().len(), 100);

        // After shutdown: new events are dropped, acks and flushes fail,
        // and a second shutdown is a no-op.
        assert!(
            sink.emit_awaiting_seq(spawned(), Provenance::default())
                .await
                .is_err()
        );
        assert_matches!(engine.flush().await, Err(AppError::EventLog(_)));
        assert_eq!(engine.shutdown(Duration::from_secs(1)).unwrap(), 200);
        assert_eq!(reader.max_seq().unwrap(), 199);

        let restarted = OrchestrationEngine::try_start(
            EventLog::open(&path).unwrap(),
            Some(path.clone()),
            |_| {},
        )
        .unwrap();
        assert_eq!(restarted.head_seq(), 200);
        let seq = restarted
            .sink()
            .emit_awaiting_seq(output(), Provenance::default())
            .await
            .unwrap();
        assert_eq!(seq, 201);
    }

    /// A log whose resume seq cannot be read fails the start instead of
    /// silently restarting seqs at 1.
    #[test]
    fn test_try_start_propagates_an_unreadable_resume_seq() {
        let (path, _cleanup) = temp_db();
        // A v1-shaped file (no `meta` table), opened without migrating.
        let conn = rusqlite::Connection::open(&path).unwrap();
        conn.execute_batch(
            "CREATE TABLE events (seq INTEGER PRIMARY KEY, ts INTEGER NOT NULL, \
             type TEXT NOT NULL, payload TEXT NOT NULL, origin_worker TEXT, \
             cause_seq INTEGER) STRICT;
             PRAGMA user_version = 1;",
        )
        .unwrap();
        drop(conn);

        let result =
            OrchestrationEngine::try_start(EventLog::open_readonly(&path).unwrap(), None, |_| {});
        // `.err()`: the engine handle is not `Debug`.
        assert_matches!(result.err(), Some(AppError::EventLog(_)));
    }
}
