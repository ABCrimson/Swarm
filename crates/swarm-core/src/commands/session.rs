//! Session CRUD registry handlers. Auto-saves via
//! [`crate::session::persist`] after every mutation, exactly mirroring
//! the pre-Phase-2 Tauri commands' plugin-store auto-save (now atomic
//! JSON, shared by both shells — see the persist module's doc).

use serde::Deserialize;
use serde_json::Value;

use crate::events::{
    SessionCreatedPayload, SessionDeletedPayload, SessionWorkerRemovedPayload, SwarmEvent,
};

use super::{Ctx, err_value, ok_value, parse_args, parse_provenance, parse_uuid};

/// Awaits the save (matching the pre-Phase-2 Tauri commands' blocking
/// `spawn_blocking(...).await` call) but never propagates a failure to
/// the caller — a persistence hiccup must not undo an already-applied
/// in-memory mutation, only get logged.
async fn autosave(ctx: &Ctx) {
    let paths = ctx.paths.clone();
    let manager = ctx.session_manager.clone();
    match tokio::task::spawn_blocking(move || crate::session::persist::save(&paths, &manager)).await
    {
        Ok(Err(e)) => tracing::error!(error = %e, "failed to auto-save sessions"),
        Err(e) => tracing::error!(error = %e, "auto-save sessions task panicked"),
        Ok(Ok(())) => {}
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateSessionArgs {
    name: String,
    config: serde_json::Value,
    #[serde(default)]
    origin_worker: Option<String>,
    #[serde(default)]
    cause_seq: Option<u64>,
}

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

pub async fn list_sessions(ctx: Ctx, _args: Value) -> Result<Value, Value> {
    ok_value(&ctx.session_manager.list_sessions())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GetSessionArgs {
    id: String,
}

pub async fn get_session(ctx: Ctx, args: Value) -> Result<Value, Value> {
    let GetSessionArgs { id } = parse_args(args)?;
    let uuid = parse_uuid(&id)?;
    let session = ctx
        .session_manager
        .get_session(&uuid)
        .map_err(|e| err_value(&e))?;
    ok_value(&session)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionAddWorkerArgs {
    session_id: String,
    worker_id: String,
}

pub async fn session_add_worker(ctx: Ctx, args: Value) -> Result<Value, Value> {
    let SessionAddWorkerArgs {
        session_id,
        worker_id,
    } = parse_args(args)?;
    let session_uuid = parse_uuid(&session_id)?;
    let worker_uuid = parse_uuid(&worker_id)?;

    ctx.session_manager
        .add_worker_to_session(&session_uuid, worker_uuid)
        .map_err(|e| err_value(&e))?;

    autosave(&ctx).await;
    ok_value(&())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionRemoveWorkerArgs {
    session_id: String,
    worker_id: String,
    #[serde(default)]
    origin_worker: Option<String>,
    #[serde(default)]
    cause_seq: Option<u64>,
}

/// The counterpart to [`session_add_worker`] — without it, `workerIds`
/// only ever grew across a worker's kill/crash. Removing a worker id
/// that isn't currently a member of the session is a benign no-op (see
/// [`crate::session::SessionManager::remove_worker_from_session`]'s
/// idempotence doc), not an error — only a missing session errors.
pub async fn session_remove_worker(ctx: Ctx, args: Value) -> Result<Value, Value> {
    let SessionRemoveWorkerArgs {
        session_id,
        worker_id,
        origin_worker,
        cause_seq,
    } = parse_args(args)?;
    let session_uuid = parse_uuid(&session_id)?;
    let worker_uuid = parse_uuid(&worker_id)?;
    let provenance = parse_provenance(origin_worker, cause_seq)?;

    ctx.session_manager
        .remove_worker_from_session(&session_uuid, worker_uuid)
        .map_err(|e| err_value(&e))?;

    ctx.sink.emit_with(
        SwarmEvent::SessionWorkerRemoved(SessionWorkerRemovedPayload {
            session_id: session_uuid,
            worker_id: worker_uuid,
        }),
        provenance,
    );

    autosave(&ctx).await;
    ok_value(&())
}
