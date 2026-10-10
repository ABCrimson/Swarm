//! Wire types for the subset of the `codex app-server` v2 protocol that
//! [`super::CodexSession`] speaks.
//!
//! Transcribed from the schema codex-cli 0.156.1 generates
//! (`codex app-server generate-json-schema` / `generate-ts`) and checked
//! against live 0.156.1 handshakes. Field names and casing follow that
//! schema exactly. Everything the adapter does not read is left out —
//! serde ignores unknown fields — so a newer server that adds fields stays
//! compatible.
//!
//! The envelope is JSON-RPC 2.0 without the `"jsonrpc": "2.0"` member:
//! the server neither sends nor requires it, and its own serializer omits
//! it. A message with `method` and `id` is a request, `method` without
//! `id` a notification, and `id` without `method` a response (`result`)
//! or error response (`error`).

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// The codex-cli release these shapes were verified against.
pub const VERIFIED_CODEX_VERSION: &str = "0.156.1";

/// Method names, grouped by direction.
pub mod method {
    // ── Client -> server requests ─────────────────────────────────────
    /// First request on every connection; anything else before it is
    /// answered with `-32600 Not initialized`.
    pub const INITIALIZE: &str = "initialize";
    /// Starts a new conversation thread.
    pub const THREAD_START: &str = "thread/start";
    /// Re-opens a persisted thread by id.
    pub const THREAD_RESUME: &str = "thread/resume";
    /// Submits one user turn on an open thread.
    pub const TURN_START: &str = "turn/start";
    /// Stops the running turn; it then completes with status
    /// `interrupted`.
    pub const TURN_INTERRUPT: &str = "turn/interrupt";

    // ── Client -> server notification ─────────────────────────────────
    /// Acknowledges the `initialize` response.
    pub const INITIALIZED: &str = "initialized";

    // ── Server -> client notifications ────────────────────────────────
    /// A turn error; `willRetry: false` means the turn will fail.
    pub const ERROR: &str = "error";
    /// A turn began (carries the turn id).
    pub const TURN_STARTED: &str = "turn/started";
    /// A turn reached a terminal status.
    pub const TURN_COMPLETED: &str = "turn/completed";
    /// A thread item (message, reasoning, tool call, ...) began.
    pub const ITEM_STARTED: &str = "item/started";
    /// A thread item finished, carrying its final content.
    pub const ITEM_COMPLETED: &str = "item/completed";
    /// Streamed text of an `agentMessage` item.
    pub const AGENT_MESSAGE_DELTA: &str = "item/agentMessage/delta";
    /// Streamed text of a `reasoning` item's summary.
    pub const REASONING_SUMMARY_TEXT_DELTA: &str = "item/reasoning/summaryTextDelta";
    /// Streamed text of a `reasoning` item's raw content.
    pub const REASONING_TEXT_DELTA: &str = "item/reasoning/textDelta";
    /// Streamed stdout/stderr of a `commandExecution` item (opted out of at
    /// `initialize`; the completed item's `aggregatedOutput` carries it whole).
    pub const COMMAND_EXECUTION_OUTPUT_DELTA: &str = "item/commandExecution/outputDelta";
    /// Token usage for a thread's turn.
    pub const THREAD_TOKEN_USAGE_UPDATED: &str = "thread/tokenUsage/updated";
    /// The server withdrew one of its own pending requests (for example
    /// an approval whose turn was interrupted).
    pub const SERVER_REQUEST_RESOLVED: &str = "serverRequest/resolved";

    // ── Server -> client requests ─────────────────────────────────────
    /// Approve a shell command.
    pub const COMMAND_EXECUTION_REQUEST_APPROVAL: &str = "item/commandExecution/requestApproval";
    /// Approve a patch (file change).
    pub const FILE_CHANGE_REQUEST_APPROVAL: &str = "item/fileChange/requestApproval";
    /// Grant extra sandbox permissions (network, file-system roots).
    pub const PERMISSIONS_REQUEST_APPROVAL: &str = "item/permissions/requestApproval";
}

