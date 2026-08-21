//! `CodexAdapter` — the second concrete [`AgentAdapter`]/[`AgentSession`]
//! implementation, driving `codex app-server`'s stateful, bidirectional
//! JSON-RPC 2.0 protocol over piped stdio
//! ([`crate::worker::proc::spawn_piped`]).
//!
//! ## Why this adapter exists: proving the trait survives a second,
//! genuinely different protocol family
//!
//! [`crate::agent::claude_code::ClaudeCodeAdapter`] speaks Claude Code's
//! `stream-json`: one-way, provider-to-client-only NDJSON with no request
//! ids and no server-initiated questions — every `agent_permission_request`
//! it emits is a REPORT of an already-decided denial (see that payload's
//! "semantics shift" doc) because there is nothing on the wire to answer.
//! Codex's `app-server` protocol is the opposite shape: **stateful,
//! bidirectional JSON-RPC 2.0** — the client sends `id`-bearing requests
//! and gets matching responses back (`thread/start`, `thread/sendMessage`),
//! the server sends one-way notifications for streaming/lifecycle
//! (`item/started`, `item/agentMessage/delta`, `item/completed`,
//! `turn/completed`), AND the server can send the client its OWN
//! `id`-bearing REQUEST mid-turn (an approval) that blocks until the
//! client replies. That last shape is genuinely new: this adapter's
//! [`CodexSession::respond_permission`] is a REAL round-trip, not a
//! documented no-op — see its doc and [`Capabilities::interactive_permissions`].
//!
//! **Verdict, stated up front (see `docs/architecture.md`'s adapter-layer
//! section for the full writeup): this adapter required ZERO changes to
//! [`crate::agent::adapter::AgentAdapter`]/[`AgentSession`]'s method
//! signatures.** The one addition — [`Capabilities::interactive_permissions`]
//! — is exactly the kind of change the trait's own design anticipated
//! ("Capabilities is how the UI stays honest when a provider can't do
//! something... disable affordances rather than silently no-op"): a new
//! FIELD on a plain data type the trait already returns, not a new METHOD
//! or a changed signature. The abstraction holds.
//!
//! ## ASSUMPTIONS — read before trusting anything below (BINDING for the
//! eventual live-codex verification pass)
//!
//! **Codex is not installed on this machine.** There are no captured
//! wire logs to build fixtures from (contrast `claude_code`'s fixtures,
//! each copied verbatim from a real spike run) — every fixture under
//! `tests/fixtures/codex/` is AUTHORED from the shapes below, not
//! captured. The [`protocol`] submodule marks, per constant, which
//! method names are taken VERBATIM from the multi-provider plan's own
//! citation of `codex app-server` (`item/started`, `item/completed`,
//! `item/agentMessage/delta`) versus INVENTED by this adapter as a
//! reasonable JSON-RPC 2.0 extrapolation (`thread/start`,
//! `thread/sendMessage`, `turn/completed`, `turn/failed`,
//! `approval/request`, and every params shape). A real `codex
//! app-server` invocation must confirm or correct:
//!
//! 1. The exact method names for session start, turn submission, and
//!    turn termination (this adapter assumes `thread/start` /
//!    `thread/sendMessage` / `turn/completed` / `turn/failed`).
//!    `turn/failed` specifically is now exercised by a fixture
//!    (`tests::test_turn_failed_settles_with_the_reported_error`,
//!    review FIX-3) — the CODE PATH is proven (exactly one
//!    `agent_turn_settled{status: error}` with the reported text
//!    surfaced), the METHOD NAME itself is still unverified against a
//!    live install, same as every other name in this list.
//! 2. Whether `thread/sendMessage` truly round-trips a `turnId` in its
//!    RESPONSE (this adapter's design leans on that — see
//!    [`CodexSession::send_turn`]'s doc) or whether turn acceptance is
//!    signaled some other way (e.g. a notification). **Updated after
//!    review FIX-1: this is no longer a correctness dependency, only an
//!    open naming/shape question.** The adapter now HANDLES EITHER WIRE
//!    ORDER between that response and a terminal notification for the
//!    same turn — [`settle_turn`]'s doc covers the order-independent
//!    fix and `tests::test_terminal_notification_arriving_before_the_send_message_response_still_settles_exactly_once`
//!    proves it. What still genuinely needs live-codex confirmation is
//!    narrower: the exact method/param names themselves, and whether a
//!    turn's acceptance is signaled via a response at all versus some
//!    other shape this adapter hasn't anticipated.
//! 3. The approval request's exact shape (`approval/request` with
//!    `kind`/`command`/`itemId` params is invented; real Codex may use a
//!    different method name or split exec-vs-patch approvals into two
//!    methods).
//! 4. Whether a dollar cost ever appears on `turn/completed` (this
//!    adapter reads an optional `costUsd` opportunistically but declares
//!    [`Capabilities::native_cost`] `false` — conservative, not verified).
//! 5. `thread/resume` — NOT IMPLEMENTED in this cut at all (see
//!    [`CodexAdapter::spawn`]'s explicit rejection of
//!    `AgentSpawnSpec::resume`); [`Capabilities::resume`] is honestly
//!    `false`, not merely unverified-but-claimed.
//! 6. The `approvalPolicy`/`sandboxPolicy` string tokens themselves
//!    (`"untrusted"`/`"on-failure"`/`"on-request"`/`"never"` and
//!    `"read-only"`/`"workspace-write"`/`"danger-full-access"`) ARE
//!    grounded in the real Codex CLI's documented `--ask-for-approval`/
//!    `--sandbox` config vocabulary — higher confidence than the JSON-RPC
//!    method/param shapes carrying them, which are unverified.
//!
//! ## Condition B (BINDING, unchanged from Claude Code)
//!
//! Exactly one `agent_turn_settled` per turn that was ever CONFIRMED
//! accepted (holds a real, server-issued [`TurnId`]) — see [`teardown`].
//! Codex's request/response `send_turn` adds one honestly-new edge case
//! Claude Code's client-synthesized-turn-id design cannot have: a turn
//! that dies *before* the server ever confirms acceptance never receives
//! a [`TurnId`] at all, so there is nothing to attach a synthesized
//! settlement to. That case resolves by directly failing the caller's
//! still-pending [`CodexSession::send_turn`] call (see
//! [`teardown`]'s pending-request drain) — never a hang, and never a
//! settlement for a turn number nobody ever received. See
//! `tests::test_child_death_before_turn_confirmation_resolves_send_turn_with_an_error_not_a_hang`.
//!
//! ## The bypass-equivalent, unconstructible (mirrors Claude Code)
//!
//! Codex's `approvalPolicy: "never"` (skip every approval — full-auto)
//! is this provider's `--dangerously-skip-permissions`/`bypassPermissions`
//! equivalent. [`parse_trust_tier`] recognizes only three tokens
//! (`restricted`/`standard`/`write_enabled`) and fails closed on anything
//! else, INCLUDING a caller passing `"never"` directly through the
//! generic trait's `permission_mode` field — there is no code path, not a
//! runtime check, through which this adapter can ever emit
//! `"approvalPolicy":"never"`. See
//! `tests::test_never_approval_policy_is_unconstructible_across_every_trust_tier`.

use std::collections::HashMap;
use std::io::Write;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering as AtomicOrdering};

use serde::{Deserialize, Serialize};
use tokio::sync::{mpsc, oneshot};
use uuid::Uuid;

use crate::agent::adapter::{
    AgentAdapter, AgentSession, AgentSpawnSpec, AgentTurnStatus, BoxFuture, CancelGranularity,
    Capabilities, ExitSummary, PermissionDecision, PermissionId, ProbeReport, ProviderId,
    SessionKey, TurnId, TurnInput,
};
use crate::error::AppError;
use crate::events::{
    AgentBlockPayload, AgentPermissionRequestPayload, AgentSessionExitedPayload,
    AgentSessionStartedPayload, AgentToolCallPayload, AgentToolResultPayload,
    AgentTurnDeltaPayload, AgentTurnSettledPayload, EventSink, Provenance, SwarmEvent,
};
use crate::worker::proc::{PipedHandle, spawn_piped, write_to_piped};

/// The CodexProtocol module: the message-shape catalog this adapter
/// targets. See the file header doc's ASSUMPTIONS list for which of
/// these are plan-cited verbatim versus this adapter's own invented,
/// unverified extrapolation. Every constant exists so the `match` arms
/// below are typo-proof, not stringly-typed against a shape nobody
/// checks.
mod protocol {
    /// Client -> server request starting a new conversation thread.
    /// Plan-cited concept ("thread lifecycle"); method name and param
    /// shape (`cwd`/`model`/`approvalPolicy`/`sandboxPolicy`) ASSUMED.
    pub const THREAD_START: &str = "thread/start";
    /// Client -> server request sending one user turn on an open thread.
    /// Method name ASSUMED. See [`super::CodexSession::send_turn`]'s doc
    /// for why leaning on this request's RESPONSE (rather than a
    /// notification) to learn the accepted `turnId` is this adapter's
    /// central protocol bet.
    pub const THREAD_SEND_MESSAGE: &str = "thread/sendMessage";
    /// Server -> client notification: an item (assistant message,
    /// command execution, file change, ...) began. Plan-cited verbatim.
    pub const ITEM_STARTED: &str = "item/started";
    /// Server -> client notification: a streamed delta of an
    /// in-progress `agentMessage` item. Plan-cited verbatim.
    pub const ITEM_AGENT_MESSAGE_DELTA: &str = "item/agentMessage/delta";
    /// Server -> client notification: an item finished, carrying its
    /// final content. Plan-cited verbatim.
    pub const ITEM_COMPLETED: &str = "item/completed";
    /// Server -> client notification: the turn reached a terminal
    /// success state. Method name ASSUMED — the plan does not cite a
    /// terminal-receipt method name for Codex the way it cites Claude
    /// Code's `result` line.
    pub const TURN_COMPLETED: &str = "turn/completed";
    /// Server -> client notification: the turn reached a terminal
    /// failure state. ASSUMED, symmetric with [`TURN_COMPLETED`].
    pub const TURN_FAILED: &str = "turn/failed";
    /// Server -> client REQUEST (`id`-bearing — the client MUST reply
    /// with a matching `id` for the session to make progress) asking
    /// approval for a gated action. Plan-cited concept ("approval
    /// requests" + "request/response with ids"); method name and param
    /// shape (`kind`/`command`/`itemId`) ASSUMED.
    pub const APPROVAL_REQUEST: &str = "approval/request";
}

/// Ceiling on how long [`CodexAdapter::spawn`] waits for the child's
/// `thread/start` response before giving up — bounded, per the
/// "Not Signed In, never a hang" rule shared with `ClaudeCodeAdapter`.
const INIT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);

