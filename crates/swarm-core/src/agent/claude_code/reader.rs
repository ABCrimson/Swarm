//! The reader task: maps the child's NDJSON lines onto session state and
//! `SwarmEvent`s until stdout closes, then tears the session down.

use std::sync::Arc;

use serde_json::Value;
use tokio::sync::{Notify, mpsc};

#[cfg(doc)]
use crate::agent::adapter::AgentSession;

use super::state::{PendingAsk, Shared, Stop};
use super::teardown::teardown;
use super::wire::{
    self, Block, CanUseTool, CommandLifecycleLine, ControlRequest, ControlRequestLine, Inbound,
    InitLine, MessageLine, PermissionDeniedLine, ResultLine, StreamEvent, StreamEventLine, System,
};
use super::{
    NO_SWARM_TURN, PERMISSION_DECISION_TIMEOUT, PERMISSION_TIMED_OUT, TURN_CANCELLED,
    TURN_ENDED_WITHOUT_RESULT, UNSUPPORTED_REQUEST,
};
use crate::agent::adapter::{AgentTurnStatus, PermissionDecision, PermissionId, TurnId};
use crate::error::AppError;
use crate::events::{
    AgentBlockPayload, AgentPermissionRequestPayload, AgentToolCallPayload, AgentToolResultPayload,
    AgentTurnDeltaPayload, AgentTurnSettledPayload, SwarmEvent,
};

/// Best-effort classification of a CLI-decided denial into the three
/// shapes captured from `claude` 2.1.232 (the permission fixtures):
///
/// - `"mode"` — `decision_reason_type == "mode"` (the active permission
///   mode blocks it, e.g. `plan`/`dontAsk`).
/// - `"ungranted_write"` — the default mode's refusal of an unapproved
///   write ("but you haven't granted it yet").
/// - `"redirection_guard"` — the static Bash output-redirection guard.
///
/// `None` when the shape matches none of them (a newer CLI's new denial
/// class), reported as unclassified rather than forced into one.
pub(super) fn classify_denial(decision_reason_type: Option<&str>, message: &str) -> Option<String> {
    if decision_reason_type == Some("mode") {
        return Some("mode".to_owned());
    }
    if message.contains("haven't granted it yet") {
        return Some("ungranted_write".to_owned());
    }
    if message.contains("Output redirection") {
        return Some("redirection_guard".to_owned());
    }
    None
}

/// The error text of a settled turn, `None` for a success. A failed turn
/// reads as the provider's own explanation followed by the terminal
/// reason, HTTP status and stop reason it reported, e.g. "There's an
/// issue with the selected model ... (Terminal Reason: api_error, API
/// Status: 404, Stop Reason: stop_sequence)".
pub(super) fn settlement_error(result: &ResultLine, cancelled: bool) -> Option<String> {
    if !result.failed() {
        return None;
    }
    let aborted = matches!(
        result.terminal_reason.as_deref(),
        Some("aborted_streaming" | "aborted_tools")
    );
    if cancelled || aborted {
        return Some(TURN_CANCELLED.to_owned());
    }
    let headline = result
        .failure_text()
        .unwrap_or_else(|| match result.subtype.as_str() {
            "success" => "Claude Code Reported An Error".to_owned(),
            "error_max_turns" => "Max Turns Reached".to_owned(),
            "error_max_budget_usd" => "Budget Exhausted".to_owned(),
            "error_during_execution" => "Error During Execution".to_owned(),
            "error_max_structured_output_retries" => {
                "Structured Output Retries Exhausted".to_owned()
            }
            other => format!("Claude Code Turn Failed ({other})"),
        });
    let details = [
        result
            .terminal_reason
            .as_deref()
            .map(|reason| format!("Terminal Reason: {reason}")),
        result
            .api_error_status
            .map(|status| format!("API Status: {status}")),
        result
            .stop_reason
            .as_deref()
            .map(|reason| format!("Stop Reason: {reason}")),
    ]
    .into_iter()
    .flatten()
    .collect::<Vec<_>>();
    Some(if details.is_empty() {
        headline
    } else {
        format!("{headline} ({})", details.join(", "))
    })
}

