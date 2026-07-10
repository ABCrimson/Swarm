//! Session management Tauri IPC command handlers.
//!
//! Exposes session CRUD operations to the React frontend.
//! Sessions are automatically persisted to disk via
//! [`crate::session::store`] after each mutation.
//!
//! Blocking disk I/O for session persistence is offloaded to
//! `tokio::task::spawn_blocking` to avoid starving the async executor.

use tauri::AppHandle;
use uuid::Uuid;

use crate::events::{SessionCreatedPayload, SessionDeletedPayload, SwarmEvent, emit_event};
use crate::session::manager::{Session, SessionManager};
use crate::session::store;

/// Creates a new session with the given name and configuration.
///
/// The session is added to the in-memory session manager,
/// a `session_created` event is emitted on `swarm://events`, and the
/// full session list is auto-saved to the persistent store.
///
/// # Arguments
///
/// * `app` - Tauri app handle (injected by Tauri)
/// * `manager` - Shared session manager (managed state)
/// * `name` - Human-readable session name
/// * `config` - Arbitrary JSON configuration for the session
///
/// # Returns
///
/// The newly created [`Session`] with a generated UUID and timestamp.
///
/// # Errors
///
/// Returns a `String` error if auto-save to the persistent store fails.
/// The session is still created in memory even if persistence fails.
#[tauri::command]
#[tracing::instrument(skip(app, manager))]
pub async fn create_session(
    app: AppHandle,
    manager: tauri::State<'_, SessionManager>,
    name: String,
    config: serde_json::Value,
) -> Result<Session, String> {
    tracing::info!(name = %name, "create_session called");
    let session = manager.create_session(name.clone(), config);

    emit_event(
        &app,
        SwarmEvent::SessionCreated(SessionCreatedPayload {
            session_id: session.id,
            name,
        }),
    );

    // Auto-save to persistent store via spawn_blocking (blocking disk I/O)
    let app_clone = app.clone();
    let manager_clone = manager.inner().clone();
    match tokio::task::spawn_blocking(move || store::save_sessions(&app_clone, &manager_clone))
        .await
    {
        Ok(Err(e)) => {
            tracing::error!(error = %e, "failed to auto-save sessions after create");
        }
        Err(e) => {
            tracing::error!(error = %e, "save_sessions task panicked after create");
        }
        Ok(Ok(())) => {}
    }

    Ok(session)
}

/// Deletes a session by ID.
///
/// Removes the session from the in-memory manager, emits a
/// `session_deleted` event on `swarm://events`, and auto-saves the
/// remaining sessions to the persistent store.
///
/// # Arguments
///
/// * `app` - Tauri app handle (injected by Tauri)
/// * `manager` - Shared session manager (managed state)
/// * `id` - UUID string of the session to delete
///
/// # Errors
///
/// Returns a `String` error if:
/// - The `id` is not a valid UUID
/// - No session with the given ID exists
#[tauri::command]
#[tracing::instrument(skip(app, manager))]
pub async fn delete_session(
    app: AppHandle,
    manager: tauri::State<'_, SessionManager>,
    id: String,
) -> Result<(), String> {
    tracing::info!(session_id = %id, "delete_session called");
    let uuid = Uuid::parse_str(&id).map_err(|e| {
        tracing::error!(error = %e, "invalid session ID");
        e.to_string()
    })?;
    let _session = manager.delete_session(&uuid).map_err(|e| {
        tracing::error!(error = %e, "failed to delete session");
        e.to_string()
    })?;

    emit_event(
        &app,
        SwarmEvent::SessionDeleted(SessionDeletedPayload { session_id: uuid }),
    );

    // Auto-save after deletion via spawn_blocking (blocking disk I/O)
    let app_clone = app.clone();
    let manager_clone = manager.inner().clone();
    match tokio::task::spawn_blocking(move || store::save_sessions(&app_clone, &manager_clone))
        .await
    {
        Ok(Err(e)) => {
            tracing::error!(error = %e, "failed to auto-save sessions after delete");
        }
        Err(e) => {
            tracing::error!(error = %e, "save_sessions task panicked after delete");
        }
        Ok(Ok(())) => {}
    }

    Ok(())
}

/// Lists all active sessions.
///
/// # Arguments
///
/// * `manager` - Shared session manager (managed state)
///
/// # Returns
///
/// A `Vec<Session>` containing all registered sessions.
#[tauri::command]
#[tracing::instrument(skip(manager))]
pub async fn list_sessions(
    manager: tauri::State<'_, SessionManager>,
) -> Result<Vec<Session>, String> {
    tracing::debug!("list_sessions called");
    Ok(manager.list_sessions())
}

/// Adds a worker to a session's worker list.
///
/// Registers the worker ID against the session in the in-memory
/// manager and auto-saves the updated session list to the
/// persistent store.
///
/// # Arguments
///
/// * `app` - Tauri app handle (injected by Tauri)
/// * `manager` - Shared session manager (managed state)
/// * `session_id` - UUID string of the target session
/// * `worker_id` - UUID string of the worker to add
///
/// # Errors
///
/// Returns a `String` error if:
/// - Either UUID string is invalid
/// - No session with the given ID exists
#[tauri::command]
#[tracing::instrument(skip(app, manager))]
pub async fn session_add_worker(
    app: AppHandle,
    manager: tauri::State<'_, SessionManager>,
    session_id: String,
    worker_id: String,
) -> Result<(), String> {
    tracing::info!(session_id = %session_id, worker_id = %worker_id, "session_add_worker called");
    let session_uuid = Uuid::parse_str(&session_id).map_err(|e| {
        tracing::error!(error = %e, "invalid session ID");
        e.to_string()
    })?;
    let worker_uuid = Uuid::parse_str(&worker_id).map_err(|e| {
        tracing::error!(error = %e, "invalid worker ID");
        e.to_string()
    })?;

    manager
        .add_worker_to_session(&session_uuid, worker_uuid)
        .map_err(|e| {
            tracing::error!(error = %e, "failed to add worker to session");
            e.to_string()
        })?;

    // Auto-save after mutation via spawn_blocking (blocking disk I/O)
    let app_clone = app.clone();
    let manager_clone = manager.inner().clone();
    match tokio::task::spawn_blocking(move || store::save_sessions(&app_clone, &manager_clone))
        .await
    {
        Ok(Err(e)) => {
            tracing::error!(error = %e, "failed to auto-save sessions after add_worker");
        }
        Err(e) => {
            tracing::error!(error = %e, "save_sessions task panicked after add_worker");
        }
        Ok(Ok(())) => {}
    }

    Ok(())
}

/// Gets a single session by ID.
///
/// # Arguments
///
/// * `manager` - Shared session manager (managed state)
/// * `id` - UUID string of the session to retrieve
///
/// # Returns
///
/// The [`Session`] matching the given ID.
///
/// # Errors
///
/// Returns a `String` error if:
/// - The `id` is not a valid UUID
/// - No session with the given ID exists
#[tauri::command]
#[tracing::instrument(skip(manager))]
pub async fn get_session(
    manager: tauri::State<'_, SessionManager>,
    id: String,
) -> Result<Session, String> {
    tracing::debug!(session_id = %id, "get_session called");
    let uuid = Uuid::parse_str(&id).map_err(|e| {
        tracing::error!(error = %e, "invalid session ID");
        e.to_string()
    })?;
    manager.get_session(&uuid).map_err(|e| {
        tracing::error!(error = %e, "failed to get session");
        e.to_string()
    })
}
