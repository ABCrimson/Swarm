//! The adapter contract: one Rust trait pair every provider CLI
//! implements, so Claude Code, Codex, and any later provider land
//! normalized `agent_*` events on the same ordered spine (see
//! `crate::events::emitter` for the event family and
//! `crate::orchestration` for the spine itself). The webview chat path
//! (`src/lib/anthropic.ts`) lives in TypeScript and does not implement
//! these traits.
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
//! ## Why [`BoxFuture`], not `async fn`
//!
//! [`AgentSession`] must stay dyn-compatible: the registry holds every
//! live session as `Arc<dyn AgentSession>`, and an `async fn` or a
//! return-position `impl Future` makes a trait non-dyn-compatible (the
//! nightly `async_fn_in_dyn_trait` feature is still incomplete). Its
//! methods therefore return [`BoxFuture`], the same
//! `Pin<Box<dyn Future + Send>>` `#[async_trait]` would generate,
//! written by hand so the crate needs no macro dependency.
//! [`AgentAdapter`] is only ever used through concrete types and could
//! take native `async fn`; it keeps [`BoxFuture`] so both traits share
//! one shape and every implementation in the workspace (test mocks
//! included) stays source-compatible.
//!
//! ## Capabilities honesty doctrine
//!
//! [`Capabilities`] exists so the UI can disable an affordance instead
//! of silently no-op'ing it when a provider structurally cannot do
//! something. Every field an adapter reports must be backed by the
//! provider's verified behavior, not an aspiration: an adapter that
//! cannot honestly claim a capability reports `false` (or the honest
//! variant) rather than letting the affordance degrade silently in the
//! client.
//!
//! ## The three conditions every adapter satisfies
//!
//! Measured against `claude` 2.1.232 when the adapter layer was
//! designed, and binding on every provider since:
//!
//! - **Condition A** (controlled config environment): a worker's
//!   provider CLI runs with a configuration SWARM controls, never the
//!   operator's personal plugins, hooks or MCP servers. Each adapter
//!   enforces it at spawn (Claude Code: `--setting-sources project`,
//!   `--strict-mcp-config` and inline `--settings`).
//! - **Condition B** (synthesize the terminal receipt on ungraceful
//!   exit): see [`AgentSession::shutdown`]'s doc.
//! - **Condition C** (never gate permissions on `allowedTools`): see
//!   [`PermissionDecision`]'s doc.

use std::pin::Pin;

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::error::AppError;

/// A future boxed for storage behind a trait object — the hand-written
/// equivalent of what `#[async_trait]` generates. See the module doc's
/// "Why [`BoxFuture`], not `async fn`" section.
pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// Provider-native session identifier — a Claude Code `session_id`
/// (UUID-shaped, but provider-owned, never SWARM-generated), a Codex
/// thread id, or whatever opaque handle the provider's own `--resume`
/// equivalent expects back. Never parsed or validated by SWARM; stored
/// and returned verbatim (see [`AgentSession::session_key`]'s doc): the
/// provider CLI owns the conversation, SWARM stores only this opaque key
/// and the cwd.
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
    /// `claude` CLI, `stream-json` over piped stdio
    /// (`crate::agent::claude_code`).
    ClaudeCode,
    /// `codex app-server`, JSON-RPC 2.0 over piped stdio
    /// (`crate::agent::codex`).
    Codex,
    /// `opencode serve` over HTTP + SSE. Reserved: no adapter yet.
    OpenCode,
    /// Gemini CLI over ACP. Reserved: no adapter yet.
    Gemini,
    /// The webview-direct `@anthropic-ai/sdk` chat path
    /// (`src/lib/anthropic.ts`). It lives in TypeScript, so it cannot
    /// implement [`AgentSession`]. Reserved for tagging that path.
    WebviewAnthropic,
}

/// How precisely an adapter can target a cancel at one in-flight turn.
///
/// Closing a provider's stdin is not a cancel (the child finishes the
/// turn regardless), and on Windows `kill()` is `TerminateProcess`,
/// with no graceful signal for a piped child. A provider without an
/// in-band cancel message is therefore `KillOnly` (a kill took 43ms on
/// `claude` 2.1.232). Claude Code's `interrupt` control request makes
/// it `Graceful`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CancelGranularity {
    /// The only lever available is killing the whole child process —
    /// coarse, but fast and reliable; the live session is gone after.
    KillOnly,
    /// The provider's own protocol has a real in-band cancel message
    /// (Claude Code's `interrupt` control request, say) that stops the
    /// turn without tearing down the session or the process.
    Graceful,
}

