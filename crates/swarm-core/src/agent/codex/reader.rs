//! The reader task: drains the child's framed stdout and maps every line to
//! events, request answers or approval prompts.

use std::mem::DropGuard;
use std::sync::Arc;

use serde::Deserialize;
use serde::de::DeserializeOwned;
use serde_json::{Value, json};
use tokio::sync::mpsc;

use super::process::encode_line;
use super::protocol::{
    ApprovalDecision, ApprovalRequest, ApprovalResponse, DeltaNotification, ErrorNotification,
    ErrorObject, ErrorResponse, INVALID_PARAMS, Incoming, Item, ItemNotification, METHOD_NOT_FOUND,
    PermissionGrantScope, PermissionsResponse, RequestId, Response, RpcError,
    ServerRequestResolved, TokenUsageNotification, Turn, TurnError, TurnNotification,
    TurnStartResponse, TurnStatus, method,
};
use super::state::{ApprovalKind, BlockStream, Inner, PendingApproval, Shared, TurnSlot};
use super::teardown::{teardown, teardown_on_drop};
use super::{RECENTLY_SETTLED, TURN_FAILED, TURN_INTERRUPTED};

use crate::agent::adapter::{AgentTurnStatus, PermissionDecision, PermissionId, TurnId};
use crate::error::AppError;
use crate::events::{
    AgentBlockPayload, AgentPermissionRequestPayload, AgentToolCallPayload, AgentToolResultPayload,
    AgentTurnDeltaPayload, AgentTurnSettledPayload, SwarmEvent,
};

/// Drains the child's framed stdout for the session's lifetime, then runs
/// [`teardown`]. A framer error (an over-long line) is a session-level
/// failure: lines already framed are still mapped first, so the event
/// log never records the exit before activity that preceded it. The
/// `biased` select keeps a framer error from overtaking queued lines.
pub(super) async fn run_reader(
    shared: Arc<Shared>,
    mut lines: mpsc::Receiver<String>,
    mut framer_errors: mpsc::UnboundedReceiver<AppError>,
) {
    // A panic while mapping a line must still tear the session down
    // (Condition B, the child's reaping), so teardown is armed as a drop
    // guard and disarmed on the normal path.
    let teardown_on_unwind = teardown_on_drop(&shared);

    let mut framer_open = true;
    loop {
        tokio::select! {
            biased;
            line = lines.recv() => match line {
                Some(line) => handle_line(&shared, &line),
                None => break,
            },
            error = framer_errors.recv(), if framer_open => match error {
                Some(error) => {
                    tracing::error!(
                        worker_id = %shared.worker_id,
                        %error,
                        "codex adapter: ndjson framer error — tearing the session down"
                    );
                    *shared.teardown_cause.lock() = Some(error.to_string());
                    while let Ok(line) = lines.try_recv() {
                        handle_line(&shared, &line);
                    }
                    break;
                }
                None => framer_open = false,
            },
        }
    }

    let shared = DropGuard::dismiss(teardown_on_unwind);
    teardown(&shared).await;
}

/// Classifies one line by the JSON-RPC discriminators and dispatches it.
fn handle_line(shared: &Shared, line: &str) {
    let message: Incoming = match serde_json::from_str(line) {
        Ok(message) => message,
        Err(error) => {
            tracing::warn!(worker_id = %shared.worker_id, %error, "codex adapter: unparseable line, skipped");
            return;
        }
    };
    match (message.method, message.id) {
        (Some(method), Some(id)) => handle_server_request(shared, &method, id, message.params),
        (Some(method), None) => handle_notification(shared, &method, message.params),
        (None, Some(RequestId::Integer(id))) => {
            let outcome = match message.error {
                Some(error) => Err(error),
                None => Ok(message.result.unwrap_or(Value::Null)),
            };
            handle_response(shared, id, outcome);
        }
        (None, Some(RequestId::String(id))) => {
            tracing::warn!(
                id,
                "codex adapter: response to a string id this client never sent"
            );
        }
        (None, None) => {
            tracing::warn!(worker_id = %shared.worker_id, "codex adapter: line is neither request, notification nor response");
        }
    }
}

