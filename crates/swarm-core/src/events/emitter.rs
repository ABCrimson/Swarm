//! Domain event types and the [`EventSink`] emission seam.
//!
//! Provides a typed event system for broadcasting worker, session,
//! agent, git and system-metrics changes to any shell embedding
//! `swarm-core`. Every event is routed through an [`EventSink`] into
//! the [`crate::orchestration::OrchestrationEngine`], which assigns a
//! monotonic sequence number and hands an ordered envelope to the shell
//! (the Tauri desktop shell emits it on the `swarm://events` webview
//! channel; `swarmd` fans it out to its WebSocket clients).
//!
//! ## Serialization Convention
//!
//! - Event type tags use `snake_case` (e.g., `"worker_spawned"`)
//! - Payload fields use `camelCase` (e.g., `"workerId"`)
//! - This matches the frontend's expected JSON format

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{Sender, SyncSender};

use serde::{Deserialize, Serialize};
use tokio::sync::oneshot;
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
    /// A worker joined a session's `workerIds` list — see
    /// [`crate::session::manager::SessionManager::add_worker_to_session`].
    SessionWorkerAdded(SessionWorkerAddedPayload),
    /// A worker was pruned from a session's `workerIds` list (typically
    /// because the worker was killed or exited) — see
    /// [`crate::session::manager::SessionManager::remove_worker_from_session`].
    SessionWorkerRemoved(SessionWorkerRemovedPayload),
    /// Periodic system metrics snapshot.
    SystemMetrics(SystemMetricsPayload),
    /// A backend log message for the frontend console.
    SystemLog(SystemLogPayload),
    /// A message was sent through the inter-agent bus.
    BusMessage(BusMessagePayload),
    /// A git worktree was created for a worker's isolation.
    WorktreeCreated(WorktreeCreatedPayload),
    /// A git worktree was removed (or preserved, if dirty) at kill time.
    WorktreeRemoved(WorktreeRemovedPayload),
    /// One step of an in-flight ship operation (staging/commit/push/compare).
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
    /// A provider-adapter session started for a worker (see
    /// [`crate::agent::adapter::AgentAdapter::spawn`]).
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
    /// The provider asked a human to approve or deny a tool call, or
    /// reported one it already denied — see
    /// [`AgentPermissionRequestPayload`]'s doc for the two shapes.
    AgentPermissionRequest(AgentPermissionRequestPayload),
    /// Terminal receipt for one turn: exactly one per turn, on success
    /// AND on ungraceful child exit — see
    /// [`crate::agent::adapter::AgentSession::shutdown`] for the
    /// synthesized-on-kill guarantee.
    AgentTurnSettled(AgentTurnSettledPayload),
    /// A provider-adapter session's underlying process exited.
    AgentSessionExited(AgentSessionExitedPayload),
}

/// Generates [`SwarmEvent::type_tag`] and [`SwarmEvent::payload_json`]
/// from one `Variant => "tag"` list. Both are exhaustive `match`es, so
/// a new variant fails to compile until it is listed here; the
/// `test_type_tag_and_payload_json_match_serde_for_every_variant` test
/// pins every literal to the tag `serde` actually writes.
macro_rules! swarm_event_tags {
    ($($variant:ident => $tag:literal),+ $(,)?) => {
        impl SwarmEvent {
            /// How many variants the enum has (keeps the every-variant
            /// test honest).
            #[cfg(test)]
            pub(crate) const VARIANT_COUNT: usize = [$(stringify!($variant)),+].len();

            /// The `snake_case` wire tag of this event (the envelope's
            /// `"type"` field and the event log's `type` column),
            /// without serializing anything.
            pub const fn type_tag(&self) -> &'static str {
                match self {
                    $(Self::$variant(_) => $tag,)+
                }
            }

            /// The event's payload alone (the envelope's `"payload"`
            /// field), serialized straight to a JSON string — the shape
            /// the event log's `payload` column stores.
            pub(crate) fn payload_json(&self) -> serde_json::Result<String> {
                match self {
                    $(Self::$variant(payload) => serde_json::to_string(payload),)+
                }
            }
        }
    };
}