/// What a provider adapter can honestly promise. See the module doc's
/// "Capabilities honesty doctrine".
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Capabilities {
    /// Streams sub-message deltas at all (as opposed to only ever
    /// handing back one whole-message terminal block). Delta size is the
    /// provider's: Claude Code's `--include-partial-messages` streamed
    /// sentence-clause chunks (4-6 per response) on 2.1.232, coarser
    /// than the webview SDK's token-level stream.
    pub partial_deltas: bool,
    /// The provider can resume a prior conversation by session key
    /// ([`AgentSpawnSpec::resume`]; Claude Code's `--resume`), context
    /// and tool results of error-terminated turns included.
    pub resume: bool,
    /// The provider's own terminal receipt carries a real
    /// dollar-denominated cost (Claude Code's `total_cost_usd`), not a
    /// client-side token-count estimate. Killed turns lose cost data (no
    /// receipt on an ungraceful exit) — see [`AgentSession::shutdown`]'s
    /// Condition B doc.
    pub native_cost: bool,
    /// Every value [`AgentSpawnSpec::permission_mode`] accepts for this
    /// provider: SWARM's trust-tier tokens (`"restricted"`,
    /// `"standard"`, `"write_enabled"` for both Claude Code and Codex),
    /// never a provider's raw mode names. Free-form strings rather than
    /// a shared enum, because providers need not offer the same tiers.
    pub permission_modes: Vec<String>,
    /// How precisely this adapter can target a cancel — see
    /// [`CancelGranularity`].
    pub cancel_granularity: CancelGranularity,
    /// Whether a turn can be steered mid-flight (a follow-up message
    /// injected while the provider is still working), as opposed to
    /// only ever being queued for the *next* turn. The chat's busy-state
    /// button follows it: "Interrupt" when `true`, "Queue Next Turn"
    /// when `false`.
    pub interrupt_midturn: bool,
    /// The adapter runs the provider in an arbitrary worktree
    /// ([`AgentSpawnSpec::cwd`] becomes the child's working directory)
    /// rather than requiring the CLI's own ambient one.
    pub worktree_aware: bool,
    /// The provider's protocol supports a real `agent_permission_request`
    /// -> [`AgentSession::respond_permission`] round trip: the provider
    /// blocks on a pending question until the session answers it on the
    /// wire (Claude Code's `can_use_tool` control request, Codex's
    /// JSON-RPC approval request). A request whose `suggestedDecision`
    /// is set reports a decision already made and needs no answer. UI
    /// affordances (Allow/Deny buttons instead of a read-only notice)
    /// MUST branch on this flag and on `suggestedDecision`.
    pub interactive_permissions: bool,
}

/// Result of [`AgentAdapter::probe`] — "is this provider usable right
/// now," checked before a spawn is attempted rather than discovered as
/// a spawn failure. Auth is never SWARM's to store: a probe reports what
/// it observed, never a credential.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProbeReport {
    /// The provider CLI was found, responded, and can authenticate.
    /// `false` covers "not on PATH", "too old" and "not signed in"
    /// alike — [`Self::detail`] carries the distinction for display.
    pub available: bool,
    /// Provider CLI version string, when determinable.
    pub version: Option<String>,
    /// Human-readable, Title Case detail for the worker-state surface
    /// ("Claude Code CLI Not Signed In", "Signed In (Claude Max)") —
    /// never a secret or an account identifier.
    pub detail: Option<String>,
}

/// Everything [`AgentAdapter::spawn`] needs to start one session.
///
/// `resume` is `Some` to rehydrate an existing conversation
/// (`--resume`/equivalent) and `None` to start fresh, in which case the
/// adapter mints its own new [`SessionKey`] (for Claude Code, the
/// worker's UUID itself becomes the `--session-id`).
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
    /// Trust tier to run under, one of [`Capabilities::permission_modes`].
    /// `None` selects the adapter's default tier; any value outside that
    /// list fails the spawn closed.
    #[serde(default)]
    pub permission_mode: Option<String>,
}

