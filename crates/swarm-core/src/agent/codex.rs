//! `CodexAdapter` — drives `codex app-server`, OpenAI Codex's stateful,
//! bidirectional JSON-RPC protocol, over piped stdio
//! ([`crate::worker::proc::spawn_piped`]).
//!
//! Verified against codex-cli 0.156.1: the wire types in `protocol` are
//! transcribed from the schema that release generates
//! (`codex app-server generate-json-schema` / `generate-ts`), and the
//! handshake, thread-open, resume, interrupt and stdin-EOF behavior below
//! was checked against a live 0.156.1 server (no model turns). Turn and
//! item notifications come from the generated schema; the fixtures under
//! `tests/fixtures/codex/` follow it.
//!
//! ## Session lifecycle
//!
//! 1. **Handshake.** `initialize` (client info + capabilities) must be the
//!    connection's first request — the server answers anything else with
//!    `-32600 Not initialized` — followed by the `initialized`
//!    notification.
//! 2. **Thread.** `thread/start` (or `thread/resume` for
//!    [`AgentSpawnSpec::resume`]) with `cwd`, the trust tier's
//!    `approvalPolicy` and `sandbox`, and `model` only when one was asked
//!    for. The response reports the policy the server actually applied;
//!    anything more permissive than requested refuses the session (see
//!    `verify_effective_policy`). The thread id is the [`SessionKey`].
//!    Codex persists a thread only once it ran a turn: resuming a thread
//!    that never did fails with the server's `no rollout found` error.
//! 3. **Turns.** `turn/start {threadId, input}` is acknowledged with the
//!    turn (its id is the [`TurnId`]); items stream as
//!    `item/started` / deltas / `item/completed`; `turn/completed` carries
//!    the terminal `status` (`completed` settles `ok`; `failed` and
//!    `interrupted` settle `error` with the turn's error message).
//! 4. **Approvals.** The server asks through its own requests
//!    (`item/commandExecution/requestApproval`,
//!    `item/fileChange/requestApproval`,
//!    `item/permissions/requestApproval`), each surfaced as a pending
//!    `agent_permission_request` and answered by
//!    [`CodexSession::respond_permission`]. Every other server request is
//!    answered with JSON-RPC `-32601` — a request is never left unanswered,
//!    because the server blocks the turn until it gets a reply.
//! 5. **Cancel** sends `turn/interrupt`; the turn settles `interrupted`
//!    and the thread stays open for the next turn. A refusal
//!    (`no active turn to interrupt`) races a turn finishing on its own,
//!    so the turn still gets time to settle; only a turn that never
//!    settles, or an unanswered interrupt, shuts the session down.
//! 6. **Shutdown** closes stdin, which app-server treats as a request to
//!    exit; the child is killed only if it has not exited within a grace
//!    period.
//!
//! ## Condition B
//!
//! Exactly one `agent_turn_settled` per turn that was ever acknowledged
//! with a [`TurnId`]: from `turn/completed`, or synthesized by
//! `teardown` when the process ends first. A turn whose `turn/start`
//! was never acknowledged has no id to settle — its
//! [`CodexSession::send_turn`] fails instead, so the caller is never left
//! waiting. Once teardown began, nothing but teardown's own settlement and
//! `agent_session_exited` is emitted for the session — lines the child
//! still writes are dropped — so no event ever follows the exit.
//!
//! ## `never` and `danger-full-access` are unconstructible
//!
//! Codex's `approvalPolicy: "never"` (full auto) and
//! `sandbox: "danger-full-access"` are this provider's equivalent of
//! Claude Code's `bypassPermissions`. `protocol::AskForApproval` and
//! `protocol::SandboxMode` have no variants for them, so no code path
//! can put them on the wire, and `parse_trust_tier` fails closed on
//! every token outside SWARM's three tiers.

mod protocol;
#[cfg(test)]
mod tests;

use std::collections::{HashMap, HashSet, VecDeque};
use std::io::Write;
use std::mem::DropGuard;
use std::process::Stdio;
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::sync::{mpsc, oneshot, watch};
use uuid::Uuid;

use self::protocol::{
    ApprovalDecision, ApprovalRequest, ApprovalResponse, AskForApproval, ClientInfo,
    DeltaNotification, ErrorNotification, ErrorObject, ErrorResponse, INVALID_PARAMS, Incoming,
    InitializeCapabilities, InitializeParams, InitializeResponse, Item, ItemNotification,
    METHOD_NOT_FOUND, Notification, OPTED_OUT_NOTIFICATIONS, PermissionGrantScope,
    PermissionsResponse, Request, RequestId, Response, RpcError, SandboxMode,
    ServerRequestResolved, ThreadOpened, ThreadResumeParams, ThreadStartParams,
    TokenUsageNotification, Turn, TurnInterruptParams, TurnNotification, TurnStartParams,
    TurnStartResponse, TurnStatus, UserInput, VERIFIED_CODEX_VERSION, method,
};
use crate::agent::adapter::{
    AgentAdapter, AgentSession, AgentSpawnSpec, AgentTurnStatus, BoxFuture, CancelGranularity,
    Capabilities, ExitSummary, PermissionDecision, PermissionId, ProbeReport, ProviderId,
    SessionKey, TurnId, TurnInput,
};
use crate::agent::stderr_snippet;
use crate::error::AppError;
use crate::events::{
    AgentBlockPayload, AgentPermissionRequestPayload, AgentSessionExitedPayload,
    AgentSessionStartedPayload, AgentToolCallPayload, AgentToolResultPayload,
    AgentTurnDeltaPayload, AgentTurnSettledPayload, EventSink, Provenance, SwarmEvent,
};
use crate::worker::proc::{PipedHandle, spawn_piped, write_to_piped};

/// `initialize.clientInfo.name` — becomes part of the server's user agent.
const CLIENT_NAME: &str = "swarm";
/// `initialize.clientInfo.title`.
const CLIENT_TITLE: &str = "Swarm Orchestrator";

