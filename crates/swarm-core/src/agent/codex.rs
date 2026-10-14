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
//! The wire types live in `protocol`; the trust-tier mapping in `tier`, the
//! child process and handshake in `process`, the shared session state in
//! `state`, teardown in `teardown` and the reader task's line handlers in
//! `reader`; this file holds the constants, the adapter and the session.
//!
//! ## Session lifecycle
//!
//! 1. **Handshake.** `initialize` (client info + capabilities) must be the
//!    connection's first request — the server answers anything else with
//!    `-32600 Not initialized` — followed by the `initialized`
//!    notification.
//! 2. **Thread.** `thread/start` (or `thread/resume` for
//!    [`AgentSpawnSpec::resume`]) with `cwd`, the trust tier's
//!    `approvalPolicy`, `approvalsReviewer` (always `user`) and `sandbox`,
//!    and `model` only when one was asked for. The response reports the
//!    policy the server actually applied; anything more permissive than
//!    requested refuses the session (see
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

mod process;
mod protocol;
mod reader;
mod state;
mod teardown;
#[cfg(test)]
mod tests;
mod tier;

pub use self::tier::CodexTrustTier;

use std::collections::HashMap;
use std::mem::DropGuard;
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use tokio::sync::{oneshot, watch};

use self::process::{
    ProbeFailure, first_line, open_thread, resolve_program, run_cli, start_stdin_writer,
};
use self::protocol::{TurnInterruptParams, TurnStartParams, TurnStartResponse, UserInput, method};
use self::reader::{approval_answer, run_reader};
use self::state::{BlockIndex, Inner, RequestFailure, Settled, Shared, TurnSlot, wait_settled};
use self::teardown::{teardown, teardown_on_drop};
use self::tier::{child_env, codex_capabilities, parse_trust_tier, requested_model};

use crate::agent::adapter::{
    AgentAdapter, AgentSession, AgentSpawnSpec, BoxFuture, Capabilities, ExitSummary,
    PermissionDecision, PermissionId, ProbeReport, ProviderId, SessionKey, TurnId, TurnInput,
};
use crate::agent::{drained_stderr_snippet, stderr_snippet};
use crate::error::AppError;
use crate::events::{AgentSessionStartedPayload, EventSink, SwarmEvent};
use crate::worker::proc::{PipedHandle, spawn_piped};

/// `initialize.clientInfo.name` — becomes part of the server's user agent.
const CLIENT_NAME: &str = "swarm";
/// `initialize.clientInfo.title`.
const CLIENT_TITLE: &str = "Swarm Orchestrator";

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

/// The bounds this adapter puts on waiting for the child's handshake,
/// requests, interrupt, exit and probes. A running turn is not bounded: it
/// ends when the server settles it or the session is torn down.
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
    /// Drives the `codex` binary found in an absolute `PATH` entry (on Windows including the
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
            let Some(program) = resolve_program(binary.clone()).await else {
                return Ok(ProbeReport {
                    available: false,
                    version: None,
                    detail: Some(format!(
                        "Codex CLI Not Found On PATH: No Absolute PATH Entry Holds {binary:?}"
                    )),
                });
            };
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
                Err(ProbeFailure::Spawn(error)) => ProbeReport {
                    available: true,
                    version,
                    detail: Some(format!(
                        "Sign-In State Unknown: `codex login status` Could Not Be Started: {error}"
                    )),
                },
                Err(ProbeFailure::TimedOut) => ProbeReport {
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
            // An empty working directory would make the child inherit
            // SWARM's own, and the sandbox's workspace would then be
            // wherever SWARM happens to run.
            let cwd_ok = std::path::Path::new(&spec.cwd).is_absolute()
                && tokio::fs::metadata(&spec.cwd)
                    .await
                    .is_ok_and(|meta| meta.is_dir());
            if !cwd_ok {
                return Err(AppError::Ai(format!(
                    "Agent Session Needs An Absolute, Existing Working Directory (Got {:?})",
                    spec.cwd
                )));
            }
            let tier = parse_trust_tier(spec.permission_mode.as_deref())?;
            let model = requested_model(spec.model.as_deref()).map(str::to_owned);
            let program = resolve_program(binary.clone()).await.ok_or_else(|| {
                AppError::Ai(format!(
                    "failed to spawn codex: No Absolute PATH Entry Holds {binary:?}"
                ))
            })?;
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
                spawn_piped(&program, &argv, &cwd, &child_env())
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
                teardown_cause: parking_lot::Mutex::new(None),
            });

            // From here on the child must never outlive a failed spawn —
            // including this future being dropped mid-handshake. Teardown
            // is quiet for a session that was never announced.
            let reap_on_drop = teardown_on_drop(&shared);

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
                    // An unacknowledged turn gets no `agent_turn_settled`, and teardown
                    // leaves `teardown_cause` in place while the slot is `Starting`,
                    // so this error is the only place the cause can surface. The
                    // lock is taken in its own statement so its !Send guard ends first.
                    let cause = shared.teardown_cause.lock().clone();
                    let detail = match cause {
                        Some(cause) => cause,
                        None => drained_stderr_snippet(&shared.stderr_tail).await,
                    };
                    return Err(AppError::Ipc(format!(
                        "codex session closed before acknowledging the turn ({detail})"
                    )));
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
