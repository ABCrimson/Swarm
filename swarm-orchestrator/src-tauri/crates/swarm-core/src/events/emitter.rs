//! Domain event types and the [`EventSink`] emission seam.
//!
//! Provides a typed event system for broadcasting worker state
//! changes, session events, AI stream deltas, and system metrics
//! to any shell embedding `swarm-core`. Every event is routed through
//! an [`EventSink`] into the [`crate::orchestration::OrchestrationEngine`],
//! which assigns a monotonic sequence number and broadcasts an ordered
//! envelope for shells to forward onward (e.g. the Tauri desktop shell
//! emits it on the `swarm://events` webview channel).
//!
//! ## Serialization Convention
//!
//! - Event type tags use `snake_case` (e.g., `"worker_spawned"`)
//! - Payload fields use `camelCase` (e.g., `"workerId"`)
//! - This matches the frontend's expected JSON format

use serde::{Deserialize, Serialize};
use std::sync::mpsc::Sender;
use uuid::Uuid;

use crate::git::ShipError;
use crate::worker::handle::WorkerState;

/// All typed events emitted by the SWARM backend.
///
/// This enum is the single source of truth for the backend-to-frontend
/// event contract. Each variant maps to a `snake_case` type tag inside
/// the ordered envelope emitted on the single `swarm://events` channel.
///
/// # Serialization
///
/// Uses adjacently tagged serialization with `"type"` and `"payload"` fields:
///
/// ```json
/// {
///   "type": "worker_spawned",
///   "payload": { "workerId": "...", "name": "...", "pid": 1234 }
/// }
/// ```
///
/// # Examples
///
/// ```
/// use swarm_core::events::{SwarmEvent, WorkerSpawnedPayload};
/// use uuid::Uuid;
///
/// let event = SwarmEvent::WorkerSpawned(WorkerSpawnedPayload {
///     worker_id: Uuid::nil(),
///     name: "agent-1".to_string(),
///     pid: Some(42),
///     isolation: None,
/// });
/// let json = serde_json::to_string(&event).unwrap();
/// assert!(json.contains("\"type\":\"worker_spawned\""));
/// ```
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", content = "payload", rename_all = "snake_case")]
pub enum SwarmEvent {
    /// A new worker has been spawned and registered.
    WorkerSpawned(WorkerSpawnedPayload),
    /// A worker has been killed and removed from the registry.
    WorkerKilled(WorkerKilledPayload),
    /// Raw output data from a worker's PTY.
    WorkerOutput(WorkerOutputPayload),
    /// A worker's lifecycle state has changed.
    WorkerState(WorkerStatePayload),
    /// A new session has been created.
    SessionCreated(SessionCreatedPayload),
    /// A session has been deleted.
    SessionDeleted(SessionDeletedPayload),
    /// Periodic system metrics snapshot.
    SystemMetrics(SystemMetricsPayload),
    /// A delta chunk from an AI streaming response.
    AiStreamDelta(AiStreamDeltaPayload),
    /// Terminal receipt for an AI stream: exactly one per request.
    AiStreamSettled(AiStreamSettledPayload),
    /// A backend log message for the frontend console.
    SystemLog(SystemLogPayload),
    /// A message was sent through the inter-agent bus.
    BusMessage(BusMessagePayload),
    /// A git worktree was created for a worker's isolation.
    WorktreeCreated(WorktreeCreatedPayload),
    /// A git worktree was removed (or preserved, if dirty) at kill time.
    WorktreeRemoved(WorktreeRemovedPayload),
    /// One step of an in-flight ship operation (preflight/staging/commit/push).
    ShipProgress(ShipProgressPayload),
    /// Terminal receipt for a ship operation: exactly one per `shipId`.
    ShipSettled(ShipSettledPayload),
    /// A commit was created by the ship chain.
    CommitCreated(CommitCreatedPayload),
}

/// Payload for the `worker_spawned` event.
///
/// Emitted when a new worker PTY process is successfully created
/// and registered in the worker registry.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkerSpawnedPayload {
    /// UUID of the newly spawned worker.
    pub worker_id: Uuid,
    /// Human-readable name of the worker.
    pub name: String,
    /// OS process ID of the PTY child, if available.
    pub pid: Option<u32>,
    /// Isolation outcome for this worker: `"worktree"` when a git
    /// worktree was created, `"none"` when it was not (no `repoRoot`
    /// given, or `isolation: "none"` was explicitly requested). The
    /// log tells you a worker ran unisolated without needing a
    /// separate event type. Additive field — `#[serde(default)]` so
    /// older persisted rows without it still deserialize.
    #[serde(default)]
    pub isolation: Option<String>,
}