/// Synthesized-settlement error text (Condition B), shared verbatim with
/// `ClaudeCodeAdapter`.
const PROCESS_EXITED_WITHOUT_RECEIPT: &str = "Process Exited Without A Receipt";
/// Settlement error for an interrupted turn that carries no message.
const TURN_INTERRUPTED: &str = "Turn Interrupted";
/// Settlement error for a failed turn that carries no message.
const TURN_FAILED: &str = "Codex Reported A Failed Turn";

/// How many settled turn ids [`CodexSession::await_turn_completion`] can
/// still recognize after later turns settled.
const RECENTLY_SETTLED: usize = 16;

/// Model names that belong to Claude, not Codex. A Codex thread accepts
/// any model string at `thread/start` and only fails at the first turn,
/// so these are never forwarded (see [`requested_model`]).
const CLAUDE_MODEL_ALIASES: [&str; 5] = ["sonnet", "opus", "haiku", "fable", "mythos"];

/// `CREATE_NO_WINDOW`: keeps the probe's console subprocesses from
/// flashing a window from the GUI app.
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Every bound this adapter puts on waiting for the child — no wait is
/// unbounded.
#[derive(Debug, Clone, Copy)]
struct Timeouts {
    /// `initialize` + `thread/start` (or `thread/resume`).
    handshake: Duration,
    /// `turn/start` acknowledgement.
    turn_ack: Duration,
    /// Any other request or answer (`turn/interrupt`, approval answers).
    request: Duration,
    /// How long an accepted `turn/interrupt` may take to settle the turn
    /// before the session is shut down instead.
    interrupt_settle: Duration,
    /// How long the child gets to exit after its stdin closes before it
    /// is killed.
    graceful_exit: Duration,
    /// Each [`CodexAdapter::probe`] subprocess.
    probe: Duration,
}

impl Timeouts {
    const PRODUCTION: Self = Self {
        handshake: Duration::from_secs(30),
        turn_ack: Duration::from_secs(30),
        request: Duration::from_secs(10),
        interrupt_settle: Duration::from_secs(10),
        graceful_exit: Duration::from_secs(3),
        probe: Duration::from_secs(5),
    };
}

// ── Trust tiers ──────────────────────────────────────────────────────

/// SWARM's spawn-time trust dial for Codex — the same three wire tokens
/// as [`crate::agent::claude_code::ClaudeCodeTrustTier`], mapped onto
/// Codex's `approvalPolicy` + `sandbox` (see `policy`).
/// [`AgentSpawnSpec::permission_mode`] is parsed by `parse_trust_tier`,
/// which accepts only these tokens.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CodexTrustTier {
    /// Read-only: `untrusted` approvals + `read-only` sandbox.
    Restricted,
    /// Workspace writes, every non-trusted command asked about:
    /// `untrusted` approvals + `workspace-write` sandbox.
    Standard,
    /// Workspace writes, the model decides when to ask: `on-request`
    /// approvals + `workspace-write` sandbox.
    WriteEnabled,
}

impl CodexTrustTier {
    /// The tier's `approvalPolicy` and `sandbox`.
    fn policy(self) -> (AskForApproval, SandboxMode) {
        match self {
            Self::Restricted => (AskForApproval::Untrusted, SandboxMode::ReadOnly),
            Self::Standard => (AskForApproval::Untrusted, SandboxMode::WorkspaceWrite),
            Self::WriteEnabled => (AskForApproval::OnRequest, SandboxMode::WorkspaceWrite),
        }
    }
}

/// Parses [`AgentSpawnSpec::permission_mode`]: `None` is
/// [`CodexTrustTier::Standard`]; anything outside the three tokens —
/// including Codex's own `"never"` — is refused rather than guessed at.
fn parse_trust_tier(raw: Option<&str>) -> Result<CodexTrustTier, AppError> {
    match raw {
        None | Some("standard") => Ok(CodexTrustTier::Standard),
        Some("restricted") => Ok(CodexTrustTier::Restricted),
        Some("write_enabled") => Ok(CodexTrustTier::WriteEnabled),
        Some(other) => Err(AppError::PermissionDenied(format!(
            "unrecognized codex trust tier {other:?} — refusing to spawn rather than guess an \
             approval policy"
        ))),
    }
}

/// The model to request. `None`, a blank string and a Claude model name
/// (a provider-agnostic spawn form may carry one over) all omit `model`,
/// so Codex uses its configured default; `agent_session_started` then
/// reports the model the thread actually runs.
fn requested_model(model: Option<&str>) -> Option<&str> {
    let model = model.map(str::trim).filter(|m| !m.is_empty())?;
    let lower = model.to_ascii_lowercase();
    if CLAUDE_MODEL_ALIASES.contains(&lower.as_str()) || lower.starts_with("claude") {
        tracing::warn!(
            model,
            "codex adapter: ignoring a Claude model name, using Codex's default model"
        );
        return None;
    }
    Some(model)
}

/// Refuses a thread whose applied policy is more permissive than the one
/// requested. The server reports what it actually applied; a stricter
/// result (for example a managed configuration forcing `readOnly`) is
/// fine, a looser one — `dangerFullAccess`, `externalSandbox`, `never`,
/// a granular policy — is not. This is what catches a request field the
/// server silently ignored.
fn verify_effective_policy(
    opened: &ThreadOpened,
    approval: AskForApproval,
    sandbox: SandboxMode,
) -> Result<(), AppError> {
    let effective_sandbox = opened.sandbox.kind.as_str();
    let sandbox_ok = match sandbox {
        SandboxMode::ReadOnly => effective_sandbox == "readOnly",
        SandboxMode::WorkspaceWrite => matches!(effective_sandbox, "readOnly" | "workspaceWrite"),
    };
    let effective_approval = opened.approval_policy.as_str();
    let approval_ok = match approval {
        AskForApproval::Untrusted => effective_approval == Some("untrusted"),
        AskForApproval::OnRequest => matches!(effective_approval, Some("untrusted" | "on-request")),
    };
    if sandbox_ok && approval_ok {
        return Ok(());
    }
    Err(AppError::PermissionDenied(format!(
        "codex opened the thread with sandbox {effective_sandbox:?} and approval policy {} \
         instead of the requested {:?} / {:?} — refusing to run it",
        opened.approval_policy,
        sandbox.effective_type(),
        approval.as_str(),
    )))
}