/// One turn's input: the provider-agnostic shape the scheduler and every
/// adapter share. Tool configuration is fixed per session at spawn, not
/// per turn.
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
/// Measured on `claude` 2.1.232: `--allowedTools Read` did **not**
/// prevent a `Bash` call in `-p` mode. `allowedTools` is an
/// **auto-approve list**, not a restriction — it widens what runs
/// without a prompt, it does not narrow what may run. Any adapter's
/// permission gating MUST rest on the permission mode, a deny list,
/// hooks or the provider's host-answered permission requests, NEVER on
/// an "allowed" list read as a denylist's complement. A
/// `PermissionDecision::Deny` only means something if the adapter's
/// spawn configuration routes the tool through such a gate; this type
/// cannot enforce that on its own.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PermissionDecision {
    /// Allow the requested tool call to proceed.
    Allow,
    /// Deny the requested tool call.
    Deny,
}

/// How a session's underlying process ended, returned by
/// [`AgentSession::shutdown`]. `shutdown` is idempotent, so this same
/// value is what every call after the first one returns too — see its
/// doc.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExitSummary {
    /// Process exit code, when the OS reports one.
    pub exit_code: Option<i32>,
    /// Signal that terminated the process (`"SIGKILL"`, ...), on Unix.
    /// Never populated on Windows, where `TerminateProcess` sets an exit
    /// code instead.
    pub signal: Option<String>,
}

/// Closed, typed terminal status for a settled agent turn. Wire form is
/// `snake_case` (`"ok"`, `"error"`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentTurnStatus {
    /// The turn completed normally.
    Ok,
    /// The turn failed — includes both a provider-reported failure and
    /// a synthesized settlement on ungraceful child exit (Condition B).
    Error,
}

/// Provider-level launcher: what a provider can do, whether it's
/// usable right now, and how to start a new live session. One instance
/// per provider (see [`ProviderId`]), held for the app's lifetime —
/// contrast with [`AgentSession`], one instance per live worker
/// conversation.
///
/// See the module doc for why every method returns [`BoxFuture`].
pub trait AgentAdapter: Send + Sync {
    /// Which provider this adapter drives.
    fn provider(&self) -> ProviderId;

    /// What this adapter can honestly promise (`partial_deltas`, `resume`,
    /// `native_cost`, `permission_modes`, `cancel_granularity`,
    /// `interrupt_midturn`, `worktree_aware`, `interactive_permissions`) —
    /// see the "Capabilities honesty doctrine" in the module doc.
    /// Synchronous: capability support is a static fact about the
    /// adapter's implementation, not something that requires I/O to learn
    /// (unlike [`Self::probe`], which checks runtime availability).
    fn capabilities(&self) -> Capabilities;

    /// Checks whether the provider CLI is installed, on `PATH`, and
    /// authenticated enough to be worth spawning. Detects and reports;
    /// never stores or returns a credential.
    fn probe(&self) -> BoxFuture<'_, Result<ProbeReport, AppError>>;

    /// Starts a new live session (or resumes one, per
    /// `spec.resume`) and returns a boxed, type-erased handle to it.
    /// The returned session outlives this call — every subsequent turn
    /// goes through the handle, not back through the adapter.
    fn spawn(&self, spec: AgentSpawnSpec)
    -> BoxFuture<'_, Result<Box<dyn AgentSession>, AppError>>;
}

