//! `ClaudeCodeAdapter`: the [`AgentAdapter`]/[`AgentSession`] pair that
//! drives the `claude` CLI's `stream-json` protocol over piped stdio
//! ([`crate::worker::proc::spawn_piped`]).
//!
//! Verified against `claude` 2.1.280 and 2.1.281 (live traces) and
//! `@anthropic-ai/claude-agent-sdk` 0.3.280's protocol types; the oldest
//! CLI it drives is `MIN_CLI_VERSION`. The wire types live in
//! `wire`; the unit tests drive a fake CLI
//! (`tests/fixtures/claude_code/fake_claude_cli.mjs`) that plays one
//! scenario module per test with the real CLI's ordering.
//!
//! ## One process per session
//!
//! A single `claude -p --input-format stream-json` process serves every
//! turn of a session: each user message written to its stdin runs as one
//! turn, with its own `system/init` and exactly one terminal `result`
//! line, while `session_id` and the conversation carry over.
//! [`ClaudeCodeSession::send_turn`] therefore writes to the same stdin
//! every time; `--resume` only rehydrates a session whose process is
//! gone.
//!
//! ## Handshake
//!
//! The CLI writes nothing to stdout until it receives input — not even
//! `system/init`, which it emits per turn, after that turn's user
//! message. [`ClaudeCodeAdapter::spawn`] therefore opens every session
//! with the `initialize` control request and waits (bounded by
//! `HANDSHAKE_TIMEOUT`) for its `control_response`, which costs no API
//! call and reports the resolved models, the account, and the active
//! permission mode. A CLI that fails to start (a `--resume` of an
//! unknown session, an unknown flag) answers with a `result` line or
//! exits instead; both fail the spawn and the child is reaped.
//! [`ClaudeCodeAdapter::probe`] runs the same handshake plus
//! `get_binary_version` in a throwaway process.
//!
//! ## Turn ownership
//!
//! The CLI can run turns SWARM never asked for: a background task's
//! completion notice, a scheduled wake-up, a resumed session's unfinished
//! work. Their frames must not be pinned on a SWARM turn. Every prompt is
//! therefore written with the SWARM turn id as its `uuid`, which the CLI
//! echoes back (`command_lifecycle.command_uuid`, and `user_message_uuid`
//! on the turn's first stream event, first assistant message and
//! `result`). A turn is *queued* from `send_turn` until the CLI starts
//! it (`command_lifecycle` `started`, or an echoing frame; on a CLI
//! without `msg_lifecycle_v1`, its `system/init`), and only a started
//! turn receives deltas, blocks, tool calls and permission requests. A
//! `result` settles the in-flight turn when it echoes that turn's id, or
//! when it echoes nothing while the turn is running (a zeroed crash
//! result); anything else belongs to work SWARM did not start and is
//! dropped. Background tasks are switched off for the child
//! (`DISABLE_BACKGROUND_TASKS_ENV`) so subagents run inside the turn
//! that launched them; their frames carry a `parent_tool_use_id` and are
//! kept out of the top-level transcript.
//!
//! ## Permissions: trust tier at spawn, human in the loop mid-turn
//!
//! A [`ClaudeCodeTrustTier`] fixes the permission mode, the settings deny
//! list, and (Restricted only) `--restricted` at spawn. Everything the
//! tier neither allows nor denies is asked of the host:
//! `--permission-prompt-tool stdio` makes the CLI send a `can_use_tool`
//! control request and block until it is answered. The session surfaces
//! each one as a pending `agent_permission_request` (no suggested
//! decision) and answers it from [`AgentSession::respond_permission`];
//! an ask nobody answers is denied after `PERMISSION_DECISION_TIMEOUT`.
//! An ask flagged `requires_user_interaction` (the tool's approval card
//! is where the user answers, e.g. `AskUserQuestion`) is denied at once
//! and reported as a denial: a one-tap Allow would pass it through
//! unanswered.
//! Denials the CLI decides on its own (the deny list, `dontAsk`, the
//! redirection guard) are reported with `suggested_decision: Deny` from
//! `system/permission_denied`, reconciled against the authoritative
//! `result.permission_denials`. Permission gating never rests on
//! `allowedTools`, which widens what runs unasked rather than narrowing
//! it (Condition C, [`PermissionDecision`]).
//!
//! ## Cancel and teardown
//!
//! [`AgentSession::cancel`] sends the `interrupt` control request; the
//! CLI aborts the turn and writes its `result` (`terminal_reason:
//! "aborted_streaming"`), which settles the turn as "Turn Cancelled",
//! and the session stays usable. Only when the CLI does not accept the
//! interrupt within `INTERRUPT_ACK_TIMEOUT`, or writes no receipt within
//! `INTERRUPT_GRACE` after accepting it, is the process killed. Teardown
//! runs exactly once, in its own task: an idle session closes stdin and
//! lets the CLI exit (it saves the session's totals on the way out), a
//! busy one is killed, and a turn still in flight gets a synthesized
//! settlement (Condition B, [`AgentSession::shutdown`]).

mod wire;

#[cfg(test)]
mod tests;

use std::collections::{HashMap, HashSet, VecDeque};
use std::io::Write;
use std::process::{Child, ExitStatus};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::sync::{Notify, mpsc, oneshot, watch};
use uuid::Uuid;

use self::wire::{
    Block, CanUseTool, CommandLifecycleLine, ControlRequest, ControlRequestLine, ControlResponse,
    Inbound, InitLine, InitializeResponse, MessageLine, PermissionDeniedLine, ResultLine, SignIn,
    StreamEvent, StreamEventLine, System,
};
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

// ── Constants ────────────────────────────────────────────────────────

/// Oldest `claude` release this adapter drives: `--permission-prompts`
/// (2.1.259) is the newest flag it passes (`--restricted` arrived in
/// 2.1.248). [`ClaudeCodeAdapter::probe`] reports anything older as
/// unavailable.
const MIN_CLI_VERSION: (u32, u32, u32) = (2, 1, 259);

/// Bound on the `initialize` handshake that opens every session.
#[cfg(not(test))]
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(30);
#[cfg(test)]
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(5);

/// Bound on the whole probe, cold CLI start included (about 1s warm on
/// the 2.1.281 reference machine).
const PROBE_TIMEOUT: Duration = Duration::from_secs(15);

/// How long [`AgentSession::cancel`] waits for the CLI to acknowledge an
/// `interrupt` control request before killing the process.
#[cfg(not(test))]
const INTERRUPT_ACK_TIMEOUT: Duration = Duration::from_secs(5);
#[cfg(test)]
const INTERRUPT_ACK_TIMEOUT: Duration = Duration::from_secs(2);