/// Resolves one of this session's requests. A `turn/start`
/// acknowledgement promotes the turn slot here, in the reader, before the
/// requester is woken — so every line after it already sees the
/// promoted turn.
fn handle_response(shared: &Shared, id: i64, outcome: Result<Value, RpcError>) {
    let pending = {
        let mut inner = shared.state.lock();
        let Some(pending) = inner.pending.remove(&id) else {
            tracing::debug!(id, "codex adapter: response to a request nobody awaits");
            return;
        };
        if pending.method == method::TURN_START
            && let Ok(result) = &outcome
            && let Ok(response) = TurnStartResponse::deserialize(result)
        {
            promote(shared, &mut inner, response.turn.id);
        }
        pending
    };
    // The requester may have timed out and gone.
    let _ = pending.reply.send(outcome);
}

/// Promotes a `Starting` slot to the acknowledged turn — or straight back
/// to idle when that turn already settled (its `turn/completed` overtook
/// the acknowledgement).
fn promote(shared: &Shared, inner: &mut Inner, turn_id: TurnId) {
    if inner.turn == TurnSlot::Starting {
        inner.turn = if shared.was_settled(&turn_id) {
            TurnSlot::Idle
        } else {
            TurnSlot::Running(turn_id)
        };
    }
}

/// Deserializes notification `params`, logging (not failing) on a shape
/// that does not match the schema.
fn parse<T: DeserializeOwned>(method: &str, params: Value) -> Option<T> {
    serde_json::from_value(params)
        .inspect_err(|error| {
            tracing::warn!(method, %error, "codex adapter: notification does not match the codex 0.156.1 schema, skipped");
        })
        .ok()
}

fn handle_notification(shared: &Shared, method: &str, params: Value) {
    match method {
        method::ITEM_STARTED => {
            if let Some(notification) = parse(method, params) {
                on_item_started(shared, notification);
            }
        }
        method::ITEM_COMPLETED => {
            if let Some(notification) = parse(method, params) {
                on_item_completed(shared, notification);
            }
        }
        method::AGENT_MESSAGE_DELTA => {
            if let Some(delta) = parse(method, params) {
                on_delta(shared, delta, "text", BlockStream::Main);
            }
        }
        method::REASONING_SUMMARY_TEXT_DELTA => {
            if let Some(delta) = parse(method, params) {
                on_delta(shared, delta, "thinking", BlockStream::Main);
            }
        }
        method::REASONING_TEXT_DELTA => {
            if let Some(delta) = parse(method, params) {
                on_delta(shared, delta, "thinking", BlockStream::ReasoningContent);
            }
        }
        // Deliberately not streamed: a delta stream is closed only by an
        // `agent_block` at the same index, and a command's output already
        // arrives whole in its `agent_tool_result` (`aggregatedOutput`).
        // A streamed copy would be a second, never-closed rendering of it.
        method::COMMAND_EXECUTION_OUTPUT_DELTA => {}
        method::TURN_STARTED => {
            if let Some(TurnNotification { thread_id, turn }) = parse(method, params)
                && shared.is_own_thread(&thread_id)
            {
                promote(shared, &mut shared.state.lock(), turn.id);
            }
        }
        // A completion that cannot be read still settles the turn: skipping it
        // would leave the slot running until the process exits (Condition B).
        method::TURN_COMPLETED => match TurnNotification::deserialize(&params) {
            Ok(TurnNotification { thread_id, turn }) => {
                if shared.is_own_thread(&thread_id) {
                    settle(shared, turn);
                }
            }
            Err(error) => {
                tracing::warn!(
                    method,
                    %error,
                    "codex adapter: notification does not match the codex 0.156.1 schema, settling the turn as an error"
                );
                if let (Some(thread_id), Some(turn_id)) = (
                    params.get("threadId").and_then(Value::as_str),
                    params.pointer("/turn/id").and_then(Value::as_str),
                ) && shared.is_own_thread(thread_id)
                {
                    settle(
                        shared,
                        Turn {
                            id: turn_id.to_owned(),
                            status: TurnStatus::Unknown,
                            error: Some(TurnError {
                                message: "Codex Sent A Turn Completion That Could Not Be Read"
                                    .to_owned(),
                                additional_details: Some(error.to_string()),
                            }),
                            duration_ms: None,
                        },
                    );
                }
            }
        },
        method::ERROR => {
            if let Some(notification) = parse::<ErrorNotification>(method, params)
                && shared.is_own_thread(&notification.thread_id)
            {
                let message = notification.error.describe();
                if notification.will_retry {
                    tracing::warn!(turn_id = %notification.turn_id, %message, "codex adapter: turn error, codex is retrying");
                } else {
                    shared.state.lock().turn_error = Some((notification.turn_id, message));
                }
            }
        }
        method::THREAD_TOKEN_USAGE_UPDATED => {
            if let Some(notification) = parse::<TokenUsageNotification>(method, params)
                && shared.is_own_thread(&notification.thread_id)
            {
                shared.state.lock().usage = Some((notification.turn_id, notification.token_usage));
            }
        }
        method::SERVER_REQUEST_RESOLVED => {
            if let Some(ServerRequestResolved { request_id }) = parse(method, params) {
                shared
                    .state
                    .lock()
                    .approvals
                    .retain(|_, approval| approval.id != request_id);
            }
        }
        other => tracing::trace!(method = other, "codex adapter: notification not mapped"),
    }
}