/// What this adapter can honestly promise.
fn codex_capabilities() -> Capabilities {
    Capabilities {
        // item/agentMessage/delta and the reasoning deltas.
        partial_deltas: true,
        // thread/resume.
        resume: true,
        // Token usage arrives as thread/tokenUsage/updated and rides the turn's
        // settlement; Codex never reports a dollar figure.
        native_cost: false,
        permission_modes: vec![
            "restricted".to_string(),
            "standard".to_string(),
            "write_enabled".to_string(),
        ],
        // turn/interrupt stops the turn and keeps the thread.
        cancel_granularity: CancelGranularity::Graceful,
        // A message sent while a turn runs is queued by the scheduler for
        // the next turn; nothing is injected into the running one.
        interrupt_midturn: false,
        // `cwd` is a thread/start parameter.
        worktree_aware: true,
        // Approvals are server requests answered on the wire.
        interactive_permissions: true,
    }
}

// ── Program resolution ───────────────────────────────────────────────

/// Resolves a bare program name the way a Windows shell would: the first
/// `PATH` directory holding `program` + a `PATHEXT` extension. Rust's
/// `Command` only appends `.exe`, but an npm install of Codex puts
/// `codex.cmd` on `PATH`. Names with an extension or a directory are left
/// alone (`None`), and the current directory is never searched.
#[cfg(any(windows, test))]
fn resolve_with_pathext(
    program: &str,
    path: Option<&std::ffi::OsStr>,
    pathext: Option<&str>,
) -> Option<std::path::PathBuf> {
    let bare = std::path::Path::new(program);
    if bare.extension().is_some() || bare.components().count() != 1 {
        return None;
    }
    let extensions: Vec<&str> = pathext
        .filter(|value| !value.trim().is_empty())
        .unwrap_or(".COM;.EXE;.BAT;.CMD")
        .split(';')
        .map(str::trim)
        .filter(|ext| !ext.is_empty())
        .collect();
    std::env::split_paths(path?).find_map(|dir| {
        extensions
            .iter()
            .map(|ext| dir.join(format!("{program}{ext}")))
            .find(|candidate| candidate.is_file())
    })
}

/// The program to run for `binary` — see [`resolve_with_pathext`]. The
/// `PATH` scan touches the file system, so it runs on the blocking pool.
#[cfg(windows)]
async fn resolve_program(binary: String) -> String {
    let fallback = binary.clone();
    tokio::task::spawn_blocking(move || {
        resolve_with_pathext(
            &binary,
            std::env::var_os("PATH").as_deref(),
            std::env::var("PATHEXT").ok().as_deref(),
        )
        .map_or(binary, |path| path.to_string_lossy().into_owned())
    })
    .await
    .unwrap_or(fallback)
}

/// The program to run for `binary`: outside Windows, `Command`'s own
/// `PATH` search already finds it.
#[cfg(not(windows))]
async fn resolve_program(binary: String) -> String {
    binary
}

// ── Child I/O ────────────────────────────────────────────────────────

/// One line for the child's stdin. `done`, when present, receives the
/// write's outcome.
struct WriteJob {
    line: String,
    done: Option<oneshot::Sender<Result<(), String>>>,
}

/// Moves the child's blocking stdin onto a dedicated thread fed by a
/// channel, so no async task ever blocks on a pipe write (a full pipe
/// blocks until the child reads). Lines are written in queue order. The
/// thread ends when the channel closes or a write fails; dropping the
/// writer then closes the pipe, which app-server treats as a request to
/// exit.
fn start_stdin_writer(
    worker_id: Uuid,
    mut stdin: Box<dyn Write + Send>,
) -> std::io::Result<mpsc::UnboundedSender<WriteJob>> {
    let (jobs, mut queue) = mpsc::unbounded_channel::<WriteJob>();
    std::thread::Builder::new()
        .name("codex-stdin".to_string())
        .spawn(move || {
            while let Some(WriteJob { line, done }) = queue.blocking_recv() {
                let outcome =
                    write_to_piped(stdin.as_mut(), line.as_bytes()).map_err(|e| format!("{e:#}"));
                let failed = outcome.is_err();
                match done {
                    Some(done) => {
                        // The requester may have given up waiting.
                        let _ = done.send(outcome);
                    }
                    None => {
                        if let Err(error) = &outcome {
                            tracing::warn!(%worker_id, %error, "codex adapter: stdin write failed");
                        }
                    }
                }
                if failed {
                    break;
                }
            }
        })?;
    Ok(jobs)
}

/// Serializes `message` as one newline-terminated JSON line.
fn encode_line(message: &impl Serialize) -> Result<String, String> {
    let mut line = serde_json::to_string(message).map_err(|e| e.to_string())?;
    line.push('\n');
    Ok(line)
}

/// Waits up to `grace` for `child` to exit on its own (its stdin is
/// already closed), then kills it; reaps it either way. Blocking — run it
/// on the blocking pool.
fn reap(mut child: std::process::Child, grace: Duration) -> Option<std::process::ExitStatus> {
    let deadline = Instant::now() + grace;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return Some(status),
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(20)),
            Ok(None) => break,
            Err(error) => {
                tracing::warn!(%error, "codex adapter: polling the child's exit failed");
                break;
            }
        }
    }
    if let Err(error) = child.kill() {
        tracing::debug!(%error, "codex adapter: kill failed (the child may have just exited)");
    }
    child
        .wait()
        .inspect_err(|error| tracing::warn!(%error, "codex adapter: reaping the child failed"))
        .ok()
}

