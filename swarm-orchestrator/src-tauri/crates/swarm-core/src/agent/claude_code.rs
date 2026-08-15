//! `ClaudeCodeAdapter` — the first concrete [`AgentAdapter`]/
//! [`AgentSession`] implementation, driving the `claude` CLI's
//! first-party `stream-json` protocol over piped stdio
//! ([`crate::worker::proc::spawn_piped`]).
//!
//! ## Grounding: every design choice here traces to an empirical finding
//!
//! This module is downstream of two spikes, both binding
//! (`RECONCILIATION.md` §0/§0b):
//!
//! - **§0 (main spike, GO with three conditions):** sentence-clause
//!   delta granularity; kill-only cancel (43ms measured); the provider
//!   emits ZERO terminal events on process kill (**Condition B** — this
//!   adapter synthesizes the receipt, see [`teardown`]); Condition A
//!   (a controlled config environment via `--setting-sources project` +
//!   `--settings '<inline json>'`, see [`inline_settings_json`] — NOT a
//!   file written into the worker's cwd, a design correction made after
//!   review; see that function's doc) is what makes latency AND cost
//!   land in-budget.
//! - **§0b (permission-gating mini-spike):** `--permission-mode manual`
//!   is a **silent no-op** in `-p` mode — the interactive
//!   `agent_permission_request` → `respond_permission` round-trip this
//!   event was originally designed for is not buildable on this
//!   provider (see [`crate::events::emitter::AgentPermissionRequestPayload`]'s
//!   semantics-shift doc). What DOES gate: `--permission-mode`
//!   (`dontAsk`/`acceptEdits`) and `settings.json` `permissions.deny` —
//!   **never** `allowedTools` (Condition C, `PermissionDecision`'s doc).
//!   Trust tiers are therefore SPAWN-TIME configurations
//!   ([`ClaudeCodeTrustTier`]), not mid-turn prompts.
//!
//! ## Multi-turn reality (Phase 3 entry finding, empirically confirmed)
//!
//! A single `claude -p` process, fed more than one stream-json user
//! message on stdin before EOF, processes each as a separate turn IN
//! THE SAME PROCESS AND SAME SESSION — each turn gets its own
//! `system/init` + terminal `result` line, but `session_id` (and
//! conversation context) is stable across all of them
//! (`scratchpad/spike/logs/multi-turn-same-process.*`). This adapter
//! therefore keeps ONE child process alive for a session's whole
//! lifetime: [`ClaudeCodeSession::send_turn`] writes to the SAME
//! already-open stdin every time; `--resume` is only used to REHYDRATE
//! a session whose process is gone (app restart, prior kill), never as
//! a per-turn respawn strategy.
//!
//! ## `acceptEdits` canary (Phase 3 entry criterion for the
//! Write-Enabled tier — PASS)
//!
//! The mini-spike left `acceptEdits` as the one untested permission-mode
//! cell. A dedicated canary run
//! (`scratchpad/spike-permissions/logs/13-acceptedits-canary.*`,
//! `--permission-mode acceptEdits --setting-sources project`, real
//! `claude` CLI, $0.05) confirmed: the Write tool executed cleanly, zero
//! `permission_denied` events, `init.permissionMode == "acceptEdits"`.
//! [`ClaudeCodeTrustTier::WriteEnabled`] is gated on this result.

use std::collections::{HashMap, VecDeque};
use std::io::Write;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tokio::sync::mpsc;
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

/// Ceiling on how long [`ClaudeCodeAdapter::spawn`] waits for the
/// child's first `system/init` line before giving up and reporting a
/// spawn failure — bounded, per the plan's "Not Signed In, never a
/// hang" rule, rather than waiting forever on a wedged/misbehaving
/// child.
const INIT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);

/// Ceiling on [`ClaudeCodeAdapter::probe`]'s `--version` check.
const PROBE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);

/// Poll interval for [`ClaudeCodeSession::await_turn_completion`].
/// Deliberately a plain poll loop rather than a `tokio::sync::Notify`
/// wakeup: `Notify::notify_waiters` only wakes tasks already
/// registered as waiting AT THE MOMENT it's called — a check-then-await
/// caller that hasn't reached `.await` yet can miss the notification
/// entirely (a real lost-wakeup hazard), which is an unacceptable risk
/// in a module whose whole design principle is "never a hang." A
/// 15ms poll against turn durations measured in the hundreds of
/// milliseconds to many seconds is negligible overhead traded for a
/// race-free implementation.
const AWAIT_TURN_COMPLETION_POLL_INTERVAL: std::time::Duration =
    std::time::Duration::from_millis(15);

/// Default `--model` alias when [`AgentSpawnSpec::model`] is `None`.
const DEFAULT_MODEL_ALIAS: &str = "sonnet";

/// Internal-turn circuit breaker (`--max-turns`), applied to EVERY
/// spawn regardless of trust tier — a generous ceiling on the
/// provider's own internal tool-use loop for one SWARM-visible turn,
/// not a constraint on how many SWARM turns a session may have (that's
/// unbounded — see the module doc's multi-turn finding). Verified
/// present but undocumented in `--help` (flag-drift note, Phase 1 spike).
const MAX_TURNS_PER_TURN: &str = "50";

/// Exact synthesized-settlement error text mandated by Condition B
/// (RECONCILIATION.md §0) for every ungraceful-exit path this adapter
/// handles — child killed, child crashed, or an NDJSON framer error.
const PROCESS_EXITED_WITHOUT_RECEIPT: &str = "Process Exited Without A Receipt";

// ── Trust tiers (Condition A / §0b — spawn-time configuration) ──────

/// SWARM's own closed vocabulary for Claude Code's spawn-time trust
/// dial. See the module doc's §0b section — permission modes are
/// spawn-time configurations, never a mid-turn prompt.
///
/// Deliberately NOT the provider's raw `--permission-mode` strings.
/// [`AgentSpawnSpec::permission_mode`] (the generic cross-provider
/// trait field) is parsed through [`parse_trust_tier`], which
/// recognizes ONLY the three wire tokens below and fails closed
/// (`Err`) on anything else — including a caller passing a raw
/// provider mode string directly (`"acceptEdits"`, `"dontAsk"`) or,
/// most importantly, `"bypassPermissions"`/`"manual"`. This is what
/// makes `--bypassPermissions` unconstructible by this adapter: there
/// is no code path — not a runtime check, an ABSENT one — through
/// which any of this enum's 3 variants could ever produce that flag
/// value. See `permission_mode_flag` and
/// `tests::test_bypass_permissions_is_unconstructible_across_every_trust_tier`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ClaudeCodeTrustTier {
    /// Read-only exploration. `--permission-mode dontAsk` (real
    /// runtime denials with events — §0b mini-spike cell 6) plus a
    /// belt-and-suspenders `settings.json` deny list.
    Restricted,
    /// Can run shell commands; cannot write/edit files (default `-p`
    /// mode auto-denies Write/Edit — §0b's "default -p mode reality").
    /// No `--permission-mode` flag: omitting it IS the documented way
    /// to request the implicit default (`"default"` itself is not a
    /// selectable value — the Phase 1 spike's flag-drift note) plus a
    /// deny list for dangerous Bash patterns.
    Standard,
    /// Can run shell commands AND write/edit files without a prompt.
    /// `--permission-mode acceptEdits` — gated on the Phase 3 canary
    /// run described in the module doc (PASS).
    WriteEnabled,
}

