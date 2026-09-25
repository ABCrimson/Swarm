//! Session registry handlers. Every mutation emits its event, then
//! persists the session set (see [`crate::session::persist`]).

use serde::Deserialize;
use serde_json::Value;

use crate::events::{
    SessionCreatedPayload, SessionDeletedPayload, SessionWorkerAddedPayload,
    SessionWorkerRemovedPayload, SwarmEvent,
};

use super::{Ctx, err_value, ok_value, parse_args, parse_provenance, parse_uuid};

/// Persists the session set on a blocking thread, waiting for it. A
/// failure is logged, never returned: it must not undo, or report as
/// failed, a mutation that has already been applied and emitted.
async fn autosave(ctx: &Ctx) {
    let paths = ctx.paths.clone();
    let manager = ctx.session_manager.clone();
    match tokio::task::spawn_blocking(move || crate::session::persist::save(&paths, &manager)).await
    {
        Ok(Ok(())) => {}
        Ok(Err(e)) => tracing::error!(error = %e, "failed to auto-save sessions"),
        Err(e) => tracing::error!(error = %e, "auto-save sessions task panicked"),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateSessionArgs {
    name: String,
    config: Value,
    #[serde(default)]
    origin_worker: Option<String>,
    #[serde(default)]
    cause_seq: Option<u64>,
}

/// Creates a session; emits `session_created`.
pub async fn create_session(ctx: Ctx, args: Value) -> Result<Value, Value> {
    let CreateSessionArgs {
        name,
        config,
        origin_worker,
        cause_seq,
    } = parse_args(args)?;
    let provenance = parse_provenance(origin_worker, cause_seq)?;
    let session = ctx.session_manager.create_session(name.clone(), config);

    ctx.sink.emit_with(
        SwarmEvent::SessionCreated(SessionCreatedPayload {
            session_id: session.id,
            name,
        }),
        provenance,
    );

    autosave(&ctx).await;
    ok_value(&session)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionIdArgs {
    id: String,
    #[serde(default)]
    origin_worker: Option<String>,
    #[serde(default)]
    cause_seq: Option<u64>,
}

/// Deletes a session; emits `session_deleted`.
pub async fn delete_session(ctx: Ctx, args: Value) -> Result<Value, Value> {
    let SessionIdArgs {
        id,
        origin_worker,
        cause_seq,
    } = parse_args(args)?;
    let uuid = parse_uuid(&id)?;
    let provenance = parse_provenance(origin_worker, cause_seq)?;
    ctx.session_manager
        .delete_session(&uuid)
        .map_err(|e| err_value(&e))?;

    ctx.sink.emit_with(
        SwarmEvent::SessionDeleted(SessionDeletedPayload { session_id: uuid }),
        provenance,
    );

    autosave(&ctx).await;
    ok_value(&())
}

/// Every session.
pub async fn list_sessions(ctx: Ctx, _args: Value) -> Result<Value, Value> {
    ok_value(&ctx.session_manager.list_sessions())
}

#[derive(Deserialize)]
struct GetSessionArgs {
    id: String,
}

/// One session by id.
pub async fn get_session(ctx: Ctx, args: Value) -> Result<Value, Value> {
    let GetSessionArgs { id } = parse_args(args)?;
    let uuid = parse_uuid(&id)?;
    let session = ctx
        .session_manager
        .get_session(&uuid)
        .map_err(|e| err_value(&e))?;
    ok_value(&session)
}

/// Arguments of both membership commands.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct MembershipArgs {
    session_id: String,
    worker_id: String,
    #[serde(default)]
    origin_worker: Option<String>,
    #[serde(default)]
    cause_seq: Option<u64>,
}

/// Adds a worker to a session. Emits `session_worker_added` (and saves)
/// only when membership actually changed: re-adding a current member is
/// a no-op.
pub async fn session_add_worker(ctx: Ctx, args: Value) -> Result<Value, Value> {
    let MembershipArgs {
        session_id,
        worker_id,
        origin_worker,
        cause_seq,
    } = parse_args(args)?;
    let session_id = parse_uuid(&session_id)?;
    let worker_id = parse_uuid(&worker_id)?;
    let provenance = parse_provenance(origin_worker, cause_seq)?;

    let added = ctx
        .session_manager
        .add_worker_to_session(&session_id, worker_id)
        .map_err(|e| err_value(&e))?;
    if added {
        ctx.sink.emit_with(
            SwarmEvent::SessionWorkerAdded(SessionWorkerAddedPayload {
                session_id,
                worker_id,
            }),
            provenance,
        );
        autosave(&ctx).await;
    }
    ok_value(&())
}

/// Removes a worker from a session; emits `session_worker_removed`.
/// Removing a non-member still succeeds and still emits, so a listener
/// that believes the worker is a member converges either way (see
/// [`crate::session::SessionManager::remove_worker_from_session`]).
pub async fn session_remove_worker(ctx: Ctx, args: Value) -> Result<Value, Value> {
    let MembershipArgs {
        session_id,
        worker_id,
        origin_worker,
        cause_seq,
    } = parse_args(args)?;
    let session_id = parse_uuid(&session_id)?;
    let worker_id = parse_uuid(&worker_id)?;
    let provenance = parse_provenance(origin_worker, cause_seq)?;

    ctx.session_manager
        .remove_worker_from_session(&session_id, worker_id)
        .map_err(|e| err_value(&e))?;

    ctx.sink.emit_with(
        SwarmEvent::SessionWorkerRemoved(SessionWorkerRemovedPayload {
            session_id,
            worker_id,
        }),
        provenance,
    );

    autosave(&ctx).await;
    ok_value(&())
}

#[cfg(test)]
mod tests {
    use serde_json::json;
    use uuid::Uuid;

    use super::super::test_support::test_ctx;
    use super::*;
    use crate::orchestration::DomainEvent;

    /// `session_add_worker` emits `session_worker_added` (with its
    /// provenance) exactly once per real membership change, so a replay
    /// of the log rebuilds membership growth as well as shrinkage.
    #[tokio::test]
    async fn test_session_add_worker_emits_once_per_membership_change() {
        let (ctx, _dir, events) = test_ctx();
        let session = create_session(ctx.clone(), json!({"name": "S", "config": {}}))
            .await
            .unwrap();
        let session_id = session["id"].as_str().unwrap().to_owned();
        let worker_id = Uuid::new_v4();
        let origin = Uuid::new_v4();

        for _ in 0..2 {
            session_add_worker(
                ctx.clone(),
                json!({
                    "sessionId": session_id,
                    "workerId": worker_id.to_string(),
                    "originWorker": origin.to_string(),
                    "causeSeq": 1,
                }),
            )
            .await
            .unwrap();
        }
        ctx.engine.flush().await.unwrap();

        let added: Vec<DomainEvent> = events
            .try_iter()
            .filter(|e| e.event.type_tag() == "session_worker_added")
            .collect();
        assert_eq!(added.len(), 1, "the idempotent re-add emits nothing");
        assert_eq!(added[0].origin_worker, Some(origin));
        assert_eq!(added[0].cause_seq, Some(1));
        let SwarmEvent::SessionWorkerAdded(payload) = &added[0].event else {
            panic!("expected session_worker_added");
        };
        assert_eq!(payload.worker_id, worker_id);
        assert_eq!(
            ctx.session_manager
                .get_session(&payload.session_id)
                .unwrap()
                .worker_ids,
            vec![worker_id]
        );
    }
}