/// Server notifications this adapter never reads, opted out of at
/// `initialize` (`capabilities.optOutNotificationMethods`) so the server
/// does not serialize them onto the pipe at all.
pub const OPTED_OUT_NOTIFICATIONS: &[&str] = &[
    "thread/started",
    "account/updated",
    "account/rateLimits/updated",
    "remoteControl/status/changed",
    "mcpServer/startupStatus/updated",
    "item/reasoning/summaryPartAdded",
    "item/plan/delta",
    "item/commandExecution/outputDelta",
    "turn/diff/updated",
    "turn/plan/updated",
    "skills/changed",
    "app/list/updated",
];

/// JSON-RPC "method not found" — the answer to every server request this
/// adapter does not implement.
pub const METHOD_NOT_FOUND: i64 = -32601;

/// JSON-RPC "invalid params" — the answer to an approval request whose
/// parameters do not match the schema.
pub const INVALID_PARAMS: i64 = -32602;

/// A JSON-RPC request id: the schema allows an integer or a string, and a
/// response must echo the id with its original type.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(untagged)]
pub enum RequestId {
    /// A numeric id (the only kind this adapter mints).
    Integer(i64),
    /// A string id.
    String(String),
}

// ── Envelopes ────────────────────────────────────────────────────────

/// Any line the server writes, before it is classified.
#[derive(Debug, Deserialize)]
pub struct Incoming {
    /// Present on requests and responses.
    #[serde(default)]
    pub id: Option<RequestId>,
    /// Present on requests and notifications.
    #[serde(default)]
    pub method: Option<String>,
    /// Request/notification parameters (`Null` when absent).
    #[serde(default)]
    pub params: Value,
    /// A successful response's payload.
    #[serde(default)]
    pub result: Option<Value>,
    /// An error response's payload.
    #[serde(default)]
    pub error: Option<RpcError>,
}

/// The `error` member of a JSON-RPC error response.
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct RpcError {
    /// JSON-RPC error code (`-32600` for invalid/rejected requests).
    pub code: i64,
    /// Human-readable description, verbatim from the server.
    pub message: String,
}

impl std::fmt::Display for RpcError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{} (code {})", self.message, self.code)
    }
}

/// A client -> server request.
#[derive(Debug, Serialize)]
pub struct Request<'a, P> {
    /// Correlates the server's response.
    pub id: i64,
    /// One of the client-request [`method`] names.
    pub method: &'a str,
    /// The method's parameters.
    pub params: P,
}

/// A client -> server notification without parameters.
#[derive(Debug, Serialize)]
pub struct Notification<'a> {
    /// One of the client-notification [`method`] names.
    pub method: &'a str,
}

/// A successful answer to a server request.
#[derive(Debug, Serialize)]
pub struct Response<R> {
    /// The server request's id, echoed with its original type.
    pub id: RequestId,
    /// The answer.
    pub result: R,
}

/// An error answer to a server request.
#[derive(Debug, Serialize)]
pub struct ErrorResponse<'a> {
    /// The server request's id, echoed with its original type.
    pub id: RequestId,
    /// What went wrong.
    pub error: ErrorObject<'a>,
}

/// The `error` member of an [`ErrorResponse`].
#[derive(Debug, Serialize)]
pub struct ErrorObject<'a> {
    /// JSON-RPC error code.
    pub code: i64,
    /// Human-readable description.
    pub message: &'a str,
}

// ── Handshake ────────────────────────────────────────────────────────

/// `initialize` parameters.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InitializeParams<'a> {
    /// Identifies this client (it becomes part of the server's user agent).
    pub client_info: ClientInfo<'a>,
    /// Negotiated connection capabilities.
    pub capabilities: InitializeCapabilities<'a>,
}

/// `initialize.clientInfo`.
#[derive(Debug, Serialize)]
pub struct ClientInfo<'a> {
    /// Machine-readable client name.
    pub name: &'a str,
    /// Human-readable client name.
    pub title: &'a str,
    /// Client version.
    pub version: &'a str,
}