/// Parses [`AgentSpawnSpec::permission_mode`] into a
/// [`ClaudeCodeTrustTier`]. `None` (the field's default) resolves to
/// [`ClaudeCodeTrustTier::Standard`]. Any string outside the exact
/// 3-token vocabulary — including every raw provider mode name and
/// `"bypassPermissions"`/`"manual"` specifically — is rejected rather
/// than guessed at.
fn parse_trust_tier(raw: Option<&str>) -> Result<ClaudeCodeTrustTier, AppError> {
    match raw {
        None | Some("standard") => Ok(ClaudeCodeTrustTier::Standard),
        Some("restricted") => Ok(ClaudeCodeTrustTier::Restricted),
        Some("write_enabled") => Ok(ClaudeCodeTrustTier::WriteEnabled),
        Some(other) => Err(AppError::PermissionDenied(format!(
            "unrecognized claude code trust tier {other:?} — refusing to spawn rather than \
             guess a permission mode (never bypassPermissions, never manual)"
        ))),
    }
}

/// The `--permission-mode` flag value for `tier`, or `None` when the
/// tier requests the implicit default (no flag at all).
fn permission_mode_flag(tier: ClaudeCodeTrustTier) -> Option<&'static str> {
    match tier {
        ClaudeCodeTrustTier::Restricted => Some("dontAsk"),
        ClaudeCodeTrustTier::Standard => None,
        ClaudeCodeTrustTier::WriteEnabled => Some("acceptEdits"),
    }
}

/// `settings.json` `permissions.deny` entries for `tier`. The bare tool
/// name form (`"Bash"`) is spike-verified verbatim
/// (`scratchpad/spike-permissions/harness/settings-deny-bash.json.bak`,
/// cells 6a/6b): it removes the tool from the model's available tool
/// list entirely — a full-tool deny, not a per-call one.
///
/// The `Tool(pattern)` glob form used for Standard/WriteEnabled's
/// dangerous-Bash-pattern denials is now ALSO spike-verified, and
/// confirmed **pattern-granular** — MEASURED, not assumed. Canary run:
/// `--settings '{"permissions":{"deny":["Bash(echo*)"]}}'
/// --setting-sources project` (inline settings, no on-disk
/// `.claude/settings.json`), one turn instructed to invoke Bash for
/// both `echo hi` and `pwd`. Result, same run: `echo hi` was denied
/// (`is_error: true`, content `"Permission to use Bash with command
/// echo hi has been denied."`, and a matching `permission_denials`
/// entry naming exactly that command) while `pwd` executed normally
/// (`is_error: false`, real cwd in the tool result) — `Bash` itself
/// stayed listed in the init message's `tools` array throughout,
/// unlike the bare-tool-name case above. Neither "deny all Bash" nor
/// "deny nothing"; the glob restricts exactly the matching invocation
/// (the run terminated via `error_max_turns` after both tool results
/// were already captured — same harmless `--max-turns`-bounds-the-
/// harness nuance as the `acceptEdits` canary elsewhere in this
/// module's tests; the measurement stands regardless).
/// (`scratchpad/spike-permissions/harness/specs/15-glob-deny-echo-vs-pwd.json`
/// and the matching `logs/15-glob-deny-echo-vs-pwd.summary.json` — run
/// used `--model haiku` rather than the harness's usual `sonnet` solely
/// to stay under a $0.10 run budget, since permission gating is
/// enforced by the CLI around the tool call rather than by the model
/// itself, so the swap doesn't affect what's being measured here.)
///
/// Only `Bash(echo*)` was exercised: the Standard/WriteEnabled deny
/// list's other four pattern-form entries below (`Bash(rm -rf*)`,
/// `Bash(git push --force*)`, `Bash(git push -f*)`,
/// `Bash(git reset --hard*)`, `Bash(sudo*)`) follow the same
/// `Tool(pattern)` glob grammar just verified pattern-granular above,
/// not a separately confirmed empirical result apiece.
fn deny_list(tier: ClaudeCodeTrustTier) -> Vec<&'static str> {
    match tier {
        ClaudeCodeTrustTier::Restricted => vec!["Bash", "Write", "Edit", "NotebookEdit"],
        ClaudeCodeTrustTier::Standard | ClaudeCodeTrustTier::WriteEnabled => vec![
            "Bash(rm -rf*)",
            "Bash(git push --force*)",
            "Bash(git push -f*)",
            "Bash(git reset --hard*)",
            "Bash(sudo*)",
        ],
    }
}

/// Condition A, inline: builds the JSON STRING passed verbatim to
/// `--settings '<json>'` (never a file, never written into the
/// worker's cwd/worktree).
///
/// **Corrects a landed-but-false claim from the first cut of this
/// module**, which wrote `<cwd>/.claude/settings.json` into the
/// worker's worktree on the (unverified, and wrong) premise that "no
/// `--settings <path>` override exists in the flag surface." A review
/// pass verified `--settings` DOES exist (`claude --help`: `--settings
/// <file-or-json>  Path to a settings JSON file or a JSON string`) —
/// and that the earlier design was actively dangerous, not merely
/// suboptimal: a file written INTO a git worktree (a) gets staged and
/// shipped by the ship chain's commit-all path, (b) makes the
/// worktree permanently dirty, so `git worktree remove` refuses
/// forever and every Claude Code worker leaked its worktree on kill,
/// and (c) a bare `fs::write` would have clobbered a human-committed
/// `.claude/settings.json` if one existed.
///
/// **Re-verified empirically before landing this fix**
/// (`scratchpad/spike-permissions/logs/14-inline-settings-plus-setting-sources.*`,
/// real CLI, `--settings '{"permissions":{"deny":["Bash"]}}'
/// --setting-sources project`): byte-for-byte identical behavior to
/// the file-based approach the original mini-spike validated — same
/// `init` tool/plugin/mcp counts (30/0/0, matching Condition A's
/// controlled-environment win) as the file-based
/// `08-settings-deny-project-only` run, and the SAME
/// deny-by-omission pattern (the model tries `ToolSearch` for `Bash`,
/// never finds it, never gets a `tool_use` for it) in both runs. The
/// two flags compose correctly; no settings-file fallback is needed.
fn inline_settings_json(tier: ClaudeCodeTrustTier) -> String {
    serde_json::json!({ "permissions": { "deny": deny_list(tier) } }).to_string()
}

/// What this adapter can honestly promise — see [`Capabilities`]'s
/// honesty doctrine. Identical for every trust tier: the trust dial
/// changes what the provider is ALLOWED to do, never what it is
/// structurally CAPABLE of.
fn claude_code_capabilities() -> Capabilities {
    Capabilities {
        partial_deltas: true,
        resume: true,
        native_cost: true,
        permission_modes: vec![
            "default".to_string(),
            "dontAsk".to_string(),
            "acceptEdits".to_string(),
        ],
        cancel_granularity: CancelGranularity::KillOnly,
        interrupt_midturn: false,
        worktree_aware: true,
    }
}

