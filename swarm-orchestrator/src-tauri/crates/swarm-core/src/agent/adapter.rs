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
    /// The provider's own protocol supports a REAL `agent_permission_request`
    /// -> `respond_permission` round-trip — [`AgentSession::respond_permission`]
    /// actually replies to a pending question on the wire, as opposed to
    /// [`crate::events::emitter::AgentPermissionRequestPayload`] being a
    /// report-only notice of an already-decided denial (see that type's
    /// "semantics shift" doc for `ClaudeCodeAdapter`, where this is
    /// `false`: `--permission-mode manual` is a silent no-op, so there is
    /// nothing on the other end to answer). Added in Phase 4 alongside
    /// `CodexAdapter` — a Capabilities-flag addition, not a trait-signature
    /// change (see the module doc's "zero trait-signature changes" bar):
    /// Codex's JSON-RPC app-server protocol issues a genuine server -> client
    /// request (an `id`-bearing approval message) that blocks the provider
    /// until answered, so `true` there is an honest, wire-verified-by-fixture
    /// claim, not an aspiration. UI affordances (e.g. rendering Allow/Deny
    /// buttons instead of a read-only denial report) MUST branch on this
    /// flag rather than assuming every provider behaves like Claude Code.
    pub interactive_permissions: bool,
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
/// [`AgentSession::shutdown`]. `shutdown` is idempotent, so this same
/// value is what every call after the first one returns too — see its
/// doc.
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

/// Closed, typed terminal status for a settled agent turn — matches
/// the [`ProviderId`]/[`PermissionDecision`] precedent set elsewhere in
/// this module (see their docs) rather than the bare `status: String`
/// the plan's payload table originally sketched. Wire form is
/// `snake_case` (`"ok"`, `"error"`), matching the informal string
/// convention every OTHER `*_settled` receipt in this codebase already
/// uses (`ai_stream_settled`, `ship_settled`) — this type just makes
/// the agent family's version of that convention unrepresentable-wrong
/// instead of merely documented-right.
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
/// See the module doc for why every method returns [`BoxFuture`]
/// instead of the plan pseudocode's `impl Future`.
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
///   a receipt that never arrives — the plan's Condition B
///   kill-criterion) and never two (a provider's own late-arriving
///   settlement racing the synthesized one is exactly the double-settle
///   the plan's verification #2 rules out) — see [`Self::shutdown`]'s
///   doc for the mechanics.
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
    /// (Condition B, [`Self::shutdown`]'s doc). Added by review (B2):
    /// the scheduler that gates concurrent agent turns needs a real
    /// "this turn's process is done executing" signal to hold its
    /// concurrency permit against — `send_turn` resolving only proves
    /// the provider ACCEPTED the turn (see its own doc), not that
    /// executing it is finished, so a scheduler that released its
    /// permit at `send_turn`'s return would bound nothing.
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
    /// adapters send the provider's real in-band cancel instead. May
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
    /// rather than `self: Box<Self>` (the plan pseudocode's original
    /// shape — changed after review), is what lets a session live
    /// behind `Arc<dyn AgentSession>`: multiple call sites (a cancel
    /// handler, an app-shutdown hook, a health check) can each hold a
    /// reference, and any of them may be the one that actually
    /// triggers teardown, without coordinating who "owns" the one-shot
    /// consumption a `Box<Self>` receiver would have forced.
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
    /// (`status: `[`AgentTurnStatus::Error`]`) for any turn still in
    /// flight at the moment `shutdown` runs — the same pattern
    /// `ai_stream_settled` already established for the webview path's
    /// error branch (`AiClient::stream_message`'s doc, since deleted
    /// with the rest of `ai/client.rs`). **Killed turns lose cost
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
        /// through, exactly like the pre-review mock.
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

    // ── FIX-4(c): the new concurrency contract ───────────────────────

    /// DIRECTIVE (review FIX-4c, part 1): `shutdown` racing a
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

    /// DIRECTIVE (review FIX-4c, part 2): a second `shutdown` call is
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

    /// DIRECTIVE (review FIX-4c, part 3): `send_turn` while a turn is
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

    // ── nit G: ProviderId wire-value pin ─────────────────────────────

    /// DIRECTIVE (review nit G): pins ALL FIVE `ProviderId` wire
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
