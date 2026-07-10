//! Message bus Tauri IPC command handlers.
//!
//! Exposes inter-agent message bus operations to the React frontend.
//! Each command delegates to the [`MessageBus`](crate::bus::channel::MessageBus)
//! and [`Router`](crate::bus::router::Router) instances managed as Tauri state.

use tauri::AppHandle;
use uuid::Uuid;

use crate::bus::channel::MessageBus;
use crate::bus::router::{PipelineInfo, PipelineStage, Router};
use crate::events::{BusMessagePayload, SwarmEvent, emit_event};

/// Sends a message from one worker to another on a topic.
///
/// If `to_worker_id` is provided, the message is sent as a direct
/// message. Otherwise, it is broadcast to all subscribers of the topic.
///
/// This delivers the message on the internal message bus only; it does
/// **not** emit events itself. Frontend delivery happens exclusively through
/// [`bus_subscribe`]'s forwarding task, which emits `SwarmEvent::BusMessage`
/// as `bus_message`-tagged envelopes on the `swarm://events` channel.
/// This keeps delivery to exactly one event per message, regardless of
/// how many (if any) frontend listeners are subscribed.
///
/// # Arguments
///
/// * `router` - Shared router (managed state)
/// * `from_worker_id` - UUID string of the sending worker
/// * `to_worker_id` - Optional UUID string of the target worker
/// * `topic` - Topic to send on
/// * `payload` - JSON payload
///
/// # Returns
///
/// The number of receivers that received the message. `0` means no
/// subscriber (via [`bus_subscribe`]) is currently listening on this topic.
///
/// # Errors
///
/// Returns a `String` error if:
/// - The UUID strings are invalid
/// - The message delivery fails
#[tauri::command]
#[tracing::instrument(skip(router, payload))]
pub async fn bus_send(
    router: tauri::State<'_, Router>,
    from_worker_id: String,
    to_worker_id: Option<String>,
    topic: String,
    payload: serde_json::Value,
) -> Result<usize, String> {
    tracing::debug!(
        from = %from_worker_id,
        to = ?to_worker_id,
        topic = %topic,
        "bus_send called"
    );

    let from = Uuid::parse_str(&from_worker_id).map_err(|e| {
        tracing::error!(error = %e, "invalid from_worker_id");
        e.to_string()
    })?;

    let to_uuid = if let Some(ref to_str) = to_worker_id {
        Some(Uuid::parse_str(to_str).map_err(|e| {
            tracing::error!(error = %e, "invalid to_worker_id");
            e.to_string()
        })?)
    } else {
        None
    };

    let count = if let Some(to) = to_uuid {
        router.send_direct(from, to, &topic, payload)?
    } else {
        router.send_broadcast(from, &topic, payload)?
    };

    Ok(count)
}

/// Subscribes to a message bus topic and streams messages as Tauri events.
///
/// Creates a background task that listens for messages on the given topic
/// and emits them to the frontend via [`emit_event`] as `bus_message`-tagged
/// `SwarmEvent::BusMessage` payloads on the `swarm://events` channel.
/// The task runs until the channel is closed or the topic is removed.
///
/// This is the **sole** path by which bus messages reach the frontend —
/// [`bus_send`] only publishes to the internal bus and does not emit
/// directly, so each message reaches the frontend at most once, in one
/// consistent shape (`{ messageId, fromWorker, toWorker, topic, payload }`).
///
/// # Arguments
///
/// * `app` - Tauri app handle for event emission
/// * `bus` - Shared message bus (managed state)
/// * `topic` - Topic to subscribe to
///
/// # Errors
///
/// Returns a `String` error if subscription fails.
#[tauri::command]
#[tracing::instrument(skip(app, bus))]
pub async fn bus_subscribe(
    app: AppHandle,
    bus: tauri::State<'_, MessageBus>,
    topic: String,
) -> Result<(), String> {
    tracing::info!(topic = %topic, "bus_subscribe called");

    let mut rx = bus.subscribe(&topic)?;

    tokio::spawn(async move {
        loop {
            match rx.recv().await {
                Ok(msg) => {
                    emit_event(
                        &app,
                        SwarmEvent::BusMessage(BusMessagePayload {
                            message_id: msg.id,
                            from_worker: msg.from_worker,
                            to_worker: msg.to_worker,
                            topic: msg.topic,
                            payload: msg.payload,
                        }),
                    );
                }
                Err(tokio::sync::broadcast::error::RecvError::Lagged(n)) => {
                    tracing::warn!(topic = %topic, skipped = n, "bus subscriber lagged");
                    continue;
                }
                Err(tokio::sync::broadcast::error::RecvError::Closed) => {
                    tracing::debug!(topic = %topic, "bus channel closed, stopping subscriber");
                    break;
                }
            }
        }
    });

    Ok(())
}

/// Creates a new message processing pipeline.
///
/// # Arguments
///
/// * `router` - Shared router (managed state)
/// * `stages` - Ordered list of pipeline stages with worker IDs and optional transforms
///
/// # Returns
///
/// The UUID string of the newly created pipeline.
#[tauri::command]
#[tracing::instrument(skip(router, stages))]
pub async fn bus_create_pipeline(
    router: tauri::State<'_, Router>,
    stages: Vec<PipelineStage>,
) -> Result<String, String> {
    tracing::info!(stage_count = stages.len(), "bus_create_pipeline called");

    let id = router.create_pipeline(stages);
    Ok(id.to_string())
}

/// Lists all active message bus channels.
///
/// # Arguments
///
/// * `bus` - Shared message bus (managed state)
///
/// # Returns
///
/// A `Vec<String>` of all active topic channel names.
#[tauri::command]
#[tracing::instrument(skip(bus))]
pub async fn bus_list_channels(bus: tauri::State<'_, MessageBus>) -> Result<Vec<String>, String> {
    tracing::debug!("bus_list_channels called");
    Ok(bus.list_channels())
}

/// Lists all registered pipelines.
///
/// # Arguments
///
/// * `router` - Shared router (managed state)
///
/// # Returns
///
/// A `Vec<PipelineInfo>` of all registered pipelines.
#[tauri::command]
#[tracing::instrument(skip(router))]
pub async fn bus_list_pipelines(
    router: tauri::State<'_, Router>,
) -> Result<Vec<PipelineInfo>, String> {
    tracing::debug!("bus_list_pipelines called");
    Ok(router.list_pipelines())
}