/// Builds the full `claude` CLI argv (everything after the binary
/// itself) for one spawn. `resume` selects `--resume <key>`
/// (rehydration) vs. `--session-id <worker_id>` (fresh session — the
/// worker's own UUID becomes the session key, per the plan).
fn build_claude_flags(
    worker_id: Uuid,
    model: &str,
    tier: ClaudeCodeTrustTier,
    resume: Option<&str>,
) -> Vec<String> {
    let mut argv = vec![
        "-p".to_string(),
        "--output-format".to_string(),
        "stream-json".to_string(),
        "--input-format".to_string(),
        "stream-json".to_string(),
        "--include-partial-messages".to_string(),
        "--verbose".to_string(),
        "--model".to_string(),
        model.to_string(),
        "--max-turns".to_string(),
        MAX_TURNS_PER_TURN.to_string(),
        "--setting-sources".to_string(),
        "project".to_string(),
        "--settings".to_string(),
        inline_settings_json(tier),
    ];
    if let Some(flag) = permission_mode_flag(tier) {
        argv.push("--permission-mode".to_string());
        argv.push(flag.to_string());
    }
    match resume {
        Some(session_key) => {
            argv.push("--resume".to_string());
            argv.push(session_key.to_string());
        }
        None => {
            argv.push("--session-id".to_string());
            argv.push(worker_id.to_string());
        }
    }
    argv
}

/// Builds one stream-json input line for [`ClaudeCodeSession::send_turn`].
/// Shape verified empirically against the real CLI
/// (`scratchpad/spike/harness/gen-specs.js`'s `userTurn` helper, used
/// in every spike run) — `{"type":"user","message":{"role":"user","content":<prompt>}}`.
fn build_turn_line(prompt: &str) -> String {
    let value = serde_json::json!({
        "type": "user",
        "message": { "role": "user", "content": prompt }
    });
    format!("{value}\n")
}

/// Best-effort classification of a `system/permission_denied` line into
/// one of the three subclasses the §0b mini-spike observed:
///
/// - `"mode"` — `decision_reason_type == "mode"` (the active
///   `--permission-mode` blocks it, e.g. `plan`/`dontAsk`).
/// - `"ungranted_write"` — default `-p` mode's auto-deny for Write/Edit
///   ("but you haven't granted it yet" in the provider's own message).
/// - `"redirection_guard"` — the static Bash output-redirection guard
///   ("Output redirection to ... was blocked").
///
/// `None` when the shape matches none of the three (a future provider
/// version's new denial class) — reported honestly as unclassified
/// rather than forced into one of the three.
fn classify_denial(decision_reason_type: Option<&str>, message: &str) -> Option<String> {
    if decision_reason_type == Some("mode") {
        return Some("mode".to_string());
    }
    if message.contains("haven't granted it yet") {
        return Some("ungranted_write".to_string());
    }
    if message.contains("Output redirection") {
        return Some("redirection_guard".to_string());
    }
    None
}

// ── Session state ────────────────────────────────────────────────────

/// Mutable state shared between [`ClaudeCodeSession`]'s trait methods
/// and the background reader task ([`run_reader`]) — guarded by a
/// `parking_lot::Mutex`, never held across an `.await` (the trait's
/// concurrency contract). `stdin`/`child` are `Option` so
/// [`teardown`] can atomically take ownership of both exactly once.
struct Inner {
    /// `Some` while a turn is in flight — the send_turn/handle_result/
    /// teardown ownership handshake (mirrors
    /// `crate::agent::adapter::tests::MockAgentSession`'s pattern):
    /// whichever of "a real `result` line arrives" or "teardown runs"
    /// gets here first atomically claims the turn id and owns emitting
    /// its ONE settled event.
    in_flight_turn: Option<TurnId>,
    /// The most recent turn id to reach a terminal settlement —
    /// natural (`handle_result`) or synthesized ([`teardown`]).
    /// [`ClaudeCodeSession::await_turn_completion`] polls this to know
    /// when to stop waiting. Set in the SAME critical section that
    /// takes `in_flight_turn`, so there is no window where a turn is
    /// neither in flight nor recorded as settled.
    last_settled_turn: Option<TurnId>,
    /// Index of the content block currently open between a
    /// `content_block_start` and its matching `content_block_stop` —
    /// there is exactly one open block at a time in every observed
    /// spike trace (blocks are never interleaved), so this single slot
    /// is enough to stamp `block_index` on the `assistant` line that
    /// carries the block's complete content.
    open_block_index: Option<u32>,
    /// Block kind (`"text"`/`"thinking"`/`"tool_use"`) by index, so a
    /// `content_block_delta` can stamp the right `kind` on its
    /// `agent_turn_delta` without re-deriving it from the delta's own
    /// (differently-named) `type` field.
    block_kind_by_index: HashMap<u32, String>,
    /// The child process handle. Taken (never re-inserted) by
    /// [`teardown`] to kill + wait.
    child: Option<std::process::Child>,
    /// Cached once [`teardown`] has fully run — every subsequent call
    /// returns this without redoing any work or re-emitting any event.
    shutdown_result: Option<ExitSummary>,
}

/// Everything a [`ClaudeCodeSession`] and its background reader task
/// share. Held behind `Arc` so both sides — the trait-method caller and
/// the spawned reader task — operate on the exact same state.
struct Shared {
    worker_id: Uuid,
    sink: EventSink,
    /// Stable for the session's lifetime — captured once from the
    /// first `system/init` line at spawn time (see
    /// [`AgentSession::session_key`]'s contract). Never behind the
    /// `Inner` mutex: it never changes, so reading it needs no lock.
    session_key: SessionKey,
    state: parking_lot::Mutex<Inner>,
    /// The child's stdin writer — deliberately a SEPARATE lock from
    /// `state` (review F4). `write_to_piped` (`send_turn`'s only
    /// caller of this field) is a BLOCKING syscall (`write_all` +
    /// `flush`): if the child's stdin pipe buffer fills (a stuck or
    /// misbehaving child), that call can block for an unbounded time.
    /// The first cut of this module guarded `stdin` with the SAME lock
    /// as `child`/`in_flight_turn` — meaning a stuck write would also
    /// block [`teardown`]'s attempt to take `child` and kill it, and
    /// killing the child is the ONLY thing that unblocks the stuck
    /// write (it turns the blocked syscall into a broken-pipe error) —
    /// a genuine circular hang in a module whose entire design
    /// principle is "never a hang." With `stdin` on its own lock,
    /// [`teardown`] can take and kill `child` without ever touching
    /// this field, and only reaches for `stdin` (to drop/close it)
    /// AFTER the kill — by which point a stuck write has already
    /// unblocked with an error and released this lock on its own.
    stdin: parking_lot::Mutex<Option<Box<dyn Write + Send>>>,
    /// Serializes the ENTIRE [`teardown`] critical section (including
    /// its `.await` points) across every caller — [`AgentSession::shutdown`],
    /// [`AgentSession::cancel`], and the reader task's own natural-EOF
    /// path can all race to tear this session down. This is a
    /// DELIBERATE, narrowly-scoped exception to the trait's "no lock
    /// across an await" rule: it is a dedicated lock nothing else in
    /// this module ever touches (unlike `state`, which every quick,
    /// non-blocking check goes through), so holding it across
    /// `child.wait()`/`emit_awaiting_seq` cannot deadlock `send_turn`
    /// (which never acquires it) — it only serializes teardown against
    /// itself, which is exactly what "idempotent, same value, no
    /// double-emit" requires when torn down from two directions at once.
    teardown_gate: tokio::sync::Mutex<()>,
}

