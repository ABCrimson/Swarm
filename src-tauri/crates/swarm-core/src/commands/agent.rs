//! Provider-adapter agent commands: `agent_turn_started`/`agent_spawn`/
//! `agent_send_turn`/`agent_cancel`/`agent_shutdown`/`agent_probe`.
//! Ported from `swarm-desktop`'s former `commands::agent`.

use std::time::Duration;

use serde::Deserialize;
use serde_json::Value;

use crate::agent::adapter::AgentAdapter;
use crate::agent::{
    AgentSpawnSpec, AgentTurnRequest, MAX_AGENT_CONCURRENCY, MIN_AGENT_CONCURRENCY,
    PermissionDecision, ProviderId, TurnInput, TurnPriority,
};
use crate::events::{AgentTurnStartedPayload, Provenance, SwarmEvent};
use crate::worker::handle::WorkerConfig;
use crate::worker::lifecycle;

use super::{Ctx, err_value, ok_value, parse_args, parse_provenance, parse_uuid};

const AGENT_TURN_STARTED_ACK_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AgentTurnStartedArgs {
    worker_id: String,
    model: String,
    request_id: String,
}

pub async fn agent_turn_started(ctx: Ctx, args: Value) -> Result<Value, Value> {
    let AgentTurnStartedArgs {
        worker_id,
        model,
        request_id,
    } = parse_args(args)?;
    let uuid = parse_uuid(&worker_id)?;

    let ack = ctx.sink.emit_awaiting_seq(
        SwarmEvent::AgentTurnStarted(AgentTurnStartedPayload {
            worker_id: uuid,
            model,
            request_id,
        }),
        Provenance::default(),
    );

    match tokio::time::timeout(AGENT_TURN_STARTED_ACK_TIMEOUT, ack).await {
        Ok(Ok(seq)) => ok_value(&seq),
        Ok(Err(_)) => Err(Value::String("Event Writer Unavailable.".to_string())),
        Err(_elapsed) => Err(Value::String("Agent Turn Started Timed Out.".to_string())),
    }
}

fn parse_provider(raw: &str) -> Result<ProviderId, Value> {
    serde_json::from_value(Value::String(raw.to_string()))
        .map_err(|_| Value::String(format!("Unknown Provider: {raw}")))
}

