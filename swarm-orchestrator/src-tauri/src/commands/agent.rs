//! Agent turn Tauri IPC command handlers.
//!
//! Provides `agent_turn_started` — a narrow webview intake used by the
//! client-side chat streaming path (`AIChat.tsx`, which streams
//! `@anthropic-ai/sdk` directly from the webview) to record a real,
//! persisted seq for each AI/agent turn — plus, as of Phase 3, the
//! provider-adapter command surface: `agent_spawn`, `agent_send_turn`,
//! `agent_cancel`, `agent_shutdown`, `agent_probe`. These attach and
//! drive a [`swarm_core::agent::ClaudeCodeAdapter`] session for a
//! worker; the webview-direct `AIChat.tsx` path and this one are
//! independent providers that happen to share the `agent_*` event
//! family (see `docs/architecture.md`'s adapter-layer section).
//!
//! Moved here from the deleted `commands/ai.rs` (Phase 2 of the
//! multi-provider plan: `ai_request` and its queue wiring were deleted
//! wholesale — see `crate::commands::ai`'s removal in the changelog —
//! but `agent_turn_started` is unrelated to that dead path and is
//! actively used, so it survived, unrenamed, in a home that now matches
//! its Phase 3 neighbors.

use std::time::Duration;

use uuid::Uuid;

use swarm_core::agent::{
    AgentAdapter, AgentScheduler, AgentSessionRegistry, AgentSpawnSpec, AgentTurnRequest,
    ClaudeCodeAdapter, ProbeReport, ProviderId, TurnInput, TurnPriority,
};
use swarm_core::error::AppError;
use swarm_core::events::{AgentTurnStartedPayload, EventSink, Provenance, SwarmEvent};
use swarm_core::git::RepoLocks;
use swarm_core::worker::lifecycle;
use swarm_core::worker::registry::WorkerRegistry;

use crate::commands::parse_provenance;

/// Ceiling on how long `agent_turn_started` waits for the writer thread
/// to ack the assigned seq. The writer thread is a single dedicated OS
/// thread doing in-memory work plus one SQLite insert — 5s is generous
/// headroom, not a tuned budget; its only job is turning "the writer
/// thread is gone/wedged" from an indefinite hang into a bounded,
/// reported failure `AIChat.tsx` already treats as "proceed unstamped."
const AGENT_TURN_STARTED_ACK_TIMEOUT: Duration = Duration::from_secs(5);

/// Records the start of one AI/agent turn and returns the real,
/// persisted seq the engine assigned it.
///
/// `AIChat.tsx`'s `doSend` calls this once per turn, before the first
/// streaming round — the returned seq (`turnSeq`) then lives in that
/// turn's closure and is cited as `causeSeq` on every tool-driven side
/// effect (`spawn_worker`, `kill_worker`, `worker_input`, `write_file`)
/// that turn executes. This is the mechanism behind the invariant "the
/// engine records provenance, it never infers it": the frontend cannot
/// cite a cause that doesn't exist in the log, and this command's job
/// is to make one exist before any tool call can reference it.
///
/// Uses [`EventSink::emit_awaiting_seq`] — deterministic (no polling,
/// no timeout-bound `waitFor` correlation): the writer thread hands
/// back the exact seq it assigned this event. The `await` on that ack
/// is itself bounded by [`AGENT_TURN_STARTED_ACK_TIMEOUT`] — a wedged or
/// gone writer thread must surface as a bounded, reported failure, not
/// an indefinite hang; `AIChat.tsx` already treats any failure here
/// (timeout included) as "proceed unstamped for this turn," never as a
/// reason to abort the turn outright.
///
/// # Arguments
///
/// * `sink` - Event sink (managed state)
/// * `worker_id` - UUID string of the worker whose chat panel started this turn
/// * `model` - Model identifier for this turn
/// * `request_id` - Client-generated correlation ID (the chat item id)
///
/// # Returns
///
/// The seq the writer thread assigned the `agent_turn_started` event.
///
/// # Errors
///
/// Returns a `String` error if `worker_id` is not a valid UUID, if the
/// event writer thread is gone (the ack channel closed without a
/// value), or if the ack does not arrive within
/// [`AGENT_TURN_STARTED_ACK_TIMEOUT`] — each case surfaces a distinct,
/// truthful message so a caller inspecting the error (or a human
/// reading logs) is not left guessing which one happened.
#[tauri::command]
#[tracing::instrument(skip(sink))]
pub async fn agent_turn_started(
    sink: tauri::State<'_, EventSink>,
    worker_id: String,
    model: String,
    request_id: String,
) -> Result<u64, String> {
    let uuid = Uuid::parse_str(&worker_id).map_err(|e| {
        tracing::error!(error = %e, "invalid worker ID");
        e.to_string()
    })?;
    tracing::info!(worker_id = %uuid, %model, %request_id, "agent_turn_started called");

    let ack = sink.emit_awaiting_seq(
        SwarmEvent::AgentTurnStarted(AgentTurnStartedPayload {
            worker_id: uuid,
            model,
            request_id,
        }),
        // The turn's own start is caused by a human (or an injected
        // instruction acting on the user's behalf) — unattributed in
        // v1, same as every other user-initiated action. See "The
        // honest v1 attribution table" under docs/architecture.md's
        // "Ordered Event Core" section for the full per-path breakdown.
        Provenance::default(),
    );

    match tokio::time::timeout(AGENT_TURN_STARTED_ACK_TIMEOUT, ack).await {
        Ok(Ok(seq)) => Ok(seq),
        Ok(Err(e)) => {
            tracing::error!(error = %e, "event writer thread gone before ack");
            Err("Event Writer Unavailable.".to_string())
        }
        Err(_elapsed) => {
            tracing::error!(
                timeout = ?AGENT_TURN_STARTED_ACK_TIMEOUT,
                "agent_turn_started ack timed out"
            );
            Err("Agent Turn Started Timed Out.".to_string())
        }
    }
}