swarm_event_tags! {
    WorkerSpawned => "worker_spawned",
    WorkerKilled => "worker_killed",
    WorkerOutput => "worker_output",
    WorkerState => "worker_state",
    SessionCreated => "session_created",
    SessionDeleted => "session_deleted",
    SessionWorkerAdded => "session_worker_added",
    SessionWorkerRemoved => "session_worker_removed",
    SystemMetrics => "system_metrics",
    SystemLog => "system_log",
    BusMessage => "bus_message",
    WorktreeCreated => "worktree_created",
    WorktreeRemoved => "worktree_removed",
    ShipProgress => "ship_progress",
    ShipSettled => "ship_settled",
    CommitCreated => "commit_created",
    WorkerInput => "worker_input",
    AgentTurnStarted => "agent_turn_started",
    FileWritten => "file_written",
    AgentSessionStarted => "agent_session_started",
    AgentTurnDelta => "agent_turn_delta",
    AgentBlock => "agent_block",
    AgentToolCall => "agent_tool_call",
    AgentToolResult => "agent_tool_result",
    AgentPermissionRequest => "agent_permission_request",
    AgentTurnSettled => "agent_turn_settled",
    AgentSessionExited => "agent_session_exited",
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

/// Payload for the `session_worker_added` event.
///
/// Emitted when a worker joins a session's `workerIds` list — only when
/// membership actually changed (re-adding a current member emits
/// nothing). Persisted, like its [`SessionWorkerRemovedPayload`]
/// counterpart, so a client replaying the log sees membership grow and
/// shrink exactly as a live listener did.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionWorkerAddedPayload {
    /// UUID of the session the worker joined.
    pub session_id: Uuid,
    /// UUID of the added worker.
    pub worker_id: Uuid,
}

/// Payload for the `session_worker_removed` event.
///
/// Emitted when a worker is pruned from a session's `workerIds` list.
/// Persisted (the default policy — see
/// [`crate::orchestration::is_persistent`]); together with
/// `session_worker_added` it lets a backfilling client rebuild the same
/// membership a live listener observed.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionWorkerRemovedPayload {
    /// UUID of the session the worker was removed from.
    pub session_id: Uuid,
    /// UUID of the removed worker.
    pub worker_id: Uuid,
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
    /// Unix timestamp in milliseconds when this snapshot was taken.
    pub timestamp: i64,
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
/// Emitted for each step of a ship operation (`staging`, `commit`,
/// `push`, `compare` — `step` is a free-form string, not a closed enum,
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
    /// Free-form step name: `"staging"`, `"commit"`, `"push"`, `"compare"`.
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
/// instead of polling progress state — the same receipt pattern as
/// `agent_turn_settled`.
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
    /// PR or compare-page URL. Set only when the attempt settles at its
    /// final `compare` step (`ship_compare_url`); `null` when it settles
    /// at the commit or push step, or fails.
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
/// or misspelled source value fails IPC *deserialization* outright
/// — the command errors before any PTY write or event emission happens
/// — instead of reading as "not terminal" and persisting or previewing
/// what are raw human keystrokes.
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
    /// classes that get a redacted preview and persist normally.
    pub fn is_machine_issued(self) -> bool {
        !matches!(self, InputSource::Terminal)
    }
}

