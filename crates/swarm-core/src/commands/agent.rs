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
use uuid::Uuid;

use crate::agent::{
    AgentAdapter, AgentSession, AgentSpawnSpec, AgentTurnRequest, MAX_AGENT_CONCURRENCY,
    MIN_AGENT_CONCURRENCY, PermissionDecision, ProviderId, TurnInput, TurnPriority,
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
/// attach (the worker stays usable as a plain terminal), and `null` when
/// no worker remains (none was created, or it was killed, or was being
/// killed, before or during its session's attach).
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

    attach_session(&ctx, worker_id, fallback_cwd, provider, model, trust_tier).await
}

/// Attaches a `provider` agent session to the PTY worker `worker_id`
/// and resolves to the worker id. The session runs in the worker's
/// worktree when it has one, else in `fallback_cwd`.
///
/// The whole attach holds an [`crate::agent::registry::AttachPermit`],
/// so a `kill_worker` racing it waits until this attach has registered
/// its session (which the kill then stops) or has stopped the session
/// itself; a kill never returns with this attach's provider still alive.
async fn attach_session(
    ctx: &Ctx,
    worker_id: Uuid,
    fallback_cwd: String,
    provider: ProviderId,
    model: Option<String>,
    trust_tier: Option<String>,
) -> Result<Value, Value> {
    // A worker being killed gets no session.
    let permit = ctx
        .agent_session_registry
        .begin_attach(worker_id)
        .map_err(|e| agent_spawn_error(None, e.to_string()))?;
    // Nor does one already killed since its spawn returned.
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
            let session: std::sync::Arc<dyn AgentSession> = std::sync::Arc::from(session);
            // A kill that began during the handshake refuses the
            // registration; the session is stopped here, while the permit
            // still holds that kill back.
            if let Err(e) = permit.insert(session.clone()) {
                if let Err(err) = session.shutdown().await {
                    tracing::warn!(%worker_id, error = %err, "agent_spawn: session shutdown after a kill during attach failed");
                }
                return Err(agent_spawn_error(None, e.to_string()));
            }
            // Every removal runs through `kill_worker`, which the permit
            // holds back, so the worker is still here; the lookup keeps a
            // worker removed any other way from keeping a live session.
            if let Err(e) = ctx.registry.get_worker(&worker_id) {
                if let Some(session) = ctx.agent_session_registry.take_session(&worker_id)
                    && let Err(err) = session.shutdown().await
                {
                    tracing::warn!(%worker_id, error = %err, "agent_spawn: session shutdown after the worker vanished during attach failed");
                }
                return Err(agent_spawn_error(None, e.to_string()));
            }
            ok_value(&worker_id.to_string())
        }
        Err(e) => {
            // A kill waiting on this attach removes the worker next, so
            // it is reported gone, never usable as a plain terminal.
            let gone = ctx
                .agent_session_registry
                .ensure_open(&worker_id)
                .and_then(|()| ctx.registry.get_worker(&worker_id).map(drop));
            if let Err(gone) = gone {
                tracing::error!(%worker_id, error = %e, "agent_spawn: session attach failed while the worker was killed");
                return Err(agent_spawn_error(None, gone.to_string()));
            }
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

/// Queues a turn on the scheduler for the worker's agent session,
/// refusing it with [`crate::error::AppError::WorkerClosing`] while a
/// kill is closing the worker. A turn queued before the kill began finds
/// no session when it is dispatched and settles as an error (see
/// `crate::runtime`'s turn executor).
pub async fn agent_send_turn(ctx: Ctx, args: Value) -> Result<Value, Value> {
    let AgentSendTurnArgs { worker_id, prompt } = parse_args(args)?;
    let uuid = parse_uuid(&worker_id)?;
    ctx.agent_session_registry
        .ensure_open(&uuid)
        .map_err(|e| err_value(&e))?;
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
/// itself is untouched. A `kill_worker` racing this waits for the
/// shutdown to finish before it touches the worker.
pub async fn agent_shutdown(ctx: Ctx, args: Value) -> Result<Value, Value> {
    let AgentShutdownArgs { worker_id } = parse_args(args)?;
    let uuid = parse_uuid(&worker_id)?;
    if let Some(session) = ctx.agent_session_registry.take_session(&uuid) {
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
/// [`crate::runtime::Runtime::start`]) and applied live. Resolves to the
/// cap in force once this call has applied.
///
/// Validate, persist, then apply: a failed write must not leave the
/// scheduler enforcing a cap neither the UI nor the file agrees with.
/// Overlapping calls are serialized (see
/// [`crate::agent::AgentScheduler::lock_concurrency_setting`]): the last
/// call to start is the last applied, to the file and the scheduler.
pub async fn set_agent_concurrency(ctx: Ctx, args: Value) -> Result<Value, Value> {
    let SetAgentConcurrencyArgs { limit } = parse_args(args)?;

    if !(MIN_AGENT_CONCURRENCY..=MAX_AGENT_CONCURRENCY).contains(&limit) {
        return Err(Value::String(format!(
            "Agent Concurrency Must Be Between {MIN_AGENT_CONCURRENCY} And {MAX_AGENT_CONCURRENCY}, Got {limit}."
        )));
    }

    apply_agent_concurrency(&ctx, limit, move |paths| {
        crate::config::write_value(paths, "agent_concurrency", serde_json::json!(limit))
    })
    .await
}

/// Under the setting's lock, persists `limit` with `write` (on the
/// blocking pool), applies it to the scheduler and resolves to the cap
/// then in force. `write` is the config write, a parameter so tests can
/// slow it down.
async fn apply_agent_concurrency(
    ctx: &Ctx,
    limit: u32,
    write: impl FnOnce(&crate::Paths) -> Result<(), crate::error::AppError> + Send + 'static,
) -> Result<Value, Value> {
    let _setting = ctx.scheduler.lock_concurrency_setting().await;
    let paths = ctx.paths.clone();
    tokio::task::spawn_blocking(move || write(&paths))
        .await
        .map_err(|e| Value::String(e.to_string()))?
        .map_err(|e| err_value(&e))?;

    ctx.scheduler.set_concurrency(limit as usize);
    ok_value(&ctx.scheduler.concurrency())
}

#[cfg(test)]
mod tests {
    use std::path::Path;
    use std::time::Instant;

    use serde_json::json;
    use tokio::task::JoinHandle;

    use super::*;
    use crate::agent::ClaudeCodeAdapter;
    use crate::commands::test_support::{test_ctx, test_ctx_with_claude};
    use crate::commands::worker::{kill_worker, spawn_worker};
    use crate::error::AppError;
    use crate::events::EventSink;
    use crate::orchestration::DomainEvent;

    /// Written by the fake CLI's `"held"` `initialize` once it is waiting
    /// (`tests/fixtures/claude_code/fake_claude_cli.mjs`).
    const HELD_MARKER: &str = "swarm-fake-claude.held";
    /// Releases the fake CLI's `"held"` `initialize` reply.
    const RELEASE_MARKER: &str = "swarm-fake-claude.release";

    /// A Claude Code adapter that runs the fake CLI with `scenario`.
    fn fake_claude(sink: EventSink, scenario: &str) -> ClaudeCodeAdapter {
        let fixture = |name: &str| {
            format!(
                "{}/tests/fixtures/claude_code/{name}",
                env!("CARGO_MANIFEST_DIR")
            )
        };
        ClaudeCodeAdapter::with_test_binary(
            sink,
            "node",
            vec![fixture("fake_claude_cli.mjs"), fixture(scenario)],
        )
    }

    /// Polls `probe` every 10 ms until it yields a value; fails after 10 s.
    async fn wait_for<T>(what: &str, probe: impl Fn() -> Option<T>) -> T {
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            if let Some(value) = probe() {
                return value;
            }
            assert!(Instant::now() < deadline, "timed out waiting for {what}");
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }

    /// Starts `agent_spawn` in `cwd` and waits until the fake CLI holds
    /// its `initialize` reply. Resolves to the new worker's id and the
    /// running `agent_spawn`.
    async fn attach_held(ctx: &Ctx, cwd: &Path) -> (Uuid, JoinHandle<Result<Value, Value>>) {
        let spawn = tokio::spawn(agent_spawn(
            ctx.clone(),
            json!({"config": {"name": "w", "cwd": cwd}, "provider": "claude_code"}),
        ));
        let id = wait_for("the PTY worker", || {
            ctx.registry.list_workers().first().map(|worker| worker.id)
        })
        .await;
        wait_for("the held initialize", || {
            cwd.join(HELD_MARKER).exists().then_some(())
        })
        .await;
        (id, spawn)
    }

    /// Starts `kill_worker` for `id` and waits, polling every 10 ms, until
    /// it is underway: until the worker is closing, or the kill has
    /// already returned. Resolves to the running kill and whether the
    /// closing was observed; fails after 10 s. The probe queues nothing.
    async fn start_kill(ctx: &Ctx, id: Uuid) -> (JoinHandle<Result<Value, Value>>, bool) {
        let kill = tokio::spawn(kill_worker(ctx.clone(), json!({"id": id.to_string()})));
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            if ctx.agent_session_registry.is_closing(&id) {
                return (kill, true);
            }
            if kill.is_finished() {
                return (kill, false);
            }
            assert!(
                Instant::now() < deadline,
                "timed out waiting for the kill to begin"
            );
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }

    /// Starts `agent_spawn` in `cwd`, waits until the fake CLI holds its
    /// `initialize` reply, starts killing the worker, waits until the
    /// worker is closing (the kill waits for the held attach), releases
    /// the reply, then awaits both. Resolves to the killed worker's id,
    /// `agent_spawn`'s result, and every event emitted by the time
    /// `kill_worker` returned. Asserts that by then no session is
    /// registered.
    async fn kill_during_attach(
        ctx: &Ctx,
        cwd: &Path,
        events: &std::sync::mpsc::Receiver<DomainEvent>,
    ) -> (Uuid, Result<Value, Value>, Vec<SwarmEvent>) {
        let (id, spawn) = attach_held(ctx, cwd).await;
        let (kill, closing) = start_kill(ctx, id).await;
        assert!(closing, "the kill must wait for the held attach");
        std::fs::write(cwd.join(RELEASE_MARKER), "").unwrap();
        kill.await.unwrap().unwrap();
        assert!(
            ctx.agent_session_registry.get(&id).is_err(),
            "no session may be registered once kill_worker returns"
        );
        let at_kill = emitted(ctx, events).await;
        (id, spawn.await.unwrap(), at_kill)
    }

    /// Every envelope the engine has emitted so far.
    async fn emitted(
        ctx: &Ctx,
        events: &std::sync::mpsc::Receiver<DomainEvent>,
    ) -> Vec<SwarmEvent> {
        ctx.engine.flush().await.unwrap();
        events.try_iter().map(|envelope| envelope.event).collect()
    }

    /// Two overlapping calls, the first with a slow config write: the
    /// later call is the one in force, in the file and in the scheduler,
    /// and each reply names the cap in force when it was applied.
    #[tokio::test]
    async fn test_set_agent_concurrency_applies_the_last_call_to_start() {
        let (ctx, _dir, _events) = test_ctx();
        let (entered_tx, entered) = std::sync::mpsc::channel();
        let first = tokio::spawn({
            let ctx = ctx.clone();
            async move {
                apply_agent_concurrency(&ctx, 2, move |paths| {
                    entered_tx.send(()).unwrap();
                    std::thread::sleep(Duration::from_millis(300));
                    crate::config::write_value(paths, "agent_concurrency", json!(2))
                })
                .await
            }
        });
        wait_for("the first call's config write", || entered.try_recv().ok()).await;

        let second = apply_agent_concurrency(&ctx, 5, |paths| {
            crate::config::write_value(paths, "agent_concurrency", json!(5))
        })
        .await
        .unwrap();
        let first = first.await.unwrap().unwrap();

        assert_eq!(
            crate::config::read_value(&ctx.paths, "agent_concurrency"),
            Some(json!(5)),
            "the file holds the later call's value"
        );
        assert_eq!(
            ctx.scheduler.concurrency(),
            5,
            "the scheduler holds the later call's value"
        );
        assert_eq!(second, json!(5));
        assert_eq!(first, json!(2), "the first reply names its own cap");
    }

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

    /// Index of `worker_id`'s first `agent_session_exited` in `log`.
    fn exited_at(log: &[SwarmEvent], worker_id: Uuid) -> Option<usize> {
        log.iter().position(|event| {
            matches!(event, SwarmEvent::AgentSessionExited(exited) if exited.worker_id == worker_id)
        })
    }

    /// Index of `worker_id`'s `worker_killed` in `log`.
    fn killed_at(log: &[SwarmEvent], worker_id: Uuid) -> Option<usize> {
        log.iter().position(
            |event| matches!(event, SwarmEvent::WorkerKilled(killed) if killed.worker_id == worker_id),
        )
    }

    /// A kill while the session's handshake is in flight waits for it;
    /// the attach then finds the worker closing, stops its own session
    /// before the kill goes on, and reports no surviving worker.
    #[tokio::test]
    async fn test_agent_spawn_shuts_down_a_session_whose_worker_is_killed_during_attach() {
        let (ctx, dir, events) =
            test_ctx_with_claude(|sink| fake_claude(sink, "handshake_held.mjs"));
        let cwd = dir.join("cwd");
        std::fs::create_dir_all(&cwd).unwrap();

        let (id, result, at_kill) = kill_during_attach(&ctx, &cwd, &events).await;

        let err = result.unwrap_err();
        assert_eq!(err["workerId"], Value::Null, "{err}");
        assert!(ctx.agent_session_registry.get(&id).is_err());
        assert!(
            at_kill.iter().any(|event| matches!(
                event,
                SwarmEvent::AgentSessionExited(exited) if exited.worker_id == id
            )),
            "the attached session must have been shut down before kill_worker returned"
        );
        let (exited, killed) = (exited_at(&at_kill, id), killed_at(&at_kill, id));
        assert!(
            exited.is_some() && exited < killed,
            "the session must exit before the worker is killed: exited at {exited:?}, killed at {killed:?}"
        );
    }

    /// A kill during the handshake followed by a failed handshake reports
    /// no surviving worker, never a worker usable as a plain terminal.
    #[tokio::test]
    async fn test_agent_spawn_reports_no_worker_when_attach_fails_after_a_kill() {
        let (ctx, dir, events) =
            test_ctx_with_claude(|sink| fake_claude(sink, "handshake_held_then_refused.mjs"));
        let cwd = dir.join("cwd");
        std::fs::create_dir_all(&cwd).unwrap();

        let (id, result, at_kill) = kill_during_attach(&ctx, &cwd, &events).await;

        let err = result.unwrap_err();
        assert_eq!(err["workerId"], Value::Null, "{err}");
        assert!(ctx.agent_session_registry.get(&id).is_err());
        assert!(
            killed_at(&at_kill, id).is_some(),
            "the kill completed before kill_worker returned"
        );
    }

    /// While a kill drains an attach still in its handshake, the worker
    /// refuses a second attach and a new turn as closing, and the first
    /// attach ends with no surviving worker or session.
    #[tokio::test]
    async fn test_attach_and_turn_admission_are_refused_while_the_worker_is_closing() {
        let (ctx, dir, _events) =
            test_ctx_with_claude(|sink| fake_claude(sink, "handshake_held.mjs"));
        let cwd = dir.join("cwd");
        std::fs::create_dir_all(&cwd).unwrap();
        let (id, spawn) = attach_held(&ctx, &cwd).await;

        let (kill, closing_seen) = start_kill(&ctx, id).await;
        assert!(closing_seen, "the kill must hold the worker closing");
        let closing = AppError::WorkerClosing { id: id.to_string() }.to_string();
        let turn = agent_send_turn(
            ctx.clone(),
            json!({"workerId": id.to_string(), "prompt": "p"}),
        )
        .await
        .unwrap_err();
        assert_eq!(turn, closing);
        let attach = attach_session(
            &ctx,
            id,
            cwd.display().to_string(),
            ProviderId::ClaudeCode,
            None,
            None,
        )
        .await
        .unwrap_err();
        assert_eq!(attach["workerId"], Value::Null, "{attach}");
        assert_eq!(attach["message"], closing);

        std::fs::write(cwd.join(RELEASE_MARKER), "").unwrap();
        kill.await.unwrap().unwrap();
        let err = spawn.await.unwrap().unwrap_err();
        assert_eq!(err["workerId"], Value::Null, "{err}");
        assert!(ctx.agent_session_registry.get(&id).is_err());
        assert!(ctx.registry.get_worker(&id).is_err());
    }

    /// `kill_worker` returns only after an attach racing it has ended:
    /// once it returns no session is registered, and the attaching
    /// session's `agent_session_exited` already precedes `worker_killed`.
    /// The handshake is released only once the kill is underway, so a
    /// kill that does not wait for it returns first.
    #[tokio::test]
    async fn test_kill_worker_returns_only_after_an_attaching_session_has_exited() {
        let (ctx, dir, events) =
            test_ctx_with_claude(|sink| fake_claude(sink, "handshake_held.mjs"));
        let cwd = dir.join("cwd");
        std::fs::create_dir_all(&cwd).unwrap();
        let (id, spawn) = attach_held(&ctx, &cwd).await;

        let (kill, _closing_seen) = start_kill(&ctx, id).await;
        std::fs::write(cwd.join(RELEASE_MARKER), "").unwrap();
        kill.await.unwrap().unwrap();

        assert!(
            ctx.agent_session_registry.get(&id).is_err(),
            "no session may be registered once kill_worker returns"
        );
        let at_kill = emitted(&ctx, &events).await;
        let (exited, killed) = (exited_at(&at_kill, id), killed_at(&at_kill, id));
        assert!(
            exited.is_some() && killed.is_some() && exited < killed,
            "the session must exit before the worker is killed: exited at {exited:?}, killed at {killed:?}"
        );
        let err = spawn.await.unwrap().unwrap_err();
        assert_eq!(err["workerId"], Value::Null, "{err}");
        assert!(ctx.agent_session_registry.get(&id).is_err());
    }

    /// A worker killed before its session attaches gets none: the lookup
    /// fails before the CLI starts.
    #[tokio::test]
    async fn test_attach_session_refuses_a_worker_killed_before_attach() {
        let (ctx, dir, events) =
            test_ctx_with_claude(|sink| fake_claude(sink, "handshake_held.mjs"));
        let cwd = dir.join("cwd");
        std::fs::create_dir_all(&cwd).unwrap();
        // Were the CLI started, it would answer at once.
        std::fs::write(cwd.join(RELEASE_MARKER), "").unwrap();
        let id = spawn_worker(ctx.clone(), json!({"config": {"name": "w", "cwd": &cwd}}))
            .await
            .unwrap();
        let id: Uuid = id.as_str().unwrap().parse().unwrap();
        kill_worker(ctx.clone(), json!({"id": id.to_string()}))
            .await
            .unwrap();

        let err = attach_session(
            &ctx,
            id,
            cwd.display().to_string(),
            ProviderId::ClaudeCode,
            None,
            None,
        )
        .await
        .unwrap_err();

        assert_eq!(err["workerId"], Value::Null, "{err}");
        assert_eq!(
            err["message"],
            AppError::WorkerNotFound { id: id.to_string() }.to_string()
        );
        assert!(!cwd.join(HELD_MARKER).exists(), "the CLI must not start");
        assert!(ctx.agent_session_registry.get(&id).is_err());
        assert!(
            !emitted(&ctx, &events)
                .await
                .iter()
                .any(|event| matches!(event, SwarmEvent::AgentSessionStarted(_))),
            "no session may start"
        );
    }
}