/// Turns the CLI's running `total_cost_usd` into one turn's own cost.
///
/// Every `result` carries the session's cumulative total; `baseline` is
/// the total the previous result reported (`Some(0.0)` for a fresh
/// session, `None` when unknown: a resumed session's first total already
/// includes the earlier process's turns). A zeroed total (the CLI writes
/// one for an aborted or crashed turn) says nothing about this turn's
/// cost and leaves the baseline alone; any other drop means the total
/// was reset (`/clear`), so the new total is this turn's cost.
pub(super) fn advance_cost(baseline: &mut Option<f64>, total: Option<f64>) -> Option<f64> {
    let total = total.filter(|total| *total != 0.0)?;
    match *baseline {
        Some(previous) if total >= previous => {
            *baseline = Some(total);
            Some(total - previous)
        }
        Some(_) => {
            *baseline = Some(total);
            Some(total)
        }
        None => {
            *baseline = Some(total);
            None
        }
    }
}

// ── Frame handling (reader task) ─────────────────────────────────────

pub(super) fn handle_line(shared: &Arc<Shared>, line: &str) {
    match serde_json::from_str::<Inbound>(line) {
        Ok(frame) => dispatch(shared, frame),
        Err(error) => recover_unreadable(shared, line, &error),
    }
}

pub(super) fn dispatch(shared: &Arc<Shared>, frame: Inbound) {
    match frame {
        Inbound::System(System::Init(init)) => handle_init(shared, &init),
        Inbound::System(System::PermissionDenied(denied)) => {
            handle_permission_denied(shared, denied);
        }
        Inbound::StreamEvent(event) => handle_stream_event(shared, event),
        Inbound::Assistant(message) => handle_assistant(shared, &message),
        Inbound::User(message) => handle_user(shared, &message),
        Inbound::Result(result) => handle_result(shared, result),
        Inbound::ControlRequest(request) => handle_control_request(shared, request),
        Inbound::ControlResponse(response) => {
            let waiter = shared
                .state
                .lock()
                .control_waiters
                .remove(response.response.request_id());
            if let Some(waiter) = waiter {
                waiter.send(response.response).ok();
            }
        }
        Inbound::ControlCancelRequest(cancel) => {
            shared.state.lock().asks.remove(&cancel.request_id);
        }
        Inbound::CommandLifecycle(lifecycle) => handle_lifecycle(shared, &lifecycle),
        Inbound::System(System::Other) | Inbound::Other => {}
    }
}

/// A line that is JSON but not a frame this module can read. Two kinds
/// still get an answer, because something waits on them: a `result`
/// settles its turn as an error, and a `control_request` is refused so
/// the CLI stops waiting.
pub(super) fn recover_unreadable(shared: &Arc<Shared>, line: &str, error: &serde_json::Error) {
    let value = serde_json::from_str::<Value>(line).unwrap_or_default();
    match value.get("type").and_then(Value::as_str) {
        Some("result") => {
            tracing::warn!(worker_id = %shared.worker_id, %error, "claude code: unreadable result frame; settling as an error");
            let text = |key: &str| value.get(key).and_then(Value::as_str).map(str::to_owned);
            handle_result(
                shared,
                ResultLine {
                    subtype: text("subtype").unwrap_or_default(),
                    is_error: true,
                    errors: vec![format!("Unreadable Result Frame: {error}")],
                    user_message_uuid: text("user_message_uuid"),
                    ..ResultLine::default()
                },
            );
        }
        Some("control_request") => {
            if let Some(request_id) = value.get("request_id").and_then(Value::as_str) {
                shared
                    .stdin
                    .send(wire::control_error(request_id, UNSUPPORTED_REQUEST));
            }
        }
        _ => {
            tracing::warn!(worker_id = %shared.worker_id, %error, "claude code: unreadable ndjson line, skipping");
        }
    }
}