/// Payload for the `worker_input` event.
///
/// Emitted from [`crate::worker::lifecycle::do_worker_input`] AFTER a
/// successful `write_to_pty`. Never carries raw keystrokes: `preview`
/// is populated only for `source ∈ {tool, automation}` — human
/// terminal keystrokes get a byte count only (see the
/// persistence carve-out in [`crate::orchestration::is_persistent`],
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
    /// At most 120 characters of the redacted text (recognized
    /// credentials masked, invisible code points dropped, CR and LF read
    /// as spaces), or `[preview withheld: line editing]` when the input
    /// contains any control other than CR or LF (BS, DEL, TAB, ESC, C1
    /// controls): the shell would read an edited line the preview cannot
    /// reproduce. CR overwrite is not modelled. `None` for `source == "terminal"` — see the struct
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
    /// Model identifier used for this turn (e.g. `"claude-sonnet-5-5"`).
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
/// turn.
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
/// Persisted. Carries one of two shapes, depending on what the
/// provider's protocol can do:
///
/// - **A pending request** (the session advertises
///   [`Capabilities::interactive_permissions`]): the provider is
///   blocked on a human decision, answered through the
///   `agent_permission_respond` command
///   ([`crate::agent::adapter::AgentSession::respond_permission`]).
///   [`Self::denial_subclass`] and [`Self::message`] are absent.
/// - **A denial report**: the provider already refused the call on its
///   own (for example because the active permission mode disallows
///   it). Nothing is left to decide, so `suggested_decision` is
///   `Some(`[`PermissionDecision::Deny`]`)` and
///   `denial_subclass`/`message` carry the provider-observed detail.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentPermissionRequestPayload {
    /// UUID of the worker whose turn is asking for permission.
    pub worker_id: Uuid,
    /// Correlation id for the turn this request belongs to.
    pub turn_id: TurnId,
    /// Correlation id for this specific permission request, echoed
    /// back by `agent_permission_respond`.
    pub request_id: PermissionId,
    /// Name of the tool awaiting approval.
    pub tool: String,
    /// The tool's proposed input, for display before approval.
    /// `Value::Null` when the provider did not report it (some denial
    /// reports carry only the tool's name).
    pub input: serde_json::Value,
    /// The provider's own suggested decision, when it has one —
    /// advisory only, never auto-applied by SWARM. Always
    /// `Some(Deny)` for a denial report. Omitted from the wire (not
    /// `null`) when absent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub suggested_decision: Option<PermissionDecision>,
    /// Best-effort classification of WHY the provider denied the call
    /// (e.g. `"mode"`, `"ungranted_write"`, `"redirection_guard"`),
    /// derived by the adapter from the provider's own denial fields.
    /// Free-form, not a closed enum: it classifies provider-CLI text,
    /// not a SWARM-owned vocabulary. Omitted from the wire when absent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub denial_subclass: Option<String>,
    /// The provider's human-readable denial message, verbatim, for a
    /// denial report. Omitted from the wire when absent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

/// Payload for the `agent_turn_settled` receipt.
///
/// Persisted. Emitted exactly once per turn, on success AND on
/// ungraceful child exit — see
/// [`crate::agent::adapter::AgentSession::shutdown`].
/// `cost_usd`/`usage` are `None` on a synthesized (kill-path)
/// settlement — the provider's terminal result, the only source of
/// truth for cost, is never observed on a kill.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentTurnSettledPayload {
    /// UUID of the worker this turn belongs to.
    pub worker_id: Uuid,
    /// Correlation id for the settled turn.
    pub turn_id: TurnId,
    /// `"ok"` or `"error"` — a closed enum, unlike the older
    /// `ship_settled` receipt's plain-string `status`.
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

/// One event on the writer channel: the event to order/persist/emit,
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
    pub(crate) ack: Option<oneshot::Sender<u64>>,
}

/// Everything the single writer thread can be asked to do. The channel
/// is FIFO, so both barriers below observe every event queued before
/// them.
#[expect(
    clippy::large_enum_variant,
    reason = "Record is the hot variant; boxing it would add an allocation per event to shrink two rare control messages"
)]
pub(crate) enum WriterCmd {
    /// Order, persist (per policy) and emit one event.
    Record(WriterMsg),
    /// Barrier: resolves with the head seq once every command queued
    /// before it has been persisted and emitted — see
    /// [`crate::orchestration::OrchestrationEngine::flush`].
    Flush(oneshot::Sender<u64>),
    /// Barrier, then finalize the log and stop the writer thread;
    /// resolves with the final head seq, or why the log could not be
    /// finalized — see
    /// [`crate::orchestration::OrchestrationEngine::shutdown`].
    Shutdown(SyncSender<Result<u64, String>>),
}

/// Where an [`EventSink`] delivers.
#[derive(Clone)]
enum Outlet {
    /// The engine's writer thread.
    Writer(Sender<WriterCmd>),
    /// A plain channel a unit test reads events back from.
    #[cfg(test)]
    Capture(Sender<WriterMsg>),
}

/// A cloneable handle for recording [`SwarmEvent`]s into the
/// [`crate::orchestration::OrchestrationEngine`]'s ordered pipeline.
///
/// Obtained via [`crate::orchestration::OrchestrationEngine::sink`]:
/// there is no way to build one before the engine exists, so no call
/// site ever has to handle "the engine is not up yet".
#[derive(Clone)]
pub struct EventSink {
    outlet: Outlet,
    /// Set once the engine starts shutting down: later events are
    /// dropped with a debug log instead of queueing behind a writer
    /// that will never process them.
    closed: Arc<AtomicBool>,
}