/// `initialize.capabilities`.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InitializeCapabilities<'a> {
    /// Experimental methods and fields stay off: this adapter uses only
    /// the stable surface.
    pub experimental_api: bool,
    /// This client does not answer `attestation/generate`.
    pub request_attestation: bool,
    /// Notifications the server should not send on this connection.
    pub opt_out_notification_methods: &'a [&'a str],
}

/// The `initialize` response (only logged).
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InitializeResponse {
    /// The server's user agent, including its version.
    pub user_agent: String,
}

/// `approvalPolicy` values this adapter can send. `never` (skip every
/// approval) is deliberately absent, so it cannot be constructed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum AskForApproval {
    /// Ask before any command outside the trusted read-only set.
    Untrusted,
    /// The model decides when to ask.
    OnRequest,
}

impl AskForApproval {
    /// The wire token, as the server echoes it back.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Untrusted => "untrusted",
            Self::OnRequest => "on-request",
        }
    }
}

/// `sandbox` values this adapter can send. `danger-full-access` is
/// deliberately absent, so it cannot be constructed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum SandboxMode {
    /// No writes anywhere.
    ReadOnly,
    /// Writes confined to the workspace (the thread's `cwd`).
    WorkspaceWrite,
}

impl SandboxMode {
    /// The `sandbox.type` the server reports for this mode in a
    /// `thread/start`/`thread/resume` response.
    pub fn effective_type(self) -> &'static str {
        match self {
            Self::ReadOnly => "readOnly",
            Self::WorkspaceWrite => "workspaceWrite",
        }
    }
}

/// `thread/start` parameters. The sandbox key is `sandbox` — a
/// `sandboxPolicy` key here would be silently ignored by the server,
/// leaving the user's configured default sandbox in force.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadStartParams<'a> {
    /// Working directory for the thread.
    pub cwd: &'a str,
    /// Model override; omitted to use the server's configured default.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<&'a str>,
    /// When to ask for approval.
    pub approval_policy: AskForApproval,
    /// Sandbox mode.
    pub sandbox: SandboxMode,
}

/// `thread/resume` parameters — the same overrides as
/// [`ThreadStartParams`], so a resumed thread runs under the tier it is
/// resumed with rather than whatever it was persisted with.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadResumeParams<'a> {
    /// The thread to re-open.
    pub thread_id: &'a str,
    /// Working directory for the thread.
    pub cwd: &'a str,
    /// Model override; omitted to keep the thread's model.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<&'a str>,
    /// When to ask for approval.
    pub approval_policy: AskForApproval,
    /// Sandbox mode.
    pub sandbox: SandboxMode,
    /// Skip hydrating the thread's history into the response — the
    /// transcript already lives in SWARM's event log.
    pub exclude_turns: bool,
}

/// The `thread/start` and `thread/resume` response (the fields read).
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadOpened {
    /// The thread.
    pub thread: ThreadRef,
    /// The model the thread will use.
    pub model: String,
    /// The approval policy the server actually applied: a string token,
    /// or an object for the experimental `granular` policy.
    pub approval_policy: Value,
    /// The sandbox policy the server actually applied.
    pub sandbox: EffectiveSandbox,
}

/// A thread reference.
#[derive(Debug, Deserialize)]
pub struct ThreadRef {
    /// Thread id (a UUIDv7).
    pub id: String,
}

/// The applied sandbox policy's discriminant (`readOnly`,
/// `workspaceWrite`, `externalSandbox`, `dangerFullAccess`).
#[derive(Debug, Deserialize)]
pub struct EffectiveSandbox {
    /// The policy kind.
    #[serde(rename = "type")]
    pub kind: String,
}

// ── Turns ────────────────────────────────────────────────────────────

/// `turn/start` parameters.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnStartParams<'a> {
    /// The thread to run the turn on.
    pub thread_id: &'a str,
    /// The user's input.
    pub input: [UserInput<'a>; 1],
}

