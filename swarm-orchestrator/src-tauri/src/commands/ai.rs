//! AI integration Tauri IPC command handlers.
//!
//! Provides the `ai_request` command that enqueues AI requests
//! into the priority queue for streaming processing via the
//! Anthropic Messages API, and `agent_turn_started` — a narrow
//! webview intake used by the client-side chat streaming path
//! (`AIChat.tsx`, which streams `@anthropic-ai/sdk` directly from the
//! webview and never calls `ai_request`) to record a real, persisted
//! seq for each AI/agent turn.

use uuid::Uuid;

use swarm_core::ai::{AiQueue, AiRequest};
use swarm_core::events::{AgentTurnStartedPayload, EventSink, Provenance, SwarmEvent};

/// Enqueues an AI request for streaming processing.
///
/// Accepts an [`AiRequest`] from the frontend and places it
/// into the [`AiQueue`] priority queue. The queue processes
/// requests in priority order with concurrency limiting,
/// emitting `ai_stream_delta` events on `swarm://events` as response
/// chunks arrive.
///
/// # Arguments
///
/// * `queue` - Shared AI request queue (managed state)
/// * `request` - The AI request containing messages, system prompt,
///   and priority level
///
/// # Returns
///
/// The `request_id` string from the request, which the frontend
/// can use to correlate incoming `ai_stream_delta` events on
/// `swarm://events`.
///
/// # Errors
///
/// Returns a `String` error if the queue channel is closed
/// (i.e., the processing loop has shut down).
#[tauri::command]
#[tracing::instrument(skip(queue, request), fields(request_id = %request.request_id))]
pub async fn ai_request(
    queue: tauri::State<'_, AiQueue>,
    request: AiRequest,
) -> Result<String, String> {
    tracing::info!(request_id = %request.request_id, "ai_request called");
    let request_id = request.request_id.clone();
    queue.enqueue(request).map_err(|e| {
        tracing::error!(error = %e, "failed to enqueue AI request");
        e.to_string()
    })?;
    Ok(request_id)
}

/// Records the start of one AI/agent turn and returns the real,
/// persisted seq the engine assigned it.
///
/// `AIChat.tsx`'s `doSend` calls this once per turn, before the first
/// streaming round — the returned seq (`turnSeq`) then lives in that
/// turn's closure and is cited as `causeSeq` on every tool-driven side
/// effect (`spawn_worker`, `kill_worker`, `worker_input`, `write_file`)
/// that turn executes. This is the mechanism behind the invariant "the
/// engine records provenance, it never infers it": the frontend cannot
/// cite a cause that doesn't exist in the log, and this command's job
/// is to make one exist before any tool call can reference it.
///
/// Uses [`EventSink::emit_awaiting_seq`] — deterministic (no polling,
/// no timeout-bound `waitFor` correlation): the writer thread hands
/// back the exact seq it assigned this event.
///
/// # Arguments
///
/// * `sink` - Event sink (managed state)
/// * `worker_id` - UUID string of the worker whose chat panel started this turn
/// * `model` - Model identifier for this turn
/// * `request_id` - Client-generated correlation ID (the chat item id)
///
/// # Returns
///
/// The seq the writer thread assigned the `agent_turn_started` event.
///
/// # Errors
///
/// Returns a `String` error if `worker_id` is not a valid UUID, or if
/// the event writer thread is gone (the ack channel closed without a value).
#[tauri::command]
#[tracing::instrument(skip(sink))]
pub async fn agent_turn_started(
    sink: tauri::State<'_, EventSink>,
    worker_id: String,
    model: String,
    request_id: String,
) -> Result<u64, String> {
    let uuid = Uuid::parse_str(&worker_id).map_err(|e| {
        tracing::error!(error = %e, "invalid worker ID");
        e.to_string()
    })?;
    tracing::info!(worker_id = %uuid, %model, %request_id, "agent_turn_started called");

    let ack = sink.emit_awaiting_seq(
        SwarmEvent::AgentTurnStarted(AgentTurnStartedPayload {
            worker_id: uuid,
            model,
            request_id,
        }),
        // The turn's own start is caused by a human (or an injected
        // instruction acting on the user's behalf) — unattributed in
        // v1, same as every other user-initiated action (see the
        // honest v1 attribution table).
        Provenance::default(),
    );
    ack.await.map_err(|e| {
        tracing::error!(error = %e, "event writer thread gone before ack");
        "Event Writer Unavailable.".to_string()
    })
}