/// How long an acknowledged interrupt may take to produce the turn's
/// `result` before [`AgentSession::cancel`] falls back to a kill.
#[cfg(not(test))]
const INTERRUPT_GRACE: Duration = Duration::from_secs(10);
#[cfg(test)]
const INTERRUPT_GRACE: Duration = Duration::from_secs(1);

/// How long an idle CLI gets to exit on its own after stdin closes
/// (2.1.281 exits in about 0.6s) before teardown kills it.
const SHUTDOWN_GRACE: Duration = Duration::from_secs(3);

/// Poll interval while waiting out [`SHUTDOWN_GRACE`] with non-blocking
/// `try_wait` calls.
const EXIT_POLL_INTERVAL: Duration = Duration::from_millis(20);

/// How long a `can_use_tool` ask may wait for a human before the session
/// denies it: bounded, so a turn never blocks forever on a dialog nobody
/// is looking at while it holds a scheduler slot.
#[cfg(not(test))]
const PERMISSION_DECISION_TIMEOUT: Duration = Duration::from_mins(10);
#[cfg(test)]
const PERMISSION_DECISION_TIMEOUT: Duration = Duration::from_secs(2);

/// Default `--model` alias when [`AgentSpawnSpec::model`] is `None`.
const DEFAULT_MODEL_ALIAS: &str = "sonnet";

/// `--max-turns`: a ceiling on the CLI's internal tool-use loop within
/// ONE SWARM turn (not on how many SWARM turns a session runs). Accepted
/// by the CLI but not listed in `--help`.
const MAX_TURNS_PER_TURN: &str = "50";

/// Switches off background tasks (async subagents, background shells)
/// for the child. With them on, an `Agent` call returns at once, the turn
/// ends, and the subagent's report arrives later as a turn SWARM never
/// started; with them off the subagent runs inside the turn that
/// launched it.
const DISABLE_BACKGROUND_TASKS_ENV: &str = "CLAUDE_CODE_DISABLE_BACKGROUND_TASKS";

/// Prefix of the synthesized settlement error for every ungraceful exit
/// (child killed, crashed, or an NDJSON framer failure) — Condition B. In
/// parentheses it is followed by the cause SWARM knows (a framer error)
/// or else the tail of the child's stderr.
const PROCESS_EXITED_WITHOUT_RECEIPT: &str = "Process Exited Without A Receipt";

/// Settlement error for a turn [`AgentSession::cancel`] interrupted.
const TURN_CANCELLED: &str = "Turn Cancelled";

/// Settlement error for a turn the CLI closed without a `result` line.
const TURN_ENDED_WITHOUT_RESULT: &str = "Turn Ended Without A Result";

/// Deny message sent to the CLI for a human "Deny".
const DENIED_BY_USER: &str = "Denied By The User";

/// Deny message for an ask nobody answered in time.
const PERMISSION_TIMED_OUT: &str = "No Decision Arrived In Time; Denied Automatically";

/// Deny message for an ask raised outside any SWARM turn (by a turn the
/// CLI started on its own).
const NO_SWARM_TURN: &str = "No SWARM Turn Is Waiting On This Session; Denied Automatically";

/// Error answer to control requests this host does not implement
/// (`request_user_dialog`, `elicitation`, ...), and the deny message for
/// a `can_use_tool` ask that only the CLI's own dialog can answer.
const UNSUPPORTED_REQUEST: &str = "Not Supported By The SWARM Host";

/// Error text for `send_turn` on a session that is shutting down.
const SESSION_CLOSED: &str = "Claude Code Session Is Shut Down";

// ── Trust tiers ──────────────────────────────────────────────────────

/// SWARM's closed vocabulary for Claude Code's spawn-time trust dial.
///
/// Deliberately NOT the provider's raw `--permission-mode` strings.
/// [`AgentSpawnSpec::permission_mode`] is parsed through
/// `parse_trust_tier`, which recognizes ONLY the three wire tokens
/// below and fails closed on anything else — including a raw provider
/// mode (`"acceptEdits"`, `"dontAsk"`) and, above all,
/// `"bypassPermissions"`. No variant maps to `bypassPermissions`, so the
/// flag value is unconstructible by this adapter (see
/// `tests::bypass_permissions_is_unconstructible`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ClaudeCodeTrustTier {
    /// Read-only exploration: `--restricted` (no command-running tools,
    /// no `WebFetch`, file tools confined to the working directory),
    /// `--permission-mode dontAsk` (anything not pre-approved is denied
    /// without asking), and a deny list for the writing tools.
    Restricted,
    /// `--permission-mode manual`, the CLI's default mode pinned against
    /// project settings: reads run, anything that needs approval
    /// (commands with side effects, file edits) is asked of the human,
    /// and the destructive Bash patterns in `deny_list` are always
    /// denied.
    Standard,
    /// `--permission-mode acceptEdits`: file edits in the working
    /// directory run without asking, commands are asked of the human,
    /// and the same destructive patterns stay denied.
    WriteEnabled,
}

/// Parses [`AgentSpawnSpec::permission_mode`] into a
/// [`ClaudeCodeTrustTier`]. `None` resolves to
/// [`ClaudeCodeTrustTier::Standard`]; any string outside the exact
/// three-token vocabulary is rejected rather than guessed at.
fn parse_trust_tier(raw: Option<&str>) -> Result<ClaudeCodeTrustTier, AppError> {
    match raw {
        None | Some("standard") => Ok(ClaudeCodeTrustTier::Standard),
        Some("restricted") => Ok(ClaudeCodeTrustTier::Restricted),
        Some("write_enabled") => Ok(ClaudeCodeTrustTier::WriteEnabled),
        Some(other) => Err(AppError::PermissionDenied(format!(
            "Unrecognized Claude Code Trust Tier {other:?}; Refusing To Spawn Rather Than \
             Guess A Permission Mode (Never bypassPermissions)"
        ))),
    }
}

/// The `--permission-mode` value for `tier`. Every tier passes one, the
/// Standard tier included: without the flag a project's
/// `.claude/settings.json` `defaultMode` picks the mode (measured on
/// 2.1.281: `"defaultMode": "acceptEdits"` made `initialize` report
/// `acceptEdits`), while `--permission-mode manual` (the name the CLI
/// has accepted for its default mode since 2.1.200) overrides it.
fn permission_mode_flag(tier: ClaudeCodeTrustTier) -> &'static str {
    match tier {
        ClaudeCodeTrustTier::Restricted => "dontAsk",
        ClaudeCodeTrustTier::Standard => "manual",
        ClaudeCodeTrustTier::WriteEnabled => "acceptEdits",
    }
}

