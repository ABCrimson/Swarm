//! Provider-agent commands: `agent_turn_started`, `agent_spawn`,
//! `agent_send_turn`, `agent_cancel`, `agent_shutdown`, `agent_probe`,
//! `agent_permission_respond` and `set_agent_concurrency`.
//!
//! Only `with_adapter!` knows which Rust adapter serves which
//! [`ProviderId`]. Every command after `agent_spawn` reaches the live
//! session through `ctx.agent_session_registry`, keyed by worker id,
//! never by provider.

use std::time::Duration;

use serde::Deserialize;
use serde_json::Value;

use crate::agent::{
    AgentAdapter, AgentSpawnSpec, AgentTurnRequest, MAX_AGENT_CONCURRENCY, MIN_AGENT_CONCURRENCY,
    PermissionDecision, ProviderId, TurnInput, TurnPriority,
};
use crate::events::{AgentTurnStartedPayload, Provenance, SwarmEvent};
use crate::worker::handle::WorkerConfig;
use crate::worker::lifecycle;

use super::{Ctx, err_value, ok_value, parse_args, parse_provenance, parse_uuid};

/// How long `agent_turn_started` waits for the writer to assign a seq.
const AGENT_TURN_STARTED_ACK_TIMEOUT: Duration = Duration::from_secs(5);

/// Evaluates `$body` with `$adapter` bound to the Rust adapter serving
/// `$provider`, as `Some(result)`; `None` for a provider with no Rust
/// adapter (the webview chat path, or one not implemented yet). The
/// single provider-to-adapter mapping, written as a macro so each arm
/// is monomorphic: the adapters need not be object-safe.
macro_rules! with_adapter {
    ($ctx:expr, $provider:expr, |$adapter:ident| $body:expr) => {
        match $provider {
            ProviderId::ClaudeCode => {
                let $adapter = &*$ctx.claude_adapter;
                Some($body)
            }
            ProviderId::Codex => {
                let $adapter = &*$ctx.codex_adapter;
                Some($body)
            }
            ProviderId::OpenCode | ProviderId::Gemini | ProviderId::WebviewAnthropic => None,
        }
    };
}

/// The Title Case refusal for a provider `with_adapter!` has no
/// adapter for.
fn no_adapter(provider: ProviderId) -> String {
    let name = serde_json::to_value(provider)
        .ok()
        .and_then(|v| v.as_str().map(str::to_owned))
        .unwrap_or_else(|| format!("{provider:?}"));
    format!("Provider Not Supported By The Backend: {name}.")
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AgentTurnStartedArgs {
    worker_id: String,
    model: String,
    request_id: String,
}

/// Records `agent_turn_started` for a turn the webview chat path runs
/// itself, and resolves to its seq (the `causeSeq` the turn's later
/// events cite).
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
        Ok(Err(_)) => Err(Value::String("Event Writer Unavailable.".to_owned())),
        Err(_elapsed) => Err(Value::String("Agent Turn Started Timed Out.".to_owned())),
    }
}