/// `item/started`: tool-like items become `agent_tool_call`; text items
/// only stream (their block is emitted on completion).
fn on_item_started(shared: &Shared, notification: ItemNotification) {
    if !shared.is_own_thread(&notification.thread_id) {
        return;
    }
    let item = typed_item(&notification.item);
    let Some((tool_use_id, name, input)) = tool_call(&item) else {
        return;
    };
    let inner = shared.state.lock();
    if inner.closing {
        return;
    }
    shared.emit(SwarmEvent::AgentToolCall(AgentToolCallPayload {
        worker_id: shared.worker_id,
        turn_id: notification.turn_id,
        tool_use_id,
        name,
        input,
    }));
}

/// `item/completed`: text items become `agent_block` (closing their delta
/// stream), tool-like items `agent_tool_result`, other kinds a verbatim
/// `agent_block` named after the item type. The user's own message echo
/// is dropped.
fn on_item_completed(shared: &Shared, notification: ItemNotification) {
    if !shared.is_own_thread(&notification.thread_id) {
        return;
    }
    let ItemNotification {
        item: raw, turn_id, ..
    } = notification;
    let item = typed_item(&raw);
    let mut inner = shared.state.lock();
    if inner.closing {
        return;
    }
    let block = |inner: &mut Inner, item_id: &str, stream, kind: &str, content: Value| {
        SwarmEvent::AgentBlock(AgentBlockPayload {
            worker_id: shared.worker_id,
            turn_id: turn_id.clone(),
            block_index: inner.blocks.index(item_id, stream),
            kind: kind.to_string(),
            content,
        })
    };
    match &item {
        Item::UserMessage => {}
        Item::AgentMessage { id, text } => {
            let event = block(
                &mut inner,
                id,
                BlockStream::Main,
                "text",
                json!({ "text": text }),
            );
            shared.emit(event);
        }
        Item::Reasoning {
            id,
            summary,
            content,
        } => {
            for (stream, parts) in [
                (BlockStream::Main, summary),
                (BlockStream::ReasoningContent, content),
            ] {
                if parts.is_empty() && !inner.blocks.was_streamed(id, stream) {
                    continue;
                }
                let thinking = parts.join("\n\n");
                let event = block(
                    &mut inner,
                    id,
                    stream,
                    "thinking",
                    json!({ "thinking": thinking }),
                );
                shared.emit(event);
            }
        }
        Item::CommandExecution { id, .. }
        | Item::FileChange { id, .. }
        | Item::McpToolCall { id, .. }
        | Item::DynamicToolCall { id, .. } => {
            shared.emit(SwarmEvent::AgentToolResult(AgentToolResultPayload {
                worker_id: shared.worker_id,
                turn_id: turn_id.clone(),
                tool_use_id: id.clone(),
                is_error: tool_failed(&item),
                content: raw,
            }));
        }
        Item::Other => {
            let Some(item_id) = raw.get("id").and_then(Value::as_str).map(str::to_owned) else {
                let item_type = raw.get("type").and_then(Value::as_str);
                tracing::warn!(
                    worker_id = %shared.worker_id,
                    item_type = item_type.unwrap_or("unknown"),
                    "codex adapter: completed item without a string id, dropped"
                );
                return;
            };
            let kind = raw
                .get("type")
                .and_then(Value::as_str)
                .unwrap_or("unknown")
                .to_owned();
            let event = block(&mut inner, &item_id, BlockStream::Main, &kind, raw);
            shared.emit(event);
        }
    }
}

