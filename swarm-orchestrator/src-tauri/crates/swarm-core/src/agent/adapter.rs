//! The adapter contract: one Rust trait pair every provider CLI
//! implements, so Claude Code, Codex, OpenCode, Gemini, and the
//! surviving webview path all land normalized `agent_*` events on the
//! same ordered spine (see `crate::events::emitter` for the event
//! family and `crate::orchestration` for the spine itself).
//!
//! ## Two traits: launch vs. live conversation
//!
//! [`AgentAdapter`] is the provider-level, stateless launcher — one
//! instance per provider, asked "what can you do" ([`AgentAdapter::capabilities`]),
//! "are you usable right now" ([`AgentAdapter::probe`]), and "start a
//! session" ([`AgentAdapter::spawn`]). [`AgentSession`] is the
//! per-worker, stateful handle to one live conversation — send a turn,
//! cancel it, answer a permission prompt, shut the process down.
//!
//! ## Why `Pin<Box<dyn Future<...> + Send>>`, not `impl Future`
//!
//! The plan's pseudocode writes trait methods as `-> impl Future<Output = ...>`
//! (return-position `impl Trait` in traits, RPITIT). That reads cleanly
//! but is not what ships: RPITIT methods make a trait **not
//! dyn-compatible** on stable Rust, and `AgentAdapter::spawn` must
//! return `Box<dyn AgentSession>` — a trait object — per the plan's own
//! signature. Every method on both traits here instead returns
//! [`BoxFuture`], a `Pin<Box<dyn Future<Output = T> + Send>>` alias —
//! exactly what the `async-trait` crate desugars an `async fn` in a
//! trait into, written by hand so this crate takes on no new
//! dependency. This preserves the plan's design intent (one trait pair,
//! object-safe, `Box<dyn AgentSession>` held in the worker registry)
//! while actually compiling.
//!
//! ## Capabilities honesty doctrine
//!
//! [`Capabilities`] exists so the UI can disable an affordance instead
//! of silently no-op'ing it when a provider structurally cannot do
//! something (OpenCode's HTTP/SSE transport has no stdin to interrupt;
//! `codex exec --json` has no mid-turn steering). Every field below is
//! backed by an empirical finding from the Phase 1 spike (claude CLI
//! 2.1.232, stream-json over piped stdio) — not an aspiration. A future
//! adapter that cannot honestly claim a capability MUST report `false`/
//! the honest variant rather than degrade the affordance silently
//! client-side.
//!
//! ## The three spike conditions this module exists to satisfy
//!
//! - **Condition A** (controlled config environment): out of scope for
//!   the trait shape itself, binding on `AgentSpawnSpec`'s eventual
//!   Phase 3 fields (per-profile config home / `--setting-sources`) —
//!   noted here so the spawn spec's Phase 3 extension doesn't forget it.
//! - **Condition B** (synthesize the terminal receipt on ungraceful
//!   exit): see [`AgentSession::shutdown`]'s doc.
//! - **Condition C** (never gate permissions on `allowedTools`): see
//!   [`PermissionDecision`]'s doc.

use std::future::Future;
use std::pin::Pin;

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::error::AppError;

/// A future boxed for storage behind a trait object — the hand-written
/// equivalent of what `#[async_trait]` generates, used throughout this
/// module so [`AgentAdapter`] and [`AgentSession`] stay dyn-compatible.
/// See the module doc's "Why `Pin<Box<dyn Future<...> + Send>>`" section.
pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// Provider-native session identifier — a Claude Code `session_id`
/// (UUID-shaped, but provider-owned, never SWARM-generated), a Codex
/// thread id, or whatever opaque handle the provider's own `--resume`
/// equivalent expects back. Never parsed or validated by SWARM; stored
/// and returned verbatim (see [`AgentSession::session_key`]'s doc and
/// the "Session state" table in the multi-provider plan: the provider
/// CLI owns the conversation, SWARM stores only this opaque key + cwd).
pub type SessionKey = String;

/// Correlation id for one turn within a session. Provider-scoped and
/// opaque to SWARM — some providers may hand back their own turn/item
/// id; SWARM does not require it to be a UUID.
pub type TurnId = String;

/// Correlation id for one outstanding permission request within a
/// turn. Opaque, provider- or SWARM-generated depending on the
/// provider's protocol shape.
pub type PermissionId = String;

