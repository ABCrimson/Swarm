//! The in-memory session set: create, look up, delete, restore, and
//! per-session worker membership.

use std::sync::Arc;

use dashmap::DashMap;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::error::AppError;

/// A named group of workers plus a free-form JSON configuration.
///
/// Persisted to `sessions.json` by [`super::persist`]; serialized with
/// camelCase keys, on disk and on the wire alike.
///
/// # Examples
///
/// ```
/// use swarm_core::session::Session;
///
/// let session: Session = serde_json::from_value(serde_json::json!({
///     "id": "550e8400-e29b-41d4-a716-446655440000",
///     "name": "Research Session",
///     "workerIds": [],
///     "createdAt": 1_700_000_000,
///     "config": { "model": "model-id" }
/// }))
/// .unwrap();
/// assert_eq!(session.name, "Research Session");
/// assert_eq!(session.config["model"], "model-id");
/// ```
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    /// Unique session identifier (UUID v4).
    pub id: Uuid,
    /// Human-readable session name.
    pub name: String,
    /// Workers belonging to this session, in the order they joined; no
    /// duplicates.
    pub worker_ids: Vec<Uuid>,
    /// Unix timestamp (seconds) when the session was created.
    pub created_at: i64,
    /// Arbitrary JSON configuration for this session.
    pub config: serde_json::Value,
}

/// The shared, concurrent session set.
///
/// Cloning is one `Arc` bump: [`crate::runtime::Runtime::start`] builds
/// one manager and every command handler shares it through
/// [`crate::commands::Ctx`].
///
/// # Examples
///
/// ```
/// use swarm_core::session::SessionManager;
/// use uuid::Uuid;
///
/// let manager = SessionManager::new();
/// let session = manager.create_session("Research".to_string(), serde_json::json!({}));
/// let worker = Uuid::new_v4();
///
/// assert!(manager.add_worker_to_session(&session.id, worker).unwrap());
/// assert!(!manager.add_worker_to_session(&session.id, worker).unwrap(), "already a member");
/// assert_eq!(manager.get_session(&session.id).unwrap().worker_ids, vec![worker]);
/// ```
#[derive(Clone, Default)]
pub struct SessionManager {
    sessions: Arc<DashMap<Uuid, Session>>,
}

impl SessionManager {
    /// An empty session set.
    pub fn new() -> Self {
        Self::default()
    }

    /// Creates and stores a session with a fresh UUID, the current time,
    /// and no workers.
    pub fn create_session(&self, name: String, config: serde_json::Value) -> Session {
        let session = Session {
            id: Uuid::new_v4(),
            name,
            worker_ids: Vec::new(),
            created_at: crate::clock::unix_secs(),
            config,
        };
        self.sessions.insert(session.id, session.clone());
        tracing::info!(session_id = %session.id, name = %session.name, "session created");
        session
    }

    /// A snapshot of one session.
    ///
    /// # Errors
    ///
    /// [`AppError::SessionNotFound`] when no session has this id.
    pub fn get_session(&self, id: &Uuid) -> Result<Session, AppError> {
        self.sessions
            .get(id)
            .map(|entry| entry.clone())
            .ok_or_else(|| not_found(id))
    }

    /// Removes a session and returns it.
    ///
    /// # Errors
    ///
    /// [`AppError::SessionNotFound`] when no session has this id.
    pub fn delete_session(&self, id: &Uuid) -> Result<Session, AppError> {
        self.sessions
            .remove(id)
            .map(|(_, session)| session)
            .ok_or_else(|| not_found(id))
    }

    /// A snapshot of every session, in no particular order.
    pub fn list_sessions(&self) -> Vec<Session> {
        self.sessions.iter().map(|entry| entry.clone()).collect()
    }

    /// Adds a worker to a session's `worker_ids`. Idempotent: re-adding
    /// a current member changes nothing. Returns whether membership
    /// changed.
    ///
    /// # Errors
    ///
    /// [`AppError::SessionNotFound`] when no session has this id.
    pub fn add_worker_to_session(
        &self,
        session_id: &Uuid,
        worker_id: Uuid,
    ) -> Result<bool, AppError> {
        let mut entry = self
            .sessions
            .get_mut(session_id)
            .ok_or_else(|| not_found(session_id))?;
        if entry.worker_ids.contains(&worker_id) {
            return Ok(false);
        }
        entry.worker_ids.push(worker_id);
        tracing::info!(%session_id, %worker_id, "worker added to session");
        Ok(true)
    }