impl EventSink {
    /// Wraps the writer channel. Called only by
    /// [`crate::orchestration::OrchestrationEngine::try_start`], which
    /// keeps a clone of `closed` to flip at shutdown.
    pub(crate) fn for_writer(tx: Sender<WriterCmd>, closed: Arc<AtomicBool>) -> Self {
        Self {
            outlet: Outlet::Writer(tx),
            closed,
        }
    }

    /// A sink that delivers every event to `tx` instead of a writer
    /// thread, so a unit test can assert on exactly what a function
    /// emits (no seqs are assigned, nothing is persisted).
    #[cfg(test)]
    pub(crate) fn new(tx: Sender<WriterMsg>) -> Self {
        Self {
            outlet: Outlet::Capture(tx),
            closed: Arc::default(),
        }
    }

    /// Queues a control command (a flush or shutdown barrier) behind
    /// every event already queued. `false` when there is no live writer
    /// thread to receive it.
    pub(crate) fn send_command(&self, cmd: WriterCmd) -> bool {
        match &self.outlet {
            Outlet::Writer(tx) => tx.send(cmd).is_ok(),
            #[cfg(test)]
            Outlet::Capture(_) => false,
        }
    }

    /// Hands one event to the writer thread, or drops it (logged) when
    /// the engine is shutting down or its writer thread is gone. A
    /// dropped event's ack sender is dropped with it.
    fn record(&self, msg: WriterMsg) {
        let event_type = msg.event.type_tag();
        if self.closed.load(Ordering::Acquire) {
            tracing::debug!(event_type, "event engine is shut down; event dropped");
            return;
        }
        let delivered = match &self.outlet {
            Outlet::Writer(tx) => tx.send(WriterCmd::Record(msg)).is_ok(),
            #[cfg(test)]
            Outlet::Capture(tx) => tx.send(msg).is_ok(),
        };
        if !delivered {
            tracing::error!(event_type, "event writer thread is gone; event dropped");
        }
    }