/// One `turn/start` input item.
#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum UserInput<'a> {
    /// Plain text.
    Text {
        /// The prompt.
        text: &'a str,
        /// UI-defined spans within `text` (none — SWARM sends plain text).
        text_elements: [(); 0],
    },
}

/// `turn/interrupt` parameters.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnInterruptParams<'a> {
    /// The turn's thread.
    pub thread_id: &'a str,
    /// The turn to stop.
    pub turn_id: &'a str,
}

/// The `turn/start` response.
#[derive(Debug, Deserialize)]
pub struct TurnStartResponse {
    /// The accepted turn.
    pub turn: Turn,
}

/// A turn (the fields read).
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Turn {
    /// Turn id (a UUIDv7).
    pub id: String,
    /// Lifecycle status.
    pub status: TurnStatus,
    /// Populated when `status` is `failed` (and sometimes `interrupted`).
    #[serde(default)]
    pub error: Option<TurnError>,
    /// Wall-clock duration, once known (signed on the wire).
    #[serde(default)]
    pub duration_ms: Option<i64>,
}

/// A turn's lifecycle status.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TurnStatus {
    /// Finished normally.
    Completed,
    /// Stopped by `turn/interrupt`.
    Interrupted,
    /// Failed; `Turn::error` says why.
    Failed,
    /// Still running.
    InProgress,
    /// A status newer than this adapter.
    #[serde(other)]
    Unknown,
}

/// A turn's error.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnError {
    /// Human-readable description, verbatim from the server.
    pub message: String,
    /// Extra detail, when the server has any.
    #[serde(default)]
    pub additional_details: Option<String>,
}

impl TurnError {
    /// `message`, with `additionalDetails` appended when present.
    pub fn describe(&self) -> String {
        match self.additional_details.as_deref().map(str::trim) {
            Some(details) if !details.is_empty() => format!("{} ({details})", self.message),
            _ => self.message.clone(),
        }
    }
}

/// `turn/started` and `turn/completed` parameters.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnNotification {
    /// The turn's thread.
    pub thread_id: String,
    /// The turn.
    pub turn: Turn,
}

/// `error` notification parameters.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ErrorNotification {
    /// What went wrong.
    pub error: TurnError,
    /// `true` while the server is still retrying on its own.
    pub will_retry: bool,
    /// The affected thread.
    pub thread_id: String,
    /// The affected turn.
    pub turn_id: String,
}

/// `thread/tokenUsage/updated` parameters.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenUsageNotification {
    /// The thread.
    pub thread_id: String,
    /// The turn the usage belongs to.
    pub turn_id: String,
    /// `{ total, last, modelContextWindow }`, forwarded verbatim.
    pub token_usage: Value,
}

/// `serverRequest/resolved` parameters.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerRequestResolved {
    /// The withdrawn request's id.
    pub request_id: RequestId,
}

// ── Items ────────────────────────────────────────────────────────────

/// `item/started` and `item/completed` parameters. The item stays raw so
/// it can be forwarded verbatim; [`Item`] is a typed view over it.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ItemNotification {
    /// The item, as the server sent it.
    pub item: Value,
    /// The item's thread.
    pub thread_id: String,
    /// The item's turn.
    pub turn_id: String,
}

/// Streamed-text notification parameters (`item/agentMessage/delta`,
/// `item/reasoning/*Delta`).
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeltaNotification {
    /// The item's thread.
    pub thread_id: String,
    /// The item's turn.
    pub turn_id: String,
    /// The item the text belongs to.
    pub item_id: String,
    /// The text chunk.
    pub delta: String,
    /// Which part of the item the text belongs to: `summaryIndex` on
    /// `summaryTextDelta`, `contentIndex` on `textDelta`, absent
    /// elsewhere. A new index starts a new paragraph.
    #[serde(default, rename = "summaryIndex", alias = "contentIndex")]
    pub part_index: Option<i64>,
}