    /// Removes a worker from a session's `worker_ids` (typically because
    /// the worker was killed or exited). Idempotent: removing a
    /// non-member is a no-op, not an error.
    ///
    /// # Errors
    ///
    /// [`AppError::SessionNotFound`] when no session has this id.
    pub fn remove_worker_from_session(
        &self,
        session_id: &Uuid,
        worker_id: Uuid,
    ) -> Result<(), AppError> {
        let mut entry = self
            .sessions
            .get_mut(session_id)
            .ok_or_else(|| not_found(session_id))?;
        entry.worker_ids.retain(|id| *id != worker_id);
        tracing::info!(%session_id, %worker_id, "worker removed from session");
        Ok(())
    }

    /// Inserts previously persisted sessions (replacing any with the same
    /// id) — used once at startup by [`super::persist::load`].
    pub fn restore_sessions(&self, sessions: Vec<Session>) {
        for session in sessions {
            self.sessions.insert(session.id, session);
        }
        tracing::info!(count = self.sessions.len(), "sessions restored");
    }
}

fn not_found(id: &Uuid) -> AppError {
    AppError::SessionNotFound { id: id.to_string() }
}

#[cfg(test)]
mod tests {
    use std::assert_matches;

    use super::*;

    fn manager_with_session() -> (SessionManager, Uuid) {
        let manager = SessionManager::new();
        let id = manager
            .create_session("Test".to_string(), serde_json::json!({}))
            .id;
        (manager, id)
    }

    fn members(manager: &SessionManager, id: &Uuid) -> Vec<Uuid> {
        manager.get_session(id).unwrap().worker_ids
    }

    #[test]
    fn test_add_then_remove_roundtrips() {
        let (manager, id) = manager_with_session();
        let worker = Uuid::new_v4();
        assert!(manager.add_worker_to_session(&id, worker).unwrap());
        assert_eq!(members(&manager, &id), vec![worker]);
        manager.remove_worker_from_session(&id, worker).unwrap();
        assert!(members(&manager, &id).is_empty());
    }

    /// Re-adding a member used to push a duplicate id.
    #[test]
    fn test_add_is_idempotent_and_reports_no_change() {
        let (manager, id) = manager_with_session();
        let worker = Uuid::new_v4();
        assert!(manager.add_worker_to_session(&id, worker).unwrap());
        assert!(!manager.add_worker_to_session(&id, worker).unwrap());
        assert_eq!(members(&manager, &id), vec![worker]);
    }

    #[test]
    fn test_remove_is_idempotent_for_a_non_member() {
        let (manager, id) = manager_with_session();
        manager
            .remove_worker_from_session(&id, Uuid::new_v4())
            .unwrap();
        assert!(members(&manager, &id).is_empty());
    }

    #[test]
    fn test_remove_only_removes_the_target_worker() {
        let (manager, id) = manager_with_session();
        let (a, b) = (Uuid::new_v4(), Uuid::new_v4());
        manager.add_worker_to_session(&id, a).unwrap();
        manager.add_worker_to_session(&id, b).unwrap();
        manager.remove_worker_from_session(&id, a).unwrap();
        assert_eq!(members(&manager, &id), vec![b]);
    }

    #[test]
    fn test_membership_changes_on_an_unknown_session_fail() {
        let manager = SessionManager::new();
        assert_matches!(
            manager.add_worker_to_session(&Uuid::new_v4(), Uuid::new_v4()),
            Err(AppError::SessionNotFound { .. })
        );
        assert_matches!(
            manager.remove_worker_from_session(&Uuid::new_v4(), Uuid::new_v4()),
            Err(AppError::SessionNotFound { .. })
        );
    }

    #[test]
    fn test_delete_and_restore() {
        let (manager, id) = manager_with_session();
        let deleted = manager.delete_session(&id).unwrap();
        assert_matches!(
            manager.get_session(&id),
            Err(AppError::SessionNotFound { .. })
        );
        manager.restore_sessions(vec![deleted]);
        assert_eq!(manager.get_session(&id).unwrap().name, "Test");
    }
}