pub(super) fn handle_init(shared: &Arc<Shared>, init: &InitLine) {
    if let Some(session_id) = &init.session_id
        && *session_id != shared.session_key
    {
        tracing::warn!(
            worker_id = %shared.worker_id,
            %session_id,
            session_key = %shared.session_key,
            "claude code: the CLI reports a different session id than the one it was started with"
        );
    }
    let mut inner = shared.state.lock();
    if init.has_message_lifecycle() || inner.lifecycle == Some(true) {
        inner.lifecycle = Some(true);
    } else {
        // No lifecycle frames will come: this init opens the turn SWARM
        // queued.
        inner.lifecycle = Some(false);
        if let Some(turn) = &mut inner.turn {
            turn.running = true;
        }
    }
}

pub(super) fn handle_lifecycle(shared: &Arc<Shared>, lifecycle: &CommandLifecycleLine) {
    let ended = {
        let mut inner = shared.state.lock();
        inner.lifecycle = Some(true);
        let Some(turn) = inner
            .turn
            .as_mut()
            .filter(|turn| turn.id == lifecycle.command_uuid)
        else {
            return;
        };
        match lifecycle.state.as_str() {
            "started" => {
                turn.running = true;
                return;
            }
            // The CLI closed the turn without a `result` for it (a
            // `cancel_queued` interrupt of a turn that never started, for
            // one); after a result, `turn` is already gone.
            "cancelled" => TURN_CANCELLED,
            "completed" => TURN_ENDED_WITHOUT_RESULT,
            _ => return,
        }
    };
    tracing::debug!(worker_id = %shared.worker_id, state = %lifecycle.state, "claude code: turn closed without a result");
    handle_result(
        shared,
        ResultLine {
            subtype: "error_during_execution".to_owned(),
            is_error: true,
            errors: vec![ended.to_owned()],
            user_message_uuid: Some(lifecycle.command_uuid.clone()),
            ..ResultLine::default()
        },
    );
}

pub(super) fn handle_stream_event(shared: &Arc<Shared>, line: StreamEventLine) {
    // A subagent's stream never touches the top-level block state.
    if line.parent_tool_use_id.is_some() {
        return;
    }
    let delta = {
        let mut inner = shared.state.lock();
        let Some(turn) = inner.turn.as_mut() else {
            return;
        };
        turn.claim(line.answers(&turn.id));
        if !turn.running {
            return;
        }
        match line.event {
            StreamEvent::ContentBlockStart {
                index,
                content_block,
            } => {
                turn.block_kinds.insert(index, content_block.kind);
                turn.open_block = Some(index);
                return;
            }
            StreamEvent::ContentBlockStop { index } => {
                if turn.open_block == Some(index) {
                    turn.open_block = None;
                }
                return;
            }
            StreamEvent::ContentBlockDelta { index, delta } => {
                let Some(text) = delta.into_text() else {
                    return;
                };
                AgentTurnDeltaPayload {
                    worker_id: shared.worker_id,
                    turn_id: turn.id.clone(),
                    block_index: index,
                    kind: turn
                        .block_kinds
                        .get(&index)
                        .cloned()
                        .unwrap_or_else(|| "text".to_owned()),
                    text,
                }
            }
            StreamEvent::Other => return,
        }
    };
    shared.sink.emit(SwarmEvent::AgentTurnDelta(delta));
}

pub(super) fn handle_assistant(shared: &Arc<Shared>, message: &MessageLine) {
    let (turn_id, block_index) = {
        let mut inner = shared.state.lock();
        let Some(turn) = inner.turn.as_mut() else {
            return;
        };
        for block in message.blocks() {
            if let Block::ToolUse { id, input, .. } = Block::of(block) {
                turn.tool_inputs.insert(id, input);
            }
        }
        if message.parent_tool_use_id.is_some() {
            return;
        }
        turn.claim(message.answers(&turn.id));
        if !turn.running {
            return;
        }
        (turn.id.clone(), turn.open_block.unwrap_or(0))
    };
    for item in message.blocks() {
        let kind = item
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or("unknown")
            .to_owned();
        shared.sink.emit(SwarmEvent::AgentBlock(AgentBlockPayload {
            worker_id: shared.worker_id,
            turn_id: turn_id.clone(),
            block_index,
            kind,
            content: item.clone(),
        }));
        if let Block::ToolUse { id, name, input } = Block::of(item) {
            shared
                .sink
                .emit(SwarmEvent::AgentToolCall(AgentToolCallPayload {
                    worker_id: shared.worker_id,
                    turn_id: turn_id.clone(),
                    tool_use_id: id,
                    name,
                    input,
                }));
        }
    }
}