/// Payload for the `worker_killed` event.
///
/// Emitted when a worker process is terminated and removed
/// from the registry.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkerKilledPayload {
    /// UUID of the killed worker.
    pub worker_id: Uuid,
}

/// Payload for the `worker_output` event.
///
/// Emitted when raw bytes are read from a worker's PTY master fd.
/// The frontend (xterm.js) writes these bytes directly to the
/// terminal emulator.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkerOutputPayload {
    /// UUID of the worker producing output.
    pub worker_id: Uuid,
    /// Output text from the PTY.
    pub data: String,
}

/// Payload for the `worker_state` event.
///
/// Emitted when a worker transitions between lifecycle states
/// (e.g., `"running"` to `"paused"`).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkerStatePayload {
    /// UUID of the worker whose state changed.
    pub worker_id: Uuid,
    /// New lifecycle state of the worker.
    pub state: WorkerState,
}

/// Payload for the `session_created` event.
///
/// Emitted when a new user session is created.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionCreatedPayload {
    /// UUID of the newly created session.
    pub session_id: Uuid,
    /// Human-readable session name.
    pub name: String,
}

/// Payload for the `session_deleted` event.
///
/// Emitted when a session is removed from the manager.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionDeletedPayload {
    /// UUID of the deleted session.
    pub session_id: Uuid,
}

/// Payload for the `system_metrics` event.
///
/// Emitted every 500ms by the background metrics collection loop.
/// Contains both system-level metrics and worker aggregate counts.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemMetricsPayload {
    /// CPU utilization percentage (0.0 - 100.0), sourced from `sysinfo`.
    pub cpu_percent: f64,
    /// Memory usage in megabytes, sourced from `sysinfo`.
    pub memory_mb: f64,
    /// Total physical memory in megabytes, sourced from `sysinfo`'s
    /// `System::total_memory()`. Real hardware capacity — the frontend
    /// must derive memory percentages from this value rather than
    /// assuming a fixed total.
    pub memory_total_mb: f64,
    /// Total number of registered workers.
    pub worker_count: usize,
    /// AI API requests per second. Currently a placeholder.
    pub ai_req_per_sec: f64,
    /// Unix timestamp in milliseconds when this snapshot was taken.
    pub timestamp: i64,
}

/// Payload for the `ai_stream_delta` event.
///
/// Emitted for each text delta chunk received from the AI
/// streaming API. The frontend accumulates these deltas to
/// build the complete response.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiStreamDeltaPayload {
    /// Correlation ID matching the original AI request.
    pub request_id: String,
    /// Text delta chunk from the AI response. Empty string on final event.
    pub delta: String,
    /// `true` when this is the final delta (message complete).
    pub done: bool,
}

/// Payload for the `ai_stream_settled` receipt.
///
/// Emitted exactly once per AI request, after the final delta, on both
/// success and failure paths. Frontends and tests await this receipt
/// instead of polling stream state.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiStreamSettledPayload {
    /// Correlation ID matching the original AI request.
    pub request_id: String,
    /// `"ok"` or `"error"`.
    pub status: String,
    /// Error description when `status == "error"`.
    pub error: Option<String>,
}

/// Payload for the `bus_message` event.
///
/// Emitted when a message is sent through the inter-agent bus.
/// Contains the full message details for frontend routing.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BusMessagePayload {
    /// UUID of the message.
    pub message_id: Uuid,
    /// UUID of the sending worker.
    pub from_worker: Uuid,
    /// UUID of the target worker, or `None` for broadcast.
    pub to_worker: Option<Uuid>,
    /// Topic the message was sent on.
    pub topic: String,
    /// JSON payload of the message.
    pub payload: serde_json::Value,
}