/// Ceiling on [`CodexAdapter::probe`]'s `--version` check.
const PROBE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);

/// Ceiling on how long [`CodexSession::send_turn`] waits for
/// `thread/sendMessage`'s response (the accepted `turnId`) before
/// giving up and reporting a send failure — the same "never a hang"
/// discipline as [`INIT_TIMEOUT`], scoped to one turn instead of spawn.
const SEND_TURN_ACK_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);

/// Poll interval for [`CodexSession::await_turn_completion`] — see
/// `ClaudeCodeSession`'s identical constant for why this is a plain poll
/// loop rather than a `Notify` wakeup (lost-wakeup hazard).
const AWAIT_TURN_COMPLETION_POLL_INTERVAL: std::time::Duration =
    std::time::Duration::from_millis(15);

/// Exact synthesized-settlement error text, shared verbatim with
/// `ClaudeCodeAdapter` (Condition B applies identically once a turn is
/// confirmed accepted) — see [`teardown`].
const PROCESS_EXITED_WITHOUT_RECEIPT: &str = "Process Exited Without A Receipt";

/// Sentinel `in_flight_turn` value meaning "a `thread/sendMessage`
/// request is outstanding but not yet confirmed accepted" — see
/// [`CodexSession::send_turn`]'s doc for why this window exists and
/// [`teardown`] for how it's handled (never synthesizes a settlement for
/// this value; there is no [`TurnId`] a caller could be holding yet).
const RESERVED_TURN_SENTINEL: &str = "";

// ── Trust tiers (Codex's spawn-time approval/sandbox dial) ───────────

/// SWARM's own closed vocabulary for Codex's spawn-time trust dial —
/// deliberately the SAME three tokens as
/// [`crate::agent::claude_code::ClaudeCodeTrustTier`] (a distinct type,
/// not reused, because the two map onto genuinely different provider
/// vocabularies — see [`approval_policy_str`]/[`sandbox_policy_str`]).
/// [`AgentSpawnSpec::permission_mode`] is parsed through
/// [`parse_trust_tier`], which recognizes ONLY these three wire tokens
/// and fails closed on anything else — including Codex's own raw
/// `"never"` approval-policy string. This is what makes
/// `approvalPolicy: "never"` (Codex's full-auto, bypass-equivalent mode)
/// unconstructible by this adapter — see the module doc's "bypass
/// equivalent" section.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CodexTrustTier {
    /// Read-only exploration. `approvalPolicy: "untrusted"` (ask before
    /// every gated action) + `sandboxPolicy: "read-only"`.
    Restricted,
    /// The provider's own middle ground: `approvalPolicy: "on-request"`
    /// (the model decides when to ask) + `sandboxPolicy: "workspace-write"`.
    Standard,
    /// Fewer prompts: `approvalPolicy: "on-failure"` (only ask when a
    /// sandboxed action fails on its own) + `sandboxPolicy:
    /// "workspace-write"` — asks less than Standard, still never
    /// `"never"`.
    WriteEnabled,
}

/// Parses [`AgentSpawnSpec::permission_mode`] into a [`CodexTrustTier`].
/// `None` resolves to [`CodexTrustTier::Standard`]. Any string outside
/// the exact 3-token vocabulary — including `"never"` specifically — is
/// rejected rather than guessed at. Mirrors
/// `crate::agent::claude_code::parse_trust_tier` exactly.
fn parse_trust_tier(raw: Option<&str>) -> Result<CodexTrustTier, AppError> {
    match raw {
        None | Some("standard") => Ok(CodexTrustTier::Standard),
        Some("restricted") => Ok(CodexTrustTier::Restricted),
        Some("write_enabled") => Ok(CodexTrustTier::WriteEnabled),
        Some(other) => Err(AppError::PermissionDenied(format!(
            "unrecognized codex trust tier {other:?} — refusing to spawn rather than guess an \
             approval policy (never \"never\", codex's full-auto/bypass-equivalent mode)"
        ))),
    }
}

/// The `approvalPolicy` param value for `tier`. String tokens grounded
/// in the real Codex CLI's documented `--ask-for-approval` vocabulary
/// (`untrusted`/`on-failure`/`on-request`/`never`) — see the module
/// doc's ASSUMPTIONS item 6.
fn approval_policy_str(tier: CodexTrustTier) -> &'static str {
    match tier {
        CodexTrustTier::Restricted => "untrusted",
        CodexTrustTier::Standard => "on-request",
        CodexTrustTier::WriteEnabled => "on-failure",
    }
}

/// The `sandboxPolicy` param value for `tier`. String tokens grounded in
/// the real Codex CLI's documented `--sandbox` vocabulary
/// (`read-only`/`workspace-write`/`danger-full-access`) — this adapter
/// never constructs `"danger-full-access"` for any tier, the sandbox-side
/// analog of never constructing `approvalPolicy: "never"`.
fn sandbox_policy_str(tier: CodexTrustTier) -> &'static str {
    match tier {
        CodexTrustTier::Restricted => "read-only",
        CodexTrustTier::Standard | CodexTrustTier::WriteEnabled => "workspace-write",
    }
}

/// What this adapter can honestly promise — see [`Capabilities`]'s
/// honesty doctrine. Unlike `ClaudeCodeAdapter`'s (every field an
/// empirical spike finding), most fields here are CONSERVATIVE
/// (`false`/`KillOnly`) precisely because there is no live install to
/// verify against — see the module doc's ASSUMPTIONS list.
/// [`Self::interactive_permissions`]... — see
/// [`Capabilities::interactive_permissions`]'s own doc — is the one flag
/// this adapter backs with an actual fixture-tested wire mechanism
/// rather than an assumption.
fn codex_capabilities() -> Capabilities {
    Capabilities {
        // item/agentMessage/delta — plan-cited method name, exercised by
        // `tests::test_happy_turn_end_to_end_onto_live_engine_with_persistence_classes`.
        partial_deltas: true,
        // `thread/resume` is NOT IMPLEMENTED in this cut at all (see
        // `CodexAdapter::spawn`'s explicit rejection below) — honestly
        // `false`, not "probably fine."
        resume: false,
        // No confirmed $ figure on `turn/completed` — an optional
        // `costUsd` is read opportunistically but never guaranteed.
        native_cost: false,
        permission_modes: vec![
            "restricted".to_string(),
            "standard".to_string(),
            "write_enabled".to_string(),
        ],
        // Conservative default, same reasoning as ClaudeCodeAdapter's:
        // no live-verified graceful in-band cancel message exists to
        // lean on yet, even though the protocol's bidirectional shape
        // makes one plausible in principle.
        cancel_granularity: CancelGranularity::KillOnly,
        interrupt_midturn: false,
        // `cwd` is a `thread/start` param.
        worktree_aware: true,
        // The REAL round-trip — see `CodexSession::respond_permission`'s
        // doc and `tests::test_approval_round_trip_answers_over_the_real_wire`.
        interactive_permissions: true,
    }
}

/// Builds the `thread/start` request's `params` object.
fn build_thread_start_params(
    cwd: &str,
    model: Option<&str>,
    tier: CodexTrustTier,
) -> serde_json::Value {
    let mut params = serde_json::json!({
        "cwd": cwd,
        "approvalPolicy": approval_policy_str(tier),
        "sandboxPolicy": sandbox_policy_str(tier),
    });
    if let Some(m) = model {
        params["model"] = serde_json::Value::String(m.to_string());
    }
    params
}

/// Builds one full JSON-RPC 2.0 request line (`id` + `method` + `params`,
/// newline-terminated) for [`write_to_piped`].
fn build_request_line(id: u64, method: &str, params: serde_json::Value) -> String {
    let value = serde_json::json!({
        "jsonrpc": "2.0",
        "id": id,
        "method": method,
        "params": params,
    });
    format!("{value}\n")
}

/// Builds one JSON-RPC 2.0 response line answering a server-initiated
/// request (an approval) — `id` echoed back VERBATIM (preserving its
/// original JSON type, number or string) per JSON-RPC correlation rules.
fn build_response_line(id: serde_json::Value, result: serde_json::Value) -> String {
    let value = serde_json::json!({ "jsonrpc": "2.0", "id": id, "result": result });
    format!("{value}\n")
}

/// Stable string form of a JSON-RPC `id` (`Number` or `String`) for use
/// as a [`PermissionId`] — the raw [`serde_json::Value`] is retained
/// separately (see [`Shared::pending_approvals`]) so
/// [`CodexSession::respond_permission`] can echo the ORIGINAL type back,
/// never coercing a numeric id into a string on the wire.
fn json_id_to_string(id: &serde_json::Value) -> String {
    match id {
        serde_json::Value::Number(n) => n.to_string(),
        serde_json::Value::String(s) => s.clone(),
        other => other.to_string(),
    }
}

// ── Session state ────────────────────────────────────────────────────

/// Mutable state shared between [`CodexSession`]'s trait methods and the
/// background reader task ([`run_reader`]) — guarded by a
/// `parking_lot::Mutex`, never held across an `.await` (the trait's
/// concurrency contract). Mirrors
/// `crate::agent::claude_code::Inner` with one addition: item-id ->
/// block-index bookkeeping, since Codex's protocol correlates by
/// provider-issued `itemId` string rather than Claude's positional
/// content-block index.
struct Inner {
    /// `Some(RESERVED_TURN_SENTINEL)` while a `thread/sendMessage`
    /// request is outstanding but not yet confirmed; `Some(real_id)`
    /// once confirmed and running. See [`CodexSession::send_turn`]'s doc.
    in_flight_turn: Option<TurnId>,
    /// The most recent turn id to reach a terminal settlement — natural
    /// or synthesized. Never set to the sentinel (see [`teardown`]).
    last_settled_turn: Option<TurnId>,
    /// Provider-issued `itemId` -> the `block_index` this session
    /// assigned it (first-seen order) — [`AgentTurnDeltaPayload`]/
    /// [`AgentBlockPayload`] need a `u32` index; Codex's protocol has no
    /// such concept natively, only opaque item ids.
    item_index: HashMap<String, u32>,
    /// Next fresh `block_index` to assign.
    next_item_index: u32,
    /// The child process handle. Taken (never re-inserted) by
    /// [`teardown`] to kill + wait.
    child: Option<std::process::Child>,
    /// Cached once [`teardown`] has fully run — every subsequent call
    /// returns this without redoing any work or re-emitting any event.
    shutdown_result: Option<ExitSummary>,
}

