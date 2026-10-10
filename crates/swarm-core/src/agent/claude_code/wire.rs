//! Typed view of the `claude` CLI's `stream-json` protocol, both
//! directions: the frames [`super`] reads from the child's stdout and
//! the frames it writes to the child's stdin.
//!
//! Shapes follow `@anthropic-ai/claude-agent-sdk` 0.3.280's `sdk.d.ts`
//! (`SDKMessage`, `SDKControlRequest`/`SDKControlResponse`,
//! `SDKResultMessage`) and were checked against live `claude` 2.1.280
//! and 2.1.281 traces. `command_lifecycle` is the one frame the SDK
//! types do not describe; the CLI advertises it as the
//! `msg_lifecycle_v1` capability on `system/init`, and its shape here is
//! the observed one.
//!
//! Every inbound type is deliberately permissive: unknown fields are
//! ignored, fields the adapter can live without are optional, and an
//! unknown `type`/`subtype` tag lands in an `Other` variant instead of
//! failing the line, so a newer CLI that adds frames or fields never
//! breaks a session. Type and range stay strict: a field of the wrong
//! type, or an integer that does not fit its field (a `u32` block index,
//! say), fails the frame instead of being coerced or wrapped (only the
//! `initialize` model list drops an odd entry on its own), and `reader`
//! still answers an unreadable `result` or `control_request`.

use std::sync::LazyLock;

use regex::Regex;
use serde::Deserialize;
use serde::de::IgnoredAny;
use serde_json::{Value, json};

// ── Inbound (CLI stdout -> adapter) ──────────────────────────────────

/// One NDJSON line from the CLI, dispatched on its `type` tag.
#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub(super) enum Inbound {
    System(System),
    StreamEvent(StreamEventLine),
    Assistant(MessageLine),
    User(MessageLine),
    Result(ResultLine),
    ControlRequest(ControlRequestLine),
    ControlResponse(ControlResponseLine),
    ControlCancelRequest(ControlCancelRequestLine),
    CommandLifecycle(CommandLifecycleLine),
    /// `rate_limit_event`, `keep_alive`, `tool_progress`, and anything a
    /// newer CLI adds.
    #[serde(other)]
    Other,
}

/// `type: "system"`, dispatched on `subtype`.
#[derive(Debug, Deserialize)]
#[serde(tag = "subtype", rename_all = "snake_case")]
pub(super) enum System {
    Init(InitLine),
    PermissionDenied(PermissionDeniedLine),
    /// `status`, `thinking_tokens`, `hook_*`, `task_*`, `api_retry`,
    /// `background_tasks_changed`, and the rest: informational only.
    #[serde(other)]
    Other,
}

/// `system/init`. The CLI writes one at the start of every turn, after
/// that turn's user message arrives (never at process start).
#[derive(Debug, Default, Deserialize)]
#[serde(default)]
pub(super) struct InitLine {
    pub session_id: Option<String>,
    /// Protocol capabilities (`msg_lifecycle_v1`, `interrupt_receipt_v1`,
    /// ...). `None` on CLIs that predate the field.
    pub capabilities: Option<Vec<String>>,
}

impl InitLine {
    /// Whether this CLI stamps `command_lifecycle` frames on
    /// uuid-carrying user messages.
    pub fn has_message_lifecycle(&self) -> bool {
        self.capabilities
            .as_deref()
            .is_some_and(|caps| caps.iter().any(|cap| cap == "msg_lifecycle_v1"))
    }
}

/// `system/permission_denied`: an advisory, best-effort notice that a
/// tool call was denied without asking anyone. `result.permission_denials`
/// is the authoritative record (see [`ResultLine::permission_denials`]).
#[derive(Debug, Default, Deserialize)]
#[serde(default)]
pub(super) struct PermissionDeniedLine {
    pub tool_name: String,
    pub tool_use_id: String,
    pub message: Option<String>,
    pub decision_reason_type: Option<String>,
}

/// `type: "stream_event"`: one raw Messages API streaming event.
#[derive(Debug, Deserialize)]
pub(super) struct StreamEventLine {
    pub event: StreamEvent,
    /// `Some` for a subagent's traffic.
    #[serde(default)]
    pub parent_tool_use_id: Option<String>,
    #[serde(default)]
    pub user_message_uuid: Option<String>,
    #[serde(default)]
    pub user_message_uuids: Vec<String>,
}