/// Tears a session down exactly once: kills + waits `child` off-thread
/// FIRST, only then takes and drops `stdin` (see [`Shared::stdin`]'s
/// doc for why that order is load-bearing, not arbitrary — killing the
/// child is what unblocks a write stuck on a full pipe, so teardown
/// must never wait on the stdin lock before it has already sent the
/// kill), synthesizes Condition B's settlement for any turn still
/// owned at that moment, emits `agent_session_exited`, and caches the
/// resulting [`ExitSummary`] for every later caller. Safe to call
/// concurrently from [`AgentSession::shutdown`], [`AgentSession::cancel`],
/// and [`run_reader`]'s own natural-EOF path — see
/// [`Shared::teardown_gate`]'s doc.
async fn teardown(shared: &Arc<Shared>) -> ExitSummary {
    let _gate = shared.teardown_gate.lock().await;

    // Fast path: a concurrent caller already finished tearing this
    // session down while we waited for the gate.
    if let Some(existing) = shared.state.lock().shutdown_result.clone() {
        return existing;
    }

    let (in_flight, child_opt) = {
        let mut inner = shared.state.lock();
        let taken = inner.in_flight_turn.take();
        if let Some(ref t) = taken {
            inner.last_settled_turn = Some(t.clone());
        }
        (taken, inner.child.take())
    };

    let (exit_code, signal) = if let Some(mut child) = child_opt {
        let waited = tokio::task::spawn_blocking(move || {
            // Killing an already-exited process is not an error — the
            // end state ("not running") is identical either way, same
            // policy as `PipedHandle::kill_and_wait`.
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

    // Only now reach for `stdin` — the kill above has already turned
    // any stuck `write_to_piped` call into a broken-pipe error, so this
    // lock is never held by a caller that's waiting on the very
    // process we just killed to unblock it.
    drop(shared.stdin.lock().take());

    if let Some(turn_id) = in_flight {
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

    // Awaiting the ack is the ordering guarantee that the settled event
    // above (if any) is durably persisted before this function returns
    // — same rationale as the mock adapter's shutdown (see
    // `crate::agent::adapter::tests::MockAgentSession::shutdown`).
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

// ── NDJSON line mapping ──────────────────────────────────────────────

fn handle_stream_event(shared: &Arc<Shared>, envelope: &serde_json::Value) {
    let Some(event) = envelope.get("event") else {
        return;
    };
    match event.get("type").and_then(|v| v.as_str()).unwrap_or("") {
        "content_block_start" => {
            let idx = event.get("index").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
            let kind = event
                .get("content_block")
                .and_then(|b| b.get("type"))
                .and_then(|v| v.as_str())
                .unwrap_or("text")
                .to_string();
            let mut inner = shared.state.lock();
            inner.block_kind_by_index.insert(idx, kind);
            inner.open_block_index = Some(idx);
        }
        "content_block_delta" => {
            let idx = event.get("index").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
            let delta = event.get("delta");
            let delta_type = delta
                .and_then(|d| d.get("type"))
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let text = match delta_type {
                "text_delta" => delta.and_then(|d| d.get("text")).and_then(|v| v.as_str()),
                "thinking_delta" => delta
                    .and_then(|d| d.get("thinking"))
                    .and_then(|v| v.as_str()),
                "input_json_delta" => delta
                    .and_then(|d| d.get("partial_json"))
                    .and_then(|v| v.as_str()),
                _ => None,
            }
            .unwrap_or("")
            .to_string();
            let (turn_id, kind) = {
                let inner = shared.state.lock();
                (
                    inner.in_flight_turn.clone(),
                    inner
                        .block_kind_by_index
                        .get(&idx)
                        .cloned()
                        .unwrap_or_else(|| "text".to_string()),
                )
            };
            if let Some(turn_id) = turn_id {
                shared
                    .sink
                    .emit(SwarmEvent::AgentTurnDelta(AgentTurnDeltaPayload {
                        worker_id: shared.worker_id,
                        turn_id,
                        block_index: idx,
                        kind,
                        text,
                    }));
            }
        }
        "content_block_stop" => {
            shared.state.lock().open_block_index = None;
        }
        _ => {}
    }
}

fn handle_assistant_block(shared: &Arc<Shared>, envelope: &serde_json::Value) {
    let Some(content) = envelope
        .get("message")
        .and_then(|m| m.get("content"))
        .and_then(|c| c.as_array())
    else {
        return;
    };
    let (turn_id, block_index) = {
        let inner = shared.state.lock();
        (
            inner.in_flight_turn.clone(),
            inner.open_block_index.unwrap_or(0),
        )
    };
    let Some(turn_id) = turn_id else {
        return;
    };
    for item in content {
        let kind = item
            .get("type")
            .and_then(|v| v.as_str())
            .unwrap_or("unknown")
            .to_string();
        shared.sink.emit(SwarmEvent::AgentBlock(AgentBlockPayload {
            worker_id: shared.worker_id,
            turn_id: turn_id.clone(),
            block_index,
            kind: kind.clone(),
            content: item.clone(),
        }));
        if kind == "tool_use" {
            let tool_use_id = item
                .get("id")
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .to_string();
            let name = item
                .get("name")
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .to_string();
            let input = item
                .get("input")
                .cloned()
                .unwrap_or(serde_json::Value::Null);
            shared
                .sink
                .emit(SwarmEvent::AgentToolCall(AgentToolCallPayload {
                    worker_id: shared.worker_id,
                    turn_id: turn_id.clone(),
                    tool_use_id,
                    name,
                    input,
                }));
        }
    }
}

fn handle_user_tool_result(shared: &Arc<Shared>, envelope: &serde_json::Value) {
    let Some(content) = envelope
        .get("message")
        .and_then(|m| m.get("content"))
        .and_then(|c| c.as_array())
    else {
        return;
    };
    let turn_id = shared.state.lock().in_flight_turn.clone();
    let Some(turn_id) = turn_id else {
        return;
    };
    for item in content {
        if item.get("type").and_then(|v| v.as_str()) != Some("tool_result") {
            continue;
        }
        let tool_use_id = item
            .get("tool_use_id")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string();
        let is_error = item
            .get("is_error")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        let content_value = item
            .get("content")
            .cloned()
            .unwrap_or(serde_json::Value::Null);
        shared
            .sink
            .emit(SwarmEvent::AgentToolResult(AgentToolResultPayload {
                worker_id: shared.worker_id,
                turn_id: turn_id.clone(),
                tool_use_id,
                is_error,
                content: content_value,
            }));
    }
}

fn handle_permission_denied(shared: &Arc<Shared>, envelope: &serde_json::Value) {
    let turn_id = shared
        .state
        .lock()
        .in_flight_turn
        .clone()
        .unwrap_or_default();
    let tool = envelope
        .get("tool_name")
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string();
    let tool_use_id = envelope
        .get("tool_use_id")
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string();
    let message = envelope
        .get("message")
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string();
    let decision_reason_type = envelope
        .get("decision_reason_type")
        .and_then(|v| v.as_str());
    let denial_subclass = classify_denial(decision_reason_type, &message);

    shared.sink.emit(SwarmEvent::AgentPermissionRequest(
        AgentPermissionRequestPayload {
            worker_id: shared.worker_id,
            turn_id,
            request_id: tool_use_id,
            tool,
            input: serde_json::Value::Null,
            suggested_decision: Some(PermissionDecision::Deny),
            denial_subclass,
            message: Some(message),
        },
    ));
}

fn handle_result(shared: &Arc<Shared>, envelope: &serde_json::Value) {
    // Ownership handshake: only whichever of "this real result line" or
    // a concurrent `teardown` gets here first claims the turn id — see
    // `Inner::in_flight_turn`'s doc. `last_settled_turn` is stamped in
    // the SAME lock scope so `await_turn_completion` never observes a
    // window where the turn is neither in flight nor recorded settled.
    let turn_id = {
        let mut inner = shared.state.lock();
        let taken = inner.in_flight_turn.take();
        if let Some(ref t) = taken {
            inner.last_settled_turn = Some(t.clone());
        }
        taken
    };
    let Some(turn_id) = turn_id else {
        return;
    };

    let subtype = envelope
        .get("subtype")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let status = if subtype == "success" {
        AgentTurnStatus::Ok
    } else {
        AgentTurnStatus::Error
    };
    let error = if status == AgentTurnStatus::Error {
        let joined = envelope
            .get("errors")
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|v| v.as_str())
                    .collect::<Vec<_>>()
                    .join("; ")
            })
            .filter(|s| !s.is_empty());
        Some(joined.unwrap_or_else(|| format!("claude code: {subtype}")))
    } else {
        None
    };
    let cost_usd = envelope.get("total_cost_usd").and_then(|v| v.as_f64());
    let usage = envelope.get("usage").cloned();
    let duration_ms = envelope
        .get("duration_ms")
        .and_then(|v| v.as_u64())
        .unwrap_or(0);
    let num_turns = envelope
        .get("num_turns")
        .and_then(|v| v.as_u64())
        .map(|n| n as u32);

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
            num_turns,
        }));
}