pub(super) fn handle_user(shared: &Arc<Shared>, message: &MessageLine) {
    if message.parent_tool_use_id.is_some() {
        return;
    }
    let mut results = Vec::new();
    let turn_id = {
        let mut inner = shared.state.lock();
        let Some(turn) = inner.turn.as_mut().filter(|turn| turn.running) else {
            return;
        };
        for block in message.blocks() {
            if let Block::ToolResult {
                tool_use_id,
                is_error,
                content,
            } = Block::of(block)
            {
                let is_error = is_error.unwrap_or(false);
                if is_error && let Some(text) = wire::tool_result_text(&content) {
                    turn.tool_errors.insert(tool_use_id.clone(), text);
                }
                results.push((tool_use_id, is_error, content));
            }
        }
        turn.id.clone()
    };
    for (tool_use_id, is_error, content) in results {
        shared
            .sink
            .emit(SwarmEvent::AgentToolResult(AgentToolResultPayload {
                worker_id: shared.worker_id,
                turn_id: turn_id.clone(),
                tool_use_id,
                is_error,
                content,
            }));
    }
}

/// A report of a denial the CLI decided on its own.
pub(super) fn denial_report(
    shared: &Shared,
    turn_id: &TurnId,
    tool_use_id: String,
    tool: String,
    input: Value,
    message: Option<String>,
    decision_reason_type: Option<&str>,
) -> SwarmEvent {
    SwarmEvent::AgentPermissionRequest(AgentPermissionRequestPayload {
        worker_id: shared.worker_id,
        turn_id: turn_id.clone(),
        request_id: tool_use_id,
        tool,
        input,
        suggested_decision: Some(PermissionDecision::Deny),
        denial_subclass: message
            .as_deref()
            .and_then(|message| classify_denial(decision_reason_type, message)),
        message,
    })
}

pub(super) fn handle_permission_denied(shared: &Arc<Shared>, denied: PermissionDeniedLine) {
    let report = {
        let mut inner = shared.state.lock();
        let Some(turn) = inner.turn.as_mut().filter(|turn| turn.running) else {
            tracing::debug!(worker_id = %shared.worker_id, tool = %denied.tool_name, "claude code: permission_denied outside a SWARM turn");
            return;
        };
        if denied.tool_use_id.is_empty() || !turn.surfaced.insert(denied.tool_use_id.clone()) {
            return;
        }
        let input = turn
            .tool_inputs
            .get(&denied.tool_use_id)
            .cloned()
            .unwrap_or(Value::Null);
        denial_report(
            shared,
            &turn.id,
            denied.tool_use_id,
            denied.tool_name,
            input,
            denied.message,
            denied.decision_reason_type.as_deref(),
        )
    };
    shared.sink.emit(report);
}

pub(super) fn handle_control_request(shared: &Arc<Shared>, request: ControlRequestLine) {
    match request.request {
        ControlRequest::CanUseTool(ask) => handle_can_use_tool(shared, request.request_id, ask),
        ControlRequest::Other => {
            shared.stdin.send(wire::control_error(
                &request.request_id,
                UNSUPPORTED_REQUEST,
            ));
        }
    }
}