impl StreamEventLine {
    pub fn answers(&self, turn: &str) -> Option<bool> {
        answers(
            self.user_message_uuid.as_deref(),
            &self.user_message_uuids,
            turn,
        )
    }
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub(super) enum StreamEvent {
    ContentBlockStart {
        index: u32,
        content_block: BlockHead,
    },
    ContentBlockDelta {
        index: u32,
        delta: Delta,
    },
    ContentBlockStop {
        index: u32,
    },
    /// `message_start`, `message_delta`, `message_stop`, `ping`, ...
    #[serde(other)]
    Other,
}

#[derive(Debug, Deserialize)]
pub(super) struct BlockHead {
    #[serde(rename = "type")]
    pub kind: String,
}

/// A `content_block_delta` payload, tagged `text_delta`,
/// `thinking_delta`, `input_json_delta`, ...
#[derive(Debug, Deserialize)]
#[serde(tag = "type")]
pub(super) enum Delta {
    #[serde(rename = "text_delta")]
    Text { text: String },
    #[serde(rename = "thinking_delta")]
    Thinking { thinking: String },
    #[serde(rename = "input_json_delta")]
    InputJson { partial_json: String },
    /// `signature_delta`, `citations_delta`, and anything newer: nothing
    /// a human reads.
    #[serde(other)]
    Other,
}

impl Delta {
    /// The human-readable text this delta adds, `None` when it adds none
    /// (an unknown delta type, or an empty chunk such as the
    /// `thinking_delta` frames that carry only `estimated_tokens`).
    pub fn into_text(self) -> Option<String> {
        match self {
            Self::Text { text } | Self::Thinking { thinking: text } => Some(text),
            Self::InputJson { partial_json } => Some(partial_json),
            Self::Other => None,
        }
        .filter(|text| !text.is_empty())
    }
}

/// `type: "assistant"` / `type: "user"`: one complete message.
#[derive(Debug, Deserialize)]
pub(super) struct MessageLine {
    pub message: MessageBody,
    /// `Some` for a subagent's traffic.
    #[serde(default)]
    pub parent_tool_use_id: Option<String>,
    #[serde(default)]
    pub user_message_uuid: Option<String>,
    #[serde(default)]
    pub user_message_uuids: Vec<String>,
}

impl MessageLine {
    pub fn answers(&self, turn: &str) -> Option<bool> {
        answers(
            self.user_message_uuid.as_deref(),
            &self.user_message_uuids,
            turn,
        )
    }

    /// The message's content blocks, verbatim.
    pub fn blocks(&self) -> &[Value] {
        match &self.message.content {
            Some(Content::Blocks(blocks)) => blocks,
            Some(Content::Other(_)) | None => &[],
        }
    }
}

#[derive(Debug, Deserialize)]
pub(super) struct MessageBody {
    #[serde(default)]
    pub content: Option<Content>,
}

/// Block-array content, or anything else (a plain string such as the
/// CLI's own `[Request interrupted by user]` notice), which has no
/// blocks.
#[derive(Debug, Deserialize)]
#[serde(untagged)]
pub(super) enum Content {
    Blocks(Vec<Value>),
    Other(IgnoredAny),
}

/// Typed view of one content block, parsed from the verbatim `Value` the
/// adapter also forwards as `agent_block` content.
#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub(super) enum Block {
    ToolUse {
        id: String,
        name: String,
        #[serde(default)]
        input: Value,
    },
    ToolResult {
        tool_use_id: String,
        #[serde(default)]
        is_error: Option<bool>,
        #[serde(default)]
        content: Value,
    },
    #[serde(other)]
    Other,
}

impl Block {
    pub fn of(value: &Value) -> Self {
        Self::deserialize(value).unwrap_or(Self::Other)
    }
}

/// Human-readable text of a `tool_result` block's content: the string
/// itself, or its text blocks joined with newlines.
pub(super) fn tool_result_text(content: &Value) -> Option<String> {
    match content {
        Value::String(text) => Some(text.clone()),
        Value::Array(parts) => {
            let text = parts
                .iter()
                .filter_map(|part| part.get("text").and_then(Value::as_str))
                .collect::<Vec<_>>()
                .join("\n");
            Some(text)
        }
        _ => None,
    }
    .filter(|text| !text.is_empty())
}

