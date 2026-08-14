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

use crate::agent::adapter::{
    AgentTurnStatus, Capabilities, PermissionDecision, PermissionId, ProviderId, SessionKey, TurnId,
};
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
    /// Bytes were written to a worker's PTY stdin.
    WorkerInput(WorkerInputPayload),
    /// An AI/agent turn started — the causal root a turn's tool-driven
    /// side effects cite as `causeSeq`.
    AgentTurnStarted(AgentTurnStartedPayload),
    /// A file was written via the `write_file` command.
    FileWritten(FileWrittenPayload),
    /// A provider-adapter session started for a worker (Phase 3+
    /// adapters; see `crate::agent::adapter::AgentAdapter::spawn`).
    AgentSessionStarted(AgentSessionStartedPayload),
    /// One sub-message delta within a turn. EPHEMERAL — see
    /// [`crate::orchestration::is_persistent`]'s `AgentTurnDelta`
    /// exclusion; persisting per-token/per-clause rows would be
    /// ~800 SQLite rows/s at 8 workers.
    AgentTurnDelta(AgentTurnDeltaPayload),
    /// One complete content block within a turn (the persisted
    /// counterpart to [`Self::AgentTurnDelta`] — replay reconstructs
    /// full turns from these rows; only the typing animation is lost).
    AgentBlock(AgentBlockPayload),
    /// A tool call the provider's agent issued mid-turn.
    AgentToolCall(AgentToolCallPayload),
    /// The result of a previously-issued [`Self::AgentToolCall`].
    AgentToolResult(AgentToolResultPayload),
    /// The provider is asking a human to approve or deny a tool call.
    /// See [`crate::agent::adapter::PermissionDecision`]'s Condition C
    /// doc — this is the ONLY legitimate gating surface, never
    /// `allowedTools`.
    AgentPermissionRequest(AgentPermissionRequestPayload),
    /// Terminal receipt for one turn: exactly one per turn, on success
    /// AND on ungraceful child exit — see
    /// `crate::agent::adapter::AgentSession::shutdown`'s Condition B
    /// doc for the synthesized-on-kill guarantee.
    AgentTurnSettled(AgentTurnSettledPayload),
    /// A provider-adapter session's underlying process exited.
    AgentSessionExited(AgentSessionExitedPayload),
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

/// Where a `worker_input` event's bytes came from.
///
/// A closed, typed enum — not a bare string — so that the
/// typed-secrets-never-archived guarantee (see [`WorkerInputPayload`]'s
/// doc and [`crate::orchestration::is_persistent`]'s carve-out) does
/// not rest on the webview spelling `"terminal"` correctly. An unknown
/// or misspelled source value now fails IPC *deserialization* outright
/// — the command errors before any PTY write or event emission happens
/// — rather than silently falling through a string-equality check as
/// "not terminal" and persisting/previewing something that should have
/// been treated as raw human keystrokes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum InputSource {
    /// Human keystrokes typed into a worker's terminal.
    Terminal,
    /// An AI tool call (e.g. the `run_command` tool).
    Tool,
    /// Machine-issued input outside a tool call (e.g. workspace-watcher
    /// auto-injection).
    Automation,
}

impl InputSource {
    /// `true` for every source except [`Self::Terminal`] — the source
    /// classes that get a control-stripped preview and persist normally.
    pub fn is_machine_issued(self) -> bool {
        !matches!(self, InputSource::Terminal)
    }
}

/// Payload for the `worker_input` event.
///
/// Emitted from [`crate::worker::lifecycle::do_worker_input`] AFTER a
/// successful `write_to_pty`. Never carries raw keystrokes: `preview`
/// is populated only for `source ∈ {tool, automation}` — human
/// terminal keystrokes get a byte count only (see the module-level
/// persistence carve-out on [`crate::orchestration::is_persistent`],
/// which additionally keeps `source: "terminal"` rows out of the
/// durable log entirely, so a typed secret is never archived).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkerInputPayload {
    /// UUID of the worker whose PTY received input.
    pub worker_id: Uuid,
    /// Number of bytes written.
    pub bytes: usize,
    /// Where the input came from.
    pub source: InputSource,
    /// First ~120 characters of the input, control characters
    /// stripped. `None` for `source == "terminal"` — see the struct
    /// doc's "never carries raw keystrokes" note.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub preview: Option<String>,
}