    /// Records an event for ordering, persistence, and emission, with
    /// no causal attribution (`Provenance::default()` — unattributed,
    /// not a guess).
    ///
    /// Fire-and-forget: the dedicated writer thread assigns a sequence
    /// number, persists (per policy), and emits the ordered envelope.
    /// If the engine has shut down (or its writer thread is gone), the
    /// event is dropped with a log line rather than panicking.
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
    /// `from_worker`, a turn's own recorded seq — never an inferred
    /// "current cause" guess.
    pub fn emit_with(&self, event: SwarmEvent, provenance: Provenance) {
        self.record(WriterMsg {
            event,
            provenance,
            ack: None,
        });
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
    /// never blocks on, or even notices, a disinterested receiver. If
    /// the event is dropped instead (engine shut down, writer gone, or
    /// the writer could not reserve its seq or persist it — it fails
    /// closed and emits nothing for an event the log lacks), the ack
    /// sender is dropped with it, so the receiver resolves to a
    /// `RecvError` rather than hanging forever.
    pub fn emit_awaiting_seq(
        &self,
        event: SwarmEvent,
        provenance: Provenance,
    ) -> oneshot::Receiver<u64> {
        let (ack_tx, ack_rx) = oneshot::channel();
        self.record(WriterMsg {
            event,
            provenance,
            ack: Some(ack_tx),
        });
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
        assert!(json.contains("\"workerId\""));
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

    /// `memory_total_mb` carries the real RAM total so the frontend never
    /// assumes 16GB (which showed usage above 100%). This locks in its
    /// wire name (`memoryTotalMb`) and that it survives a
    /// serialize/deserialize roundtrip untouched.
    #[test]
    fn test_system_metrics_memory_total_mb_roundtrip() {
        let event = SwarmEvent::SystemMetrics(SystemMetricsPayload {
            cpu_percent: 12.0,
            memory_mb: 35_389.0,
            memory_total_mb: 262_144.0, // 256GB machine from the bug report
            worker_count: 1,
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
            assert!((p.memory_mb - 35_389.0).abs() < f64::EPSILON);
        } else {
            panic!("expected SystemMetrics variant");
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
        assert!(json.contains("\"sessionId\""));
        let deserialized: SwarmEvent = serde_json::from_str(&json).expect("deserialize");
        if let SwarmEvent::SessionCreated(p) = deserialized {
            assert_eq!(p.session_id, id);
            assert_eq!(p.name, "My Session");
        } else {
            panic!("expected SessionCreated variant");
        }
    }

    #[test]
    fn test_session_worker_removed_roundtrip() {
        let session_id = Uuid::new_v4();
        let worker_id = Uuid::new_v4();
        let event = SwarmEvent::SessionWorkerRemoved(SessionWorkerRemovedPayload {
            session_id,
            worker_id,
        });
        let json = serde_json::to_string(&event).expect("serialize");
        assert!(json.contains("\"type\":\"session_worker_removed\""));
        let deserialized: SwarmEvent = serde_json::from_str(&json).expect("deserialize");
        if let SwarmEvent::SessionWorkerRemoved(p) = deserialized {
            assert_eq!(p.session_id, session_id);
            assert_eq!(p.worker_id, worker_id);
        } else {
            panic!("expected SessionWorkerRemoved variant");
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
        assert!(json.contains("\"workerId\""));
        assert!(json.contains("\"worktreePath\""));
        assert!(json.contains("\"headCommit\":\"sha123\""));
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

    /// `source` is a closed, typed enum — an
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
            model: "claude-sonnet-5-5".to_string(),
            request_id: "turn-1".to_string(),
        });
        let json = serde_json::to_string(&event).expect("serialize");
        assert!(json.contains("\"type\":\"agent_turn_started\""));
        assert!(json.contains("\"requestId\":\"turn-1\""));
        let deserialized: SwarmEvent = serde_json::from_str(&json).expect("deserialize");
        if let SwarmEvent::AgentTurnStarted(p) = deserialized {
            assert_eq!(p.worker_id, worker_id);
            assert_eq!(p.model, "claude-sonnet-5-5");
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
                interactive_permissions: false,
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
            denial_subclass: None,
            message: None,
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

        // A synthesized settlement on ungraceful exit carries no cost
        // data — honestly None, not a fabricated 0.
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

    /// `status` is a closed enum, not a bare
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

    // ── type_tag / payload_json ─────────────────────────────────────

    /// One instance of every variant, in declaration order.
    fn one_of_each_variant() -> Vec<SwarmEvent> {
        use crate::agent::adapter::{
            AgentTurnStatus, CancelGranularity, Capabilities, PermissionDecision, ProviderId,
        };

        let id = Uuid::nil();
        vec![
            SwarmEvent::WorkerSpawned(WorkerSpawnedPayload {
                worker_id: id,
                name: "w".to_string(),
                pid: Some(1),
                isolation: None,
            }),
            SwarmEvent::WorkerKilled(WorkerKilledPayload { worker_id: id }),
            SwarmEvent::WorkerOutput(WorkerOutputPayload {
                worker_id: id,
                data: "out".to_string(),
            }),
            SwarmEvent::WorkerState(WorkerStatePayload {
                worker_id: id,
                state: WorkerState::Running,
            }),
            SwarmEvent::SessionCreated(SessionCreatedPayload {
                session_id: id,
                name: "s".to_string(),
            }),
            SwarmEvent::SessionDeleted(SessionDeletedPayload { session_id: id }),
            SwarmEvent::SessionWorkerAdded(SessionWorkerAddedPayload {
                session_id: id,
                worker_id: id,
            }),
            SwarmEvent::SessionWorkerRemoved(SessionWorkerRemovedPayload {
                session_id: id,
                worker_id: id,
            }),
            SwarmEvent::SystemMetrics(SystemMetricsPayload {
                cpu_percent: 1.0,
                memory_mb: 2.0,
                memory_total_mb: 3.0,
                worker_count: 4,
                timestamp: 5,
            }),
            SwarmEvent::SystemLog(SystemLogPayload {
                level: "info".to_string(),
                message: "m".to_string(),
                target: "t".to_string(),
                timestamp: 6,
            }),
            SwarmEvent::BusMessage(BusMessagePayload {
                message_id: id,
                from_worker: id,
                to_worker: None,
                topic: "topic".to_string(),
                payload: serde_json::json!({"k": 1}),
            }),
            SwarmEvent::WorktreeCreated(WorktreeCreatedPayload {
                worker_id: id,
                session_id: None,
                repo_root: "/r".to_string(),
                worktree_path: "/r-wt".to_string(),
                branch: "b".to_string(),
                base_commit: "c".to_string(),
            }),
            SwarmEvent::WorktreeRemoved(WorktreeRemovedPayload {
                worker_id: id,
                worktree_path: "/r-wt".to_string(),
                branch: "b".to_string(),
                disposition: "removed".to_string(),
                head_commit: None,
                reason: None,
            }),
            SwarmEvent::ShipProgress(ShipProgressPayload {
                ship_id: id,
                worker_id: id,
                step: "push".to_string(),
                status: "ok".to_string(),
                detail: None,
            }),
            SwarmEvent::ShipSettled(ShipSettledPayload {
                ship_id: id,
                worker_id: id,
                commit_sha: None,
                pushed_ref: None,
                pr_url: None,
                status: "ok".to_string(),
                error: None,
            }),
            SwarmEvent::CommitCreated(CommitCreatedPayload {
                worker_id: id,
                sha: "c".to_string(),
                branch: "b".to_string(),
                seq_from: 1,
                seq_to: 2,
            }),
            SwarmEvent::WorkerInput(WorkerInputPayload {
                worker_id: id,
                bytes: 1,
                source: InputSource::Tool,
                preview: Some("x".to_string()),
            }),
            SwarmEvent::AgentTurnStarted(AgentTurnStartedPayload {
                worker_id: id,
                model: "m".to_string(),
                request_id: "r".to_string(),
            }),
            SwarmEvent::FileWritten(FileWrittenPayload {
                path: "/f".to_string(),
                bytes: 1,
            }),
            SwarmEvent::AgentSessionStarted(AgentSessionStartedPayload {
                worker_id: id,
                provider: ProviderId::Codex,
                session_key: "k".to_string(),
                model: "m".to_string(),
                cwd: "/".to_string(),
                capabilities: Capabilities {
                    partial_deltas: false,
                    resume: false,
                    native_cost: false,
                    permission_modes: vec![],
                    cancel_granularity: CancelGranularity::KillOnly,
                    interrupt_midturn: false,
                    worktree_aware: false,
                    interactive_permissions: true,
                },
            }),
            SwarmEvent::AgentTurnDelta(AgentTurnDeltaPayload {
                worker_id: id,
                turn_id: "t".to_string(),
                block_index: 0,
                kind: "text".to_string(),
                text: "d".to_string(),
            }),
            SwarmEvent::AgentBlock(AgentBlockPayload {
                worker_id: id,
                turn_id: "t".to_string(),
                block_index: 0,
                kind: "text".to_string(),
                content: serde_json::json!("b"),
            }),
            SwarmEvent::AgentToolCall(AgentToolCallPayload {
                worker_id: id,
                turn_id: "t".to_string(),
                tool_use_id: "u".to_string(),
                name: "n".to_string(),
                input: serde_json::json!({}),
            }),
            SwarmEvent::AgentToolResult(AgentToolResultPayload {
                worker_id: id,
                turn_id: "t".to_string(),
                tool_use_id: "u".to_string(),
                is_error: false,
                content: serde_json::json!(null),
            }),
            SwarmEvent::AgentPermissionRequest(AgentPermissionRequestPayload {
                worker_id: id,
                turn_id: "t".to_string(),
                request_id: "p".to_string(),
                tool: "Bash".to_string(),
                input: serde_json::json!({}),
                suggested_decision: Some(PermissionDecision::Deny),
                denial_subclass: Some("mode".to_string()),
                message: None,
            }),
            SwarmEvent::AgentTurnSettled(AgentTurnSettledPayload {
                worker_id: id,
                turn_id: "t".to_string(),
                status: AgentTurnStatus::Ok,
                error: None,
                cost_usd: None,
                usage: None,
                duration_ms: 1,
                num_turns: None,
            }),
            SwarmEvent::AgentSessionExited(AgentSessionExitedPayload {
                worker_id: id,
                exit_code: Some(0),
                signal: None,
            }),
        ]
    }

    /// `type_tag`/`payload_json` must agree with what `serde` writes for
    /// every variant — they replace a full `serde_json::Value`
    /// round-trip on the writer's hot path, so a drifted literal would
    /// persist rows under a tag no reader recognizes.
    #[test]
    fn test_type_tag_and_payload_json_match_serde_for_every_variant() {
        let events = one_of_each_variant();
        assert_eq!(
            events.len(),
            SwarmEvent::VARIANT_COUNT,
            "one_of_each_variant() must list every variant"
        );
        let mut tags = std::collections::HashSet::new();
        for event in &events {
            let tagged = serde_json::to_value(event).expect("serialize");
            assert_eq!(tagged["type"], event.type_tag());
            let payload: serde_json::Value =
                serde_json::from_str(&event.payload_json().expect("payload_json")).unwrap();
            assert_eq!(payload, tagged["payload"], "{}", event.type_tag());
            assert!(
                tags.insert(event.type_tag()),
                "duplicate tag {}",
                event.type_tag()
            );
        }
    }

    // ── EventSink ────────────────────────────────────────────────────

    /// A capture sink over a fresh channel, plus the receiving end.
    fn sink() -> (EventSink, std::sync::mpsc::Receiver<WriterMsg>) {
        let (tx, rx) = std::sync::mpsc::channel();
        (EventSink::new(tx), rx)
    }

    fn recv_record(rx: &std::sync::mpsc::Receiver<WriterMsg>) -> WriterMsg {
        rx.recv().expect("an event on the capture channel")
    }

    fn killed() -> SwarmEvent {
        SwarmEvent::WorkerKilled(WorkerKilledPayload {
            worker_id: Uuid::nil(),
        })
    }

    #[test]
    fn test_emit_with_carries_provenance_onto_the_writer_channel() {
        let (sink, rx) = sink();
        let worker_id = Uuid::new_v4();
        sink.emit_with(
            killed(),
            Provenance {
                origin_worker: Some(worker_id),
                cause_seq: Some(9),
            },
        );

        let msg = recv_record(&rx);
        assert_eq!(msg.provenance.origin_worker, Some(worker_id));
        assert_eq!(msg.provenance.cause_seq, Some(9));
        assert!(msg.ack.is_none());
    }

    #[test]
    fn test_emit_defaults_to_unattributed_provenance() {
        let (sink, rx) = sink();
        sink.emit(killed());
        assert_eq!(recv_record(&rx).provenance, Provenance::default());
    }

    /// `emit_awaiting_seq` attaches its ack sender to the recorded message;
    /// the writer loop's handling of a dropped receiver is covered by
    /// `orchestration::engine`'s `test_writer_loop_survives_dropped_ack_receiver`.
    #[test]
    fn test_emit_awaiting_seq_attaches_an_ack_sender() {
        let (sink, rx) = sink();
        let _ack_rx = sink.emit_awaiting_seq(killed(), Provenance::default());
        assert!(
            recv_record(&rx).ack.is_some(),
            "emit_awaiting_seq must attach an ack sender"
        );
    }

    /// An ack nothing ever resolves (a wedged writer that received the
    /// message but never reaches `ack.send`) can be bounded with a
    /// timeout, as `commands::agent::agent_turn_started` does.
    #[tokio::test]
    async fn test_emit_awaiting_seq_ack_can_be_bounded_with_a_timeout() {
        let (sink, _rx) = sink();
        let ack = sink.emit_awaiting_seq(killed(), Provenance::default());
        let result = tokio::time::timeout(std::time::Duration::from_millis(30), ack).await;
        assert!(result.is_err(), "an unresolved ack must time out, not hang");
    }

    /// Once the engine is shutting down, events are dropped at the sink
    /// (never queued behind a writer that will not process them), and an
    /// awaited seq resolves to an error instead of hanging.
    #[tokio::test]
    async fn test_a_closed_sink_drops_events_and_fails_acks() {
        let (tx, rx) = std::sync::mpsc::channel();
        let sink = EventSink::for_writer(tx, Arc::new(AtomicBool::new(true)));

        sink.emit(killed());
        let ack = sink.emit_awaiting_seq(killed(), Provenance::default());
        assert!(ack.await.is_err());
        assert!(rx.try_recv().is_err(), "nothing reached the writer channel");
    }
}
