//! Per-session state shared by the session's methods and its reader task.

use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::{Arc, OnceLock};

use serde::Serialize;
use serde_json::Value;
use tokio::sync::{mpsc, oneshot, watch};
use uuid::Uuid;

use super::Timeouts;
use super::process::WriteJob;
use super::protocol::{Notification, Request, RequestId, RpcError, encode_line};

use crate::agent::adapter::{ExitSummary, PermissionId, TurnId};
use crate::error::AppError;
use crate::events::{EventSink, SwarmEvent};

/// Where the session's single turn slot stands.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) enum TurnSlot {
    /// No turn.
    Idle,
    /// `turn/start` sent, not yet acknowledged — no [`TurnId`] exists.
    Starting,
    /// Acknowledged and running.
    Running(TurnId),
}

/// The streams a thread item's text can arrive on — each gets its own
/// `block_index`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub(super) enum BlockStream {
    /// The item's primary text (message text, reasoning summary).
    Main,
    /// A reasoning item's raw content.
    ReasoningContent,
}

/// Per-turn `block_index` bookkeeping: `agent_turn_delta`/`agent_block`
/// need a `u32` index, Codex has item ids. Indexes are assigned in
/// first-streamed order, from zero for every turn.
#[derive(Debug, Default)]
pub(super) struct BlockIndex {
    assigned: HashMap<(String, BlockStream), u32>,
    /// Streams that have emitted at least one delta.
    pub(super) streamed: HashSet<(String, BlockStream)>,
    /// Last reasoning part index seen per stream (parts are joined with a
    /// blank line, as the completed item's parts are).
    pub(super) part: HashMap<(String, BlockStream), i64>,
}

impl BlockIndex {
    pub(super) fn index(&mut self, item_id: &str, stream: BlockStream) -> u32 {
        let next = u32::try_from(self.assigned.len()).unwrap_or(u32::MAX);
        *self
            .assigned
            .entry((item_id.to_string(), stream))
            .or_insert(next)
    }

    pub(super) fn was_streamed(&self, item_id: &str, stream: BlockStream) -> bool {
        self.streamed.contains(&(item_id.to_string(), stream))
    }
}

/// What a pending approval answers, which decides its answer's shape.
#[derive(Debug)]
pub(super) enum ApprovalKind {
    /// `item/commandExecution/requestApproval`.
    Command,
    /// `item/fileChange/requestApproval`. A `grantRoot` in the request is
    /// never granted: Allow answers `accept` (this change only), because
    /// the prompt offers no session-long choice.
    FileChange,
    /// `item/permissions/requestApproval` and the profile it asked for.
    Permissions { requested: Value },
}

/// A server approval request awaiting `respond_permission` on a
/// [`super::CodexSession`].
#[derive(Debug)]
pub(super) struct PendingApproval {
    pub(super) id: RequestId,
    pub(super) kind: ApprovalKind,
}

/// One of this session's requests awaiting its response.
pub(super) struct PendingRequest {
    pub(super) method: &'static str,
    pub(super) reply: oneshot::Sender<Result<Value, RpcError>>,
}

/// Why a request produced no result.
#[derive(Debug)]
pub(super) enum RequestFailure {
    /// The server answered with an error.
    Rejected(RpcError),
    /// Writing the request failed.
    Write(String),
    /// The session closed before the response arrived.
    Closed,
}

impl RequestFailure {
    pub(super) fn into_app_error(self, what: &str) -> AppError {
        match self {
            Self::Rejected(error) => AppError::Ai(format!("codex rejected {what}: {error}")),
            Self::Write(error) => {
                AppError::Ipc(format!("failed to write {what} to codex stdin: {error}"))
            }
            Self::Closed => AppError::Ipc(format!("codex exited before answering {what}")),
        }
    }
}

/// Turn ids that settled, broadcast to [`wait_settled`].
#[derive(Debug, Default)]
pub(super) struct Settled {
    /// The session is torn down: nothing else will settle.
    pub(super) closed: bool,
    /// The most recent settled turn ids, oldest first.
    pub(super) recent: VecDeque<TurnId>,
}

/// Mutable session state. Guarded by a `parking_lot::Mutex` that is never
/// held across an `.await`; events are emitted while holding it, so an
/// event is either emitted before [`super::teardown::teardown`] marks the session closing
/// or not at all.
pub(super) struct Inner {
    pub(super) turn: TurnSlot,
    pub(super) blocks: BlockIndex,
    /// Latest `thread/tokenUsage/updated` payload and its turn.
    pub(super) usage: Option<(TurnId, Value)>,
    /// A non-retrying `error` notification's message and its turn.
    pub(super) turn_error: Option<(TurnId, String)>,
    /// Server approval requests awaiting an answer.
    pub(super) approvals: HashMap<PermissionId, PendingApproval>,
    /// This session's requests awaiting a response.
    pub(super) pending: HashMap<i64, PendingRequest>,
    pub(super) next_request_id: i64,
    /// The stdin writer thread's queue; `None` once closed.
    pub(super) writer: Option<mpsc::UnboundedSender<WriteJob>>,
    /// The child; taken by [`super::teardown::teardown`].
    pub(super) child: Option<std::process::Child>,
    /// `agent_session_started` was emitted — only then does teardown emit
    /// the settlement and `agent_session_exited`.
    pub(super) announced: bool,
    /// Teardown has begun: no further events, requests or answers.
    pub(super) closing: bool,
    /// Teardown's result, returned by every later call.
    pub(super) exit: Option<ExitSummary>,
}