/// Payload for the `agent_turn_started` event.
///
/// A narrow webview intake: the frontend calls the
/// `agent_turn_started` command once per AI/agent turn, before the
/// first streaming round, to obtain a real persisted `seq` for that
/// turn (via [`EventSink::emit_awaiting_seq`]) — every tool-driven side
/// effect that turn then cites this event's `seq` as its own
/// `causeSeq`. The engine records provenance; it never infers it — see
/// [`EventSink::emit_with`]'s invariant doc. This is the mechanism that
/// makes that invariant possible for AI turns: the frontend cannot cite
/// a cause that does not exist in the log, so this command's job is to
/// make one exist.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentTurnStartedPayload {
    /// UUID of the worker whose chat panel started this turn.
    pub worker_id: Uuid,
    /// Model identifier used for this turn (e.g. `"claude-sonnet-4-5"`).
    pub model: String,
    /// Client-generated correlation ID for this turn (the chat item id).
    pub request_id: String,
}

/// Payload for the `file_written` event.
///
/// Emitted once, after a successful `write_file` command — write only;
/// reads are not a causally interesting side effect and emit nothing.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileWrittenPayload {
    /// Absolute path written.
    pub path: String,
    /// Number of bytes written.
    pub bytes: usize,
}

/// Payload for the `agent_session_started` event.
///
/// Emitted once, immediately after [`crate::agent::adapter::AgentAdapter::spawn`]
/// resolves successfully — the provider-adapter counterpart to
/// `worker_spawned`/`worktree_created` (which record the SWARM-side
/// process/isolation facts). `capabilities` is stamped verbatim from
/// the adapter (see [`Capabilities`]'s honesty doctrine) so a replay or
/// a UI restored after a restart can render the right affordances
/// without re-probing the provider.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSessionStartedPayload {
    /// UUID of the worker this session belongs to.
    pub worker_id: Uuid,
    /// Which provider CLI is driving this session.
    pub provider: ProviderId,
    /// Provider-native session identifier (see [`SessionKey`]'s doc).
    pub session_key: SessionKey,
    /// Model alias/id this session was started with.
    pub model: String,
    /// Working directory the provider process is running in.
    pub cwd: String,
    /// What this adapter can honestly promise for this session.
    pub capabilities: Capabilities,
}

/// Payload for the `agent_turn_delta` event.
///
/// EPHEMERAL — never persisted (see
/// [`crate::orchestration::is_persistent`]). One row per streamed
/// sub-message chunk within a turn; the persisted counterpart once the
/// block completes is [`AgentBlockPayload`].
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentTurnDeltaPayload {
    /// UUID of the worker whose turn this delta belongs to.
    pub worker_id: Uuid,
    /// Correlation id for the turn this delta belongs to.
    pub turn_id: TurnId,
    /// Zero-based index of the content block this delta extends.
    pub block_index: u32,
    /// Block kind (e.g. `"text"`, `"thinking"`) — free-form, mirrors
    /// whatever the provider's own protocol calls it, not a closed
    /// enum, since providers do not agree on block taxonomies.
    pub kind: String,
    /// The delta text chunk itself.
    pub text: String,
}

/// Payload for the `agent_block` event.
///
/// Persisted. Emitted once a content block within a turn is complete —
/// the durable counterpart to the (ephemeral)
/// [`AgentTurnDeltaPayload`] stream that preceded it. `content` is
/// arbitrary structured JSON because block shapes vary by `kind` and by
/// provider (a `"text"` block is just a string; a `"thinking"` block
/// may carry a signature; a future block kind may carry anything else
/// the provider's protocol defines).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentBlockPayload {
    /// UUID of the worker whose turn this block belongs to.
    pub worker_id: Uuid,
    /// Correlation id for the turn this block belongs to.
    pub turn_id: TurnId,
    /// Zero-based index of this content block within the turn.
    pub block_index: u32,
    /// Block kind — see [`AgentTurnDeltaPayload::kind`]'s doc.
    pub kind: String,
    /// The complete block content.
    pub content: serde_json::Value,
}

/// Payload for the `agent_tool_call` event.
///
/// Persisted. `tool_use_id` is the provider's own correlation id for
/// this call — the same id [`AgentToolResultPayload::tool_use_id`]
/// echoes back, letting a replay reconstruct call/result pairs
/// unambiguously even when several tool calls are in flight within one
/// turn (confirmed reconstructable in the Phase 1 spike's Gate 5).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentToolCallPayload {
    /// UUID of the worker whose turn issued this tool call.
    pub worker_id: Uuid,
    /// Correlation id for the turn this tool call belongs to.
    pub turn_id: TurnId,
    /// Provider-native tool-use correlation id.
    pub tool_use_id: String,
    /// Name of the tool invoked.
    pub name: String,
    /// The tool's input arguments, verbatim from the provider.
    pub input: serde_json::Value,
}