// ── Phase 3: provider-adapter command surface ───────────────────────

/// Parses a wire provider string (e.g. `"claude_code"`) into a
/// [`ProviderId`], failing closed on anything unrecognized — same
/// discipline as every other closed-enum wire value in this codebase
/// (see `ProviderId`'s own doc).
fn parse_provider(raw: &str) -> Result<ProviderId, String> {
    serde_json::from_value(serde_json::Value::String(raw.to_string()))
        .map_err(|_| format!("Unknown Provider: {raw}"))
}

/// Typed error for [`agent_spawn`] (review F9).
///
/// A generic `String` error loses the worker id the instant the PTY
/// worker spawn itself succeeds but the SUBSEQUENT agent-session attach
/// fails — the caller is left with an error message and no way to
/// find/show the worker that nonetheless exists and is usable as a
/// plain terminal (see [`agent_spawn`]'s doc). `workerId` is `Some` from
/// the moment the PTY worker has been created, `None` only for errors
/// that happen before that (bad provider string, bad provenance args,
/// or the PTY spawn itself failing).
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSpawnError {
    /// UUID of the worker that was created, if the failure happened
    /// AFTER worker creation (the agent-session attach step).
    pub worker_id: Option<String>,
    /// Human-readable failure detail.
    pub message: String,
}

impl std::fmt::Display for AgentSpawnError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message)
    }
}

impl From<String> for AgentSpawnError {
    /// Every error site BEFORE the worker exists (`parse_provider`,
    /// `parse_provenance`, and `?` from those) converts through here —
    /// `workerId: None` is correct at that point, there is no worker
    /// yet.
    fn from(message: String) -> Self {
        Self {
            worker_id: None,
            message,
        }
    }
}