/// Typed view of the thread-item kinds this adapter maps. Kinds it does
/// not map (plans, web searches, compactions, collaboration calls, ...)
/// fall into [`Item::Other`] and are forwarded verbatim.
#[derive(Debug, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Item {
    /// Echo of the user's own input.
    UserMessage,
    /// Assistant text.
    AgentMessage {
        /// Item id.
        id: String,
        /// The full message text.
        text: String,
    },
    /// Model reasoning.
    Reasoning {
        /// Item id.
        id: String,
        /// Reasoning-summary parts.
        #[serde(default)]
        summary: Vec<String>,
        /// Raw reasoning parts (only some models expose these).
        #[serde(default)]
        content: Vec<String>,
    },
    /// A shell command.
    CommandExecution {
        /// Item id.
        id: String,
        /// The command line.
        command: String,
        /// Its working directory.
        #[serde(default)]
        cwd: Option<String>,
        /// Lifecycle status.
        status: ItemStatus,
        /// Exit code, once finished (`null` when declined).
        #[serde(default)]
        exit_code: Option<i64>,
    },
    /// A patch.
    FileChange {
        /// Item id.
        id: String,
        /// The per-file changes.
        #[serde(default)]
        changes: Value,
        /// Lifecycle status.
        status: ItemStatus,
    },
    /// A call to an MCP server tool.
    McpToolCall {
        /// Item id.
        id: String,
        /// MCP server name.
        server: String,
        /// Tool name.
        tool: String,
        /// Tool arguments.
        #[serde(default)]
        arguments: Value,
        /// Lifecycle status.
        status: ItemStatus,
        /// Populated when the call failed.
        #[serde(default)]
        error: Option<Value>,
    },
    /// A call to a client-registered dynamic tool.
    DynamicToolCall {
        /// Item id.
        id: String,
        /// Tool name.
        tool: String,
        /// Tool arguments.
        #[serde(default)]
        arguments: Value,
        /// Lifecycle status.
        status: ItemStatus,
        /// Whether the tool reported success.
        #[serde(default)]
        success: Option<bool>,
    },
    /// Any other item kind.
    #[serde(other)]
    Other,
}

/// A tool item's lifecycle status.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ItemStatus {
    /// Running.
    InProgress,
    /// Finished.
    Completed,
    /// Failed.
    Failed,
    /// Declined at approval.
    Declined,
    /// A status newer than this adapter.
    #[serde(other)]
    Unknown,
}

impl ItemStatus {
    /// `failed` or `declined`.
    pub fn is_error(self) -> bool {
        matches!(self, Self::Failed | Self::Declined)
    }
}

// ── Approvals ────────────────────────────────────────────────────────

/// Parameters of the three approval requests (the fields read; the full
/// object is forwarded as the permission request's `input`).
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApprovalRequest {
    /// The turn the gated item belongs to.
    pub turn_id: String,
    /// `item/permissions/requestApproval` only: the requested profile.
    #[serde(default)]
    pub permissions: Option<Value>,
}

/// A command or file-change approval decision. The schema's
/// session-scoped and policy-amending variants (`acceptForSession`,
/// `acceptWithExecpolicyAmendment`, ...) are deliberately never sent: the
/// prompt offers one-shot Allow / Deny only.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ApprovalDecision {
    /// Run it once.
    Accept,
    /// Do not run it; the turn continues.
    Decline,
}

/// Answer to `item/commandExecution/requestApproval` and
/// `item/fileChange/requestApproval`.
#[derive(Debug, Serialize)]
pub struct ApprovalResponse {
    /// The decision.
    pub decision: ApprovalDecision,
}

/// Answer to `item/permissions/requestApproval`.
#[derive(Debug, Serialize)]
pub struct PermissionsResponse {
    /// The granted subset of the requested profile (`{}` grants nothing).
    pub permissions: Value,
    /// How long the grant lasts.
    pub scope: PermissionGrantScope,
}

/// `item/permissions/requestApproval` grant scope.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum PermissionGrantScope {
    /// For the current turn only.
    Turn,
}