/// Surfaces a `can_use_tool` ask as a pending `agent_permission_request`
/// for [`AgentSession::respond_permission`] to answer. Two kinds are
/// denied at once instead: an ask raised outside a running SWARM turn,
/// and a `requires_user_interaction` ask (the tool's approval card is
/// where the user answers it, so a one-tap Allow would pass its input
/// through unanswered); the latter is still reported, as a denial.
pub(super) fn handle_can_use_tool(shared: &Arc<Shared>, request_id: PermissionId, ask: CanUseTool) {
    let turn_id = {
        let mut guard = shared.state.lock();
        let inner = &mut *guard;
        match inner.turn.as_mut().filter(|turn| turn.running) {
            Some(turn) => {
                turn.surfaced.insert(ask.tool_use_id.clone());
                if !ask.requires_user_interaction {
                    inner.asks.insert(
                        request_id.clone(),
                        PendingAsk {
                            turn_id: turn.id.clone(),
                            tool_use_id: ask.tool_use_id.clone(),
                            input: ask.input.clone(),
                        },
                    );
                }
                Some(turn.id.clone())
            }
            None => None,
        }
    };
    let Some(turn_id) = turn_id else {
        tracing::info!(worker_id = %shared.worker_id, tool = %ask.tool_name, "claude code: denying a permission ask raised outside a SWARM turn");
        shared.stdin.send(wire::permission_deny(
            &request_id,
            &ask.tool_use_id,
            NO_SWARM_TURN,
            false,
        ));
        return;
    };
    if let Some(agent_id) = &ask.agent_id {
        tracing::debug!(worker_id = %shared.worker_id, %agent_id, tool = %ask.tool_name, "claude code: subagent permission ask");
    }
    if ask.requires_user_interaction {
        tracing::info!(worker_id = %shared.worker_id, tool = %ask.tool_name, "claude code: denying an ask that needs the CLI's own dialog");
        shared.stdin.send(wire::permission_deny(
            &request_id,
            &ask.tool_use_id,
            UNSUPPORTED_REQUEST,
            false,
        ));
        // A report, keyed like every report by its tool-use id: nothing
        // is left for `respond_permission` to answer.
        shared.sink.emit(SwarmEvent::AgentPermissionRequest(
            AgentPermissionRequestPayload {
                worker_id: shared.worker_id,
                turn_id,
                request_id: ask.tool_use_id,
                tool: ask.tool_name,
                input: ask.input,
                suggested_decision: Some(PermissionDecision::Deny),
                denial_subclass: None,
                message: Some(UNSUPPORTED_REQUEST.to_owned()),
            },
        ));
        return;
    }
    shared.sink.emit(SwarmEvent::AgentPermissionRequest(
        AgentPermissionRequestPayload {
            worker_id: shared.worker_id,
            turn_id,
            request_id: request_id.clone(),
            message: ask.message(),
            tool: ask.tool_name,
            input: ask.input,
            // Pending: the human decides.
            suggested_decision: None,
            denial_subclass: None,
        },
    ));
    expire_ask(shared, request_id);
}

/// Denies the ask `request_id` if it is still open after
/// [`PERMISSION_DECISION_TIMEOUT`].
pub(super) fn expire_ask(shared: &Arc<Shared>, request_id: PermissionId) {
    let session = Arc::downgrade(shared);
    tokio::spawn(async move {
        tokio::time::sleep(PERMISSION_DECISION_TIMEOUT).await;
        let Some(shared) = session.upgrade() else {
            return;
        };
        let expired = shared.state.lock().asks.remove(&request_id);
        if let Some(ask) = expired {
            tracing::info!(worker_id = %shared.worker_id, %request_id, "claude code: permission ask timed out; denying");
            shared.stdin.send(wire::permission_deny(
                &request_id,
                &ask.tool_use_id,
                PERMISSION_TIMED_OUT,
                false,
            ));
        }
    });
}