/// Which provider CLI a worker is driven by.
///
/// A closed, typed enum — not a bare string — following the
/// [`crate::events::InputSource`] precedent for wire enums: an unknown
/// or misspelled provider value fails IPC/event deserialization
/// outright rather than silently coercing into some default. Wire form
/// is `snake_case` (`"claude_code"`, `"webview_anthropic"`, ...),
/// matching every other closed-set enum in this codebase.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProviderId {
    /// `claude` CLI, `stream-json` over piped stdio (the Phase 1 spike
    /// target; Phase 3's first real adapter).
    ClaudeCode,
    /// `codex app-server` (JSON-RPC/stdio) or `codex exec --json`
    /// fallback (Phase 4).
    Codex,
    /// `opencode serve` over HTTP + SSE (Phase 4 stretch).
    OpenCode,
    /// Gemini CLI over native ACP — the honest place to prove ACP as a
    /// transport, since ACP reaches Claude Code only through a
    /// third-party Node adapter (Phase 4).
    Gemini,
    /// "Provider #0" — the existing webview-direct `@anthropic-ai/sdk`
    /// chat path (`src/lib/anthropic.ts`). Cannot implement
    /// [`AgentSession`] (it lives in TypeScript, not Rust); joins the
    /// same event family via a narrow ingest command instead (Phase 5).
    WebviewAnthropic,
}

/// How precisely an adapter can target a cancel at one in-flight turn.
///
/// **Empirical finding (Phase 1 spike, Gate 3):** cancel latency was
/// 43ms via `kill()` — well inside the ≤500ms gate — but **stdin-close
/// is NOT a cancel** (the child runs the turn to completion regardless),
/// and on Windows, `kill()` is `TerminateProcess` with no graceful
/// signal path at all (no `SIGTERM` equivalent for a piped child).
/// `KillOnly` is therefore the honest default capability for every
/// piped-stdio provider until a provider ships a real mid-turn cancel
/// protocol message.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CancelGranularity {
    /// The only lever available is killing the whole child process —
    /// coarse, but fast (43ms measured) and reliable.
    KillOnly,
    /// The provider's own protocol has a real in-band cancel message
    /// (e.g. a JSON-RPC cancel notification) that stops the turn
    /// without tearing down the session/process.
    Graceful,
}

/// What a provider adapter can honestly promise. See the module doc's
/// "Capabilities honesty doctrine" — every field traces to a spike
/// finding, not an aspiration.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Capabilities {
    /// Streams sub-message deltas at all (as opposed to only ever
    /// handing back one whole-message terminal block). **Empirical
    /// finding (Gate 2): PASS, but sentence-clause granularity** — 4-6
    /// deltas per response, ~100-230 chars each, on
    /// `--include-partial-messages`. Chunkier than the webview SDK's
    /// token-level streaming; disclosed, not hidden, in the UI when
    /// `true`.
    pub partial_deltas: bool,
    /// The provider can resume a prior conversation by session key
    /// (Claude Code's `--resume`/`--session-id`/`--fork-session`).
    /// **Empirical finding: PASS** — context, including tool results
    /// from an error-terminated turn, carried across invocations by
    /// session id.
    pub resume: bool,
    /// The provider's own terminal receipt carries a real
    /// dollar-denominated cost (`total_cost_usd`), not a client-side
    /// token-count estimate. **Empirical finding (Gate 6): PASS** on
    /// every clean exit — `total_cost_usd` always present, `modelUsage`
    /// breakdown included. **Killed turns lose cost data** (no `result`
    /// line on an ungraceful exit) — see [`AgentSession::shutdown`]'s
    /// Condition B doc.
    pub native_cost: bool,
    /// Named permission modes this provider's `AgentSpawnSpec` accepts
    /// (Claude Code: `default`/`acceptEdits`/`plan`/`auto`/`dontAsk`/
    /// `bypassPermissions`/`manual`). Free-form strings, not a shared
    /// closed enum, because providers do not agree on names. **Flag
    /// drift note:** `"default"` is not itself a selectable
    /// `--permission-mode` value — it is the implicit state when the
    /// flag is omitted.
    pub permission_modes: Vec<String>,
    /// How precisely this adapter can target a cancel — see
    /// [`CancelGranularity`].
    pub cancel_granularity: CancelGranularity,
    /// Whether a turn can be steered mid-flight (a follow-up message
    /// injected while the provider is still working), as opposed to
    /// only ever being queued for the *next* turn. Drives the frontend
    /// label choice per the plan: "Inject Instruction" when `true`,
    /// "Queue Next Turn" when `false` — the label follows the
    /// capability flag rather than every provider getting the same
    /// affordance regardless of whether it can actually honor it.
    pub interrupt_midturn: bool,
    /// The adapter can be pointed at an arbitrary worktree `cwd`
    /// (`--add-dir` or equivalent) rather than requiring the CLI's own
    /// ambient working directory.
    pub worktree_aware: bool,
}