/// Everything a [`CodexSession`] and its background reader task share.
struct Shared {
    worker_id: Uuid,
    sink: EventSink,
    /// Stable for the session's lifetime — the `threadId` captured from
    /// `thread/start`'s response.
    session_key: SessionKey,
    state: parking_lot::Mutex<Inner>,
    /// The child's stdin writer — a SEPARATE lock from `state`, same
    /// rationale as `ClaudeCodeAdapter::Shared::stdin`'s doc (a stuck
    /// blocking write must never be able to block [`teardown`]'s attempt
    /// to kill the child, since killing it is what unsticks the write).
    stdin: parking_lot::Mutex<Option<Box<dyn Write + Send>>>,
    /// Serializes the entire [`teardown`] critical section across every
    /// caller — see `ClaudeCodeAdapter::Shared::teardown_gate`'s doc.
    teardown_gate: tokio::sync::Mutex<()>,
    /// Monotonic counter minting this session's OWN outgoing JSON-RPC
    /// request ids (the `thread/start` handshake uses id `1` directly,
    /// before this counter exists — see [`CodexAdapter::spawn`]).
    next_id: AtomicU64,
    /// Outstanding requests THIS session sent, keyed by the numeric id
    /// it minted — resolved by [`handle_response`] when the matching
    /// line arrives, or drained with a synthetic error by [`teardown`]
    /// if the session dies first (never left to hang forever).
    pending_requests: parking_lot::Mutex<
        HashMap<u64, oneshot::Sender<Result<serde_json::Value, serde_json::Value>>>,
    >,
    /// Outstanding approval requests the SERVER sent us, keyed by the
    /// [`PermissionId`] handed out on `agent_permission_request` — value
    /// is the ORIGINAL raw JSON-RPC `id` (preserving its type) so
    /// [`CodexSession::respond_permission`] can echo it back correctly.
    pending_approvals: parking_lot::Mutex<HashMap<PermissionId, serde_json::Value>>,
}

/// Mints this session's next outgoing JSON-RPC request id.
fn next_request_id(shared: &Shared) -> u64 {
    shared.next_id.fetch_add(1, AtomicOrdering::SeqCst)
}

/// Assigns (or returns the already-assigned) `block_index` for
/// `item_id`, first-seen order.
fn assign_item_index(shared: &Arc<Shared>, item_id: &str) -> u32 {
    let mut inner = shared.state.lock();
    if let Some(&idx) = inner.item_index.get(item_id) {
        return idx;
    }
    let idx = inner.next_item_index;
    inner.next_item_index += 1;
    inner.item_index.insert(item_id.to_string(), idx);
    idx
}

/// The turn id to stamp on an event derived from `params` — PREFERS the
/// protocol's own explicit `turnId` field (Codex states it on every
/// notification, unlike Claude Code's implicit single-in-flight-turn
/// correlation) and falls back to this session's own bookkeeping only
/// if absent.
fn current_turn_id(shared: &Arc<Shared>, params: &serde_json::Value) -> TurnId {
    params
        .get("turnId")
        .and_then(|v| v.as_str())
        .map(str::to_string)
        .unwrap_or_else(|| {
            shared
                .state
                .lock()
                .in_flight_turn
                .clone()
                .unwrap_or_default()
        })
}

/// Tears a session down exactly once — mirrors
/// `crate::agent::claude_code::teardown` closely (kill + wait the child
/// FIRST, only then drop `stdin`; synthesize Condition B's settlement;
/// emit `agent_session_exited`; cache the result). Two additions specific
/// to Codex's bidirectional protocol:
///
/// 1. **Never synthesizes a settlement for [`RESERVED_TURN_SENTINEL`]**
///    — a turn still awaiting `thread/sendMessage`'s response never
///    received a real [`TurnId`], so there is nothing to attach a
///    settlement to (see the module doc's Condition B section).
/// 2. **Drains [`Shared::pending_requests`]**, sending a synthetic error
///    to every outstanding oneshot — this is what unblocks a
///    [`CodexSession::send_turn`] call stuck awaiting a response that
///    will now never arrive, turning it into a clean `Err` return
///    instead of a hang.
async fn teardown(shared: &Arc<Shared>) -> ExitSummary {
    let _gate = shared.teardown_gate.lock().await;

    if let Some(existing) = shared.state.lock().shutdown_result.clone() {
        return existing;
    }

    let (in_flight, child_opt) = {
        let mut inner = shared.state.lock();
        let taken = inner.in_flight_turn.take();
        // Only record a REAL id — the sentinel is a placeholder, never a
        // [`TurnId`] any caller could be polling `await_turn_completion`
        // with, so recording it as "the last settled turn" would be a
        // bogus value (see `settle_turn`'s doc for the matching
        // order-independence fix on the other side of this handshake).
        if let Some(ref t) = taken
            && t != RESERVED_TURN_SENTINEL
        {
            inner.last_settled_turn = Some(t.clone());
        }
        (taken, inner.child.take())
    };

    let (exit_code, signal) = if let Some(mut child) = child_opt {
        let waited = tokio::task::spawn_blocking(move || {
            let _ = child.kill();
            child.wait()
        })
        .await;
        match waited {
            Ok(Ok(status)) => (status.code(), None),
            _ => (None, None),
        }
    } else {
        (None, None)
    };

    drop(shared.stdin.lock().take());

    // Unblock every outstanding request await — a `send_turn` stuck
    // waiting on `thread/sendMessage`'s response must resolve now,
    // never hang past this session's own death.
    let pending: Vec<_> = shared.pending_requests.lock().drain().collect();
    for (_, tx) in pending {
        let _ = tx.send(Err(
            serde_json::json!({ "message": "codex session shut down before a response arrived" }),
        ));
    }
    shared.pending_approvals.lock().clear();

    if let Some(turn_id) = in_flight
        && turn_id != RESERVED_TURN_SENTINEL
    {
        shared
            .sink
            .emit(SwarmEvent::AgentTurnSettled(AgentTurnSettledPayload {
                worker_id: shared.worker_id,
                turn_id,
                status: AgentTurnStatus::Error,
                error: Some(PROCESS_EXITED_WITHOUT_RECEIPT.to_string()),
                cost_usd: None,
                usage: None,
                duration_ms: 0,
                num_turns: None,
            }));
    }

    let ack = shared.sink.emit_awaiting_seq(
        SwarmEvent::AgentSessionExited(AgentSessionExitedPayload {
            worker_id: shared.worker_id,
            exit_code,
            signal: signal.clone(),
        }),
        Provenance::default(),
    );
    let _ = ack.await;

    let summary = ExitSummary { exit_code, signal };
    shared.state.lock().shutdown_result = Some(summary.clone());
    summary
}

// ── JSON-RPC line mapping ────────────────────────────────────────────

/// Settles a turn from its terminal notification (`turn/completed`/
/// `turn/failed`). `notification_turn_id` is that notification's OWN
/// `params.turnId` when present — the authoritative id Codex itself
/// reports, independent of whether THIS session has locally promoted
/// [`RESERVED_TURN_SENTINEL`] to it yet.
///
/// # Order-independence (review FIX-1, binding)
///
/// This adapter's design leans on `thread/sendMessage`'s RESPONSE to
/// learn a turn's real [`TurnId`] (see [`CodexSession::send_turn`]'s
/// doc) — but nothing in JSON-RPC 2.0 guarantees a response arrives
/// before every notification about the same turn; `handle_response`'s
/// doc already covers the same-task-different-lines ordering hazard,
/// but a genuinely reordered WIRE (the terminal notification arriving
/// before the response that confirms the turn at all) is a DIFFERENT,
/// live possibility this function must not assume away. If `turn_id ==
/// RESERVED_TURN_SENTINEL` at this moment — the terminal notification
/// beat the response — this function no longer skips: it settles using
/// `notification_turn_id` as the best-available id (Codex's own
/// notification already told us definitively which turn this is, same
/// as every other per-item handler in this file already trusts). Never
/// zero settled events for a turn Codex told us is done, regardless of
/// which line won the race. `handle_response`'s own promotion attempt,
/// arriving after, finds `in_flight_turn` already cleared and correctly
/// no-ops rather than re-settling — see its doc.
fn settle_turn(
    shared: &Arc<Shared>,
    status: AgentTurnStatus,
    error: Option<String>,
    cost_usd: Option<f64>,
    usage: Option<serde_json::Value>,
    duration_ms: u64,
    notification_turn_id: Option<&str>,
) {
    // Ownership handshake with `teardown` — mirrors
    // `crate::agent::claude_code::handle_result`: whichever of "a real
    // terminal notification" or a concurrent `teardown` gets here first
    // claims the turn id and owns emitting its ONE settled event.
    let turn_id = {
        let mut inner = shared.state.lock();

        // Two cases where nothing should be settled, checked before
        // taking anything:
        // 1. The session already fully tore down (teardown reached its
        //    own terminal state) — a notification arriving from a
        //    buffered batch racing teardown's later steps (kill/wait/
        //    emit, which run AFTER releasing this same lock) must never
        //    emit a settlement chronologically after `agent_session_exited`
        //    already did.
        // 2. A duplicate/stray terminal notification for a turn THIS
        //    session already settled (via either order) — never a
        //    second emit, checked against the id this notification
        //    itself claims to be about.
        let already_final = inner.shutdown_result.is_some()
            || (notification_turn_id.is_some()
                && inner.last_settled_turn.as_deref() == notification_turn_id);
        if already_final {
            None
        } else {
            let taken = inner.in_flight_turn.take();
            let resolved = match taken.as_deref() {
                // Already promoted to a real id (the common, response-
                // first order) — use it directly.
                Some(id) if id != RESERVED_TURN_SENTINEL => Some(id.to_string()),
                // Still the sentinel (or nothing recorded at all) — the
                // reordered-wire case this fix exists for, OR a
                // notification arriving with no local bookkeeping to
                // fall back on. Either way, trust the notification's own
                // claimed id if it has one.
                _ => notification_turn_id.map(str::to_string),
            };
            if let Some(ref t) = resolved {
                inner.last_settled_turn = Some(t.clone());
            }
            resolved
        }
    };
    let Some(turn_id) = turn_id else {
        return;
    };

    shared
        .sink
        .emit(SwarmEvent::AgentTurnSettled(AgentTurnSettledPayload {
            worker_id: shared.worker_id,
            turn_id,
            status,
            error,
            cost_usd,
            usage,
            duration_ms,
            num_turns: None,
        }));
}