pub(super) fn handle_result(shared: &Arc<Shared>, result: ResultLine) {
    let (turn, cost_usd) = {
        let mut inner = shared.state.lock();
        // Every result moves the running total, including results of
        // turns SWARM did not start: the next turn's cost must not
        // include theirs.
        let cost_usd = advance_cost(&mut inner.cost_baseline, result.total_cost_usd);
        let owned = inner
            .turn
            .as_ref()
            .is_some_and(|turn| result.answers(&turn.id).unwrap_or(turn.running));
        if !owned {
            tracing::debug!(worker_id = %shared.worker_id, subtype = %result.subtype, "claude code: result of a turn SWARM did not start");
            return;
        }
        let Some(turn) = inner.turn.take() else {
            return;
        };
        inner.asks.retain(|_, ask| ask.turn_id != turn.id);
        shared.publish_in_flight(None);
        (turn, cost_usd)
    };

    // Denials the CLI decided without a `permission_denied` frame (a
    // path-scoped deny rule, for one) are only in the authoritative list.
    for denial in &result.permission_denials {
        if turn.surfaced.contains(&denial.tool_use_id) {
            continue;
        }
        let message = turn.tool_errors.get(&denial.tool_use_id).cloned();
        shared.sink.emit(denial_report(
            shared,
            &turn.id,
            denial.tool_use_id.clone(),
            denial.tool_name.clone(),
            denial.tool_input.clone(),
            message,
            None,
        ));
    }

    let error = settlement_error(&result, turn.cancelling);
    shared
        .sink
        .emit(SwarmEvent::AgentTurnSettled(AgentTurnSettledPayload {
            worker_id: shared.worker_id,
            turn_id: turn.id,
            status: if error.is_some() {
                AgentTurnStatus::Error
            } else {
                AgentTurnStatus::Ok
            },
            error,
            cost_usd,
            usage: result.usage,
            // Saturating float-to-int cast: an absent or odd duration
            // reads as 0 rather than failing the receipt.
            duration_ms: result.duration_ms as u64,
            num_turns: result.num_turns.and_then(|n| u32::try_from(n).ok()),
        }));
}

/// Maps framed NDJSON lines through [`handle_line`] until stdout closes
/// (the child exited) or [`watch_framer_errors`] raises `drain_signal`,
/// then runs [`teardown`].
///
/// On a framer error the loop first drains every line already buffered
/// in `lines` (non-blocking `try_recv`): valid lines can sit unconsumed
/// behind the failure, and `agent_session_exited` must not persist
/// before the activity that happened while the session was alive. The
/// signal is a `Notify` (whose `notify_one` stores a permit, so an early
/// failure is never lost) rather than a second channel raced in the same
/// `select!`: a closed channel's `recv()` resolves `None` on every poll
/// and could win the race while real lines are still queued.
pub(super) async fn run_reader(
    shared: Arc<Shared>,
    mut lines: mpsc::Receiver<String>,
    drain_signal: Arc<Notify>,
) {
    let mut draining = false;
    loop {
        if draining {
            match lines.try_recv() {
                Ok(line) => {
                    handle_line(&shared, &line);
                    continue;
                }
                // Drained, or the forwarder is gone.
                Err(_) => break,
            }
        }
        tokio::select! {
            line = lines.recv() => match line {
                Some(line) => handle_line(&shared, &line),
                None => break,
            },
            () = drain_signal.notified() => draining = true,
        }
    }
    teardown(&shared, if draining { Stop::Kill } else { Stop::Graceful }).await;
}

/// Watches for an NDJSON framer error ([`AppError::LineTooLong`]) and
/// signals [`run_reader`] to drain and tear down — a line the framer had
/// to discard is a session-level failure (`PipedHandle::framer_errors`'s
/// contract). Never calls [`teardown`] itself; see [`run_reader`].
pub(super) async fn watch_framer_errors(
    shared: Arc<Shared>,
    mut framer_errors: mpsc::UnboundedReceiver<AppError>,
    drain_signal: Arc<Notify>,
) {
    if let Some(error) = framer_errors.recv().await {
        tracing::error!(worker_id = %shared.worker_id, %error, "claude code: ndjson framer error; draining and tearing the session down");
        *shared.teardown_cause.lock() = Some(error.to_string());
        drain_signal.notify_one();
    }
}