fn handle_line(shared: &Arc<Shared>, line: &str) {
    let value: serde_json::Value = match serde_json::from_str(line) {
        Ok(v) => v,
        Err(e) => {
            tracing::warn!(
                worker_id = %shared.worker_id,
                error = %e,
                "claude code adapter: unparseable ndjson line, skipping"
            );
            return;
        }
    };
    match value.get("type").and_then(|v| v.as_str()).unwrap_or("") {
        "system" => {
            // `init` (including a mid-session re-init at the start of a
            // subsequent turn — see the module doc's multi-turn
            // finding) and every other system subtype (hook_started/
            // hook_response/status/rate_limit_event/...) are
            // informational-only and intentionally ignored here:
            // `agent_session_started` is emitted exactly once, at
            // `spawn()` time, from the FIRST init line.
            if value.get("subtype").and_then(|v| v.as_str()) == Some("permission_denied") {
                handle_permission_denied(shared, &value);
            }
        }
        "stream_event" => handle_stream_event(shared, &value),
        "assistant" => handle_assistant_block(shared, &value),
        "user" => handle_user_tool_result(shared, &value),
        "result" => handle_result(shared, &value),
        _ => {}
    }
}

/// Background task, spawned once per session at `spawn()` time and
/// running for the child process's entire lifetime — drains framed
/// NDJSON lines (mapping each via [`handle_line`]) and NDJSON framer
/// errors until the child exits, then runs [`teardown`] exactly once
/// (idempotent no-op if `shutdown`/`cancel` already claimed it).
/// Drains framed NDJSON lines (mapping each via [`handle_line`]) until
/// the child's stdout closes OR [`watch_framer_errors`] signals via
/// `drain_signal` that a framer error occurred — in the latter case
/// this loop first drains every line ALREADY buffered in the channel
/// (via `try_recv`, non-blocking) before proceeding to [`teardown`]
/// (review F8): a framer error can fire while genuinely valid,
/// already-parsed lines are still sitting unconsumed in `lines`, and
/// letting `watch_framer_errors` call `teardown` directly (the
/// original design) raced this loop — `agent_session_exited` could
/// persist BEFORE the backlog's `agent_block`/`agent_tool_call`/etc.
/// events, an event log claiming the session ended before activity
/// that actually happened while it was still alive. `teardown` itself
/// is only ever called from HERE now, never from
/// `watch_framer_errors` directly — see that function's doc.
///
/// Framer errors are watched by a SEPARATE task rather than raced
/// against this loop in one `tokio::select!` with `framer_errors`
/// itself: both `mpsc::Receiver::recv` futures are re-created fresh on
/// every loop iteration, and a `select!` between two independently-
/// owned, differently-lifecycled receivers has a real failure mode —
/// once `framer_errors`' sender drops, its `recv()` future resolves to
/// `Ready(None)` on EVERY subsequent poll (unlike a genuinely pending
/// `lines.recv()`), which can win the `select!`'s fairness race before
/// `lines` ever gets polled again, incorrectly treating "no more framer
/// errors will ever arrive" as "tear down now" while real lines are
/// still queued. The signal here is a plain `tokio::sync::Notify`
/// (`notify_one`, which — unlike `notify_waiters` — DOES store a permit
/// for a not-yet-waiting receiver, so no lost-wakeup risk even if the
/// error fires before this loop's first poll) raced against `lines` in
/// a `select!` — structurally different from racing two `recv()`
/// futures, since `Notify::notified()` only ever resolves on a genuine
/// one-shot event, never "stays Ready forever" the way a
/// closed-channel `recv()` does.
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
                Err(_) => break, // empty (fully drained) or disconnected
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

/// Watches for an NDJSON framer error ([`crate::worker::proc::NdjsonFramer`]'s
/// [`AppError::LineTooLong`]) and signals [`run_reader`] to finish
/// draining and tear the session down — the "provider sent us garbage"
/// half of session teardown, per
/// `crate::worker::proc::PipedHandle::framer_errors`'s "treat as a
/// session-level failure" contract. Deliberately does NOT call
/// [`teardown`] itself (review F8) — see [`run_reader`]'s doc for why
/// ownership of that call moved there.
async fn watch_framer_errors(
    shared: Arc<Shared>,
    mut framer_errors: mpsc::UnboundedReceiver<AppError>,
    drain_signal: Arc<tokio::sync::Notify>,
) {
    if let Some(e) = framer_errors.recv().await {
        tracing::error!(
            worker_id = %shared.worker_id,
            error = %e,
            "claude code adapter: ndjson framer error — signaling run_reader to drain and tear down"
        );
        drain_signal.notify_one();
    }
}

async fn wait_for_init(lines: &mut mpsc::Receiver<String>) -> Option<serde_json::Value> {
    while let Some(line) = lines.recv().await {
        if let Ok(value) = serde_json::from_str::<serde_json::Value>(&line)
            && value.get("type").and_then(|v| v.as_str()) == Some("system")
            && value.get("subtype").and_then(|v| v.as_str()) == Some("init")
        {
            return Some(value);
        }
    }
    None
}

fn stderr_snippet(tail: &Arc<parking_lot::Mutex<VecDeque<u8>>>) -> String {
    let buf = tail.lock();
    let text = String::from_utf8_lossy(&buf.iter().copied().collect::<Vec<u8>>()).into_owned();
    if text.trim().is_empty() {
        "no stderr output".to_string()
    } else {
        format!("stderr: {text}")
    }
}

// ── AgentAdapter / AgentSession ──────────────────────────────────────