/// `type: "result"`: the one terminal receipt per CLI turn.
#[derive(Debug, Default, Deserialize)]
#[serde(default)]
pub(super) struct ResultLine {
    /// `success`, or one of the `error_*` subtypes.
    pub subtype: String,
    /// `true` for any failed turn, including an API error the CLI still
    /// reports with `subtype: "success"`.
    pub is_error: bool,
    /// Final assistant text on success; the error text when `is_error`
    /// is set on a `success` subtype.
    pub result: Option<String>,
    pub errors: Vec<String>,
    pub api_error_status: Option<u16>,
    pub terminal_reason: Option<String>,
    pub stop_reason: Option<String>,
    /// The session's RUNNING total, not this turn's own cost.
    pub total_cost_usd: Option<f64>,
    /// Main-loop token usage for this turn alone.
    pub usage: Option<Value>,
    pub duration_ms: f64,
    pub num_turns: Option<u64>,
    /// Authoritative record of every tool call the CLI refused this turn.
    pub permission_denials: Vec<PermissionDenial>,
    pub user_message_uuid: Option<String>,
    pub user_message_uuids: Vec<String>,
}

impl ResultLine {
    /// `Some(true)`/`Some(false)` when the result names the user
    /// message(s) it answers, `None` when it carries no echo at all (a
    /// CLI-initiated turn, a zeroed crash result, or an older CLI).
    pub fn answers(&self, turn: &str) -> Option<bool> {
        answers(
            self.user_message_uuid.as_deref(),
            &self.user_message_uuids,
            turn,
        )
    }

    pub fn failed(&self) -> bool {
        self.is_error || self.subtype != "success"
    }

    /// The provider's own explanation of a failure: its `errors[]`
    /// (minus internal `[ede_diagnostic]` breadcrumbs), else the
    /// `result` text.
    pub fn failure_text(&self) -> Option<String> {
        let errors = self
            .errors
            .iter()
            .map(|error| error.trim())
            .filter(|error| !error.is_empty() && !error.starts_with("[ede_diagnostic]"))
            .collect::<Vec<_>>();
        if !errors.is_empty() {
            return Some(errors.join("; "));
        }
        self.result
            .as_deref()
            .map(str::trim)
            .filter(|text| !text.is_empty())
            .map(str::to_owned)
    }
}

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
pub(super) struct PermissionDenial {
    pub tool_name: String,
    pub tool_use_id: String,
    pub tool_input: Value,
}

/// `type: "control_request"` from the CLI to the host.
#[derive(Debug, Deserialize)]
pub(super) struct ControlRequestLine {
    pub request_id: String,
    pub request: ControlRequest,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "subtype", rename_all = "snake_case")]
pub(super) enum ControlRequest {
    CanUseTool(CanUseTool),
    /// `request_user_dialog`, `elicitation`, `hook_callback`,
    /// `mcp_message`, ...: nothing this host offers.
    #[serde(other)]
    Other,
}

/// `can_use_tool`: the CLI is blocked until the host answers.
#[derive(Debug, Deserialize)]
pub(super) struct CanUseTool {
    pub tool_name: String,
    #[serde(default)]
    pub input: Value,
    pub tool_use_id: String,
    /// Why the ask escalated, for the dialog's consent line. May carry
    /// ANSI escapes. Absent on a plain default-mode ask (2.1.280's Write
    /// ask carries only `description`).
    #[serde(default)]
    pub decision_reason: Option<String>,
    /// The prompt line the CLI's own dialog would show.
    #[serde(default)]
    pub title: Option<String>,
    /// A short description of the call (the target file name for Write).
    #[serde(default)]
    pub description: Option<String>,
    /// The tool's approval card is itself the input surface (the user
    /// answers ON it, e.g. `AskUserQuestion`), or its disclosure only
    /// renders locally: a one-tap Allow/Deny must not be offered.
    #[serde(default)]
    pub requires_user_interaction: bool,
    /// Set when the call comes from a subagent.
    #[serde(default)]
    pub agent_id: Option<String>,
}

/// Removes ANSI escape sequences, which the CLI may put in a
/// `can_use_tool` request's text fields.
pub(super) fn strip_ansi(text: &str) -> String {
    static ANSI: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)")
            .expect("static ANSI pattern compiles")
    });
    ANSI.replace_all(text, "").into_owned()
}