fn handle_item_started(shared: &Arc<Shared>, params: &serde_json::Value) {
    let Some(item) = params.get("item") else {
        return;
    };
    let Some(item_id) = item.get("id").and_then(|v| v.as_str()) else {
        return;
    };
    let kind = item
        .get("type")
        .and_then(|v| v.as_str())
        .unwrap_or("unknown");
    let turn_id = current_turn_id(shared, params);
    if turn_id.is_empty() {
        return;
    }
    assign_item_index(shared, item_id);

    if matches!(kind, "commandExecution" | "fileChange" | "mcpToolCall") {
        let name = item
            .get("command")
            .and_then(|v| v.as_str())
            .or_else(|| item.get("name").and_then(|v| v.as_str()))
            .unwrap_or(kind)
            .to_string();
        shared
            .sink
            .emit(SwarmEvent::AgentToolCall(AgentToolCallPayload {
                worker_id: shared.worker_id,
                turn_id,
                tool_use_id: item_id.to_string(),
                name,
                input: item.clone(),
            }));
    }
    // `agentMessage`/`reasoning` starts are bookkeeping-only (mirrors
    // Claude Code's `content_block_start`, which emits nothing either) —
    // the interesting event is the streamed delta / the completed block.
}

fn handle_agent_message_delta(shared: &Arc<Shared>, params: &serde_json::Value) {
    let Some(item_id) = params.get("itemId").and_then(|v| v.as_str()) else {
        return;
    };
    let turn_id = current_turn_id(shared, params);
    if turn_id.is_empty() {
        return;
    }
    let delta = params
        .get("delta")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let block_index = assign_item_index(shared, item_id);
    shared
        .sink
        .emit(SwarmEvent::AgentTurnDelta(AgentTurnDeltaPayload {
            worker_id: shared.worker_id,
            turn_id,
            block_index,
            kind: "text".to_string(),
            text: delta,
        }));
}

fn handle_item_completed(shared: &Arc<Shared>, params: &serde_json::Value) {
    let Some(item) = params.get("item") else {
        return;
    };
    let Some(item_id) = item.get("id").and_then(|v| v.as_str()) else {
        return;
    };
    let kind = item
        .get("type")
        .and_then(|v| v.as_str())
        .unwrap_or("unknown")
        .to_string();
    let turn_id = current_turn_id(shared, params);
    if turn_id.is_empty() {
        return;
    }
    let block_index = assign_item_index(shared, item_id);

    match kind.as_str() {
        "commandExecution" | "fileChange" | "mcpToolCall" => {
            let is_error = item
                .get("exitCode")
                .and_then(|v| v.as_i64())
                .map(|c| c != 0)
                .or_else(|| item.get("isError").and_then(|v| v.as_bool()))
                .unwrap_or(false);
            shared
                .sink
                .emit(SwarmEvent::AgentToolResult(AgentToolResultPayload {
                    worker_id: shared.worker_id,
                    turn_id,
                    tool_use_id: item_id.to_string(),
                    is_error,
                    content: item.clone(),
                }));
        }
        "agentMessage" => {
            let text = item
                .get("text")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            shared.sink.emit(SwarmEvent::AgentBlock(AgentBlockPayload {
                worker_id: shared.worker_id,
                turn_id,
                block_index,
                kind: "text".to_string(),
                content: serde_json::json!({ "text": text }),
            }));
        }
        "reasoning" => {
            let text = item
                .get("text")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            shared.sink.emit(SwarmEvent::AgentBlock(AgentBlockPayload {
                worker_id: shared.worker_id,
                turn_id,
                block_index,
                kind: "thinking".to_string(),
                content: serde_json::json!({ "thinking": text }),
            }));
        }
        _ => {
            // Unknown/future item kind — never silently dropped, matches
            // `AgentBlockPayload::content`'s doc ("shapes vary by kind
            // and provider"); forwarded verbatim so replay/UI can decide.
            shared.sink.emit(SwarmEvent::AgentBlock(AgentBlockPayload {
                worker_id: shared.worker_id,
                turn_id,
                block_index,
                kind,
                content: item.clone(),
            }));
        }
    }
}

fn handle_turn_completed(shared: &Arc<Shared>, params: &serde_json::Value) {
    let cost_usd = params.get("costUsd").and_then(|v| v.as_f64());
    let usage = params.get("usage").cloned();
    let duration_ms = params
        .get("durationMs")
        .and_then(|v| v.as_u64())
        .unwrap_or(0);
    let notification_turn_id = params.get("turnId").and_then(|v| v.as_str());
    settle_turn(
        shared,
        AgentTurnStatus::Ok,
        None,
        cost_usd,
        usage,
        duration_ms,
        notification_turn_id,
    );
}

fn handle_turn_failed(shared: &Arc<Shared>, params: &serde_json::Value) {
    let error = params
        .get("error")
        .and_then(|v| v.as_str())
        .map(str::to_string)
        .unwrap_or_else(|| "codex reported a turn failure".to_string());
    let notification_turn_id = params.get("turnId").and_then(|v| v.as_str());
    settle_turn(
        shared,
        AgentTurnStatus::Error,
        Some(error),
        None,
        None,
        0,
        notification_turn_id,
    );
}

/// Handles a server -> client REQUEST (an `id`-bearing approval) — the
/// genuinely new shape Claude Code's protocol never produces. Registers
/// the pending approval (keyed by a [`PermissionId`] derived from the
/// raw JSON-RPC id) and emits `agent_permission_request` with
/// `suggested_decision: None` — this notification IS the pending
/// question, not a report of an already-decided one (contrast
/// `ClaudeCodeAdapter`'s always-`Some(Deny)` report — see
/// [`AgentPermissionRequestPayload`]'s doc).
fn handle_approval_request(
    shared: &Arc<Shared>,
    id: serde_json::Value,
    params: &serde_json::Value,
) {
    let turn_id = current_turn_id(shared, params);
    let kind = params
        .get("kind")
        .and_then(|v| v.as_str())
        .unwrap_or("exec")
        .to_string();
    let command = params
        .get("command")
        .and_then(|v| v.as_str())
        .map(str::to_string);
    let request_id: PermissionId = json_id_to_string(&id);

    shared
        .pending_approvals
        .lock()
        .insert(request_id.clone(), id);

    shared.sink.emit(SwarmEvent::AgentPermissionRequest(
        AgentPermissionRequestPayload {
            worker_id: shared.worker_id,
            turn_id,
            request_id,
            tool: kind,
            input: params
                .get("command")
                .cloned()
                .unwrap_or(serde_json::Value::Null),
            suggested_decision: None,
            denial_subclass: None,
            message: command,
        },
    ));
}

/// Handles a response line for one of THIS session's own outgoing
/// requests (`thread/start`'s handshake is handled separately by
/// [`wait_for_response`], before `Shared` even exists — this is for
/// every request sent AFTER that, i.e. `thread/sendMessage`).
///
/// # The cross-task confirmation race this function closes (found by a
/// flaky test under full-workspace load, not by inspection)
///
/// `thread/sendMessage`'s response confirms a turn's REAL [`TurnId`] —
/// the natural place to promote [`RESERVED_TURN_SENTINEL`] to that real
/// id looks like [`CodexSession::send_turn`]'s OWN code, right after it
/// `.await`s the resolved oneshot. It is NOT: resolving a oneshot only
/// WAKES the awaiting task, it does not preempt whatever is currently
/// running — on the single-threaded executor a `#[tokio::test]` (and,
/// in production, this adapter's own dedicated reader) uses, this
/// `run_reader` task keeps running synchronously through every ALREADY-
/// BUFFERED line after this response (item/started, deltas,
/// item/completed, and crucially `turn/completed`) BEFORE the scheduler
/// ever gets a chance to resume `send_turn`'s continuation. Every one of
/// those per-item notifications reads its `turnId` straight from its own
/// `params` (see [`current_turn_id`]), so they are unaffected — the fix
/// promotes the sentinel to the real id HERE, synchronously, in the SAME
/// reader-task execution that is about to go on and process this turn's
/// own notifications next, so everything downstream in this line-
/// processing pass (and every later one) sees the real id, never the
/// sentinel — the fast, common-case path.
///
/// This is now belt-and-suspenders, not load-bearing for correctness
/// (review FIX-1): [`settle_turn`] independently handles the case where
/// a terminal notification wins the race and arrives while `turn_id` is
/// STILL the sentinel — the wire itself gives no ordering guarantee
/// between a request's response and later notifications, only THIS
/// adapter's own single-task processing does, and only for lines that
/// happen to already be buffered together. See `settle_turn`'s own doc
/// for the order-independent fix. [`CodexSession::send_turn`]'s post-
/// await code also promotes the sentinel, as a final defensive fallback
/// for the (spec-violating) case where the response carries no `turnId`
/// at all.
fn handle_response(shared: &Arc<Shared>, id: u64, value: &serde_json::Value) {
    let Some(sender) = shared.pending_requests.lock().remove(&id) else {
        // No matching outstanding request — a duplicate, a stale
        // straggler after this session already moved on, or a
        // protocol-shape surprise. Logged, never a panic.
        tracing::warn!(
            id,
            "codex adapter: response for an unknown/already-resolved request id, ignoring"
        );
        return;
    };
    let result = if let Some(err) = value.get("error") {
        Err(err.clone())
    } else {
        let result = value
            .get("result")
            .cloned()
            .unwrap_or(serde_json::Value::Null);
        if let Some(turn_id) = result.get("turnId").and_then(|v| v.as_str()) {
            let mut inner = shared.state.lock();
            if inner.in_flight_turn.as_deref() == Some(RESERVED_TURN_SENTINEL) {
                inner.in_flight_turn = Some(turn_id.to_string());
            }
        }
        Ok(result)
    };
    let _ = sender.send(result);
}

/// Classifies and dispatches one JSON-RPC line from the child's stdout,
/// per JSON-RPC 2.0's own discriminator: a `method` field present means
/// a notification (no `id`) or a server-initiated request (`id`
/// present); `method` absent means a response to one of THIS session's
/// own requests (`id` must be present and, since this session only ever
/// mints numeric ids, numeric).
fn handle_line(shared: &Arc<Shared>, line: &str) {
    let value: serde_json::Value = match serde_json::from_str(line) {
        Ok(v) => v,
        Err(e) => {
            tracing::warn!(
                worker_id = %shared.worker_id,
                error = %e,
                "codex adapter: unparseable json-rpc line, skipping"
            );
            return;
        }
    };
    let method = value.get("method").and_then(|v| v.as_str());
    let params = value
        .get("params")
        .cloned()
        .unwrap_or(serde_json::Value::Null);

    match method {
        Some(protocol::ITEM_STARTED) => handle_item_started(shared, &params),
        Some(protocol::ITEM_AGENT_MESSAGE_DELTA) => handle_agent_message_delta(shared, &params),
        Some(protocol::ITEM_COMPLETED) => handle_item_completed(shared, &params),
        Some(protocol::TURN_COMPLETED) => handle_turn_completed(shared, &params),
        Some(protocol::TURN_FAILED) => handle_turn_failed(shared, &params),
        Some(protocol::APPROVAL_REQUEST) => {
            if let Some(id) = value.get("id").cloned() {
                handle_approval_request(shared, id, &params);
            } else {
                tracing::warn!(
                    "codex adapter: approval/request with no id — cannot be answered, ignoring"
                );
            }
        }
        Some(other) if value.get("id").is_some() => {
            tracing::warn!(
                method = other,
                "codex adapter: unrecognized server request method — no reply sent"
            );
        }
        Some(other) => {
            tracing::debug!(
                method = other,
                "codex adapter: unrecognized notification, ignoring"
            );
        }
        None => match value.get("id").and_then(|v| v.as_u64()) {
            Some(id) => handle_response(shared, id, &value),
            None => {
                tracing::warn!(
                    worker_id = %shared.worker_id,
                    "codex adapter: line has neither a recognized method nor a numeric response id, skipping"
                );
            }
        },
    }
}