impl Inner {
    /// Queues `line` for stdin; `false` once the writer is gone.
    pub(super) fn enqueue(
        &self,
        line: String,
        done: Option<oneshot::Sender<Result<(), String>>>,
    ) -> bool {
        self.writer
            .as_ref()
            .is_some_and(|writer| writer.send(WriteJob { line, done }).is_ok())
    }
}

/// Everything a [`super::CodexSession`] and its reader task share.
pub(super) struct Shared {
    pub(super) worker_id: Uuid,
    pub(super) sink: EventSink,
    pub(super) timeouts: Timeouts,
    /// The thread id, set once the handshake has opened the thread.
    pub(super) thread_id: OnceLock<String>,
    pub(super) state: parking_lot::Mutex<Inner>,
    pub(super) settled: watch::Sender<Settled>,
    /// Serializes [`super::teardown::teardown`] across callers.
    pub(super) teardown_gate: tokio::sync::Mutex<()>,
    pub(super) stderr_tail: Arc<parking_lot::Mutex<VecDeque<u8>>>,
    /// Why the session is torn down, when SWARM knows it (a framer error).
    pub(super) teardown_cause: parking_lot::Mutex<Option<String>>,
}

impl Shared {
    pub(super) fn thread_id(&self) -> &str {
        self.thread_id.get().map_or("", String::as_str)
    }

    /// Whether a notification about `thread_id` belongs to this session
    /// (sub-agent threads on the same connection do not).
    pub(super) fn is_own_thread(&self, thread_id: &str) -> bool {
        self.thread_id.get().is_some_and(|own| own == thread_id)
    }

    pub(super) fn is_running(&self, turn_id: &str) -> bool {
        matches!(&self.state.lock().turn, TurnSlot::Running(id) if id == turn_id)
    }

    pub(super) fn was_settled(&self, turn_id: &str) -> bool {
        self.settled
            .borrow()
            .recent
            .iter()
            .any(|settled| settled == turn_id)
    }

    /// Sends a request and waits for its response.
    pub(super) async fn request<P: Serialize>(
        &self,
        method: &'static str,
        params: P,
    ) -> Result<Value, RequestFailure> {
        let (reply, response) = oneshot::channel();
        let (done, written) = oneshot::channel();
        let id = {
            let mut inner = self.state.lock();
            if inner.closing {
                return Err(RequestFailure::Closed);
            }
            let id = inner.next_request_id;
            inner.next_request_id += 1;
            let line =
                encode_line(&Request { id, method, params }).map_err(RequestFailure::Write)?;
            inner.pending.insert(id, PendingRequest { method, reply });
            if !inner.enqueue(line, Some(done)) {
                inner.pending.remove(&id);
                return Err(RequestFailure::Closed);
            }
            id
        };
        let write_failure = match written.await {
            Ok(Ok(())) => None,
            Ok(Err(error)) => Some(RequestFailure::Write(error)),
            Err(_) => Some(RequestFailure::Closed),
        };
        if let Some(failure) = write_failure {
            self.state.lock().pending.remove(&id);
            return Err(failure);
        }
        match response.await {
            Ok(Ok(result)) => Ok(result),
            Ok(Err(error)) => Err(RequestFailure::Rejected(error)),
            Err(_) => Err(RequestFailure::Closed),
        }
    }

    /// Queues a notification without waiting for the write.
    pub(super) fn notify(&self, method: &'static str) {
        match encode_line(&Notification { method }) {
            Ok(line) => {
                self.state.lock().enqueue(line, None);
            }
            Err(error) => {
                tracing::error!(method, %error, "codex adapter: encoding a notification failed")
            }
        }
    }

    /// Puts the turn slot back to idle after an unacknowledged
    /// `turn/start` failed.
    pub(super) fn release_start(&self) {
        let mut inner = self.state.lock();
        if inner.turn == TurnSlot::Starting {
            inner.turn = TurnSlot::Idle;
        }
    }

    pub(super) fn emit(&self, event: SwarmEvent) {
        self.sink.emit(event);
    }
}

/// Resolves once `turn_id` has settled or the session has closed.
pub(super) async fn wait_settled(shared: &Shared, turn_id: &str) {
    let mut settled = shared.settled.subscribe();
    // The sender lives in `shared`, so this cannot see a closed channel.
    let _ = settled
        .wait_for(|state| state.closed || state.recent.iter().any(|id| id == turn_id))
        .await;
}