/// Per-worker, stateful handle to one live provider conversation.
/// Returned by [`AgentAdapter::spawn`], held by
/// [`crate::agent::registry::AgentSessionRegistry`] for the session's
/// lifetime.
///
/// Session state has three owners and no mirroring: an `AgentSession`
/// impl stores only what it needs to keep the child process and the
/// protocol state alive (stdin writer, pending permissions, current
/// turn) — it never mirrors the conversation transcript. The
/// transcript lives in the provider CLI's own memory (recoverable via
/// [`Self::session_key`] + `resume`) and, normalized, in the ordered
/// event log (`agent_block` rows) — never a third copy in this struct.
///
/// # Concurrency contract (BINDING — every implementation must honor this)
///
/// - **One turn in flight at a time; sessions never queue.**
///   [`Self::send_turn`] called while a turn is already in flight on
///   this session MUST return [`AppError::AgentSessionBusy`] rather
///   than block, overwrite, or interleave the new turn with the
///   running one. Turn-level queueing ACROSS turns (deciding which of
///   several pending turns for several sessions gets to run next, and
///   how many run at once) is
///   [`crate::agent::scheduler::AgentScheduler`]'s job — a session that
///   also queued internally would duplicate that logic and let the two
///   layers disagree about ordering. Callers that want a turn queued
///   rather than rejected go through the scheduler.
/// - **[`Self::cancel`] may race [`Self::send_turn`]/[`Self::shutdown`]
///   safely.** A cancel arriving after its turn already settled
///   naturally, or concurrently with a [`Self::shutdown`] tearing the
///   process down, is an ORDINARY outcome an implementation must
///   handle gracefully (e.g. by no-op'ing once there is nothing left
///   to cancel) — never a panic, and never left to corrupt internal
///   state.
/// - **No internal lock may be held across an `.await` point.** Every
///   method here returns a boxed future; if an implementation's state
///   lives behind a `Mutex`/`RwLock`, the guard must be dropped before
///   yielding, not carried across an `.await` — holding one across an
///   await is exactly the shape that would deadlock [`Self::cancel`]
///   racing [`Self::send_turn`] under the rule above.
/// - **Condition B, restated as a hard invariant on this trait:** a
///   turn that is in-flight when [`Self::shutdown`] is called (or the
///   child process dies out from under the session on its own) MUST
///   still produce **exactly one** `agent_turn_settled` for that turn —
///   synthesized by the session itself when the provider never sent
///   its own terminal receipt. Never zero (nothing may wait forever for
///   a receipt that never arrives) and never two (a provider's own
///   late-arriving receipt must not race the synthesized one into a
///   double settlement) — see [`Self::shutdown`]'s doc for the
///   mechanics.
pub trait AgentSession: Send + Sync {
    /// This session's provider-native identifier (see [`SessionKey`]'s
    /// doc). Stable for the session's lifetime.
    fn session_key(&self) -> &SessionKey;

    /// Sends one turn and returns its [`TurnId`] once the provider has
    /// accepted it (not once it has *completed* — completion is
    /// reported asynchronously via `agent_turn_settled`, see
    /// [`crate::events::emitter::AgentTurnSettledPayload`]).
    ///
    /// Returns [`AppError::AgentSessionBusy`] if a turn is already in
    /// flight on this session — see the trait's concurrency contract
    /// above. Never queues internally.
    fn send_turn(&self, turn: TurnInput) -> BoxFuture<'_, Result<TurnId, AppError>>;

    /// Resolves once `turn` reaches a terminal settlement — the SAME
    /// settlement `agent_turn_settled` reports, whether the provider
    /// produced it naturally or it was synthesized on ungraceful exit
    /// (Condition B, [`Self::shutdown`]'s doc). The scheduler holds a
    /// turn's concurrency permit until this resolves: `send_turn`
    /// resolving only proves the provider ACCEPTED the turn, not that
    /// executing it is finished.
    ///
    /// **MUST NOT hang past this session's own death.** If the session
    /// is torn down (via [`Self::shutdown`]) before `turn` ever
    /// settles — including a `turn` id that never existed, e.g. a
    /// caller racing a rejected [`Self::send_turn`] — this resolves
    /// `Ok(())` anyway rather than waiting for an event that can no
    /// longer arrive. A caller that wants to distinguish "settled
    /// successfully" from "session died before this turn settled"
    /// reads the persisted `agent_turn_settled`/`agent_session_exited`
    /// rows for the real answer; this method's contract is purely
    /// "stop blocking," not "tell you how it went."
    fn await_turn_completion(&self, turn: TurnId) -> BoxFuture<'_, Result<(), AppError>>;

