//! AI integration Tauri IPC command handler.
//!
//! Provides the `ai_request` command that enqueues AI requests
//! into the priority queue for streaming processing via the
//! Anthropic Messages API.

use crate::ai::{AiQueue, AiRequest};

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