/// Result of [`AgentAdapter::probe`] — "is this provider usable right
/// now," checked before a spawn is attempted rather than discovered as
/// a spawn failure. Auth is never SWARM's to store (see the plan's Auth
/// table): a probe reports what it observed, never a credential.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProbeReport {
    /// The provider CLI was found and responded (e.g. `--version`
    /// succeeded). `false` covers "binary not on PATH" and "binary
    /// present but not authenticated" alike — [`Self::detail`] carries
    /// the distinction for display.
    pub available: bool,
    /// Provider CLI version string, when determinable. Exact-pin
    /// discipline (per the plan's protocol-churn hedge) starts with
    /// knowing what's actually installed.
    pub version: Option<String>,
    /// Human-readable detail for the "Not Signed In" / "Not Installed"
    /// worker-state surface (Phase 3 UI) — never a secret, never a raw
    /// credential-adjacent error string.
    pub detail: Option<String>,
}

/// Everything [`AgentAdapter::spawn`] needs to start one session.
///
/// `resume` is `Some` to rehydrate an existing conversation
/// (`--resume`/equivalent) and `None` to start fresh, in which case the
/// adapter mints its own new [`SessionKey`] (for Claude Code, SWARM's
/// worker UUID itself becomes the `--session-id`, per the plan).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSpawnSpec {
    /// UUID of the SWARM worker this session belongs to — the SUBJECT
    /// stamped on every `agent_*` event this session produces.
    pub worker_id: Uuid,
    /// Working directory the provider process should run in — a
    /// worker's worktree path when isolated, matching
    /// [`Capabilities::worktree_aware`].
    pub cwd: String,
    /// Model alias/id to request, when the provider supports selecting
    /// one. `None` defers to the provider's own default.
    #[serde(default)]
    pub model: Option<String>,
    /// Resume an existing session by its provider-native key, instead
    /// of starting a fresh conversation.
    #[serde(default)]
    pub resume: Option<SessionKey>,
    /// Named permission mode to request, when the provider supports
    /// one (see [`Capabilities::permission_modes`]). `None` defers to
    /// the provider's implicit default.
    #[serde(default)]
    pub permission_mode: Option<String>,
}

/// One turn's input. Deliberately minimal in Phase 2 — Phase 3's
/// `ClaudeCodeAdapter` extends this with attachments/tool config as the
/// concrete protocol demands; the scheduler and trait boundary need
/// only a stable, provider-agnostic shape to compile and be tested
/// against today.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnInput {
    /// The user-authored (or tool-injected) prompt text for this turn.
    pub prompt: String,
}

/// A human's (or a policy's) answer to one [`crate::events::emitter::AgentPermissionRequestPayload`].
///
/// # Condition C (BINDING): never gate on `allowedTools`
///
/// **Empirical finding (Phase 1 spike, Gate 5 side finding):**
/// `--allowedTools Read` did **not** prevent a `Bash` tool from
/// executing in `-p` mode. `allowedTools` is an **auto-approve list**,
/// not a restriction — passing it widens what runs without a prompt, it
/// does not narrow what is permitted to run. Any adapter's permission
/// gating MUST rest on `--permission-mode`/`disallowedTools`/hooks (or
/// the provider's real equivalent), NEVER on an "allowed" list read as
/// if it were a denylist's complement. A `PermissionDecision::Deny`
/// only means something if the adapter's spawn configuration already
/// routes the tool through a real gate — this type cannot enforce that
/// on its own, and Phase 3's `ClaudeCodeAdapter` entry criterion is an
/// empirical test proving its chosen gate actually blocks a denied
/// tool, not just documents the intent.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PermissionDecision {
    /// Allow the requested tool call to proceed.
    Allow,
    /// Deny the requested tool call.
    Deny,
}