/// Background task, spawned once per session at `spawn()` time — mirrors
/// `crate::agent::claude_code::run_reader` exactly (see its doc for the
/// drain-before-teardown rationale and why framer errors are watched by
/// a separate task rather than raced in one `select!`).
async fn run_reader(
    shared: Arc<Shared>,
    mut lines: mpsc::Receiver<String>,
    drain_signal: Arc<tokio::sync::Notify>,
) {
    let mut draining = false;
    loop {
        if draining {
            match lines.try_recv() {
                Ok(line) => {
                    handle_line(&shared, &line);
                    continue;
                }
                Err(_) => break,
            }
        }
        tokio::select! {
            line = lines.recv() => {
                match line {
                    Some(l) => {
                        handle_line(&shared, &l);
                        continue;
                    }
                    None => break,
                }
            }
            _ = drain_signal.notified() => {
                draining = true;
            }
        }
    }
    teardown(&shared).await;
}

/// Watches for an NDJSON framer error and signals [`run_reader`] to
/// finish draining and tear the session down — see
/// `crate::agent::claude_code::watch_framer_errors`'s doc.
async fn watch_framer_errors(
    shared: Arc<Shared>,
    mut framer_errors: mpsc::UnboundedReceiver<AppError>,
    drain_signal: Arc<tokio::sync::Notify>,
) {
    if let Some(e) = framer_errors.recv().await {
        tracing::error!(
            worker_id = %shared.worker_id,
            error = %e,
            "codex adapter: ndjson framer error — signaling run_reader to drain and tear down"
        );
        drain_signal.notify_one();
    }
}

/// Waits for the response line matching `expected_id` (skipping any
/// notification/other lines that arrive first) — used only during
/// [`CodexAdapter::spawn`]'s `thread/start` handshake, before [`Shared`]
/// (and therefore [`handle_line`]'s general dispatch) exists yet. Mirrors
/// `crate::agent::claude_code::wait_for_init`'s skip-until-match shape.
async fn wait_for_response(
    lines: &mut mpsc::Receiver<String>,
    expected_id: u64,
) -> Option<Result<serde_json::Value, serde_json::Value>> {
    while let Some(line) = lines.recv().await {
        let Ok(value) = serde_json::from_str::<serde_json::Value>(&line) else {
            continue;
        };
        if value.get("method").is_some() {
            continue; // a notification/request arrived before our response
        }
        if value.get("id").and_then(|v| v.as_u64()) != Some(expected_id) {
            continue;
        }
        if let Some(err) = value.get("error") {
            return Some(Err(err.clone()));
        }
        return Some(Ok(value
            .get("result")
            .cloned()
            .unwrap_or(serde_json::Value::Null)));
    }
    None
}

fn stderr_snippet(tail: &Arc<parking_lot::Mutex<std::collections::VecDeque<u8>>>) -> String {
    let buf = tail.lock();
    let text = String::from_utf8_lossy(&buf.iter().copied().collect::<Vec<u8>>()).into_owned();
    if text.trim().is_empty() {
        "no stderr output".to_string()
    } else {
        format!("stderr: {text}")
    }
}

// ── AgentAdapter / AgentSession ──────────────────────────────────────

/// The `codex` CLI adapter, driving `codex app-server` — one instance
/// drives every Codex worker; each [`CodexSession`] it spawns owns one
/// child process. See the module doc for the trait-survival verdict and
/// the ASSUMPTIONS this implementation makes pending a live `codex`
/// install.
pub struct CodexAdapter {
    sink: EventSink,
    binary: String,
    /// Test-only argv prefix (empty in production) — see
    /// [`CodexAdapter::with_test_binary`].
    extra_prefix_args: Vec<String>,
}

impl CodexAdapter {
    /// Production constructor — drives the real `codex` binary (resolved
    /// via `PATH`).
    pub fn new(sink: EventSink) -> Self {
        Self {
            sink,
            binary: "codex".to_string(),
            extra_prefix_args: Vec::new(),
        }
    }

    /// Test-only constructor: drives a fake child process instead of the
    /// real `codex` binary — see
    /// `crate::agent::claude_code::ClaudeCodeAdapter::with_test_binary`'s
    /// doc for the identical pattern.
    #[cfg(test)]
    pub fn with_test_binary(
        sink: EventSink,
        binary: impl Into<String>,
        prefix_args: Vec<String>,
    ) -> Self {
        Self {
            sink,
            binary: binary.into(),
            extra_prefix_args: prefix_args,
        }
    }
}

impl AgentAdapter for CodexAdapter {
    fn provider(&self) -> ProviderId {
        ProviderId::Codex
    }

    fn capabilities(&self) -> Capabilities {
        codex_capabilities()
    }