/// Payload for the `agent_tool_result` event.
///
/// Persisted. See [`AgentToolCallPayload`]'s doc for the
/// `tool_use_id` correlation contract.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentToolResultPayload {
    /// UUID of the worker whose turn this result belongs to.
    pub worker_id: Uuid,
    /// Correlation id for the turn this result belongs to.
    pub turn_id: TurnId,
    /// Provider-native tool-use correlation id, echoing the
    /// originating [`AgentToolCallPayload::tool_use_id`].
    pub tool_use_id: String,
    /// `true` when the tool call itself failed/errored.
    pub is_error: bool,
    /// The tool's result content, verbatim from the provider.
    pub content: serde_json::Value,
}

/// Payload for the `agent_permission_request` event.
///
/// Persisted. See
/// [`crate::agent::adapter::PermissionDecision`]'s Condition C doc:
/// this event, answered via `respond_permission`, is the only
/// legitimate gating surface — never `allowedTools`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentPermissionRequestPayload {
    /// UUID of the worker whose turn is asking for permission.
    pub worker_id: Uuid,
    /// Correlation id for the turn this request belongs to.
    pub turn_id: TurnId,
    /// Correlation id for this specific permission request, echoed
    /// back on `respond_permission`.
    pub request_id: PermissionId,
    /// Name of the tool awaiting approval.
    pub tool: String,
    /// The tool's proposed input, for display before approval.
    pub input: serde_json::Value,
    /// The provider's own suggested decision, when it has one (e.g. a
    /// hook-computed recommendation) — advisory only, never
    /// auto-applied by SWARM.
    #[serde(default)]
    pub suggested_decision: Option<PermissionDecision>,
}

/// Payload for the `agent_turn_settled` receipt.
///
/// Persisted. Emitted exactly once per turn, on success AND on
/// ungraceful child exit — see
/// `crate::agent::adapter::AgentSession::shutdown`'s Condition B doc.
/// `cost_usd`/`usage` are `None` on a synthesized (kill-path)
/// settlement — the provider's terminal `result` line, which is the
/// only source of truth for cost, is never observed on a kill.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentTurnSettledPayload {
    /// UUID of the worker this turn belongs to.
    pub worker_id: Uuid,
    /// Correlation id for the settled turn.
    pub turn_id: TurnId,
    /// `"ok"` or `"error"` — a closed enum (see
    /// [`AgentTurnStatus`]'s doc for why this one is typed where the
    /// older `ai_stream_settled`/`ship_settled` receipts stayed plain
    /// strings).
    pub status: AgentTurnStatus,
    /// Error description when `status == `[`AgentTurnStatus::Error`].
    pub error: Option<String>,
    /// Real, provider-reported cost in USD, when available (see
    /// [`Capabilities::native_cost`]).
    pub cost_usd: Option<f64>,
    /// Provider-reported token usage breakdown, verbatim, when
    /// available.
    pub usage: Option<serde_json::Value>,
    /// Wall-clock duration of the turn in milliseconds.
    pub duration_ms: u64,
    /// Number of provider-internal turns this call represents, when
    /// the provider reports one (some providers can take several
    /// internal steps per SWARM-visible turn).
    pub num_turns: Option<u32>,
}

/// Payload for the `agent_session_exited` event.
///
/// Persisted. Emitted once a session's underlying provider process has
/// fully exited (clean or killed) — the provider-adapter counterpart to
/// `worker_killed`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSessionExitedPayload {
    /// UUID of the worker this session belonged to.
    pub worker_id: Uuid,
    /// Process exit code, when the OS reports one.
    pub exit_code: Option<i32>,
    /// Signal name that terminated the process, when applicable.
    #[serde(default)]
    pub signal: Option<String>,
}

/// Causal attribution for one event: who caused it (`origin_worker`,
/// the CAUSER) and what it was reacting to (`cause_seq`, the seq of the
/// event that triggered it). Distinct from a payload's own
/// `worker_id`/`workerId` (the SUBJECT) — for a tool-driven spawn the
/// two differ, and that difference IS the causal edge (see
/// `docs/architecture.md`'s subject-vs-causer rule).
///
/// `Default` is the honest "unattributed" value (`None`/`None`) — every
/// existing call site that only ever called [`EventSink::emit`] keeps
/// recording exactly that, truthfully, rather than a manufactured
/// guess.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Provenance {
    /// UUID of the worker whose action caused this event, if known.
    pub origin_worker: Option<Uuid>,
    /// Seq of the event this one is causally reacting to, if known.
    pub cause_seq: Option<u64>,
}