/// The `claude` CLI adapter. One instance drives every Claude Code
/// worker; each [`ClaudeCodeSession`] it spawns owns one child process.
pub struct ClaudeCodeAdapter {
    sink: EventSink,
    binary: String,
    /// Test-only argv prefix (empty in production) — see
    /// [`ClaudeCodeAdapter::with_test_binary`].
    extra_prefix_args: Vec<String>,
}

impl ClaudeCodeAdapter {
    /// Production constructor — drives the real `claude` binary
    /// (resolved via `PATH`).
    pub fn new(sink: EventSink) -> Self {
        Self {
            sink,
            binary: "claude".to_string(),
            extra_prefix_args: Vec::new(),
        }
    }

    /// Test-only constructor: drives a fake child process instead of
    /// the real `claude` binary. `binary`/`prefix_args` together form
    /// the argv PREFIX (e.g. `("node", vec![fake_cli_js_path,
    /// fixture_path])`) prepended before the real `-p --output-format
    /// ...` flags this adapter always builds — see [`build_claude_flags`].
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

impl AgentAdapter for ClaudeCodeAdapter {
    fn provider(&self) -> ProviderId {
        ProviderId::ClaudeCode
    }

    fn capabilities(&self) -> Capabilities {
        claude_code_capabilities()
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
                    // Never a network-touching auth check here (bounded,
                    // cheap probe per the plan) — the honest signal for
                    // "signed in or not" is the FIRST spawn's own
                    // `system/init.apiKeySource` / an early
                    // `agent_session_exited` failure, not this probe.
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
                    detail: Some(format!("Claude Code CLI Not Found On PATH: {e}")),
                },
                Err(_elapsed) => ProbeReport {
                    available: false,
                    version: None,
                    detail: Some("Claude Code CLI Probe Timed Out".to_string()),
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
            let tier = parse_trust_tier(spec.permission_mode.as_deref())?;

            let model = spec
                .model
                .clone()
                .unwrap_or_else(|| DEFAULT_MODEL_ALIAS.to_string());
            let mut argv = prefix;
            argv.extend(build_claude_flags(
                spec.worker_id,
                &model,
                tier,
                spec.resume.as_deref(),
            ));

            let env: HashMap<String, String> = HashMap::new();
            let handle = spawn_piped(&binary, &argv, &spec.cwd, &env)
                .map_err(|e| AppError::Ai(format!("failed to spawn claude code: {e}")))?;

            let PipedHandle {
                stdin,
                child,
                pid: _,
                mut lines,
                framer_errors,
                stderr_tail,
            } = handle;

            let init_value =
                match tokio::time::timeout(INIT_TIMEOUT, wait_for_init(&mut lines)).await {
                    Ok(Some(v)) => v,
                    Ok(None) => {
                        return Err(AppError::Ai(format!(
                            "claude code exited before emitting system/init ({})",
                            stderr_snippet(&stderr_tail)
                        )));
                    }
                    Err(_elapsed) => {
                        return Err(AppError::Ai(format!(
                            "claude code did not emit system/init within {INIT_TIMEOUT:?} ({})",
                            stderr_snippet(&stderr_tail)
                        )));
                    }
                };

            let session_key: SessionKey = init_value
                .get("session_id")
                .and_then(|v| v.as_str())
                .map(str::to_string)
                .unwrap_or_else(|| spec.worker_id.to_string());
            let reported_model = init_value
                .get("model")
                .and_then(|v| v.as_str())
                .map(str::to_string)
                .unwrap_or_else(|| model.clone());

            let shared = Arc::new(Shared {
                worker_id: spec.worker_id,
                sink: sink.clone(),
                session_key: session_key.clone(),
                state: parking_lot::Mutex::new(Inner {
                    in_flight_turn: None,
                    last_settled_turn: None,
                    open_block_index: None,
                    block_kind_by_index: HashMap::new(),
                    child: Some(child),
                    shutdown_result: None,
                }),
                stdin: parking_lot::Mutex::new(Some(stdin)),
                teardown_gate: tokio::sync::Mutex::new(()),
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
                    provider: ProviderId::ClaudeCode,
                    session_key,
                    model: reported_model,
                    cwd: spec.cwd.clone(),
                    capabilities: claude_code_capabilities(),
                },
            ));

            Ok(Box::new(ClaudeCodeSession { shared }) as Box<dyn AgentSession>)
        })
    }
}

/// Per-worker, stateful handle to one live `claude` CLI child process.
pub struct ClaudeCodeSession {
    shared: Arc<Shared>,
}

impl AgentSession for ClaudeCodeSession {
    fn session_key(&self) -> &SessionKey {
        &self.shared.session_key
    }

