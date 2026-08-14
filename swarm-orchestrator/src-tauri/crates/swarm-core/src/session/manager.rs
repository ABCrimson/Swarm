//! Session lifecycle manager.
//!
//! Handles creation, retrieval, deletion, and restoration
//! of user sessions across application restarts. Sessions
//! are stored in a concurrent `DashMap` for thread-safe access.

use dashmap::DashMap;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use uuid::Uuid;

use crate::error::AppError;

/// Represents a user session containing a set of workers and configuration.
///
/// Sessions group related workers together and store arbitrary
/// JSON configuration. They are persisted to disk via
/// [`super::store`] for crash recovery.
///
/// # Fields
///
/// * `id` - Unique session identifier (UUID v4)
/// * `name` - Human-readable session name
/// * `worker_ids` - UUIDs of workers belonging to this session
/// * `created_at` - Unix timestamp (seconds) when the session was created
/// * `config` - Arbitrary JSON configuration blob
///
/// # Examples
///
/// ```
/// use serde_json::json;
///
/// let session_json = json!({
///     "id": "550e8400-e29b-41d4-a716-446655440000",
///     "name": "Research Session",
///     "workerIds": [],
///     "createdAt": 1700000000,
///     "config": { "model": "model-id" }
/// });
/// ```
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    /// Unique session identifier.
    pub id: Uuid,
    /// Human-readable session name.
    pub name: String,
    /// UUIDs of workers belonging to this session.
    pub worker_ids: Vec<Uuid>,
    /// Unix timestamp (seconds) when the session was created.
    pub created_at: i64,
    /// Arbitrary JSON configuration for this session.
    pub config: serde_json::Value,
}

/// Thread-safe manager for all active sessions.
///
/// Uses `DashMap` for concurrent access, matching the
/// [`WorkerRegistry`](crate::worker::registry::WorkerRegistry) pattern.
/// The manager is stored as Tauri managed state and shared
/// across all command handlers.
///
/// # Examples
///
/// ```ignore
/// use swarm_core::session::SessionManager;
/// use serde_json::json;
///
/// let manager = SessionManager::new();
/// let session = manager.create_session(
///     "Research".to_string(),
///     json!({ "model": "model-id" }),
/// );
/// assert_eq!(session.name, "Research");
/// ```
#[derive(Clone)]
pub struct SessionManager {
    /// Concurrent map of session ID to session data.
    pub sessions: Arc<DashMap<Uuid, Session>>,
}

impl SessionManager {
    /// Creates a new empty session manager.
    ///
    /// # Returns
    ///
    /// A `SessionManager` with zero sessions.
    pub fn new() -> Self {
        Self {
            sessions: Arc::new(DashMap::new()),
        }
    }

    /// Creates a new session with the given name and configuration.
    ///
    /// Generates a UUID v4 identifier and records the current
    /// Unix timestamp. The session starts with an empty worker list.
    ///
    /// # Arguments
    ///
    /// * `name` - Human-readable session name
    /// * `config` - Arbitrary JSON configuration for the session
    ///
    /// # Returns
    ///
    /// The newly created [`Session`].
    pub fn create_session(&self, name: String, config: serde_json::Value) -> Session {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);

        let session = Session {
            id: Uuid::new_v4(),
            name,
            worker_ids: Vec::new(),
            created_at: now,
            config,
        };

        self.sessions.insert(session.id, session.clone());
        tracing::info!(session_id = %session.id, name = %session.name, "session created");
        session
    }

    /// Gets a session by ID.
    ///
    /// # Arguments
    ///
    /// * `id` - The UUID of the session to retrieve
    ///
    /// # Returns
    ///
    /// A clone of the [`Session`] matching the given ID.
    ///
    /// # Errors
    ///
    /// * [`AppError::SessionNotFound`] - No session with the given ID exists
    pub fn get_session(&self, id: &Uuid) -> Result<Session, AppError> {
        self.sessions
            .get(id)
            .map(|entry| entry.clone())
            .ok_or_else(|| AppError::SessionNotFound { id: id.to_string() })
    }

    /// Deletes a session by ID and returns it.
    ///
    /// # Arguments
    ///
    /// * `id` - The UUID of the session to delete
    ///
    /// # Returns
    ///
    /// The removed [`Session`].
    ///
    /// # Errors
    ///
    /// * [`AppError::SessionNotFound`] - No session with the given ID exists
    pub fn delete_session(&self, id: &Uuid) -> Result<Session, AppError> {
        self.sessions
            .remove(id)
            .map(|(_, session)| session)
            .ok_or_else(|| AppError::SessionNotFound { id: id.to_string() })
    }

    /// Lists all sessions as cloned snapshots.
    ///
    /// # Returns
    ///
    /// A `Vec<Session>` containing all registered sessions.
    pub fn list_sessions(&self) -> Vec<Session> {
        self.sessions.iter().map(|entry| entry.clone()).collect()
    }

    /// Adds a worker to a session's worker list.
    ///
    /// # Arguments
    ///
    /// * `session_id` - The UUID of the target session
    /// * `worker_id` - The UUID of the worker to add
    ///
    /// # Errors
    ///
    /// * [`AppError::SessionNotFound`] - No session with the given ID exists
    pub fn add_worker_to_session(
        &self,
        session_id: &Uuid,
        worker_id: Uuid,
    ) -> Result<(), AppError> {
        let mut entry =
            self.sessions
                .get_mut(session_id)
                .ok_or_else(|| AppError::SessionNotFound {
                    id: session_id.to_string(),
                })?;
        entry.worker_ids.push(worker_id);
        Ok(())
    }

    /// Loads sessions from a stored list for restore on startup.
    ///
    /// Inserts each session into the DashMap, replacing any
    /// existing entries with the same ID.
    ///
    /// # Arguments
    ///
    /// * `sessions` - A list of previously serialized sessions
    pub fn restore_sessions(&self, sessions: Vec<Session>) {
        for session in sessions {
            self.sessions.insert(session.id, session);
        }
        tracing::info!(count = self.sessions.len(), "sessions restored");
    }
}

impl Default for SessionManager {
    fn default() -> Self {
        Self::new()
    }
}