/// `agent_spawn`'s error: `{ workerId, message }`, where `workerId` is
/// set when the PTY worker was created but the agent session failed to
/// attach (the worker stays usable as a plain terminal).
fn agent_spawn_error(worker_id: Option<String>, message: String) -> Value {
    serde_json::json!({ "workerId": worker_id, "message": message })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AgentSpawnArgs {
    config: WorkerConfig,
    provider: ProviderId,
    #[serde(default)]
    model: Option<String>,
    #[serde(default)]
    trust_tier: Option<String>,
    #[serde(default)]
    origin_worker: Option<String>,
    #[serde(default)]
    cause_seq: Option<u64>,
}

/// Spawns a PTY worker, then attaches a `provider` agent session to it.
/// Resolves to the worker id.
pub async fn agent_spawn(ctx: Ctx, args: Value) -> Result<Value, Value> {
    let AgentSpawnArgs {
        config,
        provider,
        model,
        trust_tier,
        origin_worker,
        cause_seq,
    } = parse_args(args)?;

    // Refuse before any side effect.
    if with_adapter!(ctx, provider, |_adapter| ()).is_none() {
        return Err(agent_spawn_error(None, no_adapter(provider)));
    }
    let provenance = parse_provenance(origin_worker, cause_seq).map_err(|e| {
        agent_spawn_error(
            None,
            e.as_str()
                .unwrap_or("Invalid Provenance Arguments.")
                .to_owned(),
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

    // An isolated worker runs in its own worktree, not the requested cwd.
    // A worker already killed since the spawn returned gets no session.
    let info = ctx
        .registry
        .get_worker(&worker_id)
        .map_err(|e| agent_spawn_error(None, e.to_string()))?;
    let cwd = info.worktree_path.unwrap_or(fallback_cwd);
    let spec = AgentSpawnSpec {
        worker_id,
        cwd,
        model,
        resume: None,
        permission_mode: trust_tier,
    };

    let Some(spawned) = with_adapter!(ctx, provider, |adapter| adapter.spawn(spec).await) else {
        return Err(agent_spawn_error(
            Some(worker_id.to_string()),
            no_adapter(provider),
        ));
    };
    match spawned {
        Ok(session) => {
            ctx.agent_session_registry
                .insert(worker_id, std::sync::Arc::from(session));
            // `kill_worker` removes the worker before it looks for a session,
            // so a kill during the attach handshake is caught here.
            if let Err(e) = ctx.registry.get_worker(&worker_id) {
                if let Some(session) = ctx.agent_session_registry.remove(&worker_id)
                    && let Err(err) = session.shutdown().await
                {
                    tracing::warn!(%worker_id, error = %err, "agent_spawn: session shutdown after a kill during attach failed");
                }
                return Err(agent_spawn_error(None, e.to_string()));
            }
            ok_value(&worker_id.to_string())
        }
        Err(e) => {
            tracing::error!(%worker_id, error = %e, "agent_spawn: session attach failed; the worker remains usable as a plain terminal");
            Err(agent_spawn_error(
                Some(worker_id.to_string()),
                e.to_string(),
            ))
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AgentSendTurnArgs {
    worker_id: String,
    prompt: String,
}

/// Queues a turn on the scheduler for the worker's agent session.
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

/// Cancels an in-flight turn on the worker's agent session.
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

/// Shuts down the worker's agent session, if it has one. The PTY worker
/// itself is untouched.
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
    /// Which provider to probe; omitted or `null` means `claude_code`, so
    /// an argument-less `{}` call probes Claude Code.
    #[serde(default)]
    provider: Option<ProviderId>,
}

/// Probes whether `provider`'s CLI is installed and usable.
pub async fn agent_probe(ctx: Ctx, args: Value) -> Result<Value, Value> {
    let AgentProbeArgs { provider } = parse_args(args)?;
    let provider = provider.unwrap_or(ProviderId::ClaudeCode);
    match with_adapter!(ctx, provider, |adapter| adapter.probe().await) {
        Some(Ok(report)) => ok_value(&report),
        Some(Err(e)) => Err(err_value(&e)),
        None => Err(Value::String(no_adapter(provider))),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AgentPermissionRespondArgs {
    worker_id: String,
    request_id: String,
    decision: PermissionDecision,
}

/// Answers a pending `agent_permission_request` on the worker's agent
/// session (see
/// [`crate::agent::adapter::AgentSession::respond_permission`]).
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

/// Sets how many agent turns run at once: persisted to
/// `swarm-config.json` (`agent_concurrency`, re-applied by
/// [`crate::runtime::Runtime::start`]) and applied live.
///
/// Validate, persist, then apply: a failed write must not leave the
/// scheduler enforcing a cap neither the UI nor the file agrees with.
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

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::commands::test_support::test_ctx;

    #[test]
    fn test_no_adapter_names_the_provider_by_its_wire_name() {
        assert_eq!(
            no_adapter(ProviderId::WebviewAnthropic),
            "Provider Not Supported By The Backend: webview_anthropic."
        );
    }

    /// A provider without a Rust adapter is refused before a PTY worker
    /// is spawned for it.
    #[tokio::test]
    async fn test_agent_spawn_refuses_an_adapterless_provider_without_spawning() {
        let (ctx, _dir, _events) = test_ctx();
        let err = agent_spawn(
            ctx.clone(),
            json!({"config": {"name": "w"}, "provider": "gemini"}),
        )
        .await
        .unwrap_err();
        assert_eq!(err["workerId"], Value::Null);
        assert_eq!(
            err["message"],
            "Provider Not Supported By The Backend: gemini."
        );
        assert!(ctx.registry.list_workers().is_empty());
    }

    #[tokio::test]
    async fn test_agent_spawn_rejects_an_unknown_provider_name() {
        let (ctx, _dir, _events) = test_ctx();
        let err = agent_spawn(ctx, json!({"config": {"name": "w"}, "provider": "nope"}))
            .await
            .unwrap_err();
        assert!(
            err.as_str().unwrap().starts_with("Invalid Arguments: "),
            "{err}"
        );
    }

    #[tokio::test]
    async fn test_agent_probe_refuses_an_adapterless_provider() {
        let (ctx, _dir, _events) = test_ctx();
        let err = agent_probe(ctx, json!({"provider": "webview_anthropic"}))
            .await
            .unwrap_err();
        assert_eq!(
            err,
            "Provider Not Supported By The Backend: webview_anthropic."
        );
    }
}