/// One item on the writer channel: the event to order/persist/emit,
/// its causal attribution, and an optional one-shot ack the caller can
/// use to learn the seq the writer thread assigns it.
///
/// Internal to `swarm-core` — callers only ever see [`EventSink`]'s
/// `emit`/`emit_with`/`emit_awaiting_seq` methods, never construct this
/// directly.
pub(crate) struct WriterMsg {
    pub(crate) event: SwarmEvent,
    pub(crate) provenance: Provenance,
    /// `Some` only for [`EventSink::emit_awaiting_seq`] callers. Sending
    /// on a oneshot is inherently non-blocking and silently discards
    /// the value when the receiver was dropped (`Sender::send` returns
    /// `Err` in that case, which the writer loop ignores) — a caller
    /// that drops its receiver (e.g. a cancelled IPC call) can never
    /// stall the single writer thread.
    pub(crate) ack: Option<tokio::sync::oneshot::Sender<u64>>,
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
pub struct EventSink(Sender<WriterMsg>);

impl EventSink {
    /// Wraps a raw channel sender. Called only by
    /// [`crate::orchestration::OrchestrationEngine::start`].
    pub(crate) fn new(tx: Sender<WriterMsg>) -> Self {
        Self(tx)
    }

    /// Records an event for ordering, persistence, and emission, with
    /// no causal attribution (`Provenance::default()` — unattributed,
    /// not a guess).
    ///
    /// Fire-and-forget: the dedicated writer thread assigns a sequence
    /// number, persists (per policy), and broadcasts the ordered
    /// envelope. If the writer thread is gone, the event is dropped
    /// with an error log rather than panicking.
    pub fn emit(&self, event: SwarmEvent) {
        self.emit_with(event, Provenance::default());
    }

    /// Records an event exactly like [`Self::emit`], additionally
    /// stamping `provenance` on the envelope.
    ///
    /// # Invariant
    ///
    /// The engine (and every caller of this method) **records**
    /// provenance — it never **infers** it. A "the last AI turn
    /// probably caused this" heuristic would manufacture exactly the
    /// class of fabricated edge this whole feature exists to replace
    /// (see `docs/architecture.md`'s ordered-event-core section). Every
    /// `Provenance` passed here must trace back to an explicit,
    /// caller-supplied value — an IPC argument, a message's own
    /// `from_worker`, a turn's own recorded seq — never a inferred
    /// "current cause" guess.
    pub fn emit_with(&self, event: SwarmEvent, provenance: Provenance) {
        let msg = WriterMsg {
            event,
            provenance,
            ack: None,
        };
        if self.0.send(msg).is_err() {
            tracing::error!("event writer thread is gone; event dropped");
        }
    }