/// How a session's underlying process ended, returned by
/// [`AgentSession::shutdown`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExitSummary {
    /// Process exit code, when the OS reports one.
    pub exit_code: Option<i32>,
    /// Signal name that terminated the process, when applicable
    /// (never populated on Windows — see
    /// [`CancelGranularity::KillOnly`]'s doc on `TerminateProcess`
    /// having no signal concept).
    pub signal: Option<String>,
}

/// Provider-level launcher: what a provider can do, whether it's
/// usable right now, and how to start a new live session. One instance
/// per provider (see [`ProviderId`]), held for the app's lifetime —
/// contrast with [`AgentSession`], one instance per live worker
/// conversation.
///
/// See the module doc for why every method returns [`BoxFuture`]
/// instead of the plan pseudocode's `impl Future`.
pub trait AgentAdapter: Send + Sync {
    /// Which provider this adapter drives.
    fn provider(&self) -> ProviderId;

    /// What this adapter can honestly promise — see the "Capabilities
    /// honesty doctrine" in the module doc. Synchronous: capability
    /// support is a static fact about the adapter's implementation, not
    /// something that requires I/O to learn (unlike [`Self::probe`],
    /// which checks runtime availability).
    fn capabilities(&self) -> Capabilities;

    /// Checks whether the provider CLI is installed, on `PATH`, and
    /// authenticated enough to be worth spawning. Never stores or
    /// returns a credential (see the plan's Auth table: "Detect and
    /// report, never store").
    fn probe(&self) -> BoxFuture<'_, Result<ProbeReport, AppError>>;

    /// Starts a new live session (or resumes one, per
    /// `spec.resume`) and returns a boxed, type-erased handle to it.
    /// The returned session outlives this call — every subsequent turn
    /// goes through the handle, not back through the adapter.
    fn spawn(&self, spec: AgentSpawnSpec)
    -> BoxFuture<'_, Result<Box<dyn AgentSession>, AppError>>;
}

/// Per-worker, stateful handle to one live provider conversation.
/// Returned by [`AgentAdapter::spawn`], held by the worker registry
/// (Phase 3) for the session's lifetime.
///
/// See the "Session state — three owners, no mirroring" table in the
/// multi-provider plan: an `AgentSession` impl stores only what it
/// needs to keep the child process and protocol state alive (stdin
/// writer, pending permissions, current turn) — it never mirrors the
/// conversation transcript. The transcript lives in the provider CLI's
/// own memory (recoverable via [`Self::session_key`] + `resume`) and,
/// normalized, in the ordered event log (`agent_block` rows) — never a
/// third copy in this struct.
pub trait AgentSession: Send + Sync {
    /// This session's provider-native identifier (see [`SessionKey`]'s
    /// doc). Stable for the session's lifetime.
    fn session_key(&self) -> &SessionKey;

    /// Sends one turn and returns its [`TurnId`] once the provider has
    /// accepted it (not once it has *completed* — completion is
    /// reported asynchronously via `agent_turn_settled`, see
    /// [`crate::events::emitter::AgentTurnSettledPayload`]).
    fn send_turn(&self, turn: TurnInput) -> BoxFuture<'_, Result<TurnId, AppError>>;

    /// Cancels an in-flight turn, honoring
    /// [`Capabilities::cancel_granularity`] — `KillOnly` adapters tear
    /// down the whole process (see [`Self::shutdown`]'s Condition B
    /// note on what that means for the terminal receipt); `Graceful`
    /// adapters send the provider's real in-band cancel instead.
    fn cancel(&self, turn: TurnId) -> BoxFuture<'_, Result<(), AppError>>;

    /// Answers a pending `agent_permission_request` by `req`'s id. See
    /// [`PermissionDecision`]'s Condition C doc — the gate this
    /// resolves must be a real one, not an `allowedTools` list.
    fn respond_permission(
        &self,
        req: PermissionId,
        decision: PermissionDecision,
    ) -> BoxFuture<'_, Result<(), AppError>>;