/// Payload for the `worktree_created` event.
///
/// Emitted once, immediately after `git worktree add` + `git worktree
/// lock` succeed for a worker's isolation. Its own `seq` (assigned by
/// the [`crate::orchestration::OrchestrationEngine`] writer thread) is
/// the range start for "what did this worker change" queries — no
/// separate `baseSeq` field is needed.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeCreatedPayload {
    /// UUID of the worker this worktree isolates.
    pub worker_id: Uuid,
    /// UUID of the session this worker belongs to, if any.
    pub session_id: Option<Uuid>,
    /// Absolute path to the repository root the worktree was created from.
    pub repo_root: String,
    /// Absolute path to the new worktree directory
    /// (`~/.swarm/worktrees/<repo>-<hash8>/w-<id8>`).
    pub worktree_path: String,
    /// Branch checked out in the worktree (`swarm/<slug>-<id8>`).
    pub branch: String,
    /// Commit sha the worktree was created from (`HEAD` of `repo_root`
    /// at spawn time).
    pub base_commit: String,
}

/// Payload for the `worktree_removed` event.
///
/// Emitted at kill time after `git worktree unlock` + `git worktree
/// remove` (never `--force`) run against an isolated worker's
/// worktree. `disposition` records the outcome — `"removed"` on
/// success, `"preserved_dirty"` when git refused because the worktree
/// had uncommitted/untracked changes (the safety guarantee: SWARM
/// never deletes work), or `"failed"` for a genuine error (e.g. the
/// worktree path was already gone out-of-band).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeRemovedPayload {
    /// UUID of the worker whose worktree this was.
    pub worker_id: Uuid,
    /// Absolute path to the worktree directory.
    pub worktree_path: String,
    /// Branch that was checked out in the worktree.
    pub branch: String,
    /// `"removed"`, `"preserved_dirty"`, or `"failed"`.
    pub disposition: String,
    /// `HEAD` commit sha of the worktree at removal time, when known.
    pub head_commit: Option<String>,
    /// Human-readable reason, populated for `"preserved_dirty"` (git's
    /// own refusal message) and `"failed"` (the error).
    pub reason: Option<String>,
}

/// Payload for the `ship_progress` event.
///
/// Emitted for each step of a ship operation (`preflight`, `staging`,
/// `commit`, `push` — `step` is a free-form string, not a closed enum,
/// so a future step can be added without a wire-format change).
/// `shipId` correlates every progress row and the terminal
/// [`ShipSettledPayload`] for one ship attempt; `waitFor` on the
/// frontend keys off it rather than a timer.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShipProgressPayload {
    /// Correlation ID for one ship attempt (client-generated).
    pub ship_id: Uuid,
    /// UUID of the worker being shipped.
    pub worker_id: Uuid,
    /// Free-form step name: `"preflight"`, `"staging"`, `"commit"`, `"push"`.
    pub step: String,
    /// `"running"`, `"ok"`, or `"error"`.
    pub status: String,
    /// Human-readable detail (e.g. a file count, a Title Case message).
    pub detail: Option<String>,
}

/// Payload for the `ship_settled` receipt.
///
/// Emitted exactly once per `shipId`, after the last [`ShipProgressPayload`],
/// on both success and failure. Frontends `waitFor` this receipt
/// instead of polling progress state — the same pattern as
/// `ai_stream_settled`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShipSettledPayload {
    /// Correlation ID matching the triggering [`ShipProgressPayload`]s.
    pub ship_id: Uuid,
    /// UUID of the worker that was shipped.
    pub worker_id: Uuid,
    /// Sha of the commit created, if the commit step completed.
    pub commit_sha: Option<String>,
    /// `"origin/<branch>"`, if the push step completed.
    pub pushed_ref: Option<String>,
    /// PR/compare-page URL, if one was opened (Phase 1: only ever the
    /// compare-URL fallback — real `gh pr create` is Phase 3).
    pub pr_url: Option<String>,
    /// `"ok"` or `"error"`.
    pub status: String,
    /// The typed failure, when `status == "error"`.
    pub error: Option<ShipError>,
}

/// Payload for the `commit_created` event.
///
/// Emitted immediately after a successful ship-chain commit (before
/// any push attempt) — `seqFrom`/`seqTo` mirror the
/// `Swarm-Seq-Range:` trailer written into the commit message itself,
/// so the binding between "this commit" and "this seq range" survives
/// outside the app (e.g. in `git log`) even if the event log is lost.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitCreatedPayload {
    /// UUID of the worker this commit was made in.
    pub worker_id: Uuid,
    /// Sha of the new commit.
    pub sha: String,
    /// Branch the commit was made on.
    pub branch: String,
    /// Start of the seq range cited in the commit's `Swarm-Seq-Range` trailer.
    pub seq_from: u64,
    /// End of the seq range cited in the commit's `Swarm-Seq-Range` trailer.
    pub seq_to: u64,
}