/// Streams one text chunk as `agent_turn_delta`. Only text items stream,
/// so every stream is closed by the item's `agent_block` (same
/// `block_index`) on completion.
fn on_delta(shared: &Shared, delta: DeltaNotification, kind: &str, stream: BlockStream) {
    if !shared.is_own_thread(&delta.thread_id) {
        return;
    }
    let mut inner = shared.state.lock();
    if inner.closing {
        return;
    }
    let mut text = delta.delta;
    if let Some(part) = delta.part_index {
        let previous = inner
            .blocks
            .part
            .insert((delta.item_id.clone(), stream), part);
        if previous.is_some_and(|previous| previous != part) {
            text.insert_str(0, "\n\n");
        }
    }
    let block_index = inner.blocks.index(&delta.item_id, stream);
    inner.blocks.streamed.insert((delta.item_id, stream));
    shared.emit(SwarmEvent::AgentTurnDelta(AgentTurnDeltaPayload {
        worker_id: shared.worker_id,
        turn_id: delta.turn_id,
        block_index,
        kind: kind.to_string(),
        text,
    }));
}

/// Settles a turn from its `turn/completed`. A completion that overtook
/// the `turn/start` acknowledgement (slot still `Starting`) settles now
/// and leaves the slot for the acknowledgement to clear; a duplicate or a
/// completion for a turn this session is not running is ignored.
fn settle(shared: &Shared, turn: Turn) {
    let mut inner = shared.state.lock();
    if inner.closing || shared.was_settled(&turn.id) {
        return;
    }
    match &inner.turn {
        TurnSlot::Running(id) if *id == turn.id => inner.turn = TurnSlot::Idle,
        TurnSlot::Starting => {}
        TurnSlot::Running(_) | TurnSlot::Idle => {
            tracing::warn!(turn_id = %turn.id, "codex adapter: completion for a turn this session is not running, ignored");
            return;
        }
    }

    let reported = turn.error.as_ref().map(TurnError::describe);
    let stashed = inner
        .turn_error
        .take_if(|(id, _)| *id == turn.id)
        .map(|(_, message)| message);
    let (status, error) = match turn.status {
        TurnStatus::Completed => (AgentTurnStatus::Ok, None),
        TurnStatus::Interrupted => (
            AgentTurnStatus::Error,
            Some(reported.unwrap_or_else(|| TURN_INTERRUPTED.to_string())),
        ),
        TurnStatus::Failed | TurnStatus::InProgress | TurnStatus::Unknown => (
            AgentTurnStatus::Error,
            Some(
                reported
                    .or(stashed)
                    .unwrap_or_else(|| TURN_FAILED.to_string()),
            ),
        ),
    };
    let usage = inner
        .usage
        .take_if(|(id, _)| *id == turn.id)
        .map(|(_, usage)| usage);

    shared.emit(SwarmEvent::AgentTurnSettled(AgentTurnSettledPayload {
        worker_id: shared.worker_id,
        turn_id: turn.id.clone(),
        status,
        error,
        cost_usd: None,
        usage,
        duration_ms: turn
            .duration_ms
            .and_then(|ms| u64::try_from(ms).ok())
            .unwrap_or(0),
        num_turns: None,
    }));
    shared.settled.send_modify(|settled| {
        settled.recent.push_back(turn.id);
        if settled.recent.len() > RECENTLY_SETTLED {
            settled.recent.pop_front();
        }
    });
}

/// Typed view of a raw item; an item whose known kind does not match the
/// schema is treated as [`Item::Other`] and forwarded verbatim.
fn typed_item(raw: &Value) -> Item {
    Item::deserialize(raw).unwrap_or_else(|error| {
        tracing::warn!(%error, "codex adapter: item does not match the codex 0.156.1 schema, forwarded verbatim");
        Item::Other
    })
}

/// `(tool_use_id, name, input)` for a tool-like item.
fn tool_call(item: &Item) -> Option<(String, String, Value)> {
    match item {
        Item::CommandExecution {
            id, command, cwd, ..
        } => Some((
            id.clone(),
            "commandExecution".to_string(),
            json!({ "command": command, "cwd": cwd }),
        )),
        Item::FileChange { id, changes, .. } => Some((
            id.clone(),
            "fileChange".to_string(),
            json!({ "changes": changes }),
        )),
        Item::McpToolCall {
            id,
            server,
            tool,
            arguments,
            ..
        } => Some((id.clone(), format!("{server}.{tool}"), arguments.clone())),
        Item::DynamicToolCall {
            id,
            tool,
            arguments,
            ..
        } => Some((id.clone(), tool.clone(), arguments.clone())),
        Item::UserMessage | Item::AgentMessage { .. } | Item::Reasoning { .. } | Item::Other => {
            None
        }
    }
}