/// The terminating signal's name, on Unix.
#[cfg(unix)]
fn signal_name(status: &std::process::ExitStatus) -> Option<String> {
    use std::os::unix::process::ExitStatusExt;
    /// Signals whose numbers agree across Linux and macOS.
    const NAMES: [(i32, &str); 9] = [
        (1, "SIGHUP"),
        (2, "SIGINT"),
        (3, "SIGQUIT"),
        (6, "SIGABRT"),
        (9, "SIGKILL"),
        (11, "SIGSEGV"),
        (13, "SIGPIPE"),
        (14, "SIGALRM"),
        (15, "SIGTERM"),
    ];
    status.signal().map(|signal| {
        NAMES
            .iter()
            .find(|(number, _)| *number == signal)
            .map_or_else(
                || format!("signal {signal}"),
                |(_, name)| (*name).to_string(),
            )
    })
}

/// Windows has no signals: a killed process has only an exit code.
#[cfg(not(unix))]
fn signal_name(_status: &std::process::ExitStatus) -> Option<String> {
    None
}

// ── Session state ────────────────────────────────────────────────────

/// Where the session's single turn slot stands.
#[derive(Debug, Clone, PartialEq, Eq)]
enum TurnSlot {
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
enum BlockStream {
    /// The item's primary text (message text, reasoning summary).
    Main,
    /// A reasoning item's raw content.
    ReasoningContent,
}

/// Per-turn `block_index` bookkeeping: `agent_turn_delta`/`agent_block`
/// need a `u32` index, Codex has item ids. Indexes are assigned in
/// first-streamed order, from zero for every turn.
#[derive(Debug, Default)]
struct BlockIndex {
    assigned: HashMap<(String, BlockStream), u32>,
    /// Streams that have emitted at least one delta.
    streamed: HashSet<(String, BlockStream)>,
    /// Last reasoning part index seen per stream (parts are joined with a
    /// blank line, as the completed item's parts are).
    part: HashMap<(String, BlockStream), i64>,
}

impl BlockIndex {
    fn index(&mut self, item_id: &str, stream: BlockStream) -> u32 {
        let next = u32::try_from(self.assigned.len()).unwrap_or(u32::MAX);
        *self
            .assigned
            .entry((item_id.to_string(), stream))
            .or_insert(next)
    }