impl CanUseTool {
    /// The text a host dialog shows: the escalation reason, else the
    /// title, else the description; ANSI styling stripped, blanks
    /// skipped.
    pub fn message(&self) -> Option<String> {
        [&self.decision_reason, &self.title, &self.description]
            .into_iter()
            .flatten()
            .map(|text| strip_ansi(text))
            .find(|text| !text.trim().is_empty())
    }
}

/// `type: "control_response"`: the CLI's answer to a host request.
#[derive(Debug, Deserialize)]
pub(super) struct ControlResponseLine {
    pub response: ControlResponse,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "subtype", rename_all = "snake_case")]
pub(super) enum ControlResponse {
    Success {
        request_id: String,
        #[serde(default)]
        response: Option<Value>,
    },
    Error {
        request_id: String,
        #[serde(default)]
        error: String,
    },
}

impl ControlResponse {
    pub fn request_id(&self) -> &str {
        match self {
            Self::Success { request_id, .. } | Self::Error { request_id, .. } => request_id,
        }
    }
}

/// `type: "control_cancel_request"`: the CLI withdrew a request it sent
/// (a pending `can_use_tool` after an abort, for one).
#[derive(Debug, Deserialize)]
pub(super) struct ControlCancelRequestLine {
    pub request_id: String,
}

/// `type: "command_lifecycle"`: progress of one uuid-stamped user
/// message through the CLI's command queue. Observed states: `queued`,
/// `started`, `completed`, `cancelled`.
#[derive(Debug, Deserialize)]
pub(super) struct CommandLifecycleLine {
    pub command_uuid: String,
    pub state: String,
}

/// Success payload of the `initialize` control request. The model list
/// is read entry by entry (one odd entry drops only itself), so what
/// fails the whole payload is a wrong type on a field the adapter acts
/// on (`account`, `pid`, `current_permission_mode`): the handshake
/// rejects such an answer instead of spawning on guessed values.
#[derive(Debug, Default, Deserialize)]
#[serde(default)]
pub(super) struct InitializeResponse {
    #[serde(deserialize_with = "readable_entries")]
    pub models: Vec<ModelInfo>,
    pub account: Option<AccountInfo>,
    pub pid: Option<u32>,
    pub current_permission_mode: Option<String>,
}

impl InitializeResponse {
    /// The concrete model id `requested` resolves to, when the CLI lists
    /// it; `requested` itself otherwise.
    pub fn resolve_model(&self, requested: &str) -> String {
        self.models
            .iter()
            .find(|model| model.value == requested)
            .and_then(|model| model.resolved_model.clone())
            .unwrap_or_else(|| requested.to_owned())
    }
}

/// The entries of a JSON list that deserialize as `T`; anything that is
/// not a list reads as empty.
fn readable_entries<'de, D, T>(deserializer: D) -> Result<Vec<T>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: serde::de::DeserializeOwned,
{
    let Value::Array(entries) = Value::deserialize(deserializer)? else {
        return Ok(Vec::new());
    };
    Ok(entries
        .into_iter()
        .filter_map(|entry| serde_json::from_value(entry).ok())
        .collect())
}

#[derive(Debug, Deserialize)]
pub(super) struct ModelInfo {
    pub value: String,
    #[serde(default, rename = "resolvedModel")]
    pub resolved_model: Option<String>,
}

/// The account the CLI would bill. Only presence is read from `email`:
/// the address itself is never held in memory.
#[derive(Debug, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub(super) struct AccountInfo {
    pub email: Option<IgnoredAny>,
    pub subscription_type: Option<String>,
    pub token_source: Option<String>,
    pub api_key_source: Option<String>,
    pub api_provider: Option<String>,
}

/// How the CLI would authenticate its next API call.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) enum SignIn {
    /// Claude.ai OAuth login, with the plan when the CLI names one.
    Account {
        plan: Option<String>,
    },
    /// An API key (`ANTHROPIC_API_KEY`, an `apiKeyHelper`, ...).
    ApiKey {
        source: String,
    },
    /// An OAuth token from the environment or a helper.
    Token {
        source: String,
    },
    /// A third-party backend (Bedrock, Vertex AI, ...) with external auth.
    Provider {
        name: String,
    },
    SignedOut,
}