    /// Tears the session down (graceful stop if the provider supports
    /// one, kill otherwise) and returns how the process ended.
    ///
    /// # Condition B (BINDING): synthesize the terminal receipt on
    /// ungraceful exit
    ///
    /// **Empirical finding (Phase 1 spike, Gate 4):** exactly one
    /// terminal event on every clean exit, including `max-turns`
    /// errors — but **ZERO terminal events on process kill**. A caller
    /// mid-turn when the child is killed (crash, `kill -9`, an app
    /// shutdown racing a live turn) would otherwise wait forever for an
    /// `agent_turn_settled` that never arrives. Every implementation of
    /// this method MUST itself emit a synthesized `agent_turn_settled`
    /// (`status: "error"`) for any turn still in flight when the
    /// process exits ungracefully — the same pattern
    /// `ai_stream_settled` already established for the webview path's
    /// error branch (`AiClient::stream_message`'s doc). **Killed turns
    /// lose cost data** (no `result` line to read `total_cost_usd`
    /// from) — the synthesized settlement's `costUsd`/`usage` are
    /// `None`, honestly, not a fabricated estimate.
    fn shutdown(self: Box<Self>) -> BoxFuture<'static, Result<ExitSummary, AppError>>;
}
#[cfg(test)]
mod tests {
    use super::*;
    use crate::events::{
        AgentBlockPayload, AgentSessionExitedPayload, AgentSessionStartedPayload, SwarmEvent,
    };
    use crate::orchestration::{EventLog, OrchestrationEngine};

    /// An adapter/session pair proving the trait contract compiles and
    /// is object-safe (`spawn` returns a real `Box<dyn AgentSession>`),
    /// and driving a full session lifecycle — spawn → turn → deltas →
    /// settled → shutdown — through a LIVE `OrchestrationEngine`, the
    /// same integration depth `agent_turn_started`'s own live-engine
    /// test uses (`orchestration::engine`'s
    /// `test_agent_turn_started_mechanism_returns_a_real_seq_through_a_live_engine`).
    struct MockAdapter {
        sink: crate::events::EventSink,
    }

    impl AgentAdapter for MockAdapter {
        fn provider(&self) -> ProviderId {
            ProviderId::ClaudeCode
        }

        fn capabilities(&self) -> Capabilities {
            Capabilities {
                partial_deltas: true,
                resume: true,
                native_cost: true,
                permission_modes: vec!["default".to_string()],
                cancel_granularity: CancelGranularity::KillOnly,
                interrupt_midturn: false,
                worktree_aware: true,
            }
        }

        fn probe(&self) -> BoxFuture<'_, Result<ProbeReport, AppError>> {
            Box::pin(async {
                Ok(ProbeReport {
                    available: true,
                    version: Some("2.1.232".to_string()),
                    detail: None,
                })
            })
        }