    fn probe(&self) -> BoxFuture<'_, Result<ProbeReport, AppError>> {
        let binary = self.binary.clone();
        Box::pin(async move {
            let attempt = tokio::time::timeout(
                PROBE_TIMEOUT,
                tokio::process::Command::new(&binary)
                    .arg("--version")
                    .output(),
            )
            .await;
            Ok(match attempt {
                Ok(Ok(output)) if output.status.success() => ProbeReport {
                    available: true,
                    version: Some(String::from_utf8_lossy(&output.stdout).trim().to_string()),
                    detail: Some("Signed-In State Unknown Until First Spawn".to_string()),
                },
                Ok(Ok(output)) => ProbeReport {
                    available: false,
                    version: None,
                    detail: Some(format!(
                        "`{binary} --version` exited with {:?}",
                        output.status.code()
                    )),
                },
                Ok(Err(e)) => ProbeReport {
                    available: false,
                    version: None,
                    detail: Some(format!("Codex CLI Not Found On PATH: {e}")),
                },
                Err(_elapsed) => ProbeReport {
                    available: false,
                    version: None,
                    detail: Some("Codex CLI Probe Timed Out".to_string()),
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
        Box::pin(async move {
            if spec.resume.is_some() {
                // Honest failure, not a silent ignore — see
                // `codex_capabilities`'s `resume: false` doc. Never
                // pretend to rehydrate a session this adapter cannot
                // actually rehydrate.
                return Err(AppError::Ai(
                    "codex adapter does not implement session resume in this cut (no \
                     thread/resume-equivalent request is sent) — spawn a fresh session instead"
                        .to_string(),
                ));
            }
            let tier = parse_trust_tier(spec.permission_mode.as_deref())?;

            let mut argv = prefix;
            argv.push("app-server".to_string());

            let env: HashMap<String, String> = HashMap::new();
            let handle = spawn_piped(&binary, &argv, &spec.cwd, &env)
                .map_err(|e| AppError::Ai(format!("failed to spawn codex: {e}")))?;

            let PipedHandle {
                mut stdin,
                child,
                pid: _,
                mut lines,
                framer_errors,
                stderr_tail,
            } = handle;

            let start_params = build_thread_start_params(&spec.cwd, spec.model.as_deref(), tier);
            let start_line = build_request_line(1, protocol::THREAD_START, start_params);
            if let Err(e) = write_to_piped(stdin.as_mut(), start_line.as_bytes()) {
                return Err(AppError::Ai(format!(
                    "failed to write thread/start to codex stdin: {e}"
                )));
            }

            let response =
                match tokio::time::timeout(INIT_TIMEOUT, wait_for_response(&mut lines, 1)).await {
                    Ok(Some(Ok(v))) => v,
                    Ok(Some(Err(e))) => {
                        return Err(AppError::Ai(format!("codex rejected thread/start: {e}")));
                    }
                    Ok(None) => {
                        return Err(AppError::Ai(format!(
                            "codex exited before responding to thread/start ({})",
                            stderr_snippet(&stderr_tail)
                        )));
                    }
                    Err(_elapsed) => {
                        return Err(AppError::Ai(format!(
                            "codex did not respond to thread/start within {INIT_TIMEOUT:?} ({})",
                            stderr_snippet(&stderr_tail)
                        )));
                    }
                };

            let session_key: SessionKey = response
                .get("threadId")
                .and_then(|v| v.as_str())
                .map(str::to_string)
                .unwrap_or_else(|| spec.worker_id.to_string());
            let reported_model = response
                .get("model")
                .and_then(|v| v.as_str())
                .map(str::to_string)
                .unwrap_or_else(|| spec.model.clone().unwrap_or_else(|| "default".to_string()));

            let shared = Arc::new(Shared {
                worker_id: spec.worker_id,
                sink: sink.clone(),
                session_key: session_key.clone(),
                state: parking_lot::Mutex::new(Inner {
                    in_flight_turn: None,
                    last_settled_turn: None,
                    item_index: HashMap::new(),
                    next_item_index: 0,
                    child: Some(child),
                    shutdown_result: None,
                }),
                stdin: parking_lot::Mutex::new(Some(stdin)),
                teardown_gate: tokio::sync::Mutex::new(()),
                next_id: AtomicU64::new(2),
                pending_requests: parking_lot::Mutex::new(HashMap::new()),
                pending_approvals: parking_lot::Mutex::new(HashMap::new()),
            });

            let drain_signal = Arc::new(tokio::sync::Notify::new());
            tokio::spawn(run_reader(shared.clone(), lines, drain_signal.clone()));
            tokio::spawn(watch_framer_errors(
                shared.clone(),
                framer_errors,
                drain_signal,
            ));

            sink.emit(SwarmEvent::AgentSessionStarted(
                AgentSessionStartedPayload {
                    worker_id: spec.worker_id,
                    provider: ProviderId::Codex,
                    session_key,
                    model: reported_model,
                    cwd: spec.cwd.clone(),
                    capabilities: codex_capabilities(),
                },
            ));

            Ok(Box::new(CodexSession { shared }) as Box<dyn AgentSession>)
        })
    }
}

/// Per-worker, stateful handle to one live `codex app-server` child
/// process.
pub struct CodexSession {
    shared: Arc<Shared>,
}

impl AgentSession for CodexSession {
    fn session_key(&self) -> &SessionKey {
        &self.shared.session_key
    }

    /// Sends `thread/sendMessage` and awaits its RESPONSE for the
    /// accepted `turnId` — a genuinely stronger acceptance guarantee than
    /// `ClaudeCodeSession::send_turn`, which synthesizes a [`TurnId`]
    /// locally and returns immediately with zero confirmation the
    /// provider actually received the line (see that method's doc: "not
    /// once it has completed" applies to both, but Claude Code doesn't
    /// even confirm ACCEPTANCE). Uses [`RESERVED_TURN_SENTINEL`] to hold
    /// the busy-check slot during the brief window between writing the
    /// request and its response arriving — see the module doc's
    /// Condition B section for what happens if the session dies in that
    /// window.
    fn send_turn(&self, turn: TurnInput) -> BoxFuture<'_, Result<TurnId, AppError>> {
        let shared = self.shared.clone();
        Box::pin(async move {
            {
                let mut inner = shared.state.lock();
                if inner.shutdown_result.is_some() {
                    return Err(AppError::Ipc("codex session already shut down".to_string()));
                }
                if inner.in_flight_turn.is_some() {
                    return Err(AppError::AgentSessionBusy);
                }
                inner.in_flight_turn = Some(RESERVED_TURN_SENTINEL.to_string());
            }

            let id = next_request_id(&shared);
            let (tx, rx) = oneshot::channel();
            shared.pending_requests.lock().insert(id, tx);

            let line = build_request_line(
                id,
                protocol::THREAD_SEND_MESSAGE,
                serde_json::json!({
                    "threadId": shared.session_key,
                    "items": [{ "type": "text", "text": turn.prompt }],
                }),
            );

            let write_result = {
                let mut stdin_guard = shared.stdin.lock();
                match stdin_guard.as_mut() {
                    Some(stdin) => write_to_piped(stdin.as_mut(), line.as_bytes()),
                    None => Err(anyhow::anyhow!("stdin already closed")),
                }
            };
            if let Err(e) = write_result {
                shared.state.lock().in_flight_turn = None;
                shared.pending_requests.lock().remove(&id);
                return Err(AppError::Ipc(format!(
                    "failed to write turn to codex stdin: {e}"
                )));
            }

            let response = match tokio::time::timeout(SEND_TURN_ACK_TIMEOUT, rx).await {
                Ok(Ok(r)) => r,
                Ok(Err(_recv_error)) => {
                    // The sender was dropped without sending — teardown
                    // drained it (session died mid-request) or a bug.
                    // `teardown` already cleared `in_flight_turn` for us
                    // in the death case; clearing again is a harmless
                    // no-op otherwise.
                    shared.state.lock().in_flight_turn = None;
                    return Err(AppError::Ipc(
                        "codex session closed before acknowledging the turn".to_string(),
                    ));
                }
                Err(_elapsed) => {
                    shared.state.lock().in_flight_turn = None;
                    shared.pending_requests.lock().remove(&id);
                    return Err(AppError::Ai(
                        "codex did not acknowledge thread/sendMessage in time".to_string(),
                    ));
                }
            };

            match response {
                Err(err_value) => {
                    shared.state.lock().in_flight_turn = None;
                    let msg = err_value
                        .get("message")
                        .and_then(|v| v.as_str())
                        .unwrap_or("thread/sendMessage rejected");
                    Err(AppError::Ai(format!("codex rejected the turn: {msg}")))
                }
                Ok(result) => {
                    let turn_id: TurnId = match result.get("turnId").and_then(|v| v.as_str()) {
                        // The common path: `handle_response` (running
                        // inside the reader task, BEFORE this
                        // continuation ever got a chance to run — see
                        // its doc) already promoted the sentinel to this
                        // exact id. Nothing left to do here.
                        Some(id) => id.to_string(),
                        // Defensive fallback only — a spec-violating
                        // response with no `turnId` at all.
                        // `handle_response` had nothing to match on, so
                        // THIS is the first and only promotion point;
                        // safe precisely because nothing could have
                        // referenced this not-yet-minted id in the
                        // meantime.
                        None => {
                            let fallback = Uuid::new_v4().to_string();
                            let mut inner = shared.state.lock();
                            if inner.in_flight_turn.as_deref() == Some(RESERVED_TURN_SENTINEL) {
                                inner.in_flight_turn = Some(fallback.clone());
                            }
                            fallback
                        }
                    };
                    Ok(turn_id)
                }
            }
        })
    }

    fn await_turn_completion(&self, turn: TurnId) -> BoxFuture<'_, Result<(), AppError>> {
        let shared = self.shared.clone();
        Box::pin(async move {
            loop {
                {
                    let inner = shared.state.lock();
                    if inner.shutdown_result.is_some() {
                        return Ok(());
                    }
                    if inner.last_settled_turn.as_deref() == Some(turn.as_str()) {
                        return Ok(());
                    }
                }
                tokio::time::sleep(AWAIT_TURN_COMPLETION_POLL_INTERVAL).await;
            }
        })
    }

    fn cancel(&self, turn: TurnId) -> BoxFuture<'_, Result<(), AppError>> {
        let shared = self.shared.clone();
        Box::pin(async move {
            let matches = {
                let inner = shared.state.lock();
                inner.in_flight_turn.as_deref() == Some(turn.as_str())
            };
            if matches {
                teardown(&shared).await;
            }
            Ok(())
        })
    }

    /// The REAL round-trip. Looks up the pending approval's original raw
    /// JSON-RPC `id`, writes a response line echoing it back with
    /// `{"decision":"approved"|"denied"}`, and returns. Unlike
    /// `ClaudeCodeSession::respond_permission` (a documented no-op — see
    /// its doc), this actually unblocks the provider: see
    /// `tests::test_approval_round_trip_answers_over_the_real_wire`,
    /// which proves it by making the fake child HANG on
    /// `AWAIT_STDIN_LINE` until this method's write arrives. An unknown
    /// or already-answered `req` is a documented no-op, not an error — a
    /// caller racing a stale/duplicate answer must not fail.
    fn respond_permission(
        &self,
        req: PermissionId,
        decision: PermissionDecision,
    ) -> BoxFuture<'_, Result<(), AppError>> {
        let shared = self.shared.clone();
        Box::pin(async move {
            let Some(raw_id) = shared.pending_approvals.lock().remove(&req) else {
                return Ok(());
            };
            let decision_str = match decision {
                PermissionDecision::Allow => "approved",
                PermissionDecision::Deny => "denied",
            };
            let line = build_response_line(raw_id, serde_json::json!({ "decision": decision_str }));
            let write_result = {
                let mut stdin_guard = shared.stdin.lock();
                match stdin_guard.as_mut() {
                    Some(stdin) => write_to_piped(stdin.as_mut(), line.as_bytes()),
                    None => Err(anyhow::anyhow!("stdin already closed")),
                }
            };
            write_result.map_err(|e| {
                AppError::Ipc(format!(
                    "failed to write approval response to codex stdin: {e}"
                ))
            })
        })
    }

    fn shutdown(&self) -> BoxFuture<'_, Result<ExitSummary, AppError>> {
        let shared = self.shared.clone();
        Box::pin(async move { Ok(teardown(&shared).await) })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::orchestration::{EventLog, OrchestrationEngine};

    fn fixture_path(name: &str) -> String {
        format!("{}/tests/fixtures/codex/{name}", env!("CARGO_MANIFEST_DIR"))
    }