impl AccountInfo {
    /// Signed-out 2.1.281 reports exactly
    /// `{"tokenSource":"none","apiProvider":"firstParty"}`; every signed-in
    /// shape adds an email/plan, a non-`none` key or token source, or a
    /// non-first-party provider.
    pub fn sign_in(&self) -> SignIn {
        let named = |source: &Option<String>| source.clone().filter(|source| source != "none");
        if let Some(provider) = &self.api_provider
            && provider != "firstParty"
        {
            return SignIn::Provider {
                name: provider.clone(),
            };
        }
        if self.email.is_some() || self.subscription_type.is_some() {
            return SignIn::Account {
                plan: self.subscription_type.clone(),
            };
        }
        if let Some(source) = named(&self.api_key_source) {
            return SignIn::ApiKey { source };
        }
        if let Some(source) = named(&self.token_source) {
            return SignIn::Token { source };
        }
        SignIn::SignedOut
    }
}

/// Success payload of the `get_binary_version` control request.
#[derive(Debug, Deserialize)]
pub(super) struct BinaryVersion {
    pub version: String,
}

fn answers(uuid: Option<&str>, uuids: &[String], turn: &str) -> Option<bool> {
    if uuid.is_none() && uuids.is_empty() {
        return None;
    }
    Some(uuid == Some(turn) || uuids.iter().any(|candidate| candidate == turn))
}

// ── Outbound (adapter -> CLI stdin) ──────────────────────────────────

fn line(frame: &Value) -> String {
    let mut line = frame.to_string();
    line.push('\n');
    line
}

fn control_request(request_id: &str, request: Value) -> String {
    line(&json!({ "type": "control_request", "request_id": request_id, "request": request }))
}

fn control_success(request_id: &str, response: Value) -> String {
    line(&json!({
        "type": "control_response",
        "response": { "subtype": "success", "request_id": request_id, "response": response },
    }))
}

pub(super) fn initialize_request(request_id: &str) -> String {
    control_request(request_id, json!({ "subtype": "initialize" }))
}

pub(super) fn binary_version_request(request_id: &str) -> String {
    control_request(request_id, json!({ "subtype": "get_binary_version" }))
}

/// Aborts the running turn and, with `cancel_queued`, every uuid-stamped
/// message still waiting in the CLI's queue (`interrupt_cancel_queued_v1`).
pub(super) fn interrupt_request(request_id: &str) -> String {
    control_request(
        request_id,
        json!({ "subtype": "interrupt", "cancel_queued": true }),
    )
}

/// One human prompt, shaped like the Agent SDK's `SDKUserMessage`. `uuid`
/// (the SWARM turn id) comes back as `command_lifecycle.command_uuid` and
/// as `user_message_uuid` on the turn's first stream event, first
/// assistant message and `result`.
pub(super) fn user_turn(prompt: &str, uuid: &str) -> String {
    line(&json!({
        "type": "user",
        "session_id": "",
        "parent_tool_use_id": null,
        "origin": { "kind": "human" },
        "uuid": uuid,
        "message": { "role": "user", "content": [{ "type": "text", "text": prompt }] },
    }))
}

/// Answers a `can_use_tool` request with "allow", passing the proposed
/// input through unchanged.
pub(super) fn permission_allow(request_id: &str, tool_use_id: &str, input: &Value) -> String {
    control_success(
        request_id,
        json!({ "behavior": "allow", "updatedInput": input, "toolUseID": tool_use_id }),
    )
}

/// Answers a `can_use_tool` request with "deny". `interrupt` also aborts
/// the turn.
pub(super) fn permission_deny(
    request_id: &str,
    tool_use_id: &str,
    message: &str,
    interrupt: bool,
) -> String {
    control_success(
        request_id,
        json!({
            "behavior": "deny",
            "message": message,
            "interrupt": interrupt,
            "toolUseID": tool_use_id,
        }),
    )
}

/// Refuses a control request this host does not support, so the CLI is
/// never left waiting on an answer that will not come.
pub(super) fn control_error(request_id: &str, error: &str) -> String {
    line(&json!({
        "type": "control_response",
        "response": { "subtype": "error", "request_id": request_id, "error": error },
    }))
}