/// The permission modes the `initialize` handshake may report for
/// `tier`. The CLI renamed `default` to "Manual" but still reports
/// `default` for `--permission-mode manual` (2.1.281); both are
/// accepted. Any other answer fails the spawn closed.
fn accepted_permission_modes(tier: ClaudeCodeTrustTier) -> &'static [&'static str] {
    match tier {
        ClaudeCodeTrustTier::Restricted => &["dontAsk"],
        ClaudeCodeTrustTier::Standard => &["default", "manual"],
        ClaudeCodeTrustTier::WriteEnabled => &["acceptEdits"],
    }
}

/// `settings.json` `permissions.deny` entries for `tier`. A bare tool
/// name (`"Bash"`) removes the tool from the model's tool list; the
/// `Tool(pattern)` form denies only matching calls (measured on 2.1.232:
/// `Bash(echo*)` refused `echo hi` while `pwd` ran, and the refusal
/// appeared in `result.permission_denials`). Only `Bash(echo*)` was
/// exercised; the patterns below rely on the same glob grammar. Under
/// `--restricted` the Bash entry is redundant (the flag removes the
/// tool) and stays as a second fence.
fn deny_list(tier: ClaudeCodeTrustTier) -> &'static [&'static str] {
    match tier {
        ClaudeCodeTrustTier::Restricted => &["Bash", "Write", "Edit", "NotebookEdit"],
        ClaudeCodeTrustTier::Standard | ClaudeCodeTrustTier::WriteEnabled => &[
            "Bash(rm -rf*)",
            "Bash(git push --force*)",
            "Bash(git push -f*)",
            "Bash(git reset --hard*)",
            "Bash(sudo*)",
        ],
    }
}

/// Condition A, inline: the JSON STRING passed verbatim to `--settings`.
/// Never a file: a settings file written into the worker's worktree would
/// be committed by the ship chain, keep the worktree dirty (so `git
/// worktree remove` refuses), and could clobber a human-committed
/// `.claude/settings.json`. `--settings` accepts inline JSON and
/// composes with `--setting-sources project`. `disableAllHooks` stops a
/// project's hooks: `-p` skips the workspace trust dialog, yet project
/// hooks still run (measured on 2.1.296: an untrusted repo's
/// `SessionStart` hook ran during the `initialize` handshake, and with
/// this key it did not).
fn inline_settings_json(tier: ClaudeCodeTrustTier) -> String {
    serde_json::json!({
        "disableAllHooks": true,
        "permissions": { "deny": deny_list(tier) },
    })
    .to_string()
}

/// What this adapter can honestly promise — identical for every trust
/// tier: the tier changes what the CLI is ALLOWED to do, never what the
/// protocol can do.
fn claude_code_capabilities() -> Capabilities {
    Capabilities {
        partial_deltas: true,
        resume: true,
        native_cost: true,
        // The values `AgentSpawnSpec::permission_mode` accepts
        // (`parse_trust_tier`), not the CLI's own mode names.
        permission_modes: ["restricted", "standard", "write_enabled"]
            .map(String::from)
            .into(),
        // The `interrupt` control request stops the turn and keeps the
        // process and the conversation.
        cancel_granularity: CancelGranularity::Graceful,
        // The CLI can fold a message into a running turn, but a session
        // rejects `send_turn` while busy and the scheduler serializes
        // turns, so SWARM never injects mid-turn.
        interrupt_midturn: false,
        worktree_aware: true,
        // `can_use_tool` over `--permission-prompt-tool stdio` blocks the
        // CLI until `respond_permission` answers it.
        interactive_permissions: true,
    }
}

/// Every argument the CLI gets for a session (the binary itself
/// excluded). `resume` selects `--resume <key>` (rehydration) over
/// `--session-id <worker_id>` (a fresh session keyed by the worker's own
/// UUID).
fn build_claude_flags(
    worker_id: Uuid,
    model: &str,
    tier: ClaudeCodeTrustTier,
    resume: Option<&str>,
) -> Vec<String> {
    let mut argv: Vec<String> = [
        "-p",
        "--output-format",
        "stream-json",
        "--input-format",
        "stream-json",
        "--include-partial-messages",
        "--verbose",
        "--model",
        model,
        "--max-turns",
        MAX_TURNS_PER_TURN,
        // Condition A: no user or local settings, no MCP servers (claude.ai
        // connectors included). Project settings load with their hooks
        // disabled and the tier's deny list added by the inline settings
        // below.
        "--setting-sources",
        "project",
        "--strict-mcp-config",
        "--permission-prompt-tool",
        "stdio",
        "--permission-prompts",
        "host",
    ]
    .map(String::from)
    .into();
    argv.extend(["--settings".to_owned(), inline_settings_json(tier)]);
    argv.extend(["--permission-mode", permission_mode_flag(tier)].map(String::from));
    if tier == ClaudeCodeTrustTier::Restricted {
        argv.push("--restricted".to_owned());
    }
    match resume {
        Some(session_key) => argv.extend(["--resume".to_owned(), session_key.to_owned()]),
        None => argv.extend(["--session-id".to_owned(), worker_id.to_string()]),
    }
    argv
}

/// Arguments for [`ClaudeCodeAdapter::probe`]'s throwaway process: the
/// control protocol and nothing that could spend tokens or touch a
/// session on disk.
fn probe_flags() -> Vec<String> {
    [
        "-p",
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        "--verbose",
        "--no-session-persistence",
        "--setting-sources",
        "project",
        "--settings",
        r#"{"disableAllHooks":true}"#,
        "--strict-mcp-config",
    ]
    .map(String::from)
    .into()
}