/// Spawns a new worker (via the existing worktree-isolation path — see
/// [`crate::commands::worker::spawn_worker`]) and attaches a Claude
/// Code provider-adapter session to it in the same call.
///
/// The underlying PTY worker and the attached agent session are
/// deliberately independent resources sharing only the worker id and
/// cwd (see the multi-provider plan's "Session state — three owners,
/// no mirroring" table): the PTY continues to back the plain terminal
/// view (`WorkerTerminal`), while the agent session drives the AI
/// conversation (`agent_send_turn` et al.). If the PTY worker spawns
/// successfully but the agent session fails to attach (e.g. the
/// `claude` binary is missing or not authenticated), the worker is left
/// running and usable as a plain terminal — this command reports the
/// agent-attach failure without rolling back the worker spawn, matching
/// the plan's "Not Signed In is a state, never a hang" rule (a
/// half-attached worker is a legitimate, visible degraded state, not a
/// silent failure). [`AgentSpawnError::worker_id`] carries that
/// worker's id in this case (review F9) so the frontend is never left
/// with an error message it can't attribute to anything.
///
/// # Arguments
///
/// * `sink`/`registry`/`repo_locks` - Worker spawn plumbing (managed state)
/// * `session_registry` - Where the new live session is registered (managed state)
/// * `claude_adapter` - The Claude Code provider adapter (managed state)
/// * `config` - Worker spawn configuration (name/cwd/repoRoot/isolation — same shape `spawn_worker` takes)
/// * `provider` - Wire provider id; only `"claude_code"` is supported today
/// * `model` - Model alias (e.g. `"sonnet"`); `None` defers to the adapter's default
/// * `trust_tier` - `"restricted"` | `"standard"` | `"write_enabled"`; `None` defers to `"standard"`
///
/// # Returns
///
/// The UUID string of the newly spawned worker (same contract as
/// `spawn_worker`) — the attached session's `sessionKey`/`capabilities`
/// arrive via the `agent_session_started` event, not this return value.
///
/// # Errors
///
/// Returns an [`AgentSpawnError`] if the PTY worker spawn itself fails
/// (same failure modes as `spawn_worker`; `workerId: None`), if
/// `provider` is unrecognized or not yet supported (`workerId: None`),
/// or if the agent session fails to attach (`workerId: Some` — the
/// worker still exists, see above).
#[tauri::command]
#[tracing::instrument(skip(sink, registry, repo_locks, session_registry, claude_adapter, config))]
#[allow(clippy::too_many_arguments)]
pub async fn agent_spawn(
    sink: tauri::State<'_, EventSink>,
    registry: tauri::State<'_, WorkerRegistry>,
    repo_locks: tauri::State<'_, RepoLocks>,
    session_registry: tauri::State<'_, AgentSessionRegistry>,
    claude_adapter: tauri::State<'_, ClaudeCodeAdapter>,
    config: swarm_core::worker::handle::WorkerConfig,
    provider: String,
    model: Option<String>,
    trust_tier: Option<String>,
    origin_worker: Option<String>,
    cause_seq: Option<u64>,
) -> Result<String, AgentSpawnError> {
    tracing::info!(name = %config.name, %provider, "agent_spawn called");
    let provider_id = parse_provider(&provider)?;
    if provider_id != ProviderId::ClaudeCode {
        return Err(AgentSpawnError {
            worker_id: None,
            message: format!("Provider Not Yet Supported: {provider} (only claude_code today)"),
        });
    }

    let provenance = parse_provenance(origin_worker, cause_seq)?;
    let fallback_cwd = config.cwd.clone();

    let registry_inner = registry.inner().clone();
    let sink_inner = sink.inner().clone();
    let repo_locks_inner = repo_locks.inner().clone();
    let worker_id = tokio::task::spawn_blocking(move || {
        lifecycle::do_spawn_worker(
            &sink_inner,
            &registry_inner,
            &repo_locks_inner,
            config,
            provenance,
        )
    })
    .await
    .map_err(|e| {
        tracing::error!(error = %e, "agent_spawn: worker spawn task panicked");
        AgentSpawnError {
            worker_id: None,
            message: e.to_string(),
        }
    })?
    .map_err(|e| {
        tracing::error!(error = %e, "agent_spawn: worker spawn failed");
        AgentSpawnError {
            worker_id: None,
            message: e.to_string(),
        }
    })?;

    // Worktree cwd (when isolated) takes priority over the config's raw
    // cwd — same resolution `do_spawn_worker` itself applies internally
    // for the PTY.
    let cwd = registry
        .get_worker(&worker_id)
        .ok()
        .and_then(|info| info.worktree_path)
        .unwrap_or(fallback_cwd);

    let spec = AgentSpawnSpec {
        worker_id,
        cwd,
        model,
        resume: None,
        permission_mode: trust_tier,
    };

    match claude_adapter.spawn(spec).await {
        Ok(session) => {
            session_registry.insert(worker_id, std::sync::Arc::from(session));
        }
        Err(e) => {
            tracing::error!(worker_id = %worker_id, error = %e, "agent_spawn: session attach failed — worker remains usable as a plain terminal");
            // The PTY worker already exists at this point (review F9)
            // — carry its id so the caller isn't left with a bare error
            // message it can't attribute to anything.
            return Err(AgentSpawnError {
                worker_id: Some(worker_id.to_string()),
                message: e.to_string(),
            });
        }
    }

    Ok(worker_id.to_string())
}