    fn was_streamed(&self, item_id: &str, stream: BlockStream) -> bool {
        self.streamed.contains(&(item_id.to_string(), stream))
    }
}

/// What a pending approval answers, which decides its answer's shape.
#[derive(Debug)]
enum ApprovalKind {
    /// `item/commandExecution/requestApproval`.
    Command,
    /// `item/fileChange/requestApproval`. A `grantRoot` in the request is
    /// never granted: Allow answers `accept` (this change only), because
    /// the prompt offers no session-long choice.
    FileChange,
    /// `item/permissions/requestApproval` and the profile it asked for.
    Permissions { requested: Value },
}

/// A server approval request awaiting [`CodexSession::respond_permission`].
#[derive(Debug)]
struct PendingApproval {
    id: RequestId,
    kind: ApprovalKind,
}

/// One of this session's requests awaiting its response.
struct PendingRequest {
    method: &'static str,
    reply: oneshot::Sender<Result<Value, RpcError>>,
}

/// Why a request produced no result.
#[derive(Debug)]
enum RequestFailure {
    /// The server answered with an error.
    Rejected(RpcError),
    /// Writing the request failed.
    Write(String),
    /// The session closed before the response arrived.
    Closed,
}

impl RequestFailure {
    fn into_app_error(self, what: &str) -> AppError {
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
struct Settled {
    /// The session is torn down: nothing else will settle.
    closed: bool,
    /// The most recent settled turn ids, oldest first.
    recent: VecDeque<TurnId>,
}

/// Mutable session state. Guarded by a `parking_lot::Mutex` that is never
/// held across an `.await`; events are emitted while holding it, so an
/// event is either emitted before [`teardown`] marks the session closing
/// or not at all.
struct Inner {
    turn: TurnSlot,
    blocks: BlockIndex,
    /// Latest `thread/tokenUsage/updated` payload and its turn.
    usage: Option<(TurnId, Value)>,
    /// A non-retrying `error` notification's message and its turn.
    turn_error: Option<(TurnId, String)>,
    /// Server approval requests awaiting an answer.
    approvals: HashMap<PermissionId, PendingApproval>,
    /// This session's requests awaiting a response.
    pending: HashMap<i64, PendingRequest>,
    next_request_id: i64,
    /// The stdin writer thread's queue; `None` once closed.
    writer: Option<mpsc::UnboundedSender<WriteJob>>,
    /// The child; taken by [`teardown`].
    child: Option<std::process::Child>,
    /// `agent_session_started` was emitted — only then does teardown emit
    /// the settlement and `agent_session_exited`.
    announced: bool,
    /// Teardown has begun: no further events, requests or answers.
    closing: bool,
    /// Teardown's result, returned by every later call.
    exit: Option<ExitSummary>,
}

impl Inner {
    /// Queues `line` for stdin; `false` once the writer is gone.
    fn enqueue(&self, line: String, done: Option<oneshot::Sender<Result<(), String>>>) -> bool {
        self.writer
            .as_ref()
            .is_some_and(|writer| writer.send(WriteJob { line, done }).is_ok())
    }
}

/// Everything a [`CodexSession`] and its reader task share.
struct Shared {
    worker_id: Uuid,
    sink: EventSink,
    timeouts: Timeouts,
    /// The thread id, set once the handshake has opened the thread.
    thread_id: OnceLock<String>,
    state: parking_lot::Mutex<Inner>,
    settled: watch::Sender<Settled>,
    /// Serializes [`teardown`] across callers.
    teardown_gate: tokio::sync::Mutex<()>,
    stderr_tail: Arc<parking_lot::Mutex<VecDeque<u8>>>,
}

impl Shared {
    fn thread_id(&self) -> &str {
        self.thread_id.get().map_or("", String::as_str)
    }

    /// Whether a notification about `thread_id` belongs to this session
    /// (sub-agent threads on the same connection do not).
    fn is_own_thread(&self, thread_id: &str) -> bool {
        self.thread_id.get().is_some_and(|own| own == thread_id)
    }

    fn is_running(&self, turn_id: &str) -> bool {
        matches!(&self.state.lock().turn, TurnSlot::Running(id) if id == turn_id)
    }

    fn was_settled(&self, turn_id: &str) -> bool {
        self.settled
            .borrow()
            .recent
            .iter()
            .any(|settled| settled == turn_id)
    }

    /// Sends a request and waits for its response.
    async fn request<P: Serialize>(
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
    fn notify(&self, method: &'static str) {
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
    fn release_start(&self) {
        let mut inner = self.state.lock();
        if inner.turn == TurnSlot::Starting {
            inner.turn = TurnSlot::Idle;
        }
    }

    fn emit(&self, event: SwarmEvent) {
        self.sink.emit(event);
    }
}

/// Resolves once `turn_id` has settled or the session has closed.
async fn wait_settled(shared: &Shared, turn_id: &str) {
    let mut settled = shared.settled.subscribe();
    // The sender lives in `shared`, so this cannot see a closed channel.
    let _ = settled
        .wait_for(|state| state.closed || state.recent.iter().any(|id| id == turn_id))
        .await;
}

/// Tears the session down exactly once; every later call returns the
/// first call's [`ExitSummary`].
///
/// Under the state lock it marks the session closing (from then on no
/// event, request or answer is produced), claims a running turn, drops
/// every pending request's reply channel (their callers resolve as
/// closed) and forgets pending approvals. It then closes stdin, gives the
/// child [`Timeouts::graceful_exit`] to exit, kills and reaps it on the
/// blocking pool, and — only for a session whose start was announced —
/// synthesizes the running turn's settlement (Condition B) and emits
/// `agent_session_exited`.
async fn teardown(shared: &Arc<Shared>) -> ExitSummary {
    let _gate = shared.teardown_gate.lock().await;

    let (running, child, writer, announced) = {
        let mut inner = shared.state.lock();
        if let Some(exit) = &inner.exit {
            return exit.clone();
        }
        inner.closing = true;
        let running = match std::mem::replace(&mut inner.turn, TurnSlot::Idle) {
            TurnSlot::Running(turn_id) => Some(turn_id),
            TurnSlot::Idle | TurnSlot::Starting => None,
        };
        inner.pending.clear();
        inner.approvals.clear();
        (
            running,
            inner.child.take(),
            inner.writer.take(),
            inner.announced,
        )
    };

    // Closing the writer's queue ends its thread, which drops stdin.
    drop(writer);
    let status = match child {
        Some(child) => {
            let grace = shared.timeouts.graceful_exit;
            tokio::task::spawn_blocking(move || reap(child, grace))
                .await
                .ok()
                .flatten()
        }
        None => None,
    };
    let exit = ExitSummary {
        exit_code: status.and_then(|status| status.code()),
        signal: status.as_ref().and_then(signal_name),
    };

    if announced {
        if let Some(turn_id) = &running {
            shared.emit(SwarmEvent::AgentTurnSettled(AgentTurnSettledPayload {
                worker_id: shared.worker_id,
                turn_id: turn_id.clone(),
                status: AgentTurnStatus::Error,
                error: Some(PROCESS_EXITED_WITHOUT_RECEIPT.to_string()),
                cost_usd: None,
                usage: None,
                duration_ms: 0,
                num_turns: None,
            }));
        }
        let persisted = shared.sink.emit_awaiting_seq(
            SwarmEvent::AgentSessionExited(AgentSessionExitedPayload {
                worker_id: shared.worker_id,
                exit_code: exit.exit_code,
                signal: exit.signal.clone(),
            }),
            Provenance::default(),
        );
        // A dropped acknowledgement means the event writer is gone or the event
        // could not be saved (it fails closed); either way there is nothing to
        // wait for.
        let _ = persisted.await;
    }

    shared.state.lock().exit = Some(exit.clone());
    shared.settled.send_modify(|settled| {
        settled.recent.extend(running);
        settled.closed = true;
    });
    exit
}

// ── Reader: classify and map every line ──────────────────────────────

/// Drains the child's framed stdout for the session's lifetime, then runs
/// [`teardown`]. A framer error (an over-long line) is a session-level
/// failure: lines already framed are still mapped first, so the event
/// log never records the exit before activity that preceded it. The
/// `biased` select keeps a framer error from overtaking queued lines.
async fn run_reader(
    shared: Arc<Shared>,
    mut lines: mpsc::Receiver<String>,
    mut framer_errors: mpsc::UnboundedReceiver<AppError>,
) {
    // A panic while mapping a line must still tear the session down
    // (Condition B, the child's reaping), so teardown is armed as a drop
    // guard and disarmed on the normal path.
    let teardown_on_unwind = DropGuard::new(Arc::clone(&shared), |shared| {
        if let Ok(runtime) = tokio::runtime::Handle::try_current() {
            runtime.spawn(async move {
                teardown(&shared).await;
            });
        }
    });

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
        method::TURN_COMPLETED => {
            if let Some(TurnNotification { thread_id, turn }) = parse(method, params)
                && shared.is_own_thread(&thread_id)
            {
                settle(shared, turn);
            }
        }
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

    let reported = turn.error.as_ref().map(protocol::TurnError::describe);
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
fn permission_id(id: &RequestId) -> PermissionId {
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
fn approval_answer(
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

// ── AgentAdapter / AgentSession ──────────────────────────────────────

/// The `codex` CLI adapter: one instance drives every Codex worker, each
/// [`CodexSession`] it spawns owns one `codex app-server` child.
pub struct CodexAdapter {
    sink: EventSink,
    binary: String,
    /// Arguments before the subcommand — empty in production; tests run a
    /// fake server through `node <script> ...`.
    extra_prefix_args: Vec<String>,
    timeouts: Timeouts,
}

impl CodexAdapter {
    /// Drives the `codex` binary found on `PATH` (on Windows including the
    /// `codex.cmd` shim an npm install creates).
    pub fn new(sink: EventSink) -> Self {
        Self {
            sink,
            binary: "codex".to_string(),
            extra_prefix_args: Vec::new(),
            timeouts: Timeouts::PRODUCTION,
        }
    }

    /// Drives `binary prefix_args...` instead of `codex`, with `timeouts`.
    #[cfg(test)]
    fn with_test_binary(
        sink: EventSink,
        binary: impl Into<String>,
        prefix_args: Vec<String>,
        timeouts: Timeouts,
    ) -> Self {
        Self {
            sink,
            binary: binary.into(),
            extra_prefix_args: prefix_args,
            timeouts,
        }
    }
}

/// Why a probe subprocess produced no output.
enum ProbeFailure {
    Spawn(std::io::Error),
    TimedOut,
}

/// Runs `program prefix... args...` with no stdin, bounded by `limit`;
/// the child is killed if the wait is abandoned.
async fn run_cli(
    program: &str,
    prefix: &[String],
    args: &[&str],
    limit: Duration,
) -> Result<std::process::Output, ProbeFailure> {
    let mut command = tokio::process::Command::new(program);
    command
        .args(prefix)
        .args(args)
        .stdin(Stdio::null())
        .kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);
    match tokio::time::timeout(limit, command.output()).await {
        Ok(Ok(output)) => Ok(output),
        Ok(Err(error)) => Err(ProbeFailure::Spawn(error)),
        Err(_) => Err(ProbeFailure::TimedOut),
    }
}

/// The first non-empty output line (stdout, else stderr).
fn first_line(output: &std::process::Output) -> Option<String> {
    [&output.stdout, &output.stderr]
        .into_iter()
        .find_map(|bytes| {
            String::from_utf8_lossy(bytes)
                .lines()
                .map(str::trim)
                .find(|line| !line.is_empty())
                .map(str::to_owned)
        })
}

impl AgentAdapter for CodexAdapter {
    fn provider(&self) -> ProviderId {
        ProviderId::Codex
    }

    fn capabilities(&self) -> Capabilities {
        codex_capabilities()
    }

    /// Runs `codex --version` and `codex login status` concurrently.
    /// Unavailable when `--version` fails or times out, or when `login status`
    /// exits non-zero; when `login status` cannot run or times out, the CLI
    /// counts as available with a "Sign-In State Unknown" detail. Otherwise the
    /// login line (for example `Logged in using ChatGPT`) is the detail; no
    /// credential is read.
    fn probe(&self) -> BoxFuture<'_, Result<ProbeReport, AppError>> {
        let binary = self.binary.clone();
        let prefix = self.extra_prefix_args.clone();
        let limit = self.timeouts.probe;
        Box::pin(async move {
            let program = resolve_program(binary).await;
            let (version, login) = tokio::join!(
                run_cli(&program, &prefix, &["--version"], limit),
                run_cli(&program, &prefix, &["login", "status"], limit),
            );
            let version = match version {
                Ok(output) if output.status.success() => first_line(&output),
                Ok(output) => {
                    return Ok(ProbeReport {
                        available: false,
                        version: None,
                        detail: Some(format!(
                            "`codex --version` Exited With {}",
                            output
                                .status
                                .code()
                                .map_or_else(|| "A Signal".to_string(), |code| code.to_string())
                        )),
                    });
                }
                Err(ProbeFailure::Spawn(error)) => {
                    let detail = if error.kind() == std::io::ErrorKind::NotFound {
                        format!("Codex CLI Not Found On PATH: {error}")
                    } else {
                        format!("Codex CLI Could Not Be Started: {error}")
                    };
                    return Ok(ProbeReport {
                        available: false,
                        version: None,
                        detail: Some(detail),
                    });
                }
                Err(ProbeFailure::TimedOut) => {
                    return Ok(ProbeReport {
                        available: false,
                        version: None,
                        detail: Some("Codex CLI Probe Timed Out".to_string()),
                    });
                }
            };
            Ok(match login {
                Ok(output) if output.status.success() => ProbeReport {
                    available: true,
                    version,
                    detail: first_line(&output),
                },
                Ok(_) => ProbeReport {
                    available: false,
                    version,
                    detail: Some("Not Signed In — Run `codex login` In A Terminal".to_string()),
                },
                Err(_) => ProbeReport {
                    available: true,
                    version,
                    detail: Some(
                        "Sign-In State Unknown: `codex login status` Did Not Answer".to_string(),
                    ),
                },
            })
        })
    }

    fn spawn(
        &self,
        spec: AgentSpawnSpec,
    ) -> BoxFuture<'_, Result<Box<dyn AgentSession>, AppError>> {
        let sink = self.sink.clone();
        let binary = self.binary.clone();
        let prefix = self.extra_prefix_args.clone();
        let timeouts = self.timeouts;
        Box::pin(async move {
            let tier = parse_trust_tier(spec.permission_mode.as_deref())?;
            let model = requested_model(spec.model.as_deref()).map(str::to_owned);
            let program = resolve_program(binary).await;
            let mut argv = prefix;
            argv.push("app-server".to_string());

            // Process creation is a blocking syscall; keep it off the
            // async worker threads.
            let cwd = spec.cwd.clone();
            let PipedHandle {
                stdin,
                child,
                pid: _,
                lines,
                framer_errors,
                stderr_tail,
            } = tokio::task::spawn_blocking(move || {
                spawn_piped(&program, &argv, &cwd, &HashMap::new())
            })
            .await
            .map_err(|e| AppError::Ai(format!("the codex spawn task failed: {e}")))?
            .map_err(|e| AppError::Ai(format!("failed to spawn codex: {e:#}")))?;

            let shared = Arc::new(Shared {
                worker_id: spec.worker_id,
                sink,
                timeouts,
                thread_id: OnceLock::new(),
                state: parking_lot::Mutex::new(Inner {
                    turn: TurnSlot::Idle,
                    blocks: BlockIndex::default(),
                    usage: None,
                    turn_error: None,
                    approvals: HashMap::new(),
                    pending: HashMap::new(),
                    next_request_id: 1,
                    writer: None,
                    child: Some(child),
                    announced: false,
                    closing: false,
                    exit: None,
                }),
                settled: watch::Sender::new(Settled::default()),
                teardown_gate: tokio::sync::Mutex::new(()),
                stderr_tail,
            });

            // From here on the child must never outlive a failed spawn —
            // including this future being dropped mid-handshake. Teardown
            // is quiet for a session that was never announced.
            let reap_on_drop = DropGuard::new(Arc::clone(&shared), |shared| {
                if let Ok(runtime) = tokio::runtime::Handle::try_current() {
                    runtime.spawn(async move {
                        teardown(&shared).await;
                    });
                }
            });

            match start_stdin_writer(spec.worker_id, stdin) {
                Ok(writer) => shared.state.lock().writer = Some(writer),
                Err(error) => {
                    let shared = DropGuard::dismiss(reap_on_drop);
                    teardown(&shared).await;
                    return Err(AppError::Ai(format!(
                        "failed to start the codex stdin writer: {error}"
                    )));
                }
            }
            tokio::spawn(run_reader(Arc::clone(&shared), lines, framer_errors));

            let opened = match tokio::time::timeout(
                timeouts.handshake,
                open_thread(&shared, &spec, tier, model.as_deref()),
            )
            .await
            {
                Ok(Ok(opened)) => opened,
                Ok(Err(error)) => {
                    let shared = DropGuard::dismiss(reap_on_drop);
                    teardown(&shared).await;
                    return Err(error);
                }
                Err(_) => {
                    let shared = DropGuard::dismiss(reap_on_drop);
                    teardown(&shared).await;
                    return Err(AppError::Ai(format!(
                        "codex did not finish its startup handshake within {:?} ({})",
                        timeouts.handshake,
                        stderr_snippet(&shared.stderr_tail)
                    )));
                }
            };

            // Announce under the state lock: a teardown that already began
            // (the child died) wins, and one that begins later sees
            // `announced` and emits its exit after this start.
            let thread_id = opened.thread.id;
            let announced = {
                let mut inner = shared.state.lock();
                let open = !inner.closing && shared.thread_id.set(thread_id.clone()).is_ok();
                if open {
                    inner.announced = true;
                    shared.emit(SwarmEvent::AgentSessionStarted(
                        AgentSessionStartedPayload {
                            worker_id: spec.worker_id,
                            provider: ProviderId::Codex,
                            session_key: thread_id.clone(),
                            model: opened.model,
                            cwd: spec.cwd.clone(),
                            capabilities: codex_capabilities(),
                        },
                    ));
                }
                open
            };
            let shared = DropGuard::dismiss(reap_on_drop);
            if !announced {
                teardown(&shared).await;
                return Err(AppError::Ai(format!(
                    "codex exited during startup ({})",
                    stderr_snippet(&shared.stderr_tail)
                )));
            }
            Ok(Box::new(CodexSession { shared, thread_id }) as Box<dyn AgentSession>)
        })
    }
}

/// The handshake: `initialize`, `initialized`, then `thread/start` — or
/// `thread/resume` when `spec.resume` names a thread — under the tier's
/// policy, verified against what the server applied.
async fn open_thread(
    shared: &Shared,
    spec: &AgentSpawnSpec,
    tier: CodexTrustTier,
    model: Option<&str>,
) -> Result<ThreadOpened, AppError> {
    let closed = |failure: RequestFailure, what: &str| match failure {
        RequestFailure::Closed => AppError::Ai(format!(
            "codex exited before answering {what} ({})",
            stderr_snippet(&shared.stderr_tail)
        )),
        other => other.into_app_error(what),
    };

    let initialized = shared
        .request(
            method::INITIALIZE,
            InitializeParams {
                client_info: ClientInfo {
                    name: CLIENT_NAME,
                    title: CLIENT_TITLE,
                    version: env!("CARGO_PKG_VERSION"),
                },
                capabilities: InitializeCapabilities {
                    experimental_api: false,
                    request_attestation: false,
                    opt_out_notification_methods: OPTED_OUT_NOTIFICATIONS,
                },
            },
        )
        .await
        .map_err(|failure| closed(failure, method::INITIALIZE))?;
    if let Ok(response) = serde_json::from_value::<InitializeResponse>(initialized) {
        tracing::info!(
            worker_id = %shared.worker_id,
            user_agent = %response.user_agent,
            verified_against = VERIFIED_CODEX_VERSION,
            "codex app-server initialized"
        );
    }
    shared.notify(method::INITIALIZED);

    let (approval_policy, sandbox) = tier.policy();
    let opened = match spec.resume.as_deref() {
        Some(thread_id) => shared
            .request(
                method::THREAD_RESUME,
                ThreadResumeParams {
                    thread_id,
                    cwd: &spec.cwd,
                    model,
                    approval_policy,
                    sandbox,
                    exclude_turns: true,
                },
            )
            .await
            .map_err(|failure| closed(failure, method::THREAD_RESUME))?,
        None => shared
            .request(
                method::THREAD_START,
                ThreadStartParams {
                    cwd: &spec.cwd,
                    model,
                    approval_policy,
                    sandbox,
                },
            )
            .await
            .map_err(|failure| closed(failure, method::THREAD_START))?,
    };
    let opened: ThreadOpened = serde_json::from_value(opened).map_err(|e| {
        AppError::Ai(format!(
            "codex answered the thread open with an unexpected shape: {e}"
        ))
    })?;
    verify_effective_policy(&opened, approval_policy, sandbox)?;
    Ok(opened)
}

/// Per-worker handle to one live `codex app-server` child and its thread.
pub struct CodexSession {
    shared: Arc<Shared>,
    thread_id: SessionKey,
}

impl AgentSession for CodexSession {
    /// The Codex thread id — what `thread/resume` takes back.
    fn session_key(&self) -> &SessionKey {
        &self.thread_id
    }

    /// Sends `turn/start` and returns the acknowledged turn's id. The slot
    /// is held as `Starting` until then, so a second turn is rejected as
    /// busy. If the acknowledgement does not arrive in time (30 s in
    /// production) the turn may be running untracked, so the
    /// session is shut down rather than left in an unknown state.
    fn send_turn(&self, turn: TurnInput) -> BoxFuture<'_, Result<TurnId, AppError>> {
        let shared = Arc::clone(&self.shared);
        Box::pin(async move {
            {
                let mut inner = shared.state.lock();
                if inner.closing {
                    return Err(AppError::Ipc("codex session already shut down".to_string()));
                }
                if inner.turn != TurnSlot::Idle {
                    return Err(AppError::AgentSessionBusy);
                }
                inner.turn = TurnSlot::Starting;
                inner.blocks = BlockIndex::default();
                inner.usage = None;
                inner.turn_error = None;
            }

            let params = TurnStartParams {
                thread_id: shared.thread_id(),
                input: [UserInput::Text {
                    text: &turn.prompt,
                    text_elements: [],
                }],
            };
            let failure = match tokio::time::timeout(
                shared.timeouts.turn_ack,
                shared.request(method::TURN_START, params),
            )
            .await
            {
                Ok(Ok(result)) => match serde_json::from_value::<TurnStartResponse>(result) {
                    Ok(response) => return Ok(response.turn.id),
                    Err(error) => format!("codex acknowledged turn/start without a turn: {error}"),
                },
                Ok(Err(RequestFailure::Closed)) => {
                    return Err(AppError::Ipc(
                        "codex session closed before acknowledging the turn".to_string(),
                    ));
                }
                Ok(Err(failure)) => {
                    shared.release_start();
                    return Err(failure.into_app_error(method::TURN_START));
                }
                Err(_) => format!(
                    "codex did not acknowledge turn/start within {:?}",
                    shared.timeouts.turn_ack
                ),
            };
            teardown(&shared).await;
            Err(AppError::Ai(format!(
                "{failure}; the session was shut down"
            )))
        })
    }

    fn await_turn_completion(&self, turn: TurnId) -> BoxFuture<'_, Result<(), AppError>> {
        let shared = Arc::clone(&self.shared);
        Box::pin(async move {
            wait_settled(&shared, &turn).await;
            Ok(())
        })
    }

    /// Interrupts `turn` with `turn/interrupt`; it then settles
    /// `interrupted`. A cancel for a turn that is not running is a no-op.
    /// The turn gets a bounded wait (10 s in production) to settle whether the
    /// interrupt was accepted or refused — a refusal (`no active turn to
    /// interrupt`) races a turn that is finishing on its own. If it does
    /// not settle, or the interrupt goes unanswered, the session is shut
    /// down instead (its teardown settles the turn).
    fn cancel(&self, turn: TurnId) -> BoxFuture<'_, Result<(), AppError>> {
        let shared = Arc::clone(&self.shared);
        Box::pin(async move {
            if !shared.is_running(&turn) {
                return Ok(());
            }
            let interrupt = tokio::time::timeout(
                shared.timeouts.request,
                shared.request(
                    method::TURN_INTERRUPT,
                    TurnInterruptParams {
                        thread_id: shared.thread_id(),
                        turn_id: &turn,
                    },
                ),
            )
            .await;
            match interrupt {
                Ok(Err(RequestFailure::Closed)) => return Ok(()),
                Ok(outcome) => {
                    if let Err(failure) = outcome {
                        tracing::debug!(worker_id = %shared.worker_id, turn_id = %turn, ?failure, "codex adapter: turn/interrupt refused, waiting for the turn to settle");
                    }
                    let settle = shared.timeouts.interrupt_settle;
                    if tokio::time::timeout(settle, wait_settled(&shared, &turn))
                        .await
                        .is_ok()
                    {
                        return Ok(());
                    }
                    tracing::warn!(worker_id = %shared.worker_id, turn_id = %turn, "codex adapter: the interrupted turn never settled, shutting the session down");
                }
                Err(_) => {
                    tracing::warn!(worker_id = %shared.worker_id, turn_id = %turn, "codex adapter: turn/interrupt went unanswered, shutting the session down");
                }
            }
            teardown(&shared).await;
            Ok(())
        })
    }

    /// Answers a pending approval on the wire. Commands and patches get
    /// `accept` / `decline` (one request only, even when a patch asked
    /// for a session-long `grantRoot`); a permissions request is granted
    /// exactly what it asked for, or nothing, for this turn. An unknown,
    /// already-answered or withdrawn request — or a closed session — is a
    /// no-op.
    fn respond_permission(
        &self,
        req: PermissionId,
        decision: PermissionDecision,
    ) -> BoxFuture<'_, Result<(), AppError>> {
        let shared = Arc::clone(&self.shared);
        Box::pin(async move {
            let (done, written) = oneshot::channel();
            {
                let mut inner = shared.state.lock();
                if inner.closing {
                    return Ok(());
                }
                let Some(approval) = inner.approvals.remove(&req) else {
                    return Ok(());
                };
                let line = approval_answer(approval, decision).map_err(|e| {
                    AppError::Ipc(format!("encoding the approval answer failed: {e}"))
                })?;
                if !inner.enqueue(line, Some(done)) {
                    return Err(AppError::Ipc("codex stdin is closed".to_string()));
                }
            }
            match tokio::time::timeout(shared.timeouts.request, written).await {
                Ok(Ok(Ok(()))) => Ok(()),
                Ok(Ok(Err(error))) => Err(AppError::Ipc(format!(
                    "failed to write the approval answer to codex stdin: {error}"
                ))),
                Ok(Err(_)) => Err(AppError::Ipc(
                    "codex stdin closed before the approval answer was written".to_string(),
                )),
                Err(_) => Err(AppError::Ipc(
                    "writing the approval answer to codex stdin timed out".to_string(),
                )),
            }
        })
    }

    fn shutdown(&self) -> BoxFuture<'_, Result<ExitSummary, AppError>> {
        let shared = Arc::clone(&self.shared);
        Box::pin(async move { Ok(teardown(&shared).await) })
    }
}