fn agent_spawn_error(worker_id: Option<String>, message: String) -> Value {
    serde_json::json!({ "workerId": worker_id, "message": message })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AgentSpawnArgs {
    config: WorkerConfig,
    provider: String,
    #[serde(default)]
    model: Option<String>,
    #[serde(default)]
    trust_tier: Option<String>,
    #[serde(default)]
    origin_worker: Option<String>,
    #[serde(default)]
    cause_seq: Option<u64>,
}

pub async fn agent_spawn(ctx: Ctx, args: Value) -> Result<Value, Value> {
    let AgentSpawnArgs {
        config,
        provider,
        model,
        trust_tier,
        origin_worker,
        cause_seq,
    } = parse_args(args)?;

    let provider_id = parse_provider(&provider)?;
    if !matches!(provider_id, ProviderId::ClaudeCode | ProviderId::Codex) {
        return Err(agent_spawn_error(
            None,
            format!("Provider Not Yet Supported: {provider} (only claude_code/codex today)"),
        ));
    }

    let provenance = parse_provenance(origin_worker, cause_seq).map_err(|e| {
        agent_spawn_error(
            None,
            e.as_str()
                .unwrap_or("Invalid Provenance Arguments.")
                .to_string(),
        )
    })?;
    let fallback_cwd = config.cwd.clone();

    let registry = ctx.registry.clone();
    let sink = ctx.sink.clone();
    let repo_locks = ctx.repo_locks.clone();
    let worker_id = tokio::task::spawn_blocking(move || {
        lifecycle::do_spawn_worker(&sink, &registry, &repo_locks, config, provenance)
    })
    .await
    .map_err(|e| agent_spawn_error(None, e.to_string()))?
    .map_err(|e| agent_spawn_error(None, e.to_string()))?;

    let cwd = ctx
        .registry
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

    // Provider-generic dispatch — `agent_spawn`/`agent_send_turn`/
    // `agent_cancel`/`agent_shutdown`/`agent_probe` never grew a
    // provider-specific twin; only this one `match` (and `agent_probe`'s
    // below) knows which adapter a `ProviderId` maps to. Every other
    // command reaches the live session purely through
    // `ctx.agent_session_registry`, keyed by worker id, never by
    // provider — see `crate::agent::registry`'s doc.
    let spawn_result = match provider_id {
        ProviderId::ClaudeCode => ctx.claude_adapter.spawn(spec).await,
        ProviderId::Codex => ctx.codex_adapter.spawn(spec).await,
        _ => unreachable!("rejected above"),
    };

    match spawn_result {
        Ok(session) => {
            ctx.agent_session_registry
                .insert(worker_id, std::sync::Arc::from(session));
        }
        Err(e) => {
            tracing::error!(worker_id = %worker_id, error = %e, "agent_spawn: session attach failed — worker remains usable as a plain terminal");
            return Err(agent_spawn_error(
                Some(worker_id.to_string()),
                e.to_string(),
            ));
        }
    }

    ok_value(&worker_id.to_string())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AgentSendTurnArgs {
    worker_id: String,
    prompt: String,
}

pub async fn agent_send_turn(ctx: Ctx, args: Value) -> Result<Value, Value> {
    let AgentSendTurnArgs { worker_id, prompt } = parse_args(args)?;
    let uuid = parse_uuid(&worker_id)?;
    ctx.scheduler
        .enqueue(AgentTurnRequest {
            worker_id: uuid,
            turn: TurnInput { prompt },
            priority: TurnPriority::Normal,
        })
        .map_err(|e| err_value(&e))?;
    ok_value(&())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AgentCancelArgs {
    worker_id: String,
    turn_id: String,
}

pub async fn agent_cancel(ctx: Ctx, args: Value) -> Result<Value, Value> {
    let AgentCancelArgs { worker_id, turn_id } = parse_args(args)?;
    let uuid = parse_uuid(&worker_id)?;
    let session = ctx
        .agent_session_registry
        .get(&uuid)
        .map_err(|e| err_value(&e))?;
    session.cancel(turn_id).await.map_err(|e| err_value(&e))?;
    ok_value(&())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AgentShutdownArgs {
    worker_id: String,
}

pub async fn agent_shutdown(ctx: Ctx, args: Value) -> Result<Value, Value> {
    let AgentShutdownArgs { worker_id } = parse_args(args)?;
    let uuid = parse_uuid(&worker_id)?;
    if let Some(session) = ctx.agent_session_registry.remove(&uuid) {
        session.shutdown().await.map_err(|e| err_value(&e))?;
    }
    ok_value(&())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AgentProbeArgs {
    /// Which provider to probe. `None`/absent/explicit `null` all
    /// default to `claude_code` — the pre-Phase-4 wire shape (`{}`)
    /// stays a valid call, never a breaking change for an existing
    /// caller (and tolerant of a Tauri wrapper serializing an omitted
    /// optional argument as an explicit `null` rather than dropping the
    /// key).
    #[serde(default)]
    provider: Option<String>,
}

pub async fn agent_probe(ctx: Ctx, args: Value) -> Result<Value, Value> {
    let AgentProbeArgs { provider } = parse_args(args)?;
    let provider = provider.unwrap_or_else(|| "claude_code".to_string());
    let provider_id = parse_provider(&provider)?;
    let probe_result = match provider_id {
        ProviderId::ClaudeCode => ctx.claude_adapter.probe().await,
        ProviderId::Codex => ctx.codex_adapter.probe().await,
        other => {
            return Err(Value::String(format!(
                "Provider Not Yet Probeable: {other:?}"
            )));
        }
    };
    match probe_result {
        Ok(report) => ok_value(&report),
        Err(e) => Err(err_value(&e)),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AgentPermissionRespondArgs {
    worker_id: String,
    request_id: String,
    decision: PermissionDecision,
}

/// Answers a pending `agent_permission_request` (`CodexSession::respond_permission`'s
/// REAL round-trip — see that method's doc; a documented no-op against a
/// `ClaudeCodeAdapter` session, per Condition C/§0b). Not part of the
/// original Phase 2/3 command surface — the multi-provider plan
/// anticipated it ("a future `agent_permission_respond` command",
/// `src/lib/agent-events.ts`'s header doc) but nothing needed to CALL
/// [`crate::agent::adapter::AgentSession::respond_permission`] through
/// the command layer until Codex made it a genuine round-trip rather
/// than an inert no-op.
pub async fn agent_permission_respond(ctx: Ctx, args: Value) -> Result<Value, Value> {
    let AgentPermissionRespondArgs {
        worker_id,
        request_id,
        decision,
    } = parse_args(args)?;
    let uuid = parse_uuid(&worker_id)?;
    let session = ctx
        .agent_session_registry
        .get(&uuid)
        .map_err(|e| err_value(&e))?;
    session
        .respond_permission(request_id, decision)
        .await
        .map_err(|e| err_value(&e))?;
    ok_value(&())
}

#[derive(Deserialize)]
struct SetAgentConcurrencyArgs {
    limit: u32,
}

/// Updates the agent-turn scheduler's live concurrency cap — the
/// backend counterpart to the frontend's `aiConcurrentLimit` Settings
/// control. Applies immediately (see
/// [`crate::agent::AgentScheduler::set_concurrency`]) and persists to
/// `swarm-config.json` (key `agent_concurrency`) so it survives
/// restarts — [`crate::runtime::Runtime::start`] re-applies the
/// persisted value on launch, same pattern as
/// [`crate::commands::worker::set_max_workers`]'s `max_workers`.
///
/// Ordering: validate -> persist -> apply. A persistence failure must
/// not leave the live scheduler enforcing a cap that neither the UI
/// nor disk agrees with.
pub async fn set_agent_concurrency(ctx: Ctx, args: Value) -> Result<Value, Value> {
    let SetAgentConcurrencyArgs { limit } = parse_args(args)?;

    if !(MIN_AGENT_CONCURRENCY..=MAX_AGENT_CONCURRENCY).contains(&limit) {
        return Err(Value::String(format!(
            "Agent Concurrency Must Be Between {MIN_AGENT_CONCURRENCY} And {MAX_AGENT_CONCURRENCY}, Got {limit}."
        )));
    }

    let paths = ctx.paths.clone();
    tokio::task::spawn_blocking(move || {
        crate::config::write_value(&paths, "agent_concurrency", serde_json::json!(limit))
    })
    .await
    .map_err(|e| Value::String(e.to_string()))?
    .map_err(|e| err_value(&e))?;

    ctx.scheduler.set_concurrency(limit as usize);
    ok_value(&())
}
