//! `ClaudeCodeAdapter`: the [`AgentAdapter`]/[`AgentSession`] pair that
//! drives the `claude` CLI's `stream-json` protocol over piped stdio
//! ([`crate::worker::proc::spawn_piped`]).
//!
//! Verified against `claude` 2.1.280 and 2.1.281 (live traces) and
//! `@anthropic-ai/claude-agent-sdk` 0.3.280's protocol types; the oldest
//! CLI it drives is `MIN_CLI_VERSION`. The wire types live in
//! `wire`; the trust-tier mapping and argv in `tier`, the child process and
//! handshake in `process`, the shared session state in `state`, teardown
//! in `teardown` and the reader task's frame handlers in `reader`; this
//! file holds the constants, the adapter and the session. The unit tests
//! drive a fake CLI (`tests/fixtures/claude_code/fake_claude_cli.mjs`)
//! that plays one scenario module per test with the real CLI's ordering.
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

mod process;
mod reader;
mod state;
mod teardown;
mod tier;
mod wire;

#[cfg(test)]
mod tests;

pub use self::tier::ClaudeCodeTrustTier;

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use tokio::sync::{Notify, oneshot, watch};
use uuid::Uuid;

use self::process::{HandshakeError, Process, handshake};
use self::reader::{run_reader, watch_framer_errors};
use self::state::{Inner, Shared, Status, Stop, TurnState};
use self::teardown::teardown;
use self::tier::{
    accepted_permission_modes, build_claude_flags, claude_code_capabilities, parse_trust_tier,
    probe_flags,
};
use self::wire::{ControlResponse, SignIn};
use crate::agent::adapter::{
    AgentAdapter, AgentSession, AgentSpawnSpec, BoxFuture, Capabilities, ExitSummary,
    PermissionDecision, PermissionId, ProbeReport, ProviderId, SessionKey, TurnId, TurnInput,
};
use crate::error::AppError;
use crate::events::{AgentSessionStartedPayload, EventSink, SwarmEvent};

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

/// Poll interval for the two bounded waits on a child: non-blocking
/// `try_wait` calls while waiting out [`SHUTDOWN_GRACE`], and the stderr
/// drain thread after the child exits (`drained_stderr_snippet`).
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
/// parentheses it is followed by the cause SWARM knows (a framer error), else
/// `crate::agent::stderr_snippet` of the child's stderr tail (`Stderr: …` or
/// `No Stderr Output`).
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

// ── AgentAdapter / AgentSession ──────────────────────────────────────

/// The `claude` CLI adapter. One instance drives every Claude Code
/// worker; each [`ClaudeCodeSession`] it spawns owns one child process.
pub struct ClaudeCodeAdapter {
    sink: EventSink,
    binary: String,
    /// Test-only argv prefix (empty in production), set by
    /// `ClaudeCodeAdapter::with_test_binary`.
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
