//! Per-session state shared by the session's methods and its reader task.

use std::collections::{HashMap, HashSet, VecDeque};
use std::process::Child;
use std::sync::Arc;
use std::sync::atomic::AtomicBool;

use serde_json::Value;
use tokio::sync::{oneshot, watch};
use uuid::Uuid;

#[cfg(doc)]
use super::reader::advance_cost;
#[cfg(doc)]
use super::{ClaudeCodeSession, SHUTDOWN_GRACE};
#[cfg(doc)]
use crate::agent::adapter::AgentSession;

use super::process::StdinWriter;
use super::wire::ControlResponse;
use crate::agent::adapter::{ExitSummary, PermissionId, SessionKey, TurnId};
use crate::events::EventSink;

// ── Session state ────────────────────────────────────────────────────

/// The SWARM turn a session currently owns, with everything scoped to
/// it. Dropped when the turn settles.
pub(super) struct TurnState {
    pub(super) id: TurnId,
    /// The CLI is executing this turn, as opposed to it still waiting in
    /// the CLI's queue behind work the CLI started itself (module doc,
    /// "Turn ownership"). Only a running turn receives frames.
    pub(super) running: bool,
    /// [`AgentSession::cancel`] already interrupted this turn.
    pub(super) cancelling: bool,
    /// Index of the content block between its `content_block_start` and
    /// `content_block_stop`; the CLI never interleaves top-level blocks,
    /// so one slot stamps the `block_index` on the complete `assistant`
    /// message that arrives in between.
    pub(super) open_block: Option<u32>,
    /// Block kind (`"text"`/`"thinking"`/`"tool_use"`) by index, for the
    /// `kind` of each `agent_turn_delta`.
    pub(super) block_kinds: HashMap<u32, String>,
    /// Input of every tool call seen this turn (subagents' included), so
    /// a denial report can show what was refused.
    pub(super) tool_inputs: HashMap<String, Value>,
    /// Text of every `is_error` tool result, the message of a denial
    /// known only from `result.permission_denials`.
    pub(super) tool_errors: HashMap<String, String>,
    /// Tool-use ids already surfaced as `agent_permission_request`
    /// (pending asks and reports alike): each call is surfaced once.
    pub(super) surfaced: HashSet<String>,
}

impl TurnState {
    pub(super) fn new(id: TurnId, running: bool) -> Self {
        Self {
            id,
            running,
            cancelling: false,
            open_block: None,
            block_kinds: HashMap::new(),
            tool_inputs: HashMap::new(),
            tool_errors: HashMap::new(),
            surfaced: HashSet::new(),
        }
    }

    /// Marks the turn started when a frame names it.
    pub(super) fn claim(&mut self, answers: Option<bool>) {
        if answers == Some(true) {
            self.running = true;
        }
    }
}

/// A `can_use_tool` ask waiting for [`AgentSession::respond_permission`].
pub(super) struct PendingAsk {
    pub(super) turn_id: TurnId,
    pub(super) tool_use_id: String,
    pub(super) input: Value,
}

/// Mutable state shared by [`ClaudeCodeSession`]'s methods and the reader
/// task, behind one `parking_lot::Mutex` that is never held across an
/// `.await` (the trait's concurrency contract).
pub(super) struct Inner {
    /// Whichever of "the turn's `result` arrives" and "teardown runs"
    /// takes this first owns emitting the turn's ONE `agent_turn_settled`.
    pub(super) turn: Option<TurnState>,
    /// Whether the CLI emits `command_lifecycle` frames; `None` until the
    /// first frame that tells.
    pub(super) lifecycle: Option<bool>,
    /// The previous `result`'s running `total_cost_usd` (see
    /// [`advance_cost`]).
    pub(super) cost_baseline: Option<f64>,
    /// Open `can_use_tool` asks by control request id.
    pub(super) asks: HashMap<PermissionId, PendingAsk>,
    /// Host-initiated control requests awaiting their `control_response`.
    pub(super) control_waiters: HashMap<String, oneshot::Sender<ControlResponse>>,
    /// The child. Taken exactly once, by teardown.
    pub(super) child: Option<Child>,
    /// Set by teardown in the same critical section that takes `turn`
    /// and `child`: `send_turn` checks it under the same lock, so no turn
    /// can be accepted once teardown has claimed the session.
    pub(super) closing: bool,
}

/// What waiters watch: the in-flight turn (settled once it changes) and,
/// once teardown has finished, the exit summary.
#[derive(Debug, Clone, Default)]
pub(super) struct Status {
    pub(super) in_flight: Option<TurnId>,
    pub(super) exit: Option<ExitSummary>,
}

/// How teardown stops the child.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Stop {
    /// Close stdin and give an idle CLI [`SHUTDOWN_GRACE`] to exit; kill
    /// a busy one.
    Graceful,
    /// Kill now.
    Kill,
}

/// Everything a [`ClaudeCodeSession`] and its reader task share.
pub(super) struct Shared {
    pub(super) worker_id: Uuid,
    pub(super) sink: EventSink,
    /// Stable for the session's lifetime: the worker id passed as
    /// `--session-id`, or the key passed to `--resume`.
    pub(super) session_key: SessionKey,
    pub(super) state: parking_lot::Mutex<Inner>,
    pub(super) stdin: StdinWriter,
    pub(super) status: watch::Sender<Status>,
    pub(super) teardown_started: AtomicBool,
    /// The child's stderr tail, appended to a synthesized settlement error
    /// when no better cause is known.
    pub(super) stderr_tail: Arc<parking_lot::Mutex<VecDeque<u8>>>,
    /// Why the session is torn down, when SWARM knows it (a framer error).
    pub(super) teardown_cause: parking_lot::Mutex<Option<String>>,
}

impl Shared {
    /// Publishes the in-flight turn. Called with `state` locked, so the
    /// watched value never disagrees with `Inner::turn`.
    pub(super) fn publish_in_flight(&self, turn: Option<&TurnState>) {
        let in_flight = turn.map(|turn| turn.id.clone());
        self.status
            .send_modify(|status| status.in_flight = in_flight);
    }

    /// Resolves once `turn` is no longer in flight (settled, rolled back,
    /// or torn down) or the session has exited.
    pub(super) async fn settled(&self, turn: &str) {
        let mut status = self.status.subscribe();
        // Err only if the sender is gone, and `self` owns it.
        status
            .wait_for(|status| status.exit.is_some() || status.in_flight.as_deref() != Some(turn))
            .await
            .ok();
    }
}