/// Enqueues one turn for `worker_id`'s attached agent session through
/// the [`AgentScheduler`] (concurrency-gated across every session, per
/// `docs/architecture.md`'s adapter section — "you do not want 20
/// Claude Code processes running tools against one repo at once").
///
/// This command is fire-and-forget by design: it confirms the turn was
/// ADMITTED to the scheduler, not that it completed (or even started)
/// — the frontend's transcript renders from the live `agent_*` event
/// stream (`agent_block`/`agent_tool_call`/`agent_tool_result`/
/// `agent_turn_settled`, all carrying `workerId`), not from this call's
/// return value. A session already mid-turn rejects the underlying
/// `send_turn` with `AgentSessionBusy` inside the scheduler's executor
/// (logged, not surfaced here) — see
/// `crate::agent::adapter::AgentSession`'s concurrency contract for why
/// that is the session's job, not this command's.
///
/// # Errors
///
/// Returns a `String` error if `worker_id` is not a valid UUID or the
/// scheduler's bounded admission queue is full
/// ([`swarm_core::error::AppError::QueueFull`]).
#[tauri::command]
#[tracing::instrument(skip(scheduler))]
pub async fn agent_send_turn(
    scheduler: tauri::State<'_, AgentScheduler>,
    worker_id: String,
    prompt: String,
) -> Result<(), String> {
    let uuid = Uuid::parse_str(&worker_id).map_err(|e| {
        tracing::error!(error = %e, "agent_send_turn: invalid worker ID");
        e.to_string()
    })?;
    scheduler
        .enqueue(AgentTurnRequest {
            worker_id: uuid,
            turn: TurnInput { prompt },
            priority: TurnPriority::Normal,
        })
        .map_err(|e| {
            tracing::error!(worker_id = %uuid, error = %e, "agent_send_turn: enqueue failed");
            e.to_string()
        })
}

/// Cancels `worker_id`'s in-flight turn (identified by `turn_id`, from
/// that turn's own `agent_block`/`agent_tool_call` events' `turnId`).
/// A stale or already-settled `turn_id` is a benign no-op — see
/// [`crate::agent::adapter::AgentSession::cancel`]'s doc.
///
/// # Errors
///
/// Returns a `String` error if `worker_id` is not a valid UUID or has
/// no attached agent session.
#[tauri::command]
#[tracing::instrument(skip(session_registry))]
pub async fn agent_cancel(
    session_registry: tauri::State<'_, AgentSessionRegistry>,
    worker_id: String,
    turn_id: String,
) -> Result<(), String> {
    let uuid = Uuid::parse_str(&worker_id).map_err(|e| e.to_string())?;
    let session = session_registry.get(&uuid).map_err(|e| e.to_string())?;
    session.cancel(turn_id).await.map_err(|e| e.to_string())
}

/// Shuts down `worker_id`'s attached agent session (idempotent — see
/// [`crate::agent::adapter::AgentSession::shutdown`]'s doc) and removes
/// it from the registry. A worker with no attached session is a benign
/// no-op, not an error — shutting down twice (or shutting down a
/// worker that was never a Claude Code worker) is exactly the
/// idempotent case this command is safe to call for.
///
/// Does NOT kill the underlying PTY worker — see `kill_worker` for
/// that (which also tears down any attached agent session as part of
/// its own cleanup).
///
/// # Errors
///
/// Returns a `String` error if `worker_id` is not a valid UUID.
#[tauri::command]
#[tracing::instrument(skip(session_registry))]
pub async fn agent_shutdown(
    session_registry: tauri::State<'_, AgentSessionRegistry>,
    worker_id: String,
) -> Result<(), String> {
    let uuid = Uuid::parse_str(&worker_id).map_err(|e| e.to_string())?;
    if let Some(session) = session_registry.remove(&uuid) {
        session.shutdown().await.map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Checks whether the Claude Code CLI is installed and responds to
/// `--version`, bounded by [`ClaudeCodeAdapter::probe`]'s own timeout —
/// never a hang, per the plan's "Not Signed In is a state, never a
/// hang" rule. Never touches or reports a credential; see
/// [`ProbeReport`]'s doc.
///
/// # Errors
///
/// This command itself never fails — an unusable provider is reported
/// as `ProbeReport { available: false, .. }` with a human-readable
/// `detail`, not an `Err`. The `Result` wrapper exists only for Tauri's
/// IPC error-transport convention, matching every other command here.
#[tauri::command]
#[tracing::instrument(skip(claude_adapter))]
pub async fn agent_probe(
    claude_adapter: tauri::State<'_, ClaudeCodeAdapter>,
) -> Result<ProbeReport, String> {
    claude_adapter
        .probe()
        .await
        .map_err(|e: AppError| e.to_string())
}