/// Environment additions for every `claude` child this adapter starts.
fn child_env() -> HashMap<String, String> {
    HashMap::from([(DISABLE_BACKGROUND_TASKS_ENV.to_owned(), "1".to_owned())])
}

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
fn classify_denial(decision_reason_type: Option<&str>, message: &str) -> Option<String> {
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

/// Display name of a third-party `apiProvider` value (the Agent SDK's
/// `AccountInfo.apiProvider` union).
fn provider_label(provider: &str) -> &str {
    match provider {
        "bedrock" => "Amazon Bedrock",
        "vertex" => "Google Vertex AI",
        "foundry" => "Microsoft Foundry",
        "anthropicAws" => "Anthropic On AWS",
        "anthropicGoogleCloud" => "Anthropic On Google Cloud",
        "mantle" => "Mantle",
        "gateway" => "Enterprise Gateway",
        other => other,
    }
}

/// `"2.1.281"` or `"2.1.281 (Claude Code)"` -> `(2, 1, 281)`.
fn parse_version(raw: &str) -> Option<(u32, u32, u32)> {
    let mut parts = raw
        .split_whitespace()
        .next()?
        .split('.')
        .map(|part| part.parse::<u32>().ok());
    Some((parts.next()??, parts.next()??, parts.next()??))
}

/// The error text of a settled turn, `None` for a success. A failed turn
/// reads as the provider's own explanation followed by the terminal
/// reason, HTTP status and stop reason it reported, e.g. "There's an
/// issue with the selected model ... (Terminal Reason: api_error, API
/// Status: 404, Stop Reason: stop_sequence)".
fn settlement_error(result: &ResultLine, cancelled: bool) -> Option<String> {
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
fn advance_cost(baseline: &mut Option<f64>, total: Option<f64>) -> Option<f64> {
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

/// `"SIGKILL"` for a Unix exit status that ended on signal 9, and so on.
#[cfg(unix)]
fn signal_name(status: ExitStatus) -> Option<String> {
    use std::os::unix::process::ExitStatusExt;
    status.signal().map(|signal| {
        match signal {
            1 => "SIGHUP",
            2 => "SIGINT",
            3 => "SIGQUIT",
            6 => "SIGABRT",
            9 => "SIGKILL",
            11 => "SIGSEGV",
            13 => "SIGPIPE",
            15 => "SIGTERM",
            other => return format!("SIG{other}"),
        }
        .to_owned()
    })
}

/// Windows has no signals: `TerminateProcess` sets an exit code.
#[cfg(not(unix))]
fn signal_name(_status: ExitStatus) -> Option<String> {
    None
}

// ── Child process plumbing ───────────────────────────────────────────

/// One line bound for the child's stdin, with an optional completion
/// signal for callers that need to know the write landed.
struct StdinFrame {
    line: String,
    ack: Option<oneshot::Sender<Result<(), String>>>,
}

/// Owns the child's stdin on a dedicated OS thread. Writes are blocking
/// syscalls that can stall for as long as the child leaves its pipe
/// full, so none of them ever runs on a Tokio worker; callers only queue
/// lines. Closing the queue ([`Self::close`]) lets the thread write what
/// is left and drop stdin, which the CLI reads as EOF. Killing the child
/// unblocks a stuck write with a broken-pipe error, which ends the thread.
struct StdinWriter {
    queue: parking_lot::Mutex<Option<mpsc::UnboundedSender<StdinFrame>>>,
}

impl StdinWriter {
    fn start(mut stdin: Box<dyn Write + Send>) -> std::io::Result<Self> {
        let (queue, mut frames) = mpsc::unbounded_channel::<StdinFrame>();
        std::thread::Builder::new()
            .name("claude-code-stdin".to_owned())
            .spawn(move || {
                while let Some(StdinFrame { line, ack }) = frames.blocking_recv() {
                    let written = write_to_piped(stdin.as_mut(), line.as_bytes())
                        .map_err(|error| format!("{error:#}"));
                    let failed = written.is_err();
                    if let Some(ack) = ack {
                        // The caller may have stopped waiting; the write
                        // happened (or failed) either way.
                        ack.send(written).ok();
                    }
                    if failed {
                        break;
                    }
                }
            })?;
        Ok(Self {
            queue: parking_lot::Mutex::new(Some(queue)),
        })
    }

    fn enqueue(&self, frame: StdinFrame) -> bool {
        self.queue
            .lock()
            .as_ref()
            .is_some_and(|queue| queue.send(frame).is_ok())
    }

    /// Queues `line` without waiting for the write. The reader task uses
    /// only this: it must never wait on stdin, or a child blocked writing
    /// stdout while not reading stdin would deadlock the pair.
    fn send(&self, line: String) -> bool {
        self.enqueue(StdinFrame { line, ack: None })
    }

    /// Queues `line` and resolves once it has been written and flushed.
    async fn write(&self, line: String) -> Result<(), String> {
        let (ack, written) = oneshot::channel();
        if !self.enqueue(StdinFrame {
            line,
            ack: Some(ack),
        }) {
            return Err("Stdin Is Closed".to_owned());
        }
        written
            .await
            .unwrap_or_else(|_| Err("The Stdin Writer Stopped".to_owned()))
    }

    /// Closes stdin once every queued line has been written.
    fn close(&self) {
        drop(self.queue.lock().take());
    }
}

/// A started `claude` child before it becomes a session.
struct Process {
    child: Child,
    stdin: StdinWriter,
    lines: mpsc::Receiver<String>,
    framer_errors: mpsc::UnboundedReceiver<AppError>,
    stderr_tail: Arc<parking_lot::Mutex<VecDeque<u8>>>,
}

impl Process {
    async fn start(binary: &str, argv: &[String], cwd: &str) -> anyhow::Result<Self> {
        let PipedHandle {
            stdin,
            child,
            pid: _,
            lines,
            framer_errors,
            stderr_tail,
        } = spawn_piped(binary, argv, cwd, &child_env())?;
        match StdinWriter::start(stdin) {
            Ok(stdin) => Ok(Self {
                child,
                stdin,
                lines,
                framer_errors,
                stderr_tail,
            }),
            Err(error) => {
                reap(child, false).await;
                Err(error.into())
            }
        }
    }

    /// Closes stdin and stops the child — a clean exit when `graceful`
    /// and the CLI takes it, a kill otherwise — and returns the last
    /// stderr it wrote.
    async fn finish(self, graceful: bool) -> String {
        self.stdin.close();
        reap(self.child, graceful).await;
        drained_stderr_snippet(&self.stderr_tail).await
    }
}

/// Stops `child` and waits for it, off the async threads. With
/// `graceful`, the child first gets [`SHUTDOWN_GRACE`] to exit on its own
/// (stdin must already be closed for that to happen).
async fn reap(mut child: Child, graceful: bool) -> Option<ExitStatus> {
    if graceful {
        let deadline = tokio::time::Instant::now() + SHUTDOWN_GRACE;
        loop {
            match child.try_wait() {
                Ok(Some(status)) => return Some(status),
                Ok(None) if tokio::time::Instant::now() < deadline => {
                    tokio::time::sleep(EXIT_POLL_INTERVAL).await;
                }
                Ok(None) | Err(_) => break,
            }
        }
    }
    tokio::task::spawn_blocking(move || {
        // Killing a process that already exited is not an error worth
        // reporting: the end state is the same.
        child.kill().ok();
        child.wait().ok()
    })
    .await
    .ok()
    .flatten()
}

/// The child's last stderr bytes, for a failure message. Waits briefly
/// for the stderr drain thread, which can trail the child's exit.
async fn drained_stderr_snippet(tail: &parking_lot::Mutex<VecDeque<u8>>) -> String {
    for _ in 0..10 {
        if !tail.lock().is_empty() {
            break;
        }
        tokio::time::sleep(EXIT_POLL_INTERVAL).await;
    }
    super::stderr_snippet(tail)
}

/// Why the `initialize` handshake failed.
#[derive(Debug)]
enum HandshakeError {
    /// The CLI answered `initialize` with an error response, or with a
    /// success payload the adapter cannot read.
    Rejected(String),
    /// The CLI wrote a `result` instead (e.g. `--resume` of an unknown
    /// session: "No conversation found with session ID: ...").
    StartupFailure(String),
    /// Stdout closed before an answer arrived.
    Exited,
}

/// Sends `initialize` (and, for the probe, `get_binary_version`) and
/// reads frames until every answer is in. Pre-turn frames (hook
/// notices) are skipped: nothing turn-scoped can arrive before the first
/// user message.
async fn handshake(
    process: &mut Process,
    want_version: bool,
) -> Result<(InitializeResponse, Option<String>), HandshakeError> {
    let init_id = format!("swarm-initialize-{}", Uuid::new_v4());
    let version_id = format!("swarm-version-{}", Uuid::new_v4());
    if !process.stdin.send(wire::initialize_request(&init_id))
        || (want_version
            && !process
                .stdin
                .send(wire::binary_version_request(&version_id)))
    {
        return Err(HandshakeError::Exited);
    }
    let mut init: Option<InitializeResponse> = None;
    let mut version = None;
    let mut version_pending = want_version;
    while let Some(line) = process.lines.recv().await {
        match serde_json::from_str::<Inbound>(&line) {
            Ok(Inbound::ControlResponse(frame)) if frame.response.request_id() == init_id => {
                match frame.response {
                    // An answer the adapter cannot read is no answer: a
                    // default would skip the spawn's permission-mode check
                    // and report the probe as signed out.
                    ControlResponse::Success { response, .. } => {
                        let payload = response.unwrap_or(Value::Null);
                        init = Some(serde_json::from_value(payload).map_err(|error| {
                            HandshakeError::Rejected(format!(
                                "Unreadable Initialize Response ({error})"
                            ))
                        })?);
                    }
                    ControlResponse::Error { error, .. } => {
                        return Err(HandshakeError::Rejected(error));
                    }
                }
            }
            Ok(Inbound::ControlResponse(frame)) if frame.response.request_id() == version_id => {
                version_pending = false;
                if let ControlResponse::Success {
                    response: Some(value),
                    ..
                } = frame.response
                {
                    version = serde_json::from_value::<wire::BinaryVersion>(value)
                        .ok()
                        .map(|answer| answer.version);
                }
            }
            Ok(Inbound::Result(result)) => {
                return Err(HandshakeError::StartupFailure(
                    result
                        .failure_text()
                        .unwrap_or_else(|| format!("Ended With {}", result.subtype)),
                ));
            }
            _ => {}
        }
        if !version_pending && let Some(init) = init.take() {
            return Ok((init, version));
        }
    }
    Err(HandshakeError::Exited)
}

// ── Session state ────────────────────────────────────────────────────

/// The SWARM turn a session currently owns, with everything scoped to
/// it. Dropped when the turn settles.
struct TurnState {
    id: TurnId,
    /// The CLI is executing this turn, as opposed to it still waiting in
    /// the CLI's queue behind work the CLI started itself (module doc,
    /// "Turn ownership"). Only a running turn receives frames.
    running: bool,
    /// [`AgentSession::cancel`] already interrupted this turn.
    cancelling: bool,
    /// Index of the content block between its `content_block_start` and
    /// `content_block_stop`; the CLI never interleaves top-level blocks,
    /// so one slot stamps the `block_index` on the complete `assistant`
    /// message that arrives in between.
    open_block: Option<u32>,
    /// Block kind (`"text"`/`"thinking"`/`"tool_use"`) by index, for the
    /// `kind` of each `agent_turn_delta`.
    block_kinds: HashMap<u32, String>,
    /// Input of every tool call seen this turn (subagents' included), so
    /// a denial report can show what was refused.
    tool_inputs: HashMap<String, Value>,
    /// Text of every `is_error` tool result, the message of a denial
    /// known only from `result.permission_denials`.
    tool_errors: HashMap<String, String>,
    /// Tool-use ids already surfaced as `agent_permission_request`
    /// (pending asks and reports alike): each call is surfaced once.
    surfaced: HashSet<String>,
}

impl TurnState {
    fn new(id: TurnId, running: bool) -> Self {
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
    fn claim(&mut self, answers: Option<bool>) {
        if answers == Some(true) {
            self.running = true;
        }
    }
}

/// A `can_use_tool` ask waiting for [`AgentSession::respond_permission`].
struct PendingAsk {
    turn_id: TurnId,
    tool_use_id: String,
    input: Value,
}

/// Mutable state shared by [`ClaudeCodeSession`]'s methods and the reader
/// task, behind one `parking_lot::Mutex` that is never held across an
/// `.await` (the trait's concurrency contract).
struct Inner {
    /// Whichever of "the turn's `result` arrives" and "teardown runs"
    /// takes this first owns emitting the turn's ONE `agent_turn_settled`.
    turn: Option<TurnState>,
    /// Whether the CLI emits `command_lifecycle` frames; `None` until the
    /// first frame that tells.
    lifecycle: Option<bool>,
    /// The previous `result`'s running `total_cost_usd` (see
    /// [`advance_cost`]).
    cost_baseline: Option<f64>,
    /// Open `can_use_tool` asks by control request id.
    asks: HashMap<PermissionId, PendingAsk>,
    /// Host-initiated control requests awaiting their `control_response`.
    control_waiters: HashMap<String, oneshot::Sender<ControlResponse>>,
    /// The child. Taken exactly once, by teardown.
    child: Option<Child>,
    /// Set by teardown in the same critical section that takes `turn`
    /// and `child`: `send_turn` checks it under the same lock, so no turn
    /// can be accepted once teardown has claimed the session.
    closing: bool,
}

/// What waiters watch: the in-flight turn (settled once it changes) and,
/// once teardown has finished, the exit summary.
#[derive(Debug, Clone, Default)]
struct Status {
    in_flight: Option<TurnId>,
    exit: Option<ExitSummary>,
}

/// How teardown stops the child.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Stop {
    /// Close stdin and give an idle CLI [`SHUTDOWN_GRACE`] to exit; kill
    /// a busy one.
    Graceful,
    /// Kill now.
    Kill,
}

/// Everything a [`ClaudeCodeSession`] and its reader task share.
struct Shared {
    worker_id: Uuid,
    sink: EventSink,
    /// Stable for the session's lifetime: the worker id passed as
    /// `--session-id`, or the key passed to `--resume`.
    session_key: SessionKey,
    state: parking_lot::Mutex<Inner>,
    stdin: StdinWriter,
    status: watch::Sender<Status>,
    teardown_started: AtomicBool,
    /// The child's stderr tail, appended to a synthesized settlement error
    /// when no better cause is known.
    stderr_tail: Arc<parking_lot::Mutex<VecDeque<u8>>>,
    /// Why the session is torn down, when SWARM knows it (a framer error).
    teardown_cause: parking_lot::Mutex<Option<String>>,
}

impl Shared {
    /// Publishes the in-flight turn. Called with `state` locked, so the
    /// watched value never disagrees with `Inner::turn`.
    fn publish_in_flight(&self, turn: Option<&TurnState>) {
        let in_flight = turn.map(|turn| turn.id.clone());
        self.status
            .send_modify(|status| status.in_flight = in_flight);
    }

    /// Resolves once `turn` is no longer in flight (settled, rolled back,
    /// or torn down) or the session has exited.
    async fn settled(&self, turn: &str) {
        let mut status = self.status.subscribe();
        // Err only if the sender is gone, and `self` owns it.
        status
            .wait_for(|status| status.exit.is_some() || status.in_flight.as_deref() != Some(turn))
            .await
            .ok();
    }
}

// ── Teardown ─────────────────────────────────────────────────────────

/// Starts teardown once; later calls are no-ops. It runs in its own task
/// so a caller that stops waiting (a dropped `shutdown` future) cannot
/// leave it half done.
fn begin_teardown(shared: &Arc<Shared>, stop: Stop) {
    if shared.teardown_started.swap(true, Ordering::AcqRel) {
        return;
    }
    tokio::spawn(run_teardown(shared.clone(), stop));
}

/// Tears the session down (once, whoever asks first) and returns the
/// exit summary every caller shares.
async fn teardown(shared: &Arc<Shared>, stop: Stop) -> ExitSummary {
    begin_teardown(shared, stop);
    let mut status = shared.status.subscribe();
    status
        .wait_for(|status| status.exit.is_some())
        .await
        .ok()
        .and_then(|status| status.exit.clone())
        .unwrap_or(ExitSummary {
            exit_code: None,
            signal: None,
        })
}

/// Claims the in-flight turn and the child in one critical section,
/// closes stdin, stops the child (gracefully only when idle), synthesizes
/// Condition B's settlement for a turn that never got its receipt, emits
/// `agent_session_exited`, and publishes the exit summary.
async fn run_teardown(shared: Arc<Shared>, stop: Stop) {
    let (in_flight, child) = {
        let mut inner = shared.state.lock();
        inner.closing = true;
        inner.asks.clear();
        inner.control_waiters.clear();
        let turn = inner.turn.take();
        shared.publish_in_flight(None);
        (turn, inner.child.take())
    };
    shared.stdin.close();

    let graceful = stop == Stop::Graceful && in_flight.is_none();
    let status = match child {
        Some(child) => reap(child, graceful).await,
        None => None,
    };
    let summary = ExitSummary {
        exit_code: status.and_then(|status| status.code()),
        signal: status.and_then(signal_name),
    };

    if let Some(turn) = in_flight {
        let cause = shared.teardown_cause.lock().take();
        let detail = match cause {
            Some(cause) => cause,
            None => drained_stderr_snippet(&shared.stderr_tail).await,
        };
        shared
            .sink
            .emit(SwarmEvent::AgentTurnSettled(AgentTurnSettledPayload {
                worker_id: shared.worker_id,
                turn_id: turn.id,
                status: AgentTurnStatus::Error,
                error: Some(format!("{PROCESS_EXITED_WITHOUT_RECEIPT} ({detail})")),
                cost_usd: None,
                usage: None,
                duration_ms: 0,
                num_turns: None,
            }));
    }

    // Awaiting the ack orders the settlement above (if any) and this row
    // on disk before any caller learns the session is gone.
    shared
        .sink
        .emit_awaiting_seq(
            SwarmEvent::AgentSessionExited(AgentSessionExitedPayload {
                worker_id: shared.worker_id,
                exit_code: summary.exit_code,
                signal: summary.signal.clone(),
            }),
            Provenance::default(),
        )
        .await
        .ok();

    shared
        .status
        .send_modify(|status| status.exit = Some(summary));
}

// ── Frame handling (reader task) ─────────────────────────────────────

fn handle_line(shared: &Arc<Shared>, line: &str) {
    match serde_json::from_str::<Inbound>(line) {
        Ok(frame) => dispatch(shared, frame),
        Err(error) => recover_unreadable(shared, line, &error),
    }
}

fn dispatch(shared: &Arc<Shared>, frame: Inbound) {
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
fn recover_unreadable(shared: &Arc<Shared>, line: &str, error: &serde_json::Error) {
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

fn handle_init(shared: &Arc<Shared>, init: &InitLine) {
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

fn handle_lifecycle(shared: &Arc<Shared>, lifecycle: &CommandLifecycleLine) {
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

fn handle_stream_event(shared: &Arc<Shared>, line: StreamEventLine) {
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

fn handle_assistant(shared: &Arc<Shared>, message: &MessageLine) {
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

fn handle_user(shared: &Arc<Shared>, message: &MessageLine) {
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
fn denial_report(
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

fn handle_permission_denied(shared: &Arc<Shared>, denied: PermissionDeniedLine) {
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

fn handle_control_request(shared: &Arc<Shared>, request: ControlRequestLine) {
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
fn handle_can_use_tool(shared: &Arc<Shared>, request_id: PermissionId, ask: CanUseTool) {
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
fn expire_ask(shared: &Arc<Shared>, request_id: PermissionId) {
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

fn handle_result(shared: &Arc<Shared>, result: ResultLine) {
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
async fn run_reader(
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
async fn watch_framer_errors(
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

// ── AgentAdapter / AgentSession ──────────────────────────────────────

/// The `claude` CLI adapter. One instance drives every Claude Code
/// worker; each [`ClaudeCodeSession`] it spawns owns one child process.
pub struct ClaudeCodeAdapter {
    sink: EventSink,
    binary: String,
    /// Test-only argv prefix (empty in production) — see
    /// [`ClaudeCodeAdapter::with_test_binary`].
    prefix_args: Vec<String>,
}

impl ClaudeCodeAdapter {
    /// Drives the `claude` binary found on `PATH`.
    pub fn new(sink: EventSink) -> Self {
        Self {
            sink,
            binary: "claude".to_owned(),
            prefix_args: Vec::new(),
        }
    }

    /// Drives a stand-in child instead of the real CLI: `binary` plus
    /// `prefix_args` (e.g. `("node", [fake_claude_cli.mjs, scenario])`)
    /// go in front of the flags [`build_claude_flags`]/[`probe_flags`]
    /// build.
    #[cfg(test)]
    pub fn with_test_binary(
        sink: EventSink,
        binary: impl Into<String>,
        prefix_args: Vec<String>,
    ) -> Self {
        Self {
            sink,
            binary: binary.into(),
            prefix_args,
        }
    }

    async fn run_probe(&self) -> ProbeReport {
        let unavailable = |version: Option<String>, detail: String| ProbeReport {
            available: false,
            version,
            detail: Some(detail),
        };
        let mut argv = self.prefix_args.clone();
        argv.extend(probe_flags());
        let cwd = std::env::temp_dir();
        let mut process = match Process::start(&self.binary, &argv, &cwd.to_string_lossy()).await {
            Ok(process) => process,
            Err(error) => {
                return unavailable(
                    None,
                    format!("Claude Code CLI Not Found On PATH: {error:#}"),
                );
            }
        };
        let answer = tokio::time::timeout(PROBE_TIMEOUT, handshake(&mut process, true)).await;
        let stderr = process.finish(true).await;
        let (init, version) = match answer {
            Ok(Ok(answer)) => answer,
            Ok(Err(HandshakeError::Rejected(error))) => {
                return unavailable(None, format!("Claude Code CLI Rejected The Probe: {error}"));
            }
            Ok(Err(HandshakeError::StartupFailure(error))) => {
                return unavailable(None, format!("Claude Code CLI Failed To Start: {error}"));
            }
            Ok(Err(HandshakeError::Exited)) => {
                return unavailable(
                    None,
                    format!("Claude Code CLI Exited During The Probe ({stderr})"),
                );
            }
            Err(_elapsed) => {
                return unavailable(None, "Claude Code CLI Probe Timed Out".to_owned());
            }
        };
        if let Some(found) = version.as_deref().and_then(parse_version)
            && found < MIN_CLI_VERSION
        {
            let (major, minor, patch) = MIN_CLI_VERSION;
            return unavailable(
                version,
                format!("Claude Code {major}.{minor}.{patch} Or Newer Required"),
            );
        }
        let detail = match init.account.unwrap_or_default().sign_in() {
            SignIn::SignedOut => {
                return unavailable(version, "Claude Code CLI Not Signed In".to_owned());
            }
            SignIn::Account { plan: Some(plan) } => format!("Signed In ({plan})"),
            SignIn::Account { plan: None } => "Signed In".to_owned(),
            SignIn::ApiKey { source } => format!("Using An API Key ({source})"),
            SignIn::Token { source } => format!("Signed In With A Token ({source})"),
            SignIn::Provider { name } => format!("Signed In Via {}", provider_label(&name)),
        };
        ProbeReport {
            available: true,
            version,
            detail: Some(detail),
        }
    }

    async fn spawn_session(&self, spec: AgentSpawnSpec) -> Result<ClaudeCodeSession, AppError> {
        let tier = parse_trust_tier(spec.permission_mode.as_deref())?;
        let requested_model = spec
            .model
            .clone()
            .unwrap_or_else(|| DEFAULT_MODEL_ALIAS.to_owned());
        let mut argv = self.prefix_args.clone();
        argv.extend(build_claude_flags(
            spec.worker_id,
            &requested_model,
            tier,
            spec.resume.as_deref(),
        ));

        let mut process = Process::start(&self.binary, &argv, &spec.cwd)
            .await
            .map_err(|error| AppError::Ai(format!("Failed To Start Claude Code: {error:#}")))?;

        let init = match tokio::time::timeout(HANDSHAKE_TIMEOUT, handshake(&mut process, false))
            .await
        {
            Ok(Ok((init, _))) => init,
            failed => {
                let stderr = process.finish(false).await;
                return Err(AppError::Ai(match failed {
                    Ok(Err(HandshakeError::Rejected(error))) => {
                        format!("Claude Code Rejected The Session Handshake: {error}")
                    }
                    Ok(Err(HandshakeError::StartupFailure(error))) => {
                        format!("Claude Code Could Not Start The Session: {error}")
                    }
                    Ok(Err(HandshakeError::Exited)) => {
                        format!("Claude Code Exited During The Session Handshake ({stderr})")
                    }
                    _ => format!(
                        "Claude Code Did Not Answer The Session Handshake Within {}s ({stderr})",
                        HANDSHAKE_TIMEOUT.as_secs()
                    ),
                }));
            }
        };

        // A second fence behind the pinned `--permission-mode`, for
        // anything that overrides the flag. The field is not in
        // the SDK's public types, so a CLI that stops reporting it runs
        // on the pinned flag alone.
        if let Some(mode) = init.current_permission_mode.as_deref()
            && !accepted_permission_modes(tier).contains(&mode)
        {
            process.finish(false).await;
            return Err(AppError::PermissionDenied(format!(
                "Claude Code Reports Permission Mode {mode:?} For The {tier:?} Trust Tier; \
                 Refusing To Run It"
            )));
        }
        if let Some(pid) = init.pid {
            tracing::debug!(worker_id = %spec.worker_id, pid, "claude code: session handshake complete");
        }

        let Process {
            child,
            stdin,
            lines,
            framer_errors,
            stderr_tail,
        } = process;
        let fresh = spec.resume.is_none();
        let session_key = spec
            .resume
            .clone()
            .unwrap_or_else(|| spec.worker_id.to_string());
        let shared = Arc::new(Shared {
            worker_id: spec.worker_id,
            sink: self.sink.clone(),
            session_key: session_key.clone(),
            state: parking_lot::Mutex::new(Inner {
                turn: None,
                lifecycle: None,
                cost_baseline: fresh.then_some(0.0),
                asks: HashMap::new(),
                control_waiters: HashMap::new(),
                child: Some(child),
                closing: false,
            }),
            stdin,
            status: watch::Sender::new(Status::default()),
            teardown_started: AtomicBool::new(false),
            stderr_tail,
            teardown_cause: parking_lot::Mutex::new(None),
        });

        let drain_signal = Arc::new(Notify::new());
        tokio::spawn(run_reader(shared.clone(), lines, drain_signal.clone()));
        tokio::spawn(watch_framer_errors(
            shared.clone(),
            framer_errors,
            drain_signal,
        ));

        self.sink.emit(SwarmEvent::AgentSessionStarted(
            AgentSessionStartedPayload {
                worker_id: spec.worker_id,
                provider: ProviderId::ClaudeCode,
                session_key,
                model: init.resolve_model(&requested_model),
                cwd: spec.cwd,
                capabilities: claude_code_capabilities(),
            },
        ));

        Ok(ClaudeCodeSession { shared })
    }
}

impl AgentAdapter for ClaudeCodeAdapter {
    fn provider(&self) -> ProviderId {
        ProviderId::ClaudeCode
    }

    fn capabilities(&self) -> Capabilities {
        claude_code_capabilities()
    }

    /// Starts the CLI with the control protocol only, asks `initialize`
    /// (account and models) and `get_binary_version`, and stops it: no
    /// API call, no session on disk. `available` is `false` when the CLI
    /// is missing, older than `MIN_CLI_VERSION`, or signed out; the
    /// account's email is never kept.
    fn probe(&self) -> BoxFuture<'_, Result<ProbeReport, AppError>> {
        Box::pin(async move { Ok(self.run_probe().await) })
    }

    fn spawn(
        &self,
        spec: AgentSpawnSpec,
    ) -> BoxFuture<'_, Result<Box<dyn AgentSession>, AppError>> {
        Box::pin(async move {
            let session: Box<dyn AgentSession> = Box::new(self.spawn_session(spec).await?);
            Ok(session)
        })
    }
}

/// Per-worker handle to one live `claude` process. Dropping the last
/// handle without [`AgentSession::shutdown`] kills the process.
pub struct ClaudeCodeSession {
    shared: Arc<Shared>,
}

impl ClaudeCodeSession {
    async fn cancel_turn(&self, turn: TurnId) {
        let shared = &self.shared;
        let (asks, acknowledged, request_id) = {
            let mut guard = shared.state.lock();
            let inner = &mut *guard;
            let Some(current) = inner
                .turn
                .as_mut()
                .filter(|current| current.id == turn && !current.cancelling)
            else {
                // Stale, already settled, or already being cancelled.
                return;
            };
            current.cancelling = true;
            let asks = inner
                .asks
                .extract_if(|_, ask| ask.turn_id == turn)
                .collect::<Vec<_>>();
            let request_id = format!("swarm-interrupt-{}", Uuid::new_v4());
            let (waiter, acknowledged) = oneshot::channel();
            inner.control_waiters.insert(request_id.clone(), waiter);
            (asks, acknowledged, request_id)
        };
        for (ask_id, ask) in asks {
            shared.stdin.send(wire::permission_deny(
                &ask_id,
                &ask.tool_use_id,
                TURN_CANCELLED,
                true,
            ));
        }
        let accepted = shared.stdin.send(wire::interrupt_request(&request_id))
            && matches!(
                tokio::time::timeout(INTERRUPT_ACK_TIMEOUT, acknowledged).await,
                Ok(Ok(ControlResponse::Success { .. }))
            );
        if accepted
            && tokio::time::timeout(INTERRUPT_GRACE, shared.settled(&turn))
                .await
                .is_ok()
        {
            return;
        }
        shared.state.lock().control_waiters.remove(&request_id);
        tracing::warn!(worker_id = %shared.worker_id, %turn, accepted, "claude code: interrupt did not settle the turn; killing the process");
        teardown(shared, Stop::Kill).await;
    }
}

impl AgentSession for ClaudeCodeSession {
    fn session_key(&self) -> &SessionKey {
        &self.shared.session_key
    }

    fn send_turn(&self, turn: TurnInput) -> BoxFuture<'_, Result<TurnId, AppError>> {
        Box::pin(async move {
            let shared = &self.shared;
            let turn_id: TurnId = Uuid::new_v4().to_string();
            {
                let mut inner = shared.state.lock();
                if inner.closing {
                    return Err(AppError::Ipc(SESSION_CLOSED.to_owned()));
                }
                if inner.turn.is_some() {
                    return Err(AppError::AgentSessionBusy);
                }
                let running = inner.lifecycle == Some(false);
                let state = TurnState::new(turn_id.clone(), running);
                shared.publish_in_flight(Some(&state));
                inner.turn = Some(state);
            }
            match shared
                .stdin
                .write(wire::user_turn(&turn.prompt, &turn_id))
                .await
            {
                Ok(()) => Ok(turn_id),
                Err(error) => {
                    let mut inner = shared.state.lock();
                    if inner.turn.as_ref().is_some_and(|turn| turn.id == turn_id) {
                        inner.turn = None;
                        shared.publish_in_flight(None);
                        Err(AppError::Ipc(format!(
                            "Failed To Send The Turn To Claude Code: {error}"
                        )))
                    } else {
                        // Teardown claimed the turn first and already
                        // synthesized its one settlement: hand back the id
                        // that settlement carries.
                        Ok(turn_id)
                    }
                }
            }
        })
    }

    fn await_turn_completion(&self, turn: TurnId) -> BoxFuture<'_, Result<(), AppError>> {
        Box::pin(async move {
            self.shared.settled(&turn).await;
            Ok(())
        })
    }

    /// Interrupts `turn` in-band (the session stays alive), falling back
    /// to a kill when the CLI does not acknowledge the interrupt or write
    /// the turn's receipt in time. A cancel for a turn that is not in
    /// flight is a no-op.
    fn cancel(&self, turn: TurnId) -> BoxFuture<'_, Result<(), AppError>> {
        Box::pin(async move {
            self.cancel_turn(turn).await;
            Ok(())
        })
    }

    /// Answers a pending `can_use_tool` ask. An id with no open ask — a
    /// report-only denial, an ask already answered, withdrawn by the CLI,
    /// or timed out — is a no-op, so a double click cannot fail.
    fn respond_permission(
        &self,
        req: PermissionId,
        decision: PermissionDecision,
    ) -> BoxFuture<'_, Result<(), AppError>> {
        Box::pin(async move {
            let ask = self.shared.state.lock().asks.remove(&req);
            let Some(ask) = ask else {
                return Ok(());
            };
            let answer = match decision {
                PermissionDecision::Allow => {
                    wire::permission_allow(&req, &ask.tool_use_id, &ask.input)
                }
                PermissionDecision::Deny => {
                    wire::permission_deny(&req, &ask.tool_use_id, DENIED_BY_USER, false)
                }
            };
            self.shared.stdin.write(answer).await.map_err(|error| {
                AppError::Ipc(format!(
                    "Failed To Send The Permission Decision To Claude Code: {error}"
                ))
            })
        })
    }

    fn shutdown(&self) -> BoxFuture<'_, Result<ExitSummary, AppError>> {
        Box::pin(async move { Ok(teardown(&self.shared, Stop::Graceful).await) })
    }
}

impl Drop for ClaudeCodeSession {
    fn drop(&mut self) {
        if self.shared.teardown_started.load(Ordering::Acquire) {
            return;
        }
        // Killing is a non-blocking syscall; the reader task sees stdout
        // close and runs the real teardown, which reaps the child.
        if let Some(child) = self.shared.state.lock().child.as_mut() {
            child.kill().ok();
        }
    }
}