        fn spawn(
            &self,
            spec: AgentSpawnSpec,
        ) -> BoxFuture<'_, Result<Box<dyn AgentSession>, AppError>> {
            let sink = self.sink.clone();
            let capabilities = self.capabilities();
            Box::pin(async move {
                let session_key: SessionKey = Uuid::new_v4().to_string();
                sink.emit(SwarmEvent::AgentSessionStarted(
                    AgentSessionStartedPayload {
                        worker_id: spec.worker_id,
                        provider: ProviderId::ClaudeCode,
                        session_key: session_key.clone(),
                        model: spec
                            .model
                            .clone()
                            .unwrap_or_else(|| "mock-model".to_string()),
                        cwd: spec.cwd.clone(),
                        capabilities,
                    },
                ));
                Ok(Box::new(MockAgentSession {
                    sink,
                    worker_id: spec.worker_id,
                    session_key,
                }) as Box<dyn AgentSession>)
            })
        }
    }

    struct MockAgentSession {
        sink: crate::events::EventSink,
        worker_id: Uuid,
        session_key: SessionKey,
    }

    impl AgentSession for MockAgentSession {
        fn session_key(&self) -> &SessionKey {
            &self.session_key
        }

        fn send_turn(&self, turn: TurnInput) -> BoxFuture<'_, Result<TurnId, AppError>> {
            let sink = self.sink.clone();
            let worker_id = self.worker_id;
            Box::pin(async move {
                let turn_id: TurnId = Uuid::new_v4().to_string();
                sink.emit(SwarmEvent::AgentTurnDelta(
                    crate::events::AgentTurnDeltaPayload {
                        worker_id,
                        turn_id: turn_id.clone(),
                        block_index: 0,
                        kind: "text".to_string(),
                        text: turn.prompt.clone(),
                    },
                ));
                sink.emit(SwarmEvent::AgentBlock(AgentBlockPayload {
                    worker_id,
                    turn_id: turn_id.clone(),
                    block_index: 0,
                    kind: "text".to_string(),
                    content: serde_json::json!({ "text": turn.prompt }),
                }));
                sink.emit(SwarmEvent::AgentTurnSettled(
                    crate::events::AgentTurnSettledPayload {
                        worker_id,
                        turn_id: turn_id.clone(),
                        status: "ok".to_string(),
                        error: None,
                        cost_usd: Some(0.001),
                        usage: None,
                        duration_ms: 12,
                        num_turns: Some(1),
                    },
                ));
                Ok(turn_id)
            })
        }

        fn cancel(&self, _turn: TurnId) -> BoxFuture<'_, Result<(), AppError>> {
            Box::pin(async { Ok(()) })
        }

        fn respond_permission(
            &self,
            _req: PermissionId,
            _decision: PermissionDecision,
        ) -> BoxFuture<'_, Result<(), AppError>> {
            Box::pin(async { Ok(()) })
        }

        fn shutdown(self: Box<Self>) -> BoxFuture<'static, Result<ExitSummary, AppError>> {
            Box::pin(async move {
                // Awaiting the ack here (rather than a bare `emit`) is
                // the test's ordering guarantee: `std::sync::mpsc` is
                // FIFO single-consumer, so by the time this ack
                // resolves, every earlier `emit` from this session
                // (spawn's AgentSessionStarted, send_turn's delta/
                // block/settled) has already been processed and
                // persisted by the single writer thread.
                let ack = self.sink.emit_awaiting_seq(
                    SwarmEvent::AgentSessionExited(AgentSessionExitedPayload {
                        worker_id: self.worker_id,
                        exit_code: Some(0),
                        signal: None,
                    }),
                    crate::events::Provenance::default(),
                );
                let _ = ack.await;
                Ok(ExitSummary {
                    exit_code: Some(0),
                    signal: None,
                })
            })
        }
    }

    /// DIRECTIVE: proves both the trait contract compiles as a real
    /// `Box<dyn AgentSession>` object (`spawn`'s return type) AND that
    /// a full session lifecycle drives the `agent_*` family through a
    /// live engine with the correct persistence class for each variant
    /// — `agent_turn_delta` absent from the persisted rows,
    /// everything else present, in emission order.
    #[tokio::test]
    async fn test_mock_adapter_session_lifecycle_drives_agent_event_family_through_live_engine() {
        let db_path =
            std::env::temp_dir().join(format!("swarm-agent-lifecycle-{}.db", Uuid::new_v4()));
        let log = EventLog::open(&db_path).expect("open file-backed log");
        let engine = OrchestrationEngine::start(log, Some(db_path.clone()), |_| {});
        let sink = engine.sink();

        let adapter = MockAdapter { sink: sink.clone() };
        let worker_id = Uuid::new_v4();

        let session = adapter
            .spawn(AgentSpawnSpec {
                worker_id,
                cwd: "/tmp/worktree".to_string(),
                model: Some("mock-model".to_string()),
                resume: None,
                permission_mode: None,
            })
            .await
            .expect("spawn should succeed");

        assert!(!session.session_key().is_empty());

        let turn_id = session
            .send_turn(TurnInput {
                prompt: "hello".to_string(),
            })
            .await
            .expect("send_turn should succeed");
        assert!(!turn_id.is_empty());

        let summary = session.shutdown().await.expect("shutdown should succeed");
        assert_eq!(summary.exit_code, Some(0));

        // Reopen the log from disk — everything the writer thread
        // persisted (and only that) must be there.
        let verify_log = EventLog::open(&db_path).expect("reopen log");
        let events = verify_log.events_since(0, 100).expect("read events");
        let types: Vec<&str> = events.iter().map(|e| e.event_type.as_str()).collect();

        assert_eq!(
            types,
            vec![
                "agent_session_started",
                "agent_block",
                "agent_turn_settled",
                "agent_session_exited",
            ],
            "agent_turn_delta must be absent (ephemeral); every other \
             variant persists in emission order, got: {types:?}"
        );

        std::fs::remove_file(&db_path).ok();
        std::fs::remove_file(format!("{}-wal", db_path.display())).ok();
        std::fs::remove_file(format!("{}-shm", db_path.display())).ok();
    }
}
