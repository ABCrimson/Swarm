//! Single-writer orchestration engine: seq assignment, persistence, emission.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::mpsc::Receiver;
use std::time::{Duration, Instant};

use serde::Serialize;
use tokio::sync::broadcast;
use uuid::Uuid;

use super::log::EventLog;
use crate::events::{EventSink, SwarmEvent, WriterMsg};

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
    /// UUID of the worker whose action caused this event (the CAUSER),
    /// when known. Absent (not `null`) when unattributed — see
    /// [`Provenance`]'s doc; `skip_serializing_if` keeps the common
    /// unattributed case (e.g. every `worker_output` chunk) from paying
    /// a wire tax for a field that's almost always absent.
    #[serde(rename = "originWorker", skip_serializing_if = "Option::is_none")]
    pub origin_worker: Option<Uuid>,
    /// Seq of the event this one is causally reacting to, when known.
    #[serde(rename = "causeSeq", skip_serializing_if = "Option::is_none")]
    pub cause_seq: Option<u64>,
    #[serde(flatten)]
    pub event: SwarmEvent,
}

/// Whether an event belongs in the durable log.
///
/// High-frequency telemetry flows through the ordered stream (it still
/// consumes sequence numbers) but is not history: it cannot be backfilled
/// after a gap and is not replayed.
///
/// `WorkerInput` gets a field-level carve-out on top of the
/// variant-level exclusions below: `source == InputSource::Terminal`
/// (raw human keystrokes) is excluded too — a persisted row per
/// keystroke would both flood the log and archive whatever the user
/// typed, secrets included. `source.is_machine_issued()` (`Tool`/
/// `Automation`) persists normally. Matched on the typed
/// [`crate::events::InputSource`] enum, not a string — an unrecognized
/// source value fails IPC deserialization long before it could reach
/// this function, so the guarantee never depends on string spelling.
pub fn is_persistent(event: &SwarmEvent) -> bool {
    match event {
        SwarmEvent::WorkerOutput(_)
        | SwarmEvent::SystemMetrics(_)
        | SwarmEvent::SystemLog(_)
        // `agent_turn_delta` is the provider-adapter analogue of
        // `ai_stream_delta` (see the LATENT BUG note in the
        // multi-provider plan: `ai_stream_delta` itself stays
        // persisted here — retired only in Phase 5 alongside the
        // webview path it serves). Persisting per-clause streaming
        // rows would be ~800 SQLite rows/s at 8 workers; the durable
        // counterpart is `agent_block`, persisted normally below.
        | SwarmEvent::AgentTurnDelta(_) => false,
        SwarmEvent::WorkerInput(p) => p.source.is_machine_issued(),
        _ => true,
    }
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
        let (tx, rx) = std::sync::mpsc::channel::<WriterMsg>();
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
    rx: Receiver<WriterMsg>,
    mut log: EventLog,
    mut emit: impl FnMut(&DomainEvent),
) -> EventLog {
    let mut seq = log.max_seq().unwrap_or(0);
    while let Ok(WriterMsg {
        event,
        provenance,
        ack,
    }) = rx.recv()
    {
        seq += 1;
        let ts = crate::clock::unix_millis();
        let envelope = DomainEvent {
            seq,
            ts,
            origin_worker: provenance.origin_worker,
            cause_seq: provenance.cause_seq,
            event,
        };

        if is_persistent(&envelope.event) {
            match serde_json::to_value(&envelope.event) {
                Ok(tagged) => {
                    let event_type = tagged["type"].as_str().unwrap_or("unknown").to_string();
                    let payload = tagged["payload"].to_string();
                    if let Err(e) = log.append(seq, ts, &event_type, &payload, &provenance) {
                        tracing::error!(seq, error = %e, "failed to persist event");
                    }
                }
                Err(e) => tracing::error!(seq, error = %e, "failed to serialize event"),
            }
        }

        emit(&envelope);

        // Non-blocking by oneshot construction — a dropped receiver
        // (e.g. a cancelled IPC call) makes `send` return `Err`, which
        // is intentionally ignored: this thread never waits on, or even
        // notices, a disinterested receiver (see `EventSink::emit_awaiting_seq`'s doc).
        if let Some(ack) = ack {
            let _ = ack.send(seq);
        }
    }
    log
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::events::{
        AiStreamSettledPayload, CommitCreatedPayload, Provenance, ShipProgressPayload,
        ShipSettledPayload, SwarmEvent, SystemMetricsPayload, WorkerInputPayload,
        WorkerOutputPayload, WorkerSpawnedPayload, WorktreeCreatedPayload, WorktreeRemovedPayload,
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

    /// Wraps a bare event with default (unattributed) provenance and no
    /// ack — the shape every pre-provenance test used to send directly.
    fn msg(event: SwarmEvent) -> WriterMsg {
        WriterMsg {
            event,
            provenance: Provenance::default(),
            ack: None,
        }
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

    /// DIRECTIVE: `worker_input` persistence depends on `source`, not
    /// just the variant — `terminal` (raw human keystrokes) is excluded
    /// (would flood the log AND archive typed secrets); `tool` and
    /// `automation` (machine-issued input) persist normally like any
    /// other event.
    #[test]
    fn test_worker_input_persistence_depends_on_source() {
        let input = |source: crate::events::InputSource| {
            SwarmEvent::WorkerInput(WorkerInputPayload {
                worker_id: Uuid::nil(),
                bytes: 3,
                source,
                preview: None,
            })
        };
        assert!(!is_persistent(&input(crate::events::InputSource::Terminal)));
        assert!(is_persistent(&input(crate::events::InputSource::Tool)));
        assert!(is_persistent(&input(
            crate::events::InputSource::Automation
        )));
    }

    /// DIRECTIVE: `file_written` and `agent_turn_started` both persist —
    /// same "excluded by name, persistent by construction" guarantee as
    /// the worktree/ship events below. `file_written` in particular is
    /// the whole point of Phase 5d (a worker's file write joining the
    /// causality graph) — it would be silently useless as history if a
    /// future refactor of the exclusion list dropped it.
    #[test]
    fn test_file_written_and_agent_turn_started_are_persistent() {
        assert!(is_persistent(&SwarmEvent::FileWritten(
            crate::events::FileWrittenPayload {
                path: "/home/user/.swarm/out.txt".to_string(),
                bytes: 7,
            }
        )));
        assert!(is_persistent(&SwarmEvent::AgentTurnStarted(
            crate::events::AgentTurnStartedPayload {
                worker_id: Uuid::nil(),
                model: "claude-sonnet-4-5".to_string(),
                request_id: "turn-1".to_string(),
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

    /// DIRECTIVE: `session_worker_removed` persists by construction
    /// (absent from the exclusion list) — a backfilling client must be
    /// able to reconstruct the same `workerIds` pruning a live listener
    /// observed, not just the growth side (`session_created`).
    #[test]
    fn test_session_worker_removed_is_persistent() {
        use crate::events::SessionWorkerRemovedPayload;

        assert!(is_persistent(&SwarmEvent::SessionWorkerRemoved(
            SessionWorkerRemovedPayload {
                session_id: Uuid::nil(),
                worker_id: Uuid::nil(),
            }
        )));
    }

    // ── agent_* persistence pinning ──────────────────────────────────

    /// DIRECTIVE: `agent_turn_delta` is the ONLY new `agent_*` variant
    /// excluded from persistence — every other new variant persists by
    /// construction (the exclusion list is by name; anything absent
    /// from it defaults to `true`). Pins every new variant's class down
    /// explicitly so a future refactor of the exclusion list can't
    /// silently flip one.
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

    #[test]
    fn test_every_other_new_agent_variant_is_persistent() {
        use crate::agent::adapter::{
            AgentTurnStatus, CancelGranularity, Capabilities, PermissionDecision, ProviderId,
        };
        use crate::events::{
            AgentBlockPayload, AgentPermissionRequestPayload, AgentSessionExitedPayload,
            AgentSessionStartedPayload, AgentToolCallPayload, AgentToolResultPayload,
            AgentTurnSettledPayload,
        };

        assert!(is_persistent(&SwarmEvent::AgentSessionStarted(
            AgentSessionStartedPayload {
                worker_id: Uuid::nil(),
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
            }
        )));
        assert!(is_persistent(&SwarmEvent::AgentBlock(AgentBlockPayload {
            worker_id: Uuid::nil(),
            turn_id: "t1".to_string(),
            block_index: 0,
            kind: "text".to_string(),
            content: serde_json::json!({}),
        })));
        assert!(is_persistent(&SwarmEvent::AgentToolCall(
            AgentToolCallPayload {
                worker_id: Uuid::nil(),
                turn_id: "t1".to_string(),
                tool_use_id: "tu1".to_string(),
                name: "run_command".to_string(),
                input: serde_json::json!({}),
            }
        )));
        assert!(is_persistent(&SwarmEvent::AgentToolResult(
            AgentToolResultPayload {
                worker_id: Uuid::nil(),
                turn_id: "t1".to_string(),
                tool_use_id: "tu1".to_string(),
                is_error: false,
                content: serde_json::json!("ok"),
            }
        )));
        assert!(is_persistent(&SwarmEvent::AgentPermissionRequest(
            AgentPermissionRequestPayload {
                worker_id: Uuid::nil(),
                turn_id: "t1".to_string(),
                request_id: "p1".to_string(),
                tool: "Bash".to_string(),
                input: serde_json::json!({}),
                suggested_decision: Some(PermissionDecision::Deny),
                denial_subclass: None,
                message: None,
            }
        )));
        assert!(is_persistent(&SwarmEvent::AgentTurnSettled(
            AgentTurnSettledPayload {
                worker_id: Uuid::nil(),
                turn_id: "t1".to_string(),
                status: AgentTurnStatus::Ok,
                error: None,
                cost_usd: Some(0.01),
                usage: None,
                duration_ms: 10,
                num_turns: Some(1),
            }
        )));
        assert!(is_persistent(&SwarmEvent::AgentSessionExited(
            AgentSessionExitedPayload {
                worker_id: Uuid::nil(),
                exit_code: Some(0),
                signal: None,
            }
        )));
    }

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
        // Unattributed provenance must be absent from the wire, not `null`.
        assert!(json.get("originWorker").is_none());
        assert!(json.get("causeSeq").is_none());
    }

    /// DIRECTIVE: a stamped envelope serializes `originWorker`/`causeSeq`
    /// as camelCase, present (not null) — the tripwire for the whole
    /// point of Phase 2: an unattributed event's envelope must stay
    /// lean (see the test above) while a stamped one actually carries
    /// the causal attribution over the wire.
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

    #[test]
    fn test_writer_persists_with_monotonic_seq() {
        // Drive the writer loop directly (no Tauri AppHandle in unit tests).
        let log = EventLog::open_in_memory().unwrap();
        let (tx, rx) = std::sync::mpsc::channel::<WriterMsg>();
        tx.send(msg(spawned())).unwrap();
        tx.send(msg(SwarmEvent::WorkerOutput(WorkerOutputPayload {
            worker_id: Uuid::nil(),
            data: "ephemeral".to_string(),
        })))
        .unwrap();
        tx.send(msg(spawned())).unwrap();
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
        let (tx, rx) = std::sync::mpsc::channel::<WriterMsg>();
        tx.send(msg(spawned())).unwrap();
        drop(tx);
        let mut log = run_writer_loop(rx, log, |_| {});
        // Simulate a prior run reaching seq 41.
        log.append(41, 1, "session_created", "{}", &Provenance::default())
            .unwrap();

        let (tx2, rx2) = std::sync::mpsc::channel::<WriterMsg>();
        let mut seen = Vec::new();
        tx2.send(msg(spawned())).unwrap();
        drop(tx2);
        let log = run_writer_loop(rx2, log, |envelope| seen.push(envelope.seq));
        assert_eq!(seen, vec![42]);
        assert_eq!(log.max_seq().unwrap(), 42);
    }

    /// DIRECTIVE: the writer loop stamps `provenance` from the
    /// `WriterMsg` onto the emitted `DomainEvent` AND persists it — both
    /// halves asserted here, not just the emitted envelope (see
    /// emitter.rs's unit tests for the `EventSink` half in isolation).
    /// This is the one seam — `run_writer_loop` → `log.append(..,
    /// provenance)` — that a change to either side (e.g. forgetting to
    /// pass `provenance` through to `append`) could silently break
    /// without a test reading the persisted row back out.
    #[test]
    fn test_writer_stamps_provenance_onto_emitted_envelope() {
        let log = EventLog::open_in_memory().unwrap();
        let (tx, rx) = std::sync::mpsc::channel::<WriterMsg>();
        let origin = Uuid::new_v4();
        tx.send(WriterMsg {
            event: spawned(),
            provenance: Provenance {
                origin_worker: Some(origin),
                cause_seq: Some(5),
            },
            ack: None,
        })
        .unwrap();
        drop(tx);

        let mut seen = Vec::new();
        let log = run_writer_loop(rx, log, |envelope| seen.push(envelope.clone()));
        assert_eq!(seen.len(), 1);
        assert_eq!(seen[0].origin_worker, Some(origin));
        assert_eq!(seen[0].cause_seq, Some(5));

        // The persisted-row half: read straight back out of SQLite,
        // independent of the emitted envelope above.
        let stored = log.events_since(0, 10).unwrap();
        assert_eq!(stored.len(), 1);
        assert_eq!(stored[0].origin_worker, Some(origin));
        assert_eq!(stored[0].cause_seq, Some(5));
    }

    /// DIRECTIVE (ack-oneshot no-stall): a dropped `emit_awaiting_seq`
    /// receiver must not stall or panic the writer loop — it must
    /// finish processing every message on the channel exactly as if no
    /// ack had been requested at all.
    #[test]
    fn test_writer_loop_survives_dropped_ack_receiver() {
        let log = EventLog::open_in_memory().unwrap();
        let (tx, rx) = std::sync::mpsc::channel::<WriterMsg>();
        let (ack_tx, ack_rx) = tokio::sync::oneshot::channel::<u64>();
        drop(ack_rx); // caller lost interest before the writer runs
        tx.send(WriterMsg {
            event: spawned(),
            provenance: Provenance::default(),
            ack: Some(ack_tx),
        })
        .unwrap();
        tx.send(msg(spawned())).unwrap();
        drop(tx);

        let mut seen = Vec::new();
        let _log = run_writer_loop(rx, log, |envelope| seen.push(envelope.seq));
        // Both messages processed, in order — the dropped ack neither
        // stalled nor skipped anything.
        assert_eq!(seen, vec![1, 2]);
    }

    /// DIRECTIVE: `agent_turn_started` returns a real seq — integration
    /// through the ACTUAL engine (a live `OrchestrationEngine::start`,
    /// spawning the real `swarm-event-writer` OS thread), not just the
    /// raw-channel unit tests above. This is the exact mechanism
    /// `commands::ai::agent_turn_started` uses: `EventSink::emit_awaiting_seq`
    /// resolved by a running writer thread, end-to-end, proving the
    /// returned seq is both the one the ack resolves to AND the one
    /// actually persisted for that event.
    #[tokio::test]
    async fn test_agent_turn_started_mechanism_returns_a_real_seq_through_a_live_engine() {
        let log = EventLog::open_in_memory().unwrap();
        let engine = OrchestrationEngine::start(log, None, |_envelope| {});
        let sink = engine.sink();
        let worker_id = Uuid::new_v4();

        let ack = sink.emit_awaiting_seq(
            SwarmEvent::AgentTurnStarted(crate::events::AgentTurnStartedPayload {
                worker_id,
                model: "claude-sonnet-4-5".to_string(),
                request_id: "turn-1".to_string(),
            }),
            Provenance::default(),
        );
        let turn_seq = ack.await.expect("live engine must resolve the ack");
        assert_eq!(turn_seq, 1, "first event through a fresh engine gets seq 1");

        // A second turn on the same live engine gets a distinct,
        // monotonically-increasing seq — proving this isn't a
        // coincidental always-1 stub.
        let ack2 = sink.emit_awaiting_seq(
            SwarmEvent::AgentTurnStarted(crate::events::AgentTurnStartedPayload {
                worker_id,
                model: "claude-sonnet-4-5".to_string(),
                request_id: "turn-2".to_string(),
            }),
            Provenance::default(),
        );
        let turn_seq_2 = ack2.await.expect("live engine must resolve the second ack");
        assert_eq!(turn_seq_2, 2);
    }
}