/// Payload for the `system_log` event.
///
/// Bridges backend log messages to the frontend console
/// for debugging and monitoring.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemLogPayload {
    /// Log level (e.g., `"info"`, `"warn"`, `"error"`).
    pub level: String,
    /// Human-readable log message.
    pub message: String,
    /// Module target that produced the log (e.g., `"swarm_core::worker"`).
    pub target: String,
    /// Unix timestamp in milliseconds when the log was produced.
    pub timestamp: i64,
}

/// A cloneable handle for recording [`SwarmEvent`]s into the
/// [`crate::orchestration::OrchestrationEngine`]'s ordered pipeline.
///
/// Obtained via [`crate::orchestration::OrchestrationEngine::sink`] —
/// there is no way to construct an `EventSink` before the engine exists,
/// which structurally removes the "engine not managed yet, event
/// dropped" hazard that a lookup-based dispatcher (e.g. one keyed off
/// Tauri's `try_state`) would otherwise need to guard against at every
/// call site.
#[derive(Clone)]
pub struct EventSink(Sender<SwarmEvent>);

impl EventSink {
    /// Wraps a raw channel sender. Called only by
    /// [`crate::orchestration::OrchestrationEngine::start`].
    pub(crate) fn new(tx: Sender<SwarmEvent>) -> Self {
        Self(tx)
    }