    /// Cancels an in-flight turn, honoring
    /// [`Capabilities::cancel_granularity`] — `KillOnly` adapters tear
    /// down the whole process (see [`Self::shutdown`]'s Condition B
    /// note on what that means for the terminal receipt); `Graceful`
    /// adapters send the provider's real in-band cancel instead, and may
    /// still fall back to a kill when the provider does not honor it. May
    /// race [`Self::send_turn`]/[`Self::shutdown`] safely — see the
    /// trait's concurrency contract above.
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
    /// **Idempotent.** A second (or Nth) call MUST NOT re-kill an
    /// already-dead process, error out, or re-emit any event — it
    /// returns the SAME [`ExitSummary`] the first call produced (an
    /// implementation typically caches it behind interior mutability
    /// the first time through). This, together with taking `&self`
    /// rather than `self: Box<Self>`, is what lets a session live
    /// behind `Arc<dyn AgentSession>`: multiple call sites (a cancel
    /// handler, an app-shutdown hook, a health check) can each hold a
    /// reference, and any of them may be the one that actually
    /// triggers teardown, without coordinating who "owns" the one-shot
    /// consumption a `Box<Self>` receiver would have forced.
    ///
    /// # Condition B (BINDING): synthesize the terminal receipt on
    /// ungraceful exit
    ///
    /// Measured on `claude` 2.1.232: exactly one terminal event on every
    /// clean exit, including `max-turns` errors — but **ZERO terminal
    /// events on process kill**. A caller mid-turn when the child is
    /// killed (crash, `kill -9`, an app shutdown racing a live turn)
    /// would otherwise wait forever for an
    /// `agent_turn_settled` that never arrives. Every implementation of
    /// this method MUST itself emit a synthesized `agent_turn_settled`
    /// (`status: `[`AgentTurnStatus::Error`]`) for any turn still in
    /// flight at the moment `shutdown` runs. **Killed turns lose cost
    /// data** (no `result` line to read `total_cost_usd` from) — the
    /// synthesized settlement's `costUsd`/`usage` are `None`, honestly,
    /// not a fabricated estimate. See the trait's concurrency contract
    /// above for the "never zero, never two" half of this invariant.
    fn shutdown(&self) -> BoxFuture<'_, Result<ExitSummary, AppError>>;
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use super::*;
    use crate::events::{
        AgentBlockPayload, AgentSessionExitedPayload, AgentSessionStartedPayload, SwarmEvent,
    };
    use crate::orchestration::{EventLog, OrchestrationEngine};