    /// Spawns a `CodexAdapter` wired to `node fake_codex_cli.cjs
    /// <fixture>` instead of the real CLI, against a fresh file-backed
    /// live engine — mirrors `claude_code::tests::spawn_test_session`.
    async fn spawn_test_session(
        fixture_name: &str,
    ) -> (
        crate::events::EventSink,
        std::path::PathBuf,
        Box<dyn AgentSession>,
    ) {
        let db_path = std::env::temp_dir().join(format!(
            "swarm-codex-{}-{}.db",
            fixture_name.replace(['.', '/'], "_"),
            Uuid::new_v4()
        ));
        let log = EventLog::open(&db_path).expect("open file-backed log");
        let engine = OrchestrationEngine::start(log, Some(db_path.clone()), |_| {});
        let sink = engine.sink();

        let cwd = std::env::temp_dir().join(format!("swarm-codex-cwd-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&cwd).expect("create test cwd");

        let adapter = CodexAdapter::with_test_binary(
            sink.clone(),
            "node",
            vec![
                fixture_path("fake_codex_cli.cjs"),
                fixture_path(fixture_name),
            ],
        );
        let session = adapter
            .spawn(AgentSpawnSpec {
                worker_id: Uuid::new_v4(),
                cwd: cwd.display().to_string(),
                model: Some("gpt-5-codex".to_string()),
                resume: None,
                permission_mode: None,
            })
            .await
            .expect("spawn should succeed against the fake codex cli");

        (sink, db_path, session)
    }

    async fn wait_for_event_type(
        db_path: &std::path::Path,
        event_type: &str,
        timeout: std::time::Duration,
    ) {
        let deadline = std::time::Instant::now() + timeout;
        loop {
            let log = EventLog::open(db_path).expect("reopen log");
            let events = log.events_since(0, 500).expect("read events");
            if events.iter().any(|e| e.event_type == event_type) {
                return;
            }
            if std::time::Instant::now() > deadline {
                let types: Vec<&str> = events.iter().map(|e| e.event_type.as_str()).collect();
                panic!("timed out waiting for {event_type}, got: {types:?}");
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
    }

    fn cleanup(db_path: &std::path::Path) {
        std::fs::remove_file(db_path).ok();
        std::fs::remove_file(format!("{}-wal", db_path.display())).ok();
        std::fs::remove_file(format!("{}-shm", db_path.display())).ok();
    }

    // ── Happy path ────────────────────────────────────────────────

    #[tokio::test]
    async fn test_happy_turn_end_to_end_onto_live_engine_with_persistence_classes() {
        let (sink, db_path, session) = spawn_test_session("happy_turn.ndjson").await;
        assert!(!session.session_key().is_empty());
        assert_eq!(session.session_key(), "thread-happy-0001");

        session
            .send_turn(TurnInput {
                prompt: "explain binary search".to_string(),
            })
            .await
            .expect("send_turn should succeed");

        wait_for_event_type(
            &db_path,
            "agent_turn_settled",
            std::time::Duration::from_secs(10),
        )
        .await;

        session.shutdown().await.expect("shutdown should succeed");
        wait_for_event_type(
            &db_path,
            "agent_session_exited",
            std::time::Duration::from_secs(10),
        )
        .await;
        let _ = &sink;

        let log = EventLog::open(&db_path).expect("reopen log");
        let events = log.events_since(0, 500).expect("read events");
        let types: Vec<&str> = events.iter().map(|e| e.event_type.as_str()).collect();

        assert!(types.contains(&"agent_session_started"));
        assert!(types.contains(&"agent_block"));
        assert!(types.contains(&"agent_turn_settled"));
        assert!(types.contains(&"agent_session_exited"));
        assert!(
            !types.contains(&"agent_turn_delta"),
            "agent_turn_delta must be ephemeral, got: {types:?}"
        );

        let settled = events
            .iter()
            .find(|e| e.event_type == "agent_turn_settled")
            .expect("settled row");
        assert_eq!(settled.payload["status"], "ok");
        assert_eq!(settled.payload["turnId"], "turn-happy-0001");

        cleanup(&db_path);
    }

    // ── Review FIX-1/FIX-2: confirmation/terminal wire-order interleaving ─

    /// DIRECTIVE (review FIX-2a): a dedicated, explicitly-named test for
    /// the wire order `happy_turn.ndjson` already rides on implicitly —
    /// `thread/sendMessage`'s response arrives, THEN the terminal
    /// `turn/completed` notification. Asserts the interleaving invariant
    /// directly (exactly one settled event, using the confirmed
    /// `TurnId`) rather than only as a side effect of a broader
    /// happy-path assertion.
    #[tokio::test]
    async fn test_send_message_response_before_terminal_notification_settles_exactly_once() {
        let (_sink, db_path, session) = spawn_test_session("happy_turn.ndjson").await;
        let turn_id = session
            .send_turn(TurnInput {
                prompt: "explain binary search".to_string(),
            })
            .await
            .expect("send_turn should succeed");
        assert_eq!(turn_id, "turn-happy-0001");

        wait_for_event_type(
            &db_path,
            "agent_turn_settled",
            std::time::Duration::from_secs(10),
        )
        .await;
        session.shutdown().await.ok();

        let log = EventLog::open(&db_path).expect("reopen log");
        let events = log.events_since(0, 500).expect("read events");
        let settled: Vec<serde_json::Value> = events
            .iter()
            .filter(|e| e.event_type == "agent_turn_settled")
            .map(|e| e.payload.clone())
            .collect();
        assert_eq!(
            settled.len(),
            1,
            "exactly one settled event for the response-first order, got: {settled:?}"
        );
        assert_eq!(settled[0]["status"], "ok");
        assert_eq!(settled[0]["turnId"], turn_id);

        cleanup(&db_path);
    }

    /// DIRECTIVE (review FIX-1/FIX-2b, the regression this whole fix
    /// exists for): the REVERSE wire order — `item/started`/
    /// `item/completed`/`turn/completed` ALL arrive BEFORE
    /// `thread/sendMessage`'s response confirms the real `TurnId`. Before
    /// FIX-1, `settle_turn` found the sentinel still in place and
    /// silently skipped (ZERO settled events for a turn Codex told us is
    /// done), then `handle_response`'s later promotion attempt found
    /// nothing left to promote — a permanently stuck `in_flight_turn`
    /// that `teardown` would eventually settle with an ERRONEOUS
    /// `PROCESS_EXITED_WITHOUT_RECEIPT`, even though the turn genuinely
    /// succeeded. After the fix: `settle_turn` trusts the terminal
    /// notification's OWN `turnId` and settles immediately; `send_turn`
    /// still returns the correct, matching `TurnId` once the (now
    /// redundant) response arrives.
    #[tokio::test]
    async fn test_terminal_notification_arriving_before_the_send_message_response_still_settles_exactly_once()
     {
        let (_sink, db_path, session) = spawn_test_session("terminal_before_response.ndjson").await;
        let turn_id = session
            .send_turn(TurnInput {
                prompt: "trigger the reordered wire".to_string(),
            })
            .await
            .expect("send_turn should still succeed even though the terminal notification won the wire race");
        assert_eq!(turn_id, "turn-reorder-0001");

        wait_for_event_type(
            &db_path,
            "agent_turn_settled",
            std::time::Duration::from_secs(10),
        )
        .await;
        session.shutdown().await.ok();
        wait_for_event_type(
            &db_path,
            "agent_session_exited",
            std::time::Duration::from_secs(10),
        )
        .await;

        let log = EventLog::open(&db_path).expect("reopen log");
        let events = log.events_since(0, 500).expect("read events");
        let settled: Vec<serde_json::Value> = events
            .iter()
            .filter(|e| e.event_type == "agent_turn_settled")
            .map(|e| e.payload.clone())
            .collect();
        assert_eq!(
            settled.len(),
            1,
            "exactly one settled event despite the reordered wire — never zero, never two, got: {settled:?}"
        );
        assert_eq!(
            settled[0]["status"], "ok",
            "the turn genuinely succeeded — must not be reported as a synthesized Condition-B error"
        );
        assert_eq!(settled[0]["turnId"], "turn-reorder-0001");
        assert_ne!(
            settled[0]["error"],
            serde_json::json!(PROCESS_EXITED_WITHOUT_RECEIPT),
            "must never be misreported as the ungraceful-exit synthesis"
        );

        cleanup(&db_path);
    }

    // ── Review FIX-3: turn/failed coverage ────────────────────────

    /// DIRECTIVE (review FIX-3): `turn/failed` was previously entirely
    /// untested and its method name is an ASSUMED one (see the module
    /// doc's ASSUMPTIONS list item 1) — this proves the CODE PATH: exactly
    /// one `agent_turn_settled{status: "error"}` with the provider's
    /// reported error text surfaced verbatim.
    #[tokio::test]
    async fn test_turn_failed_settles_with_the_reported_error() {
        let (_sink, db_path, session) = spawn_test_session("turn_failed.ndjson").await;
        let turn_id = session
            .send_turn(TurnInput {
                prompt: "run something that fails".to_string(),
            })
            .await
            .expect("send_turn should succeed");

        wait_for_event_type(
            &db_path,
            "agent_turn_settled",
            std::time::Duration::from_secs(10),
        )
        .await;
        session.shutdown().await.ok();

        let log = EventLog::open(&db_path).expect("reopen log");
        let events = log.events_since(0, 500).expect("read events");
        let settled: Vec<serde_json::Value> = events
            .iter()
            .filter(|e| e.event_type == "agent_turn_settled")
            .map(|e| e.payload.clone())
            .collect();
        assert_eq!(settled.len(), 1, "got: {settled:?}");
        assert_eq!(settled[0]["status"], "error");
        assert_eq!(settled[0]["error"], "sandboxed command exited non-zero");
        assert_eq!(settled[0]["turnId"], turn_id);

        cleanup(&db_path);
    }

    // ── Tool-call correlation by request id ──────────────────────

    #[tokio::test]
    async fn test_tool_turn_maps_tool_call_and_tool_result_with_matching_ids() {
        let (_sink, db_path, session) = spawn_test_session("tool_turn.ndjson").await;
        session
            .send_turn(TurnInput {
                prompt: "read data.txt".to_string(),
            })
            .await
            .expect("send_turn should succeed");

        wait_for_event_type(
            &db_path,
            "agent_turn_settled",
            std::time::Duration::from_secs(10),
        )
        .await;
        session.shutdown().await.ok();

        let log = EventLog::open(&db_path).expect("reopen log");
        let events = log.events_since(0, 500).expect("read events");

        let calls: Vec<serde_json::Value> = events
            .iter()
            .filter(|e| e.event_type == "agent_tool_call")
            .map(|e| e.payload.clone())
            .collect();
        let results: Vec<serde_json::Value> = events
            .iter()
            .filter(|e| e.event_type == "agent_tool_result")
            .map(|e| e.payload.clone())
            .collect();

        assert!(!calls.is_empty(), "expected at least one agent_tool_call");
        assert_eq!(calls.len(), results.len(), "call/result count must match");
        for call in &calls {
            let id = call["toolUseId"].as_str().unwrap();
            assert!(
                results.iter().any(|r| r["toolUseId"].as_str() == Some(id)),
                "no matching agent_tool_result for tool_use_id {id}"
            );
        }

        cleanup(&db_path);
    }

    // ── Interactive approval round-trip — the Codex-specific finding ─

    /// DIRECTIVE: proves `respond_permission` is a REAL round-trip, not
    /// a report-only no-op. The fixture's fake child HANGS on
    /// `AWAIT_STDIN_LINE` after emitting the `approval/request` line —
    /// if `respond_permission` did nothing (Claude Code's behavior), this
    /// test would time out waiting for `agent_turn_settled`, since the
    /// fake child would never resume to emit `item/completed`/
    /// `turn/completed`.
    #[tokio::test]
    async fn test_approval_round_trip_answers_over_the_real_wire() {
        let (_sink, db_path, session) = spawn_test_session("approval_round_trip.ndjson").await;
        session
            .send_turn(TurnInput {
                prompt: "clean the build directory".to_string(),
            })
            .await
            .expect("send_turn should succeed");

        wait_for_event_type(
            &db_path,
            "agent_permission_request",
            std::time::Duration::from_secs(10),
        )
        .await;

        let request_id = {
            let log = EventLog::open(&db_path).expect("reopen log");
            let events = log.events_since(0, 500).expect("read events");
            let req = events
                .iter()
                .find(|e| e.event_type == "agent_permission_request")
                .expect("agent_permission_request row");
            assert!(
                req.payload["suggestedDecision"].is_null(),
                "a genuinely pending Codex approval must not carry a suggestedDecision \
                 (unlike ClaudeCodeAdapter's always-Some(Deny) report), got: {:?}",
                req.payload["suggestedDecision"]
            );
            req.payload["requestId"].as_str().unwrap().to_string()
        };

        session
            .respond_permission(request_id, PermissionDecision::Allow)
            .await
            .expect("respond_permission should succeed");

        // If this hangs, the round-trip didn't actually reach the fake
        // child's AWAIT_STDIN_LINE — the whole point of this test.
        wait_for_event_type(
            &db_path,
            "agent_turn_settled",
            std::time::Duration::from_secs(10),
        )
        .await;

        session.shutdown().await.ok();

        let log = EventLog::open(&db_path).expect("reopen log");
        let events = log.events_since(0, 500).expect("read events");
        let settled = events
            .iter()
            .find(|e| e.event_type == "agent_turn_settled")
            .expect("settled row");
        assert_eq!(
            settled.payload["status"], "ok",
            "the turn must settle successfully AFTER the approval was answered"
        );

        cleanup(&db_path);
    }

    // ── Condition B: kill-mid-turn (post-confirmation) ────────────

    #[tokio::test]
    async fn test_kill_mid_turn_synthesizes_exactly_one_settled_and_session_exited() {
        let (_sink, db_path, session) = spawn_test_session("hang_after_init.ndjson").await;

        let turn_id = session
            .send_turn(TurnInput {
                prompt: "start something long".to_string(),
            })
            .await
            .expect("send_turn should succeed");

        tokio::time::sleep(std::time::Duration::from_millis(200)).await;

        let summary = session.shutdown().await.expect("shutdown should succeed");
        assert!(summary.exit_code.is_none() || summary.exit_code != Some(0));

        wait_for_event_type(
            &db_path,
            "agent_session_exited",
            std::time::Duration::from_secs(10),
        )
        .await;

        let log = EventLog::open(&db_path).expect("reopen log");
        let events = log.events_since(0, 500).expect("read events");

        let settled: Vec<serde_json::Value> = events
            .iter()
            .filter(|e| e.event_type == "agent_turn_settled")
            .map(|e| e.payload.clone())
            .collect();
        assert_eq!(
            settled.len(),
            1,
            "exactly one settled event, got: {settled:?}"
        );
        assert_eq!(settled[0]["status"], "error");
        assert_eq!(settled[0]["error"], "Process Exited Without A Receipt");
        assert_eq!(settled[0]["turnId"], turn_id);

        let exited_count = events
            .iter()
            .filter(|e| e.event_type == "agent_session_exited")
            .count();
        assert_eq!(exited_count, 1, "exactly one agent_session_exited");

        cleanup(&db_path);
    }

    // ── Condition B corollary: death BEFORE turn confirmation ──────

    /// DIRECTIVE: the Codex-specific edge case Claude Code's
    /// client-synthesized-turn-id design cannot have — a turn that dies
    /// before `thread/sendMessage`'s response ever arrives never
    /// received a real [`TurnId`], so there is nothing to attach a
    /// synthesized settlement to. It resolves by directly failing the
    /// caller's still-pending `send_turn` (via `teardown`'s
    /// pending-request drain), never a hang and never a phantom
    /// `agent_turn_settled` for a turn nobody ever received.
    #[tokio::test]
    async fn test_child_death_before_turn_confirmation_resolves_send_turn_with_an_error_not_a_hang()
    {
        let (_sink, db_path, session) = spawn_test_session("unconfirmed_turn_death.ndjson").await;

        let result = tokio::time::timeout(
            std::time::Duration::from_secs(10),
            session.send_turn(TurnInput {
                prompt: "this will never be confirmed".to_string(),
            }),
        )
        .await
        .expect("send_turn must not hang past the session's own death");

        assert!(
            result.is_err(),
            "send_turn must fail once the child dies before confirming the turn, got: {result:?}"
        );

        wait_for_event_type(
            &db_path,
            "agent_session_exited",
            std::time::Duration::from_secs(10),
        )
        .await;

        let log = EventLog::open(&db_path).expect("reopen log");
        let events = log.events_since(0, 500).expect("read events");
        let settled_count = events
            .iter()
            .filter(|e| e.event_type == "agent_turn_settled")
            .count();
        assert_eq!(
            settled_count, 0,
            "no agent_turn_settled must be emitted for a turn that was never confirmed accepted"
        );

        cleanup(&db_path);
    }

    // ── Framer-error surfacing (post-confirmation) ────────────────

    #[tokio::test]
    async fn test_framer_error_surfaces_as_synthesized_settlement() {
        let (_sink, db_path, session) = spawn_test_session("oversized_line.ndjson").await;

        let turn_id = session
            .send_turn(TurnInput {
                prompt: "trigger the oversized line".to_string(),
            })
            .await
            .expect("send_turn should succeed");

        wait_for_event_type(
            &db_path,
            "agent_session_exited",
            std::time::Duration::from_secs(15),
        )
        .await;

        let log = EventLog::open(&db_path).expect("reopen log");
        let events = log.events_since(0, 500).expect("read events");
        let settled: Vec<serde_json::Value> = events
            .iter()
            .filter(|e| e.event_type == "agent_turn_settled")
            .map(|e| e.payload.clone())
            .collect();
        assert_eq!(settled.len(), 1);
        assert_eq!(settled[0]["status"], "error");
        assert_eq!(settled[0]["turnId"], turn_id);

        cleanup(&db_path);
    }

    // ── Busy rejection / idempotent shutdown ───────────────────────

    #[tokio::test]
    async fn test_send_turn_while_busy_returns_agent_session_busy() {
        let (_sink, db_path, session) = spawn_test_session("hang_after_init.ndjson").await;

        session
            .send_turn(TurnInput {
                prompt: "first".to_string(),
            })
            .await
            .expect("first send_turn should succeed");

        let second = session
            .send_turn(TurnInput {
                prompt: "second".to_string(),
            })
            .await;
        assert!(
            matches!(second, Err(AppError::AgentSessionBusy)),
            "expected AgentSessionBusy, got: {second:?}"
        );

        session.shutdown().await.ok();
        cleanup(&db_path);
    }

    #[tokio::test]
    async fn test_shutdown_is_idempotent() {
        let (_sink, db_path, session) = spawn_test_session("happy_turn.ndjson").await;
        session
            .send_turn(TurnInput {
                prompt: "hi".to_string(),
            })
            .await
            .expect("send_turn should succeed");
        wait_for_event_type(
            &db_path,
            "agent_turn_settled",
            std::time::Duration::from_secs(10),
        )
        .await;

        let first = session.shutdown().await.expect("first shutdown succeeds");
        let second = session.shutdown().await.expect("second shutdown succeeds");
        assert_eq!(
            first, second,
            "idempotent shutdown must return the same summary"
        );

        wait_for_event_type(
            &db_path,
            "agent_session_exited",
            std::time::Duration::from_secs(10),
        )
        .await;
        let log = EventLog::open(&db_path).expect("reopen log");
        let events = log.events_since(0, 500).expect("read events");
        let exited_count = events
            .iter()
            .filter(|e| e.event_type == "agent_session_exited")
            .count();
        assert_eq!(
            exited_count, 1,
            "double shutdown must not re-emit agent_session_exited"
        );

        cleanup(&db_path);
    }

    // ── "never" approval policy unconstructible ────────────────────

    #[test]
    fn test_never_approval_policy_is_unconstructible_across_every_trust_tier() {
        for tier in [
            CodexTrustTier::Restricted,
            CodexTrustTier::Standard,
            CodexTrustTier::WriteEnabled,
        ] {
            assert_ne!(approval_policy_str(tier), "never");
            assert_ne!(sandbox_policy_str(tier), "danger-full-access");
        }

        for bad in [
            "never",
            "danger-full-access",
            "bypassPermissions",
            "manual",
            "auto",
        ] {
            let result = parse_trust_tier(Some(bad));
            assert!(
                result.is_err(),
                "expected {bad:?} to be rejected as an unrecognized trust tier, got: {result:?}"
            );
        }
    }

    #[test]
    fn test_build_thread_start_params_never_emits_never_or_danger_full_access() {
        for tier in [
            CodexTrustTier::Restricted,
            CodexTrustTier::Standard,
            CodexTrustTier::WriteEnabled,
        ] {
            let params = build_thread_start_params("/tmp/repo", Some("gpt-5-codex"), tier);
            let raw = params.to_string();
            assert!(
                !raw.contains("never"),
                "params must never contain \"never\", got: {raw}"
            );
            assert!(
                !raw.contains("danger-full-access"),
                "params must never contain \"danger-full-access\", got: {raw}"
            );
        }
    }

    // ── Probe ─────────────────────────────────────────────────────

    #[tokio::test]
    async fn test_probe_reports_available_for_a_present_binary() {
        let log = EventLog::open_in_memory().expect("open in-memory log");
        let engine = OrchestrationEngine::start(log, None, |_| {});
        let adapter = CodexAdapter::with_test_binary(engine.sink(), "node", vec![]);
        let report = adapter.probe().await.expect("probe should not error");
        assert!(report.available);
        assert!(report.version.is_some());
    }

    #[tokio::test]
    async fn test_probe_reports_unavailable_for_a_missing_binary() {
        let log = EventLog::open_in_memory().expect("open in-memory log");
        let engine = OrchestrationEngine::start(log, None, |_| {});
        let adapter = CodexAdapter::with_test_binary(
            engine.sink(),
            "definitely-not-a-real-codex-binary-xyz",
            vec![],
        );
        let report = adapter.probe().await.expect("probe should not error");
        assert!(!report.available);
        assert!(report.detail.is_some());
        assert!(
            report
                .detail
                .unwrap()
                .contains("Codex CLI Not Found On PATH")
        );
    }

    // ── Provider identity / capability honesty ──────────────────────

    #[test]
    fn test_provider_and_capabilities_are_honest() {
        let log = EventLog::open_in_memory().expect("open in-memory log");
        let engine = OrchestrationEngine::start(log, None, |_| {});
        let adapter = CodexAdapter::new(engine.sink());
        assert_eq!(adapter.provider(), ProviderId::Codex);
        let caps = adapter.capabilities();
        assert!(caps.partial_deltas);
        assert!(
            !caps.resume,
            "resume is NOT implemented in this cut — must be honestly false"
        );
        assert!(!caps.native_cost);
        assert_eq!(caps.cancel_granularity, CancelGranularity::KillOnly);
        assert!(!caps.interrupt_midturn);
        assert!(caps.worktree_aware);
        assert!(
            caps.interactive_permissions,
            "the one flag this adapter backs with a fixture-tested real round-trip"
        );
    }

    /// DIRECTIVE: `resume` being explicitly rejected (not silently
    /// ignored) at spawn time — see `codex_capabilities`'s `resume:
    /// false` doc.
    #[tokio::test]
    async fn test_resume_is_explicitly_rejected_not_silently_ignored() {
        let db_path =
            std::env::temp_dir().join(format!("swarm-codex-resume-reject-{}.db", Uuid::new_v4()));
        let log = EventLog::open(&db_path).expect("open file-backed log");
        let engine = OrchestrationEngine::start(log, Some(db_path.clone()), |_| {});
        let adapter = CodexAdapter::with_test_binary(
            engine.sink(),
            "node",
            vec![
                fixture_path("fake_codex_cli.cjs"),
                fixture_path("happy_turn.ndjson"),
            ],
        );
        let result = adapter
            .spawn(AgentSpawnSpec {
                worker_id: Uuid::new_v4(),
                cwd: std::env::temp_dir().display().to_string(),
                model: None,
                resume: Some("some-prior-thread-id".to_string()),
                permission_mode: None,
            })
            .await;
        assert!(
            result.is_err(),
            "resume must be rejected, got: {}",
            result.is_ok()
        );
        cleanup(&db_path);
    }
}