    /// Records an event for ordering, persistence, and emission.
    ///
    /// Fire-and-forget: the dedicated writer thread assigns a sequence
    /// number, persists (per policy), and broadcasts the ordered
    /// envelope. If the writer thread is gone, the event is dropped
    /// with an error log rather than panicking.
    pub fn emit(&self, event: SwarmEvent) {
        if self.0.send(event).is_err() {
            tracing::error!("event writer thread is gone; event dropped");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_worker_spawned_roundtrip() {
        let event = SwarmEvent::WorkerSpawned(WorkerSpawnedPayload {
            worker_id: Uuid::new_v4(),
            name: "test-worker".to_string(),
            pid: Some(42),
            isolation: Some("worktree".to_string()),
        });
        let json = serde_json::to_string(&event).expect("serialize");
        let deserialized: SwarmEvent = serde_json::from_str(&json).expect("deserialize");
        if let SwarmEvent::WorkerSpawned(p) = deserialized {
            assert_eq!(p.name, "test-worker");
            assert_eq!(p.pid, Some(42));
            assert_eq!(p.isolation.as_deref(), Some("worktree"));
        } else {
            panic!("expected WorkerSpawned variant");
        }
    }

    #[test]
    fn test_worker_killed_roundtrip() {
        let id = Uuid::new_v4();
        let event = SwarmEvent::WorkerKilled(WorkerKilledPayload { worker_id: id });
        let json = serde_json::to_string(&event).expect("serialize");
        let deserialized: SwarmEvent = serde_json::from_str(&json).expect("deserialize");
        if let SwarmEvent::WorkerKilled(p) = deserialized {
            assert_eq!(p.worker_id, id);
        } else {
            panic!("expected WorkerKilled variant");
        }
    }

    #[test]
    fn test_system_metrics_roundtrip() {
        let event = SwarmEvent::SystemMetrics(SystemMetricsPayload {
            cpu_percent: 45.2,
            memory_mb: 1024.5,
            memory_total_mb: 262_144.0,
            worker_count: 3,
            ai_req_per_sec: 1.5,
            timestamp: 1700000000,
        });
        let json = serde_json::to_string(&event).expect("serialize");
        let deserialized: SwarmEvent = serde_json::from_str(&json).expect("deserialize");
        if let SwarmEvent::SystemMetrics(p) = deserialized {
            assert!((p.cpu_percent - 45.2).abs() < f64::EPSILON);
            assert_eq!(p.worker_count, 3);
        } else {
            panic!("expected SystemMetrics variant");
        }
    }

    /// Regression test for the "Memory usage: critically high: 216%" bug:
    /// the frontend never learned the machine's real RAM total and fell
    /// back to a hardcoded 16GB assumption. `memory_total_mb` closes that
    /// gap — this test locks in its wire name (`memoryTotalMb`) and that
    /// it survives a serialize/deserialize roundtrip untouched.
    #[test]
    fn test_system_metrics_memory_total_mb_roundtrip() {
        let event = SwarmEvent::SystemMetrics(SystemMetricsPayload {
            cpu_percent: 12.0,
            memory_mb: 35_389.0,
            memory_total_mb: 262_144.0, // 256GB machine from the bug report
            worker_count: 1,
            ai_req_per_sec: 0.0,
            timestamp: 1700000000,
        });

        let json = serde_json::to_string(&event).expect("serialize");
        assert!(
            json.contains("\"memoryTotalMb\":262144"),
            "expected camelCase memoryTotalMb field in JSON, got: {json}"
        );

        let deserialized: SwarmEvent = serde_json::from_str(&json).expect("deserialize");
        if let SwarmEvent::SystemMetrics(p) = deserialized {
            assert!((p.memory_total_mb - 262_144.0).abs() < f64::EPSILON);
            // 35,389 / 262,144 ≈ 13.5%, not the inflated 216% from dividing
            // by a hardcoded 16,384 MB assumption.
            let pct = (p.memory_mb / p.memory_total_mb) * 100.0;
            assert!(
                (pct - 13.5).abs() < 0.1,
                "expected ~13.5% memory usage on real hardware total, got {pct}"
            );
        } else {
            panic!("expected SystemMetrics variant");
        }
    }

    #[test]
    fn test_ai_stream_delta_roundtrip() {
        let event = SwarmEvent::AiStreamDelta(AiStreamDeltaPayload {
            request_id: "req-123".to_string(),
            delta: "Hello ".to_string(),
            done: false,
        });
        let json = serde_json::to_string(&event).expect("serialize");
        let deserialized: SwarmEvent = serde_json::from_str(&json).expect("deserialize");
        if let SwarmEvent::AiStreamDelta(p) = deserialized {
            assert_eq!(p.request_id, "req-123");
            assert_eq!(p.delta, "Hello ");
            assert!(!p.done);
        } else {
            panic!("expected AiStreamDelta variant");
        }
    }

    #[test]
    fn test_session_created_roundtrip() {
        let id = Uuid::new_v4();
        let event = SwarmEvent::SessionCreated(SessionCreatedPayload {
            session_id: id,
            name: "My Session".to_string(),
        });
        let json = serde_json::to_string(&event).expect("serialize");
        let deserialized: SwarmEvent = serde_json::from_str(&json).expect("deserialize");
        if let SwarmEvent::SessionCreated(p) = deserialized {
            assert_eq!(p.session_id, id);
            assert_eq!(p.name, "My Session");
        } else {
            panic!("expected SessionCreated variant");
        }
    }

    #[test]
    fn test_system_log_roundtrip() {
        let event = SwarmEvent::SystemLog(SystemLogPayload {
            level: "warn".to_string(),
            message: "something happened".to_string(),
            target: "swarm_core::worker".to_string(),
            timestamp: 1700000000,
        });
        let json = serde_json::to_string(&event).expect("serialize");
        let deserialized: SwarmEvent = serde_json::from_str(&json).expect("deserialize");
        if let SwarmEvent::SystemLog(p) = deserialized {
            assert_eq!(p.level, "warn");
            assert_eq!(p.message, "something happened");
        } else {
            panic!("expected SystemLog variant");
        }
    }

    #[test]
    fn test_ai_stream_settled_roundtrip() {
        let event = SwarmEvent::AiStreamSettled(AiStreamSettledPayload {
            request_id: "req-9".to_string(),
            status: "error".to_string(),
            error: Some("rate limited".to_string()),
        });
        let json = serde_json::to_string(&event).expect("serialize");
        assert!(json.contains("\"type\":\"ai_stream_settled\""));
        assert!(json.contains("\"requestId\":\"req-9\""));
        let deserialized: SwarmEvent = serde_json::from_str(&json).expect("deserialize");
        if let SwarmEvent::AiStreamSettled(p) = deserialized {
            assert_eq!(p.status, "error");
            assert_eq!(p.error.as_deref(), Some("rate limited"));
        } else {
            panic!("expected AiStreamSettled variant");
        }
    }

    #[test]
    fn test_json_uses_snake_case_type_tag() {
        let event = SwarmEvent::WorkerSpawned(WorkerSpawnedPayload {
            worker_id: Uuid::nil(),
            name: "test".to_string(),
            pid: None,
            isolation: Some("none".to_string()),
        });
        let json = serde_json::to_string(&event).expect("serialize");
        assert!(json.contains("\"type\":\"worker_spawned\""));
        assert!(json.contains("\"payload\""));
    }

    #[test]
    fn test_worker_spawned_isolation_field_absent_deserializes_as_none() {
        // Backward compatibility: a persisted row from before this
        // field existed has no `isolation` key at all — it must still
        // deserialize rather than fail replay.
        let json =
            r#"{"workerId":"00000000-0000-0000-0000-000000000000","name":"legacy","pid":null}"#;
        let payload: WorkerSpawnedPayload = serde_json::from_str(json).expect("deserialize");
        assert_eq!(payload.isolation, None);
    }

    #[test]
    fn test_worktree_created_roundtrip() {
        let worker_id = Uuid::new_v4();
        let session_id = Uuid::new_v4();
        let event = SwarmEvent::WorktreeCreated(WorktreeCreatedPayload {
            worker_id,
            session_id: Some(session_id),
            repo_root: "C:/Projects/swarm".to_string(),
            worktree_path: "C:/Users/x/.swarm/worktrees/swarm-abcd1234/w-11112222".to_string(),
            branch: "swarm/research-agent-11112222".to_string(),
            base_commit: "deadbeefcafef00d".to_string(),
        });
        let json = serde_json::to_string(&event).expect("serialize");
        assert!(json.contains("\"type\":\"worktree_created\""));
        assert!(json.contains("\"workerId\""));
        assert!(json.contains("\"repoRoot\""));
        assert!(json.contains("\"worktreePath\""));
        assert!(json.contains("\"baseCommit\""));
        let deserialized: SwarmEvent = serde_json::from_str(&json).expect("deserialize");
        if let SwarmEvent::WorktreeCreated(p) = deserialized {
            assert_eq!(p.worker_id, worker_id);
            assert_eq!(p.session_id, Some(session_id));
            assert_eq!(p.branch, "swarm/research-agent-11112222");
            assert_eq!(p.base_commit, "deadbeefcafef00d");
        } else {
            panic!("expected WorktreeCreated variant");
        }
    }

    #[test]
    fn test_worktree_created_session_id_optional() {
        let event = SwarmEvent::WorktreeCreated(WorktreeCreatedPayload {
            worker_id: Uuid::nil(),
            session_id: None,
            repo_root: "/repo".to_string(),
            worktree_path: "/repo-wt".to_string(),
            branch: "swarm/x-abcd1234".to_string(),
            base_commit: "sha".to_string(),
        });
        let json = serde_json::to_string(&event).expect("serialize");
        let deserialized: SwarmEvent = serde_json::from_str(&json).expect("deserialize");
        if let SwarmEvent::WorktreeCreated(p) = deserialized {
            assert_eq!(p.session_id, None);
        } else {
            panic!("expected WorktreeCreated variant");
        }
    }

    #[test]
    fn test_worktree_removed_roundtrip_removed_disposition() {
        let worker_id = Uuid::new_v4();
        let event = SwarmEvent::WorktreeRemoved(WorktreeRemovedPayload {
            worker_id,
            worktree_path: "/repo-wt".to_string(),
            branch: "swarm/x-abcd1234".to_string(),
            disposition: "removed".to_string(),
            head_commit: Some("sha123".to_string()),
            reason: None,
        });
        let json = serde_json::to_string(&event).expect("serialize");
        assert!(json.contains("\"type\":\"worktree_removed\""));
        assert!(json.contains("\"disposition\":\"removed\""));
        let deserialized: SwarmEvent = serde_json::from_str(&json).expect("deserialize");
        if let SwarmEvent::WorktreeRemoved(p) = deserialized {
            assert_eq!(p.worker_id, worker_id);
            assert_eq!(p.disposition, "removed");
            assert_eq!(p.reason, None);
        } else {
            panic!("expected WorktreeRemoved variant");
        }
    }

    #[test]
    fn test_worktree_removed_roundtrip_preserved_dirty_disposition() {
        let event = SwarmEvent::WorktreeRemoved(WorktreeRemovedPayload {
            worker_id: Uuid::nil(),
            worktree_path: "/repo-wt".to_string(),
            branch: "swarm/x-abcd1234".to_string(),
            disposition: "preserved_dirty".to_string(),
            head_commit: Some("sha456".to_string()),
            reason: Some("contains modified or untracked files".to_string()),
        });
        let json = serde_json::to_string(&event).expect("serialize");
        let deserialized: SwarmEvent = serde_json::from_str(&json).expect("deserialize");
        if let SwarmEvent::WorktreeRemoved(p) = deserialized {
            assert_eq!(p.disposition, "preserved_dirty");
            assert_eq!(
                p.reason.as_deref(),
                Some("contains modified or untracked files")
            );
        } else {
            panic!("expected WorktreeRemoved variant");
        }
    }

    #[test]
    fn test_ship_progress_roundtrip() {
        let ship_id = Uuid::new_v4();
        let worker_id = Uuid::new_v4();
        let event = SwarmEvent::ShipProgress(ShipProgressPayload {
            ship_id,
            worker_id,
            step: "push".to_string(),
            status: "running".to_string(),
            detail: None,
        });
        let json = serde_json::to_string(&event).expect("serialize");
        assert!(json.contains("\"type\":\"ship_progress\""));
        assert!(json.contains("\"shipId\""));
        let deserialized: SwarmEvent = serde_json::from_str(&json).expect("deserialize");
        if let SwarmEvent::ShipProgress(p) = deserialized {
            assert_eq!(p.ship_id, ship_id);
            assert_eq!(p.worker_id, worker_id);
            assert_eq!(p.step, "push");
        } else {
            panic!("expected ShipProgress variant");
        }
    }

    #[test]
    fn test_ship_settled_roundtrip_with_error() {
        use crate::git::{ShipErrorKind, ShipRemedy};

        let ship_id = Uuid::new_v4();
        let event = SwarmEvent::ShipSettled(ShipSettledPayload {
            ship_id,
            worker_id: Uuid::new_v4(),
            commit_sha: None,
            pushed_ref: None,
            pr_url: None,
            status: "error".to_string(),
            error: Some(ShipError {
                kind: ShipErrorKind::PushRejected,
                message: "Push Rejected".to_string(),
                remedy: Some(ShipRemedy::FetchAndRebase),
            }),
        });
        let json = serde_json::to_string(&event).expect("serialize");
        assert!(json.contains("\"type\":\"ship_settled\""));
        assert!(json.contains("\"pushRejected\""));
        let deserialized: SwarmEvent = serde_json::from_str(&json).expect("deserialize");
        if let SwarmEvent::ShipSettled(p) = deserialized {
            assert_eq!(p.status, "error");
            assert_eq!(p.error.unwrap().kind, ShipErrorKind::PushRejected);
        } else {
            panic!("expected ShipSettled variant");
        }
    }

    #[test]
    fn test_commit_created_roundtrip() {
        let worker_id = Uuid::new_v4();
        let event = SwarmEvent::CommitCreated(CommitCreatedPayload {
            worker_id,
            sha: "deadbeef".to_string(),
            branch: "swarm/agent-abcd1234".to_string(),
            seq_from: 10,
            seq_to: 42,
        });
        let json = serde_json::to_string(&event).expect("serialize");
        assert!(json.contains("\"type\":\"commit_created\""));
        assert!(json.contains("\"seqFrom\":10"));
        assert!(json.contains("\"seqTo\":42"));
        let deserialized: SwarmEvent = serde_json::from_str(&json).expect("deserialize");
        if let SwarmEvent::CommitCreated(p) = deserialized {
            assert_eq!(p.worker_id, worker_id);
            assert_eq!(p.sha, "deadbeef");
        } else {
            panic!("expected CommitCreated variant");
        }
    }

    #[test]
    fn test_payload_uses_camel_case_fields() {
        let event = SwarmEvent::WorkerSpawned(WorkerSpawnedPayload {
            worker_id: Uuid::nil(),
            name: "test".to_string(),
            pid: Some(100),
            isolation: None,
        });
        let json = serde_json::to_string(&event).expect("serialize");
        assert!(json.contains("\"workerId\""));
    }
}