/// Whether a completed tool-like item failed: a `failed`/`declined`
/// status, a non-zero exit code, an MCP error, or a dynamic tool's
/// `success: false`.
fn tool_failed(item: &Item) -> bool {
    match item {
        Item::CommandExecution {
            status, exit_code, ..
        } => status.is_error() || exit_code.is_some_and(|code| code != 0),
        Item::FileChange { status, .. } => status.is_error(),
        Item::McpToolCall { status, error, .. } => status.is_error() || error.is_some(),
        Item::DynamicToolCall {
            status, success, ..
        } => status.is_error() || *success == Some(false),
        Item::UserMessage | Item::AgentMessage { .. } | Item::Reasoning { .. } | Item::Other => {
            false
        }
    }
}

/// The [`PermissionId`] for a server request id: its JSON encoding, so
/// `5` and `"5"` stay distinct.
pub(super) fn permission_id(id: &RequestId) -> PermissionId {
    match id {
        RequestId::Integer(n) => n.to_string(),
        RequestId::String(s) => Value::String(s.clone()).to_string(),
    }
}

/// Server requests: the three approval kinds are registered and surfaced
/// as `agent_permission_request`; every other method is answered with
/// JSON-RPC `-32601` so the server never blocks on it.
fn handle_server_request(shared: &Shared, method: &str, id: RequestId, params: Value) {
    let mut inner = shared.state.lock();
    if inner.closing {
        return;
    }
    let tool = match method {
        method::COMMAND_EXECUTION_REQUEST_APPROVAL => "commandExecution",
        method::FILE_CHANGE_REQUEST_APPROVAL => "fileChange",
        method::PERMISSIONS_REQUEST_APPROVAL => "permissions",
        other => {
            tracing::warn!(
                method = other,
                "codex adapter: unsupported server request, answering method-not-found"
            );
            let message = format!("swarm does not implement {other}");
            answer_error(&inner, id, METHOD_NOT_FOUND, &message);
            return;
        }
    };
    let request = match ApprovalRequest::deserialize(&params) {
        Ok(request) => request,
        Err(error) => {
            tracing::warn!(method, %error, "codex adapter: approval request does not match the codex 0.156.1 schema");
            let message = format!("invalid {method} params: {error}");
            answer_error(&inner, id, INVALID_PARAMS, &message);
            return;
        }
    };
    let kind = match method {
        method::FILE_CHANGE_REQUEST_APPROVAL => ApprovalKind::FileChange,
        method::PERMISSIONS_REQUEST_APPROVAL => ApprovalKind::Permissions {
            requested: request.permissions.unwrap_or(Value::Null),
        },
        _ => ApprovalKind::Command,
    };
    let request_id = permission_id(&id);
    inner
        .approvals
        .insert(request_id.clone(), PendingApproval { id, kind });
    shared.emit(SwarmEvent::AgentPermissionRequest(
        AgentPermissionRequestPayload {
            worker_id: shared.worker_id,
            turn_id: request.turn_id,
            request_id,
            tool: tool.to_string(),
            input: params,
            suggested_decision: None,
            denial_subclass: None,
            message: None,
        },
    ));
}

/// Answers a server request with a JSON-RPC error (fire-and-forget: the
/// reader never waits on a write).
fn answer_error(inner: &Inner, id: RequestId, code: i64, message: &str) {
    let answer = ErrorResponse {
        id,
        error: ErrorObject { code, message },
    };
    match encode_line(&answer) {
        Ok(line) => {
            inner.enqueue(line, None);
        }
        Err(error) => tracing::error!(%error, "codex adapter: encoding an error answer failed"),
    }
}

/// The answer line for an approval.
pub(super) fn approval_answer(
    approval: PendingApproval,
    decision: PermissionDecision,
) -> Result<String, String> {
    let allow = decision == PermissionDecision::Allow;
    match approval.kind {
        // One Allow approves this one request — never a session-long grant
        // (`acceptForSession`), which the prompt does not offer.
        ApprovalKind::Command | ApprovalKind::FileChange => encode_line(&Response {
            id: approval.id,
            result: ApprovalResponse {
                decision: if allow {
                    ApprovalDecision::Accept
                } else {
                    ApprovalDecision::Decline
                },
            },
        }),
        ApprovalKind::Permissions { requested } => {
            // Allow grants exactly what was asked for; deny grants nothing.
            let granted: serde_json::Map<String, Value> = match (allow, requested) {
                (true, Value::Object(profile)) => profile
                    .into_iter()
                    .filter(|(_, value)| !value.is_null())
                    .collect(),
                _ => serde_json::Map::new(),
            };
            encode_line(&Response {
                id: approval.id,
                result: PermissionsResponse {
                    permissions: Value::Object(granted),
                    scope: PermissionGrantScope::Turn,
                },
            })
        }
    }
}