    /// Records an event like [`Self::emit_with`], returning a receiver
    /// that resolves to the seq the writer thread assigns it.
    ///
    /// The primary use is `agent_turn_started`: the frontend needs a
    /// real, persisted seq to cite as `causeSeq` on every tool-driven
    /// side effect in that turn, and this is how it learns that number
    /// deterministically (no polling, no timeout-bound
    /// correlation-by-waitFor).
    ///
    /// Non-blocking and stall-proof: if the caller drops the returned
    /// receiver (e.g. a cancelled IPC call) before the writer thread
    /// gets to it, the subsequent `ack.send(seq)` inside the writer
    /// loop simply returns `Err` and is ignored — the writer thread
    /// never blocks on, or even notices, a disinterested receiver.
    pub fn emit_awaiting_seq(
        &self,
        event: SwarmEvent,
        provenance: Provenance,
    ) -> tokio::sync::oneshot::Receiver<u64> {
        let (ack_tx, ack_rx) = tokio::sync::oneshot::channel();
        let msg = WriterMsg {
            event,
            provenance,
            ack: Some(ack_tx),
        };
        if self.0.send(msg).is_err() {
            tracing::error!("event writer thread is gone; event dropped");
            // `ack_tx` is dropped here (it was moved into `msg`, which
            // is now dropped) — the awaiting receiver resolves to a
            // `RecvError` rather than hanging forever.
        }
        ack_rx
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

    // ── Provenance ───────────────────────────────────────────────────

    #[test]
    fn test_provenance_default_is_fully_unattributed() {
        let prov = Provenance::default();
        assert_eq!(prov.origin_worker, None);
        assert_eq!(prov.cause_seq, None);
    }

    #[test]
    fn test_provenance_roundtrip_with_values() {
        let worker_id = Uuid::new_v4();
        let prov = Provenance {
            origin_worker: Some(worker_id),
            cause_seq: Some(42),
        };
        let json = serde_json::to_string(&prov).expect("serialize");
        assert!(json.contains("\"originWorker\""));
        assert!(json.contains("\"causeSeq\":42"));
        let deserialized: Provenance = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(deserialized, prov);
    }

    // ── worker_input ─────────────────────────────────────────────────

    #[test]
    fn test_worker_input_roundtrip_terminal_source_no_preview() {
        let worker_id = Uuid::new_v4();
        let event = SwarmEvent::WorkerInput(WorkerInputPayload {
            worker_id,
            bytes: 5,
            source: InputSource::Terminal,
            preview: None,
        });
        let json = serde_json::to_string(&event).expect("serialize");
        assert!(json.contains("\"type\":\"worker_input\""));
        assert!(json.contains("\"source\":\"terminal\""));
        // preview must be entirely absent from the wire, not `null` —
        // omission (not nullability) is the contract for "no preview".
        assert!(!json.contains("preview"));
        let deserialized: SwarmEvent = serde_json::from_str(&json).expect("deserialize");
        if let SwarmEvent::WorkerInput(p) = deserialized {
            assert_eq!(p.worker_id, worker_id);
            assert_eq!(p.bytes, 5);
            assert_eq!(p.preview, None);
        } else {
            panic!("expected WorkerInput variant");
        }
    }

    #[test]
    fn test_worker_input_roundtrip_tool_source_with_preview() {
        let event = SwarmEvent::WorkerInput(WorkerInputPayload {
            worker_id: Uuid::nil(),
            bytes: 12,
            source: InputSource::Tool,
            preview: Some("pnpm build\n".to_string()),
        });
        let json = serde_json::to_string(&event).expect("serialize");
        assert!(json.contains("\"preview\":\"pnpm build\\n\""));
        let deserialized: SwarmEvent = serde_json::from_str(&json).expect("deserialize");
        if let SwarmEvent::WorkerInput(p) = deserialized {
            assert_eq!(p.source, InputSource::Tool);
            assert_eq!(p.preview.as_deref(), Some("pnpm build\n"));
        } else {
            panic!("expected WorkerInput variant");
        }
    }

    /// DIRECTIVE (BLOCKING fix): `source` is a closed, typed enum — an
    /// unrecognized string must fail deserialization outright, not
    /// silently coerce into some default. This is what makes the
    /// "typed secrets never archived" guarantee independent of the
    /// webview spelling `"terminal"` correctly.
    #[test]
    fn test_input_source_rejects_unknown_string() {
        let result: Result<InputSource, _> = serde_json::from_str("\"carrier_pigeon\"");
        assert!(result.is_err());
    }

    #[test]
    fn test_input_source_is_machine_issued() {
        assert!(!InputSource::Terminal.is_machine_issued());
        assert!(InputSource::Tool.is_machine_issued());
        assert!(InputSource::Automation.is_machine_issued());
    }

    // ── agent_turn_started ───────────────────────────────────────────

    #[test]
    fn test_agent_turn_started_roundtrip() {
        let worker_id = Uuid::new_v4();
        let event = SwarmEvent::AgentTurnStarted(AgentTurnStartedPayload {
            worker_id,
            model: "claude-sonnet-4-5".to_string(),
            request_id: "turn-1".to_string(),
        });
        let json = serde_json::to_string(&event).expect("serialize");
        assert!(json.contains("\"type\":\"agent_turn_started\""));
        assert!(json.contains("\"requestId\":\"turn-1\""));
        let deserialized: SwarmEvent = serde_json::from_str(&json).expect("deserialize");
        if let SwarmEvent::AgentTurnStarted(p) = deserialized {
            assert_eq!(p.worker_id, worker_id);
            assert_eq!(p.model, "claude-sonnet-4-5");
        } else {
            panic!("expected AgentTurnStarted variant");
        }
    }

    // ── file_written ─────────────────────────────────────────────────

    #[test]
    fn test_file_written_roundtrip() {
        let event = SwarmEvent::FileWritten(FileWrittenPayload {
            path: "/home/user/.swarm/out.txt".to_string(),
            bytes: 7,
        });
        let json = serde_json::to_string(&event).expect("serialize");
        assert!(json.contains("\"type\":\"file_written\""));
        assert!(json.contains("\"bytes\":7"));
        let deserialized: SwarmEvent = serde_json::from_str(&json).expect("deserialize");
        if let SwarmEvent::FileWritten(p) = deserialized {
            assert_eq!(p.path, "/home/user/.swarm/out.txt");
            assert_eq!(p.bytes, 7);
        } else {
            panic!("expected FileWritten variant");
        }
    }

    // ── agent_* family ───────────────────────────────────────────────

    #[test]
    fn test_agent_session_started_roundtrip() {
        use crate::agent::adapter::{CancelGranularity, Capabilities, ProviderId};

        let worker_id = Uuid::new_v4();
        let event = SwarmEvent::AgentSessionStarted(AgentSessionStartedPayload {
            worker_id,
            provider: ProviderId::ClaudeCode,
            session_key: "sess-abc".to_string(),
            model: "claude-sonnet-5".to_string(),
            cwd: "/repo/worktree".to_string(),
            capabilities: Capabilities {
                partial_deltas: true,
                resume: true,
                native_cost: true,
                permission_modes: vec!["default".to_string(), "plan".to_string()],
                cancel_granularity: CancelGranularity::KillOnly,
                interrupt_midturn: false,
                worktree_aware: true,
            },
        });
        let json = serde_json::to_string(&event).expect("serialize");
        assert!(json.contains("\"type\":\"agent_session_started\""));
        assert!(json.contains("\"sessionKey\":\"sess-abc\""));
        assert!(json.contains("\"provider\":\"claude_code\""));
        assert!(json.contains("\"cancelGranularity\":\"kill_only\""));
        let deserialized: SwarmEvent = serde_json::from_str(&json).expect("deserialize");
        if let SwarmEvent::AgentSessionStarted(p) = deserialized {
            assert_eq!(p.worker_id, worker_id);
            assert_eq!(p.provider, ProviderId::ClaudeCode);
            assert!(p.capabilities.resume);
        } else {
            panic!("expected AgentSessionStarted variant");
        }
    }

    #[test]
    fn test_agent_turn_delta_roundtrip() {
        let worker_id = Uuid::new_v4();
        let event = SwarmEvent::AgentTurnDelta(AgentTurnDeltaPayload {
            worker_id,
            turn_id: "turn-1".to_string(),
            block_index: 0,
            kind: "text".to_string(),
            text: "Hello".to_string(),
        });
        let json = serde_json::to_string(&event).expect("serialize");
        assert!(json.contains("\"type\":\"agent_turn_delta\""));
        assert!(json.contains("\"turnId\":\"turn-1\""));
        assert!(json.contains("\"blockIndex\":0"));
        let deserialized: SwarmEvent = serde_json::from_str(&json).expect("deserialize");
        if let SwarmEvent::AgentTurnDelta(p) = deserialized {
            assert_eq!(p.worker_id, worker_id);
            assert_eq!(p.text, "Hello");
        } else {
            panic!("expected AgentTurnDelta variant");
        }
    }

    #[test]
    fn test_agent_block_roundtrip() {
        let event = SwarmEvent::AgentBlock(AgentBlockPayload {
            worker_id: Uuid::nil(),
            turn_id: "turn-1".to_string(),
            block_index: 0,
            kind: "text".to_string(),
            content: serde_json::json!({"text": "Hello"}),
        });
        let json = serde_json::to_string(&event).expect("serialize");
        assert!(json.contains("\"type\":\"agent_block\""));
        let deserialized: SwarmEvent = serde_json::from_str(&json).expect("deserialize");
        if let SwarmEvent::AgentBlock(p) = deserialized {
            assert_eq!(p.content, serde_json::json!({"text": "Hello"}));
        } else {
            panic!("expected AgentBlock variant");
        }
    }

    #[test]
    fn test_agent_tool_call_and_result_roundtrip_share_tool_use_id() {
        let tool_use_id = "toolu_01ABC".to_string();
        let call = SwarmEvent::AgentToolCall(AgentToolCallPayload {
            worker_id: Uuid::nil(),
            turn_id: "turn-1".to_string(),
            tool_use_id: tool_use_id.clone(),
            name: "run_command".to_string(),
            input: serde_json::json!({"command": "pnpm build"}),
        });
        let result = SwarmEvent::AgentToolResult(AgentToolResultPayload {
            worker_id: Uuid::nil(),
            turn_id: "turn-1".to_string(),
            tool_use_id: tool_use_id.clone(),
            is_error: false,
            content: serde_json::json!("ok"),
        });

        let call_json = serde_json::to_string(&call).expect("serialize");
        assert!(call_json.contains("\"type\":\"agent_tool_call\""));
        assert!(call_json.contains("\"toolUseId\":\"toolu_01ABC\""));

        let result_json = serde_json::to_string(&result).expect("serialize");
        assert!(result_json.contains("\"type\":\"agent_tool_result\""));
        assert!(result_json.contains("\"isError\":false"));

        if let (SwarmEvent::AgentToolCall(c), SwarmEvent::AgentToolResult(r)) = (
            serde_json::from_str::<SwarmEvent>(&call_json).unwrap(),
            serde_json::from_str::<SwarmEvent>(&result_json).unwrap(),
        ) {
            assert_eq!(
                c.tool_use_id, r.tool_use_id,
                "call and result must correlate"
            );
        } else {
            panic!("expected AgentToolCall/AgentToolResult variants");
        }
    }

    #[test]
    fn test_agent_permission_request_roundtrip_with_suggested_decision() {
        use crate::agent::adapter::PermissionDecision;

        let event = SwarmEvent::AgentPermissionRequest(AgentPermissionRequestPayload {
            worker_id: Uuid::nil(),
            turn_id: "turn-1".to_string(),
            request_id: "perm-1".to_string(),
            tool: "Bash".to_string(),
            input: serde_json::json!({"command": "rm -rf /"}),
            suggested_decision: Some(PermissionDecision::Deny),
        });
        let json = serde_json::to_string(&event).expect("serialize");
        assert!(json.contains("\"type\":\"agent_permission_request\""));
        assert!(json.contains("\"suggestedDecision\":\"deny\""));
        let deserialized: SwarmEvent = serde_json::from_str(&json).expect("deserialize");
        if let SwarmEvent::AgentPermissionRequest(p) = deserialized {
            assert_eq!(p.suggested_decision, Some(PermissionDecision::Deny));
        } else {
            panic!("expected AgentPermissionRequest variant");
        }
    }

    #[test]
    fn test_agent_permission_request_suggested_decision_absent_deserializes_as_none() {
        // Backward/forward compatibility: a provider that never offers
        // a suggestion omits the field entirely.
        let json = r#"{"workerId":"00000000-0000-0000-0000-000000000000","turnId":"t","requestId":"p","tool":"Bash","input":{}}"#;
        let payload: AgentPermissionRequestPayload =
            serde_json::from_str(json).expect("deserialize");
        assert_eq!(payload.suggested_decision, None);
    }

    #[test]
    fn test_agent_turn_settled_roundtrip_ok_and_synthesized_error() {
        use crate::agent::adapter::AgentTurnStatus;

        let ok = SwarmEvent::AgentTurnSettled(AgentTurnSettledPayload {
            worker_id: Uuid::nil(),
            turn_id: "turn-1".to_string(),
            status: AgentTurnStatus::Ok,
            error: None,
            cost_usd: Some(0.0123),
            usage: Some(serde_json::json!({"inputTokens": 100})),
            duration_ms: 4200,
            num_turns: Some(1),
        });
        let json = serde_json::to_string(&ok).expect("serialize");
        assert!(json.contains("\"type\":\"agent_turn_settled\""));
        assert!(json.contains("\"status\":\"ok\""));
        assert!(json.contains("\"costUsd\":0.0123"));

        // Condition B: a synthesized settlement on ungraceful exit
        // carries no cost data — honestly None, not a fabricated 0.
        let synthesized = SwarmEvent::AgentTurnSettled(AgentTurnSettledPayload {
            worker_id: Uuid::nil(),
            turn_id: "turn-2".to_string(),
            status: AgentTurnStatus::Error,
            error: Some("process killed".to_string()),
            cost_usd: None,
            usage: None,
            duration_ms: 900,
            num_turns: None,
        });
        let json2 = serde_json::to_string(&synthesized).expect("serialize");
        assert!(json2.contains("\"status\":\"error\""));
        let deserialized: SwarmEvent = serde_json::from_str(&json2).expect("deserialize");
        if let SwarmEvent::AgentTurnSettled(p) = deserialized {
            assert_eq!(p.status, AgentTurnStatus::Error);
            assert_eq!(p.cost_usd, None);
            assert_eq!(p.usage, None);
        } else {
            panic!("expected AgentTurnSettled variant");
        }
    }

    /// DIRECTIVE (review nit F): `status` is a closed enum, not a bare
    /// string — an unrecognized value must fail deserialization
    /// outright, matching the [`crate::events::InputSource`]/
    /// `ProviderId` precedent.
    #[test]
    fn test_agent_turn_status_rejects_unknown_string() {
        use crate::agent::adapter::AgentTurnStatus;
        let result: Result<AgentTurnStatus, _> = serde_json::from_str("\"pending\"");
        assert!(result.is_err());
    }

    #[test]
    fn test_agent_session_exited_roundtrip() {
        let worker_id = Uuid::new_v4();
        let event = SwarmEvent::AgentSessionExited(AgentSessionExitedPayload {
            worker_id,
            exit_code: Some(1),
            signal: None,
        });
        let json = serde_json::to_string(&event).expect("serialize");
        assert!(json.contains("\"type\":\"agent_session_exited\""));
        assert!(json.contains("\"exitCode\":1"));
        // Unlike `WorkerInputPayload::preview`, `signal` has no
        // `skip_serializing_if` — it serializes as `null`, matching
        // every other plain `Option` payload field in this codebase
        // (e.g. `WorktreeRemovedPayload::reason`).
        assert!(json.contains("\"signal\":null"));
        let deserialized: SwarmEvent = serde_json::from_str(&json).expect("deserialize");
        if let SwarmEvent::AgentSessionExited(p) = deserialized {
            assert_eq!(p.worker_id, worker_id);
            assert_eq!(p.exit_code, Some(1));
        } else {
            panic!("expected AgentSessionExited variant");
        }
    }

    // ── EventSink emit_with / emit_awaiting_seq ─────────────────────

    #[test]
    fn test_emit_with_carries_provenance_onto_the_writer_channel() {
        let (tx, rx) = std::sync::mpsc::channel::<WriterMsg>();
        let sink = EventSink::new(tx);
        let worker_id = Uuid::new_v4();

        sink.emit_with(
            SwarmEvent::WorkerKilled(WorkerKilledPayload { worker_id }),
            Provenance {
                origin_worker: Some(worker_id),
                cause_seq: Some(9),
            },
        );

        let msg = rx.recv().expect("message on writer channel");
        assert_eq!(msg.provenance.origin_worker, Some(worker_id));
        assert_eq!(msg.provenance.cause_seq, Some(9));
        assert!(msg.ack.is_none());
    }

    #[test]
    fn test_emit_defaults_to_unattributed_provenance() {
        let (tx, rx) = std::sync::mpsc::channel::<WriterMsg>();
        let sink = EventSink::new(tx);
        sink.emit(SwarmEvent::WorkerKilled(WorkerKilledPayload {
            worker_id: Uuid::nil(),
        }));
        let msg = rx.recv().expect("message on writer channel");
        assert_eq!(msg.provenance, Provenance::default());
    }

    /// DIRECTIVE: dropping the `emit_awaiting_seq` receiver must never
    /// stall the writer — the writer-side `ack.send(seq)` is
    /// non-blocking by construction (oneshot semantics), and this pins
    /// that down at the `EventSink` boundary rather than only trusting
    /// the type. See the kill-criterion in the provenance plan.
    #[test]
    fn test_ack_send_after_receiver_dropped_does_not_panic_or_block() {
        let (tx, rx) = std::sync::mpsc::channel::<WriterMsg>();
        let sink = EventSink::new(tx);

        let ack_rx = sink.emit_awaiting_seq(
            SwarmEvent::WorkerKilled(WorkerKilledPayload {
                worker_id: Uuid::nil(),
            }),
            Provenance::default(),
        );
        drop(ack_rx); // caller lost interest before the writer got to it

        let msg = rx.recv().expect("message on writer channel");
        let ack = msg
            .ack
            .expect("emit_awaiting_seq must attach an ack sender");
        // This is the exact call the writer loop makes. It must return
        // without panicking regardless of the (already-dropped) receiver.
        let send_result = ack.send(7);
        assert!(
            send_result.is_err(),
            "send must report the dropped receiver, not hang"
        );
    }

    /// DIRECTIVE (BLOCKING fix, `agent_turn_started` hardening): a
    /// caller awaiting `emit_awaiting_seq`'s receiver through
    /// `tokio::time::timeout` must observe a bounded timeout, not an
    /// indefinite hang, when nothing ever resolves the ack (e.g. a
    /// wedged writer thread that received the message but never reaches
    /// `ack.send(seq)`). This is the exact mechanism
    /// `commands::ai::agent_turn_started` wraps in a 5s timeout; proven
    /// here at the `EventSink` boundary (accessible from swarm-core's
    /// own tests, unlike the desktop-crate command) with a short
    /// duration so the test itself stays fast.
    #[tokio::test]
    async fn test_emit_awaiting_seq_ack_can_be_bounded_with_a_timeout() {
        let (tx, rx) = std::sync::mpsc::channel::<WriterMsg>();
        let sink = EventSink::new(tx);
        // Kept alive (not dropped) — a dropped receiver resolves the ack
        // immediately with a RecvError (see the test above), which is a
        // different code path than a genuine timeout.
        let _rx = rx;

        let ack = sink.emit_awaiting_seq(
            SwarmEvent::WorkerKilled(WorkerKilledPayload {
                worker_id: Uuid::nil(),
            }),
            Provenance::default(),
        );

        let result = tokio::time::timeout(std::time::Duration::from_millis(30), ack).await;
        assert!(
            result.is_err(),
            "an ack nothing ever resolves must time out, not hang forever"
        );
    }
}