    fn send_turn(&self, turn: TurnInput) -> BoxFuture<'_, Result<TurnId, AppError>> {
        let shared = self.shared.clone();
        Box::pin(async move {
            let turn_id: TurnId = Uuid::new_v4().to_string();
            {
                // Lock scope ends before any `.await` below, and —
                // review F4 — before the blocking stdin write further
                // down: this is `state`'s lock, `stdin` now lives
                // behind its OWN separate lock (see `Shared::stdin`'s
                // doc for why sharing one lock between them was a
                // latent circular hang: a write stuck on a full pipe
                // would have blocked `teardown`'s attempt to take
                // `child` and kill it, and killing the child is the
                // only thing that unblocks a stuck write).
                let mut inner = shared.state.lock();
                if inner.shutdown_result.is_some() {
                    return Err(AppError::Ipc(
                        "claude code session already shut down".to_string(),
                    ));
                }
                if inner.in_flight_turn.is_some() {
                    return Err(AppError::AgentSessionBusy);
                }
                inner.in_flight_turn = Some(turn_id.clone());
                inner.open_block_index = None;
                inner.block_kind_by_index.clear();
            }

            let line = build_turn_line(&turn.prompt);
            let write_result = {
                let mut stdin_guard = shared.stdin.lock();
                match stdin_guard.as_mut() {
                    Some(stdin) => write_to_piped(stdin.as_mut(), line.as_bytes()),
                    None => Err(anyhow::anyhow!("stdin already closed")),
                }
            };
            if let Err(e) = write_result {
                // The write never reached the child — roll back so a
                // retry isn't permanently blocked by a phantom in-flight
                // turn.
                shared.state.lock().in_flight_turn = None;
                return Err(AppError::Ipc(format!(
                    "failed to write turn to claude code stdin: {e}"
                )));
            }
            Ok(turn_id)
        })
    }

    fn await_turn_completion(&self, turn: TurnId) -> BoxFuture<'_, Result<(), AppError>> {
        let shared = self.shared.clone();
        Box::pin(async move {
            loop {
                {
                    let inner = shared.state.lock();
                    // Never hang past this session's own death — see
                    // the trait doc's binding contract.
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
            // Only tear down if `turn` is genuinely the in-flight one —
            // a stale cancel for an already-settled turn must not kill
            // a live, idle-between-turns session (the multi-turn-
            // same-process reality: the process stays alive after a
            // turn settles). `KillOnly` capability means there is no
            // finer-grained lever than the whole process.
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

    fn respond_permission(
        &self,
        _req: PermissionId,
        _decision: PermissionDecision,
    ) -> BoxFuture<'_, Result<(), AppError>> {
        // Condition C / §0b: the interactive round-trip is NOT
        // buildable on `claude -p` (`--permission-mode manual` is a
        // silent no-op). Every `agent_permission_request` this adapter
        // emits is a REPORT of an already-decided provider denial,
        // never a pending question — there is nothing on the other end
        // to answer. Documented no-op, not an error: a caller built
        // against the generic trait (expecting some providers to
        // support the real round-trip) should not have its call fail.
        Box::pin(async { Ok(()) })
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
        format!(
            "{}/tests/fixtures/claude_code/{name}",
            env!("CARGO_MANIFEST_DIR")
        )
    }

    /// Spawns a `ClaudeCodeAdapter` wired to `node fake_claude_cli.cjs
    /// <fixture>` instead of the real CLI, against a fresh file-backed
    /// live engine — mirrors `agent::adapter::tests`' own live-engine
    /// harness depth.
    async fn spawn_test_session(
        fixture_name: &str,
    ) -> (
        crate::events::EventSink,
        std::path::PathBuf,
        Box<dyn AgentSession>,
    ) {
        let db_path = std::env::temp_dir().join(format!(
            "swarm-claude-code-{}-{}.db",
            fixture_name.replace(['.', '/'], "_"),
            Uuid::new_v4()
        ));
        let log = EventLog::open(&db_path).expect("open file-backed log");
        let engine = OrchestrationEngine::start(log, Some(db_path.clone()), |_| {});
        let sink = engine.sink();

        let cwd = std::env::temp_dir().join(format!("swarm-claude-code-cwd-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&cwd).expect("create test cwd");

        let adapter = ClaudeCodeAdapter::with_test_binary(
            sink.clone(),
            "node",
            vec![
                fixture_path("fake_claude_cli.cjs"),
                fixture_path(fixture_name),
            ],
        );
        let session = adapter
            .spawn(AgentSpawnSpec {
                worker_id: Uuid::new_v4(),
                cwd: cwd.display().to_string(),
                model: Some("sonnet".to_string()),
                resume: None,
                permission_mode: None,
            })
            .await
            .expect("spawn should succeed against the fake claude cli");

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
        let payload = settled.payload.clone();
        assert_eq!(payload["status"], "ok");
        assert!(payload["costUsd"].as_f64().unwrap() > 0.0);

        cleanup(&db_path);
    }

    /// DIRECTIVE (review F2): the multi-turn-same-process reality
    /// (module doc) was previously only PROVEN against the real CLI in
    /// the standalone spike harness — never against `ClaudeCodeSession`
    /// itself. This drives TWO real turns through one session using a
    /// fixture built verbatim from that same real two-turn spike
    /// capture (`scratchpad/spike/logs/multi-turn-same-process.raw.ndjson`
    /// — an ACTUAL two-turn run against the real CLI, not a synthetic
    /// splice), converting the empirical finding into tested adapter
    /// behavior: one `agent_session_started` (never two — the second
    /// turn's own `system/init` line is informational-only, per
    /// `handle_line`'s doc), two `agent_turn_settled` rows, one
    /// `session_key` throughout.
    ///
    /// **Real-CLI caveat, still true of this fake-CLI test:** the fixture
    /// proves `ClaudeCodeSession`'s OWN handling of a second turn on an
    /// already-open process is correct; it does not re-prove that the
    /// real `claude` binary always behaves this way (that's the spike's
    /// job, already done). **`--max-turns` nuance the docs previously
    /// glossed over:** the acceptEdits canary
    /// (`scratchpad/spike-permissions/logs/13-acceptedits-canary.*`)
    /// exited 1 / `error_max_turns` because ITS `--max-turns 2` budget
    /// was consumed by a Read + Write + summary sequence within ONE
    /// SWARM-visible turn — `--max-turns` bounds the provider's
    /// internal tool-use loop per turn (this adapter always passes 50,
    /// `MAX_TURNS_PER_TURN`), it is unrelated to how many SEPARATE
    /// `send_turn` calls one process accepts, which is what this test
    /// exercises and is unbounded.
    #[tokio::test]
    async fn test_two_real_turns_on_one_session_both_settle_with_one_session_started() {
        let (_sink, db_path, session) = spawn_test_session("two_turn.ndjson").await;
        let session_key_before = session.session_key().to_string();

        session
            .send_turn(TurnInput {
                prompt: "Reply with exactly the single word: ONE".to_string(),
            })
            .await
            .expect("first send_turn should succeed");
        wait_for_event_type(
            &db_path,
            "agent_turn_settled",
            std::time::Duration::from_secs(10),
        )
        .await;

        session
            .send_turn(TurnInput {
                prompt: "Reply with exactly the single word: TWO".to_string(),
            })
            .await
            .expect("second send_turn should succeed on the SAME still-open session");

        // Poll until a SECOND settled row shows up (the first already did).
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        loop {
            let log = EventLog::open(&db_path).expect("reopen log");
            let events = log.events_since(0, 500).expect("read events");
            let settled_count = events
                .iter()
                .filter(|e| e.event_type == "agent_turn_settled")
                .count();
            if settled_count >= 2 {
                break;
            }
            if std::time::Instant::now() > deadline {
                let types: Vec<&str> = events.iter().map(|e| e.event_type.as_str()).collect();
                panic!("timed out waiting for a second agent_turn_settled, got: {types:?}");
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }

        assert_eq!(
            session.session_key().as_str(),
            session_key_before.as_str(),
            "session_key must stay stable across both turns"
        );

        session.shutdown().await.ok();

        let log = EventLog::open(&db_path).expect("reopen log");
        let events = log.events_since(0, 500).expect("read events");

        let started_count = events
            .iter()
            .filter(|e| e.event_type == "agent_session_started")
            .count();
        assert_eq!(
            started_count, 1,
            "exactly one agent_session_started for the whole session, not one per turn"
        );

        let settled: Vec<serde_json::Value> = events
            .iter()
            .filter(|e| e.event_type == "agent_turn_settled")
            .map(|e| e.payload.clone())
            .collect();
        assert_eq!(settled.len(), 2, "both turns must settle");
        for s in &settled {
            assert_eq!(s["status"], "ok");
        }
        assert_ne!(
            settled[0]["turnId"], settled[1]["turnId"],
            "the two turns must have distinct turn ids"
        );

        cleanup(&db_path);
    }

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

    // ── Condition B: kill-mid-turn ───────────────────────────────

    #[tokio::test]
    async fn test_kill_mid_turn_synthesizes_exactly_one_settled_and_session_exited() {
        let (_sink, db_path, session) = spawn_test_session("hang_after_init.ndjson").await;

        let turn_id = session
            .send_turn(TurnInput {
                prompt: "start something long".to_string(),
            })
            .await
            .expect("send_turn should succeed");

        // Give the fake CLI a moment to emit its pre-hang deltas so the
        // turn is genuinely "in flight" with visible progress before we
        // tear it down.
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

    // ── Framer-error surfacing ────────────────────────────────────

    #[tokio::test]
    async fn test_framer_error_surfaces_as_synthesized_settlement() {
        let (_sink, db_path, session) = spawn_test_session("oversized_line.ndjson").await;

        let turn_id = session
            .send_turn(TurnInput {
                prompt: "trigger the oversized line".to_string(),
            })
            .await
            .expect("send_turn should succeed");

        // No explicit shutdown call here — the reader task must
        // self-terminate the session once the NDJSON framer reports
        // AppError::LineTooLong, per proc.rs's "treat as a
        // session-level failure" contract.
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

    // ── Permission denial subclass mapping ───────────────────────

    async fn assert_denial_subclass(fixture: &str, expected_subclass: &str) {
        let (_sink, db_path, session) = spawn_test_session(fixture).await;
        session
            .send_turn(TurnInput {
                prompt: "attempt the gated action".to_string(),
            })
            .await
            .expect("send_turn should succeed");

        wait_for_event_type(
            &db_path,
            "agent_permission_request",
            std::time::Duration::from_secs(10),
        )
        .await;
        session.shutdown().await.ok();

        let log = EventLog::open(&db_path).expect("reopen log");
        let events = log.events_since(0, 500).expect("read events");
        let denial = events
            .iter()
            .find(|e| e.event_type == "agent_permission_request")
            .expect("agent_permission_request row");
        let payload = denial.payload.clone();

        assert_eq!(payload["suggestedDecision"], "deny");
        assert_eq!(payload["denialSubclass"], expected_subclass);
        assert!(payload["message"].as_str().is_some_and(|s| !s.is_empty()));

        cleanup(&db_path);
    }

    #[tokio::test]
    async fn test_permission_denied_mode_subclass() {
        assert_denial_subclass("permission_denied_mode.ndjson", "mode").await;
    }

    #[tokio::test]
    async fn test_permission_denied_ungranted_write_subclass() {
        assert_denial_subclass(
            "permission_denied_ungranted_write.ndjson",
            "ungranted_write",
        )
        .await;
    }

    #[tokio::test]
    async fn test_permission_denied_redirection_guard_subclass() {
        assert_denial_subclass(
            "permission_denied_redirection_guard.ndjson",
            "redirection_guard",
        )
        .await;
    }

    // ── Busy rejection / idempotent shutdown ─────────────────────

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

    // ── Condition A: inline --settings JSON, never a worktree file ─

    #[test]
    fn test_condition_a_settings_flag_is_inline_json_with_tier_specific_deny_list() {
        for tier in [
            ClaudeCodeTrustTier::Restricted,
            ClaudeCodeTrustTier::Standard,
            ClaudeCodeTrustTier::WriteEnabled,
        ] {
            let raw = inline_settings_json(tier);
            let value: serde_json::Value = serde_json::from_str(&raw).unwrap();
            let deny = value["permissions"]["deny"].as_array().unwrap();
            let expected = deny_list(tier);
            assert_eq!(deny.len(), expected.len());
            for e in expected {
                assert!(
                    deny.iter().any(|v| v.as_str() == Some(e)),
                    "expected deny entry {e:?} for {tier:?}, got: {deny:?}"
                );
            }
        }
    }

    /// DIRECTIVE (review B1): the settings mechanism is inline JSON,
    /// never a file path — and never, under any circumstance, a path
    /// that lives inside a worktree. Proves this positively (the
    /// `--settings` value always starts with `{`) rather than merely
    /// asserting the deleted `write_project_settings` function is gone.
    #[test]
    fn test_settings_flag_is_always_inline_json_never_a_worktree_path() {
        let worker_id = Uuid::new_v4();
        for tier in [
            ClaudeCodeTrustTier::Restricted,
            ClaudeCodeTrustTier::Standard,
            ClaudeCodeTrustTier::WriteEnabled,
        ] {
            for resume in [None, Some("some-session-key")] {
                let argv = build_claude_flags(worker_id, "sonnet", tier, resume);
                let idx = argv
                    .iter()
                    .position(|a| a == "--settings")
                    .expect("--settings must always be present");
                let value = &argv[idx + 1];
                assert!(
                    value.trim_start().starts_with('{'),
                    "expected inline JSON for {tier:?}, got: {value:?}"
                );
                assert!(
                    !value.contains(".claude") && !value.contains('/') && !value.contains('\\'),
                    "settings value must never look like a filesystem path, got: {value:?}"
                );
            }
        }
    }

    // ── bypassPermissions unconstructible (argv proof) ───────────

    #[test]
    fn test_bypass_permissions_is_unconstructible_across_every_trust_tier() {
        let worker_id = Uuid::new_v4();
        for tier in [
            ClaudeCodeTrustTier::Restricted,
            ClaudeCodeTrustTier::Standard,
            ClaudeCodeTrustTier::WriteEnabled,
        ] {
            for resume in [None, Some("some-session-key")] {
                let argv = build_claude_flags(worker_id, "sonnet", tier, resume);
                assert!(
                    !argv.iter().any(|a| a == "bypassPermissions"),
                    "bypassPermissions must never appear in argv for {tier:?}, got: {argv:?}"
                );
                assert!(
                    !argv.iter().any(|a| a == "manual"),
                    "manual must never appear in argv for {tier:?} (silent no-op, never offered), got: {argv:?}"
                );
            }
        }

        // Even a caller that tries to smuggle the raw string through
        // the generic trait's permission_mode field is rejected before
        // any argv is ever built.
        for bad in [
            "bypassPermissions",
            "manual",
            "acceptEdits",
            "dontAsk",
            "plan",
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
    fn test_build_turn_line_matches_the_spike_verified_input_format_shape() {
        let line = build_turn_line("hello world");
        assert!(line.ends_with('\n'));
        let value: serde_json::Value = serde_json::from_str(line.trim()).unwrap();
        assert_eq!(value["type"], "user");
        assert_eq!(value["message"]["role"], "user");
        assert_eq!(value["message"]["content"], "hello world");
    }

    // ── Probe ─────────────────────────────────────────────────────

    #[tokio::test]
    async fn test_probe_reports_available_for_a_present_binary() {
        let log = EventLog::open_in_memory().expect("open in-memory log");
        let engine = OrchestrationEngine::start(log, None, |_| {});
        let adapter = ClaudeCodeAdapter::with_test_binary(engine.sink(), "node", vec![]);
        let report = adapter.probe().await.expect("probe should not error");
        assert!(report.available);
        assert!(report.version.is_some());
    }

    #[tokio::test]
    async fn test_probe_reports_unavailable_for_a_missing_binary() {
        let log = EventLog::open_in_memory().expect("open in-memory log");
        let engine = OrchestrationEngine::start(log, None, |_| {});
        let adapter = ClaudeCodeAdapter::with_test_binary(
            engine.sink(),
            "definitely-not-a-real-claude-binary-xyz",
            vec![],
        );
        let report = adapter.probe().await.expect("probe should not error");
        assert!(!report.available);
        assert!(report.detail.is_some());
    }

    // ── Provider identity ─────────────────────────────────────────

    #[test]
    fn test_provider_and_capabilities_are_honest() {
        let log = EventLog::open_in_memory().expect("open in-memory log");
        let engine = OrchestrationEngine::start(log, None, |_| {});
        let adapter = ClaudeCodeAdapter::new(engine.sink());
        assert_eq!(adapter.provider(), ProviderId::ClaudeCode);
        let caps = adapter.capabilities();
        assert!(caps.partial_deltas);
        assert!(caps.resume);
        assert!(caps.native_cost);
        assert_eq!(caps.cancel_granularity, CancelGranularity::KillOnly);
        assert!(!caps.interrupt_midturn);
        assert!(caps.worktree_aware);
    }
}
