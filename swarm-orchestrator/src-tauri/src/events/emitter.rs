//! Tauri event emitter utilities.
//!
//! Provides a typed event system for broadcasting worker state
//! changes, session events, AI stream deltas, and system metrics
//! to the React frontend via Tauri's `AppHandle::emit` API.
//!
//! ## Serialization Convention
//!
//! - Event type tags use `snake_case` (e.g., `"worker_spawned"`)
//! - Payload fields use `camelCase` (e.g., `"workerId"`)
//! - This matches the frontend's expected JSON format

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};
use uuid::Uuid;

use crate::worker::handle::WorkerState;

/// All typed events emitted by the SWARM backend.
///
/// This enum is the single source of truth for the backend-to-frontend
/// event contract. Each variant maps to a specific Tauri event channel.
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
}

/// Payload for the `worker:spawned` event.
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
}

/// Payload for the `worker:killed` event.
///
/// Emitted when a worker process is terminated and removed
/// from the registry.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkerKilledPayload {
    /// UUID of the killed worker.
    pub worker_id: Uuid,
}

/// Payload for the `worker:output` event.
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

/// Payload for the `worker:state` event.
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

/// Payload for the `session:created` event.
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

/// Payload for the `session:deleted` event.
///
/// Emitted when a session is removed from the manager.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionDeletedPayload {
    /// UUID of the deleted session.
    pub session_id: Uuid,
}

/// Payload for the `system:metrics` event.
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
    /// Total number of registered workers.
    pub worker_count: usize,
    /// AI API requests per second. Currently a placeholder.
    pub ai_req_per_sec: f64,
    /// Unix timestamp in milliseconds when this snapshot was taken.
    pub timestamp: i64,
}

/// Payload for the `ai:stream_delta` event.
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

/// Payload for the `swarm://bus-message` event.
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

/// Payload for the `system:log` event.
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

/// Emits a typed [`SwarmEvent`] to the Tauri frontend.
///
/// Routes each enum variant to its corresponding channel name
/// and serializes the payload. Channel names use colon-separated
/// namespaces (e.g., `"worker:spawned"`, `"ai:stream_delta"`).
///
/// # Arguments
///
/// * `app` - The Tauri app handle to emit events through
/// * `event` - The typed event to emit
///
/// # Channel Mapping
///
/// | Variant           | Channel             |
/// |-------------------|----------------------|
/// | `WorkerSpawned`   | `worker:spawned`    |
/// | `WorkerKilled`    | `worker:killed`     |
/// | `WorkerOutput`    | `worker:output`     |
/// | `WorkerState`     | `worker:state`      |
/// | `SessionCreated`  | `session:created`   |
/// | `SessionDeleted`  | `session:deleted`   |
/// | `SystemMetrics`   | `system:metrics`    |
/// | `AiStreamDelta`   | `ai:stream_delta`   |
/// | `AiStreamSettled` | `ai:stream_settled` |
/// | `SystemLog`       | `system:log`        |
///
/// In addition to the legacy per-channel emission above, every event is
/// routed through the [`crate::orchestration::OrchestrationEngine`], which
/// assigns a monotonic sequence number and emits an ordered envelope on
/// the single `swarm://events` channel.
#[tracing::instrument(skip(app, event), fields(event_type))]
pub fn emit_event(app: &AppHandle, event: SwarmEvent) {
    // Ordered path: the engine assigns seq and emits on `swarm://events`.
    // `try_state` because unit tests construct AppHandles without setup.
    if let Some(engine) = app.try_state::<crate::orchestration::OrchestrationEngine>() {
        engine.record(event.clone());
    }

    // Legacy per-channel path — removed in the frontend-cutover cleanup task.
    let (channel, result) = match &event {
        SwarmEvent::WorkerSpawned(p) => ("worker:spawned", app.emit("worker:spawned", p)),
        SwarmEvent::WorkerKilled(p) => ("worker:killed", app.emit("worker:killed", p)),
        SwarmEvent::WorkerOutput(p) => ("worker:output", app.emit("worker:output", p)),
        SwarmEvent::WorkerState(p) => ("worker:state", app.emit("worker:state", p)),
        SwarmEvent::SessionCreated(p) => ("session:created", app.emit("session:created", p)),
        SwarmEvent::SessionDeleted(p) => ("session:deleted", app.emit("session:deleted", p)),
        SwarmEvent::SystemMetrics(p) => ("system:metrics", app.emit("system:metrics", p)),
        SwarmEvent::AiStreamDelta(p) => ("ai:stream_delta", app.emit("ai:stream_delta", p)),
        SwarmEvent::AiStreamSettled(p) => ("ai:stream_settled", app.emit("ai:stream_settled", p)),
        SwarmEvent::SystemLog(p) => ("system:log", app.emit("system:log", p)),
        SwarmEvent::BusMessage(p) => ("swarm://bus-message", app.emit("swarm://bus-message", p)),
    };

    tracing::Span::current().record("event_type", tracing::field::display(&channel));

    if let Err(e) = result {
        tracing::error!(channel = channel, error = %e, "failed to emit event");
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
        });
        let json = serde_json::to_string(&event).expect("serialize");
        let deserialized: SwarmEvent = serde_json::from_str(&json).expect("deserialize");
        if let SwarmEvent::WorkerSpawned(p) = deserialized {
            assert_eq!(p.name, "test-worker");
            assert_eq!(p.pid, Some(42));
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
        });
        let json = serde_json::to_string(&event).expect("serialize");
        assert!(json.contains("\"type\":\"worker_spawned\""));
        assert!(json.contains("\"payload\""));
    }

    #[test]
    fn test_payload_uses_camel_case_fields() {
        let event = SwarmEvent::WorkerSpawned(WorkerSpawnedPayload {
            worker_id: Uuid::nil(),
            name: "test".to_string(),
            pid: Some(100),
        });
        let json = serde_json::to_string(&event).expect("serialize");
        assert!(json.contains("\"workerId\""));
    }
}
