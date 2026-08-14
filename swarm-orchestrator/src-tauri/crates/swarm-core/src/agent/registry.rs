//! Live provider-session registry.
//!
//! Tauri-free counterpart to [`crate::worker::registry::WorkerRegistry`]
//! for the ephemeral, process-lifetime side of a worker's agent
//! session: a [`crate::agent::adapter::AgentSession`] trait object,
//! keyed by worker id. See the "Session state — three owners, no
//! mirroring" table in the multi-provider plan: this registry is the
//! "Process (ephemeral)" row — it holds only what's needed to reach the
//! live child process (send a turn, cancel, shut down), never a copy of
//! the conversation transcript. Reconstructible from the event log +
//! the provider's own `--resume` on restart; nothing here is persisted.

use std::sync::Arc;

use dashmap::DashMap;
use uuid::Uuid;

use super::adapter::AgentSession;
use crate::error::AppError;

/// Thread-safe map of worker id -> live agent session handle.
///
/// One entry per worker that currently has an attached provider
/// session (Claude Code today; any future adapter tomorrow, since the
/// value type is the trait object, not a concrete provider type).
#[derive(Clone, Default)]
pub struct AgentSessionRegistry {
    sessions: Arc<DashMap<Uuid, Arc<dyn AgentSession>>>,
}

impl AgentSessionRegistry {
    /// Creates an empty registry.
    pub fn new() -> Self {
        Self::default()
    }

    /// Registers a newly-spawned session for `worker_id`. Overwrites
    /// (without tearing down) any prior entry — callers are expected to
    /// have already `shutdown()`'d a stale session before replacing it;
    /// this registry does not enforce that on its own.
    pub fn insert(&self, worker_id: Uuid, session: Arc<dyn AgentSession>) {
        self.sessions.insert(worker_id, session);
    }

    /// Looks up the live session for `worker_id`.
    ///
    /// # Errors
    ///
    /// [`AppError::WorkerNotFound`] — no session is registered for this
    /// worker (never spawned, or already removed after shutdown).
    pub fn get(&self, worker_id: &Uuid) -> Result<Arc<dyn AgentSession>, AppError> {
        self.sessions
            .get(worker_id)
            .map(|entry| entry.clone())
            .ok_or_else(|| AppError::WorkerNotFound {
                id: worker_id.to_string(),
            })
    }

    /// Removes and returns `worker_id`'s session, if any — the caller
    /// is responsible for calling `shutdown()` on it (this registry
    /// never tears a session down on its own, matching
    /// [`crate::worker::registry::WorkerRegistry::remove_worker`]'s
    /// "caller cleans up" contract).
    pub fn remove(&self, worker_id: &Uuid) -> Option<Arc<dyn AgentSession>> {
        self.sessions.remove(worker_id).map(|(_, v)| v)
    }

    /// Number of currently registered sessions.
    pub fn count(&self) -> usize {
        self.sessions.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::adapter::{
        AgentTurnStatus, BoxFuture, ExitSummary, PermissionDecision, PermissionId, SessionKey,
        TurnId, TurnInput,
    };

    struct NoopSession(SessionKey);
    impl AgentSession for NoopSession {
        fn session_key(&self) -> &SessionKey {
            &self.0
        }
        fn send_turn(&self, _turn: TurnInput) -> BoxFuture<'_, Result<TurnId, AppError>> {
            Box::pin(async { Ok("t".to_string()) })
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
            Box::pin(async {
                Ok(ExitSummary {
                    exit_code: Some(0),
                    signal: None,
                })
            })
        }
    }
    // Silence unused-variant warning for AgentTurnStatus import used only
    // to keep this test module's imports symmetric with the adapter's own.
    #[allow(dead_code)]
    fn _use(_s: AgentTurnStatus) {}

    #[test]
    fn test_insert_get_remove_roundtrip() {
        let registry = AgentSessionRegistry::new();
        let worker_id = Uuid::new_v4();
        let session: Arc<dyn AgentSession> = Arc::new(NoopSession("key-1".to_string()));

        registry.insert(worker_id, session);
        assert_eq!(registry.count(), 1);

        let fetched = registry.get(&worker_id).expect("session should exist");
        assert_eq!(fetched.session_key(), "key-1");

        let removed = registry.remove(&worker_id);
        assert!(removed.is_some());
        assert_eq!(registry.count(), 0);
        assert!(registry.get(&worker_id).is_err());
    }

    #[test]
    fn test_get_missing_worker_returns_worker_not_found() {
        let registry = AgentSessionRegistry::new();
        let result = registry.get(&Uuid::new_v4());
        assert!(matches!(result, Err(AppError::WorkerNotFound { .. })));
    }
}