    /// An adapter/session pair proving the trait contract compiles and
    /// is object-safe (`spawn` returns a real `Box<dyn AgentSession>`),
    /// and driving a full session lifecycle — spawn → turn → deltas →
    /// settled → shutdown — through a LIVE `OrchestrationEngine` (a real
    /// writer thread and a file-backed log).
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
                interactive_permissions: false,
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
                Ok(
                    Box::new(MockAgentSession::new(sink, spec.worker_id, session_key))
                        as Box<dyn AgentSession>,
                )
            })
        }
    }

    /// Mutable state behind [`MockAgentSession`]'s interior mutability —
    /// what makes `send_turn`'s busy-check and `shutdown`'s idempotency
    /// possible with a `&self`-only trait surface.
    #[derive(Default)]
    struct MockSessionState {
        /// `Some` once a turn is in flight — `send_turn` while `Some`
        /// returns [`AppError::AgentSessionBusy`]. Whichever of
        /// `send_turn`'s natural completion or `shutdown`'s Condition-B
        /// synthesis gets here first clears it and owns emitting that
        /// turn's ONE `agent_turn_settled` — see both methods' bodies
        /// below for the ownership handshake.
        in_flight_turn: Option<TurnId>,
        /// Cached exit summary once `shutdown` has run its teardown
        /// once — every subsequent call returns this without redoing
        /// any work or re-emitting any event.
        shutdown_result: Option<ExitSummary>,
    }

    struct MockAgentSession {
        sink: crate::events::EventSink,
        worker_id: Uuid,
        session_key: SessionKey,
        state: parking_lot::Mutex<MockSessionState>,
        /// Test-only hook: when `Some`, `send_turn` awaits this after
        /// emitting its delta/block but before its settled event and
        /// the ownership handshake — lets a test hold a turn "in
        /// flight" under its own control (e.g. to call `shutdown`
        /// concurrently) rather than racing real timing. `None` in
        /// every non-gated test — `send_turn` then runs straight
        /// through.
        turn_gate: Option<Arc<tokio::sync::Notify>>,
    }

    impl MockAgentSession {
        fn new(sink: crate::events::EventSink, worker_id: Uuid, session_key: SessionKey) -> Self {
            Self {
                sink,
                worker_id,
                session_key,
                state: parking_lot::Mutex::new(MockSessionState::default()),
                turn_gate: None,
            }
        }

        fn with_gate(mut self, gate: Arc<tokio::sync::Notify>) -> Self {
            self.turn_gate = Some(gate);
            self
        }
    }

    impl AgentSession for MockAgentSession {
        fn session_key(&self) -> &SessionKey {
            &self.session_key
        }

        fn send_turn(&self, turn: TurnInput) -> BoxFuture<'_, Result<TurnId, AppError>> {
            Box::pin(async move {
                let turn_id: TurnId = Uuid::new_v4().to_string();
                {
                    // Lock scope ends before any `.await` below — the
                    // trait's "no lock across an await" rule.
                    let mut state = self.state.lock();
                    if state.in_flight_turn.is_some() {
                        return Err(AppError::AgentSessionBusy);
                    }
                    state.in_flight_turn = Some(turn_id.clone());
                }

                self.sink.emit(SwarmEvent::AgentTurnDelta(
                    crate::events::AgentTurnDeltaPayload {
                        worker_id: self.worker_id,
                        turn_id: turn_id.clone(),
                        block_index: 0,
                        kind: "text".to_string(),
                        text: turn.prompt.clone(),
                    },
                ));
                self.sink.emit(SwarmEvent::AgentBlock(AgentBlockPayload {
                    worker_id: self.worker_id,
                    turn_id: turn_id.clone(),
                    block_index: 0,
                    kind: "text".to_string(),
                    content: serde_json::json!({ "text": turn.prompt }),
                }));

                if let Some(gate) = &self.turn_gate {
                    gate.notified().await;
                }

                // Ownership handshake with `shutdown`: only whichever
                // of the two still finds itself holding `turn_id`
                // clears the slot and emits the ONE settled event —
                // Condition B's "never two" half. If `shutdown` ran
                // concurrently and already synthesized this turn's
                // settlement, `in_flight_turn` no longer matches and
                // this natural-completion path emits nothing further.
                let still_owner = {
                    let mut state = self.state.lock();
                    if state.in_flight_turn.as_deref() == Some(turn_id.as_str()) {
                        state.in_flight_turn = None;
                        true
                    } else {
                        false
                    }
                };
                if still_owner {
                    self.sink.emit(SwarmEvent::AgentTurnSettled(
                        crate::events::AgentTurnSettledPayload {
                            worker_id: self.worker_id,
                            turn_id: turn_id.clone(),
                            status: AgentTurnStatus::Ok,
                            error: None,
                            cost_usd: Some(0.001),
                            usage: None,
                            duration_ms: 12,
                            num_turns: Some(1),
                        },
                    ));
                }

                Ok(turn_id)
            })
        }

        fn await_turn_completion(&self, _turn: TurnId) -> BoxFuture<'_, Result<(), AppError>> {
            // `send_turn` above already runs the turn to full settlement
            // (including the ownership handshake) before ever returning
            // `Ok(turn_id)` — by construction, any turn id a caller could
            // hold has already completed. Nothing to wait for.
            Box::pin(async { Ok(()) })
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

        fn shutdown(&self) -> BoxFuture<'_, Result<ExitSummary, AppError>> {
            Box::pin(async move {
                // Idempotency fast path — no lock held across the
                // early return, nothing re-emitted on a second call.
                {
                    let state = self.state.lock();
                    if let Some(existing) = &state.shutdown_result {
                        return Ok(existing.clone());
                    }
                }

                // Condition B: synthesize settlement for any turn still
                // owned at shutdown time. Lock scope kept tight and
                // never held across the `sink.emit` calls below (they
                // are synchronous in this mock, but the discipline
                // matters for any real implementation whose sink work
                // genuinely awaits).
                let in_flight = {
                    let mut state = self.state.lock();
                    state.in_flight_turn.take()
                };
                if let Some(turn_id) = in_flight {
                    self.sink.emit(SwarmEvent::AgentTurnSettled(
                        crate::events::AgentTurnSettledPayload {
                            worker_id: self.worker_id,
                            turn_id,
                            status: AgentTurnStatus::Error,
                            error: Some("session shut down mid-turn".to_string()),
                            cost_usd: None,
                            usage: None,
                            duration_ms: 0,
                            num_turns: None,
                        },
                    ));
                }

                // Awaiting the ack here (rather than a bare `emit`) is
                // the test's ordering guarantee: `std::sync::mpsc` is
                // FIFO single-consumer, so by the time this ack
                // resolves, every earlier `emit` from this session has
                // already been processed and persisted by the single
                // writer thread.
                let ack = self.sink.emit_awaiting_seq(
                    SwarmEvent::AgentSessionExited(AgentSessionExitedPayload {
                        worker_id: self.worker_id,
                        exit_code: Some(0),
                        signal: None,
                    }),
                    crate::events::Provenance::default(),
                );
                let _ = ack.await;

                let summary = ExitSummary {
                    exit_code: Some(0),
                    signal: None,
                };
                {
                    let mut state = self.state.lock();
                    state.shutdown_result.get_or_insert_with(|| summary.clone());
                }
                Ok(summary)
            })
        }
    }

    /// Proves both that the trait contract compiles as a real
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

    // ── The concurrency contract ─────────────────────────────────────

    /// `shutdown` racing a
    /// still-in-flight `send_turn` yields EXACTLY ONE
    /// `agent_turn_settled` for that turn — never zero (Condition B)
    /// and never two (the ownership handshake in both methods' bodies).
    /// Uses `tokio::join!` (not `tokio::spawn`, which would require the
    /// non-`'static` `BoxFuture<'_, _>` these trait methods return) to
    /// run `send_turn` and `shutdown` concurrently on one task, with a
    /// `Notify` gate holding `send_turn` "mid-turn" until after
    /// `shutdown` has had a chance to observe it in flight. Asserted
    /// directly off the persisted log — the precise "exactly one, never
    /// zero, never two" proof, not just that both futures resolved Ok.
    #[tokio::test]
    async fn test_shutdown_during_in_flight_turn_persists_exactly_one_settled_event() {
        let db_path =
            std::env::temp_dir().join(format!("swarm-agent-shutdown-race-{}.db", Uuid::new_v4()));
        let log = EventLog::open(&db_path).expect("open file-backed log");
        let engine = OrchestrationEngine::start(log, Some(db_path.clone()), |_| {});
        let sink = engine.sink();
        let gate = Arc::new(tokio::sync::Notify::new());
        let session = MockAgentSession::new(sink, Uuid::new_v4(), Uuid::new_v4().to_string())
            .with_gate(gate.clone());

        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            let send_fut = session.send_turn(TurnInput {
                prompt: "long running".to_string(),
            });
            let shutdown_fut = async {
                tokio::task::yield_now().await;
                tokio::task::yield_now().await;
                let outcome = session.shutdown().await;
                gate.notify_one();
                outcome
            };
            let (send_result, shutdown_result) = tokio::join!(send_fut, shutdown_fut);
            assert!(send_result.is_ok());
            assert!(shutdown_result.is_ok());
        })
        .await
        .expect("test must not hang");

        // Give the writer thread a brief window to flush (no
        // emit_awaiting_seq was threaded through this path, so poll
        // rather than assume synchronous persistence).
        let settled_rows;
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        loop {
            let verify_log = EventLog::open(&db_path).expect("reopen log");
            let events = verify_log.events_since(0, 100).expect("read events");
            let has_exited = events
                .iter()
                .any(|e| e.event_type == "agent_session_exited");
            if has_exited {
                settled_rows = events
                    .iter()
                    .filter(|e| e.event_type == "agent_turn_settled")
                    .count();
                break;
            }
            if std::time::Instant::now() > deadline {
                panic!("timed out waiting for agent_session_exited to persist");
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }

        assert_eq!(
            settled_rows, 1,
            "exactly one agent_turn_settled must persist — never zero, never two"
        );

        std::fs::remove_file(&db_path).ok();
        std::fs::remove_file(format!("{}-wal", db_path.display())).ok();
        std::fs::remove_file(format!("{}-shm", db_path.display())).ok();
    }

    /// A second `shutdown` call is
    /// idempotent — same summary, no re-emitted `agent_session_exited`.
    #[tokio::test]
    async fn test_double_shutdown_is_idempotent() {
        let db_path =
            std::env::temp_dir().join(format!("swarm-agent-double-shutdown-{}.db", Uuid::new_v4()));
        let log = EventLog::open(&db_path).expect("open file-backed log");
        let engine = OrchestrationEngine::start(log, Some(db_path.clone()), |_| {});
        let sink = engine.sink();
        let session = MockAgentSession::new(sink, Uuid::new_v4(), Uuid::new_v4().to_string());

        let first = session.shutdown().await.expect("first shutdown succeeds");
        let second = session.shutdown().await.expect("second shutdown succeeds");
        assert_eq!(
            first, second,
            "idempotent shutdown must return the same summary"
        );

        // Poll for persistence, then assert only one exited row exists.
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        loop {
            let verify_log = EventLog::open(&db_path).expect("reopen log");
            let events = verify_log.events_since(0, 100).expect("read events");
            let exited_rows = events
                .iter()
                .filter(|e| e.event_type == "agent_session_exited")
                .count();
            if exited_rows >= 1 {
                assert_eq!(
                    exited_rows, 1,
                    "double shutdown must not re-emit agent_session_exited"
                );
                break;
            }
            if std::time::Instant::now() > deadline {
                panic!("timed out waiting for agent_session_exited to persist");
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }

        std::fs::remove_file(&db_path).ok();
        std::fs::remove_file(format!("{}-wal", db_path.display())).ok();
        std::fs::remove_file(format!("{}-shm", db_path.display())).ok();
    }

    /// `send_turn` while a turn is
    /// already in flight returns [`AppError::AgentSessionBusy`] — a
    /// session never queues internally. An in-memory (not file-backed)
    /// engine is enough here since only the returned `Result`s matter,
    /// not persisted rows.
    #[tokio::test]
    async fn test_send_turn_while_busy_returns_agent_session_busy() {
        let log = EventLog::open_in_memory().expect("open in-memory log");
        let engine = OrchestrationEngine::start(log, None, |_| {});
        let gate = Arc::new(tokio::sync::Notify::new());
        let session =
            MockAgentSession::new(engine.sink(), Uuid::new_v4(), Uuid::new_v4().to_string())
                .with_gate(gate.clone());

        let result = tokio::time::timeout(std::time::Duration::from_secs(5), async {
            let first_fut = session.send_turn(TurnInput {
                prompt: "first".to_string(),
            });
            let second_fut = async {
                tokio::task::yield_now().await;
                let busy_result = session
                    .send_turn(TurnInput {
                        prompt: "second".to_string(),
                    })
                    .await;
                // Release the first turn now that we've captured the
                // busy result from the second.
                gate.notify_one();
                busy_result
            };
            tokio::join!(first_fut, second_fut)
        })
        .await
        .expect("test must not hang");

        let (first_result, second_result) = result;
        assert!(first_result.is_ok(), "first send_turn must succeed");
        assert!(
            matches!(second_result, Err(AppError::AgentSessionBusy)),
            "second send_turn while busy must return AgentSessionBusy, got: {second_result:?}"
        );
    }

    // ── ProviderId wire values ───────────────────────────────────────

    /// Pins ALL FIVE `ProviderId` wire
    /// values. `src/lib/agent-events.ts`'s `ProviderIdSchema` hardcodes
    /// this same list on the TypeScript side with no automated
    /// cross-language check; this test is the Rust-side half of that
    /// manual contract. If this test ever needs to change,
    /// `agent-events.ts` needs the identical edit.
    #[test]
    fn test_provider_id_wire_values_pinned_for_the_typescript_schema() {
        let cases = [
            (ProviderId::ClaudeCode, "\"claude_code\""),
            (ProviderId::Codex, "\"codex\""),
            (ProviderId::OpenCode, "\"open_code\""),
            (ProviderId::Gemini, "\"gemini\""),
            (ProviderId::WebviewAnthropic, "\"webview_anthropic\""),
        ];
        for (variant, expected_json) in cases {
            let json = serde_json::to_string(&variant).unwrap();
            assert_eq!(
                json, expected_json,
                "ProviderId::{variant:?} wire value drifted"
            );
        }
    }
}
