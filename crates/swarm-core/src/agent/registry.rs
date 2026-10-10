//! Live provider-session registry.
//!
//! The Tauri-free counterpart to [`crate::worker::registry::WorkerRegistry`]
//! for the ephemeral, process-lifetime side of a worker's agent session:
//! a [`crate::agent::adapter::AgentSession`] trait object, keyed by
//! worker id. It holds only what is needed to reach the live child
//! process (send a turn, cancel, answer a permission request, shut
//! down), never a copy of the conversation transcript — that lives in the
//! provider's own session store and, normalized, in the event log.
//! Nothing here is persisted: after a restart the registry is empty. An
//! adapter whose [`crate::agent::adapter::Capabilities::resume`] is `true`
//! can rehydrate a conversation from a recorded session key through
//! [`crate::agent::adapter::AgentSpawnSpec::resume`], but no command
//! passes one today.

use std::sync::Arc;

use dashmap::DashMap;
use dashmap::mapref::entry::Entry;
use uuid::Uuid;

use super::adapter::AgentSession;
use crate::error::AppError;

/// Per-worker turn lock type — see [`AgentSessionRegistry::turn_lock`].
pub type TurnLock = Arc<tokio::sync::Mutex<()>>;

/// One registered session and the turn lock that lives exactly as long
/// as it does.
struct SessionEntry {
    session: Arc<dyn AgentSession>,
    turn_lock: TurnLock,
}

/// Thread-safe map of worker id -> live agent session handle.
///
/// One entry per worker that currently has an attached provider session.
/// The value is the trait object, so every adapter (Claude Code, Codex,
/// any future one) shares this one registry.
#[derive(Clone, Default)]
pub struct AgentSessionRegistry {
    entries: Arc<DashMap<Uuid, SessionEntry>>,
}

impl AgentSessionRegistry {
    /// Creates an empty registry.
    pub fn new() -> Self {
        Self::default()
    }

    /// Returns `worker_id`'s turn lock, which a turn executor holds
    /// across `send_turn` + `await_turn_completion` so two turns for the
    /// same session can never race into
    /// [`AppError::AgentSessionBusy`].
    ///
    /// [`crate::agent::scheduler::AgentScheduler`] already runs at most
    /// one turn per worker, so for scheduler traffic this lock is
    /// uncontended; it guards any other caller that dispatches turns for
    /// the same worker. It is NOT the lock behind
    /// [`AgentSession::send_turn`]'s own busy check — that contract (a
    /// session never queues internally) is unchanged.
    ///
    /// The lock lives and dies with the session entry, so the registry
    /// never accumulates locks for workers that are long gone. For a
    /// worker with no registered session this returns a fresh, unshared
    /// lock — the caller's subsequent [`Self::get`] fails with
    /// [`AppError::WorkerNotFound`] anyway.
    pub fn turn_lock(&self, worker_id: &Uuid) -> TurnLock {
        self.entries
            .get(worker_id)
            .map(|entry| entry.turn_lock.clone())
            .unwrap_or_default()
    }

    /// Registers a newly spawned session for `worker_id`.
    ///
    /// Replacing a live session must never orphan its child process: a
    /// replaced session is shut down in the background (its turn lock is
    /// kept for the new session, so a turn still running against the old
    /// one serializes with the next). Without a Tokio runtime to run that
    /// shutdown on, the replaced session is dropped with an error log.
    pub fn insert(&self, worker_id: Uuid, session: Arc<dyn AgentSession>) {
        let replaced = match self.entries.entry(worker_id) {
            Entry::Occupied(mut occupied) => {
                Some(std::mem::replace(&mut occupied.get_mut().session, session))
            }
            Entry::Vacant(vacant) => {
                vacant.insert(SessionEntry {
                    session,
                    turn_lock: TurnLock::default(),
                });
                None
            }
        };
        let Some(stale) = replaced else {
            return;
        };
        tracing::warn!(%worker_id, "agent session replaced while still registered — shutting the old one down");
        match tokio::runtime::Handle::try_current() {
            Ok(runtime) => {
                runtime.spawn(async move {
                    if let Err(e) = stale.shutdown().await {
                        tracing::warn!(%worker_id, error = %e, "shutting down a replaced agent session failed");
                    }
                });
            }
            Err(_) => {
                tracing::error!(%worker_id, "no Tokio runtime to shut down a replaced agent session; dropping it");
            }
        }
    }

    /// Looks up the live session for `worker_id`.
    ///
    /// # Errors
    ///
    /// [`AppError::WorkerNotFound`] — no session is registered for this
    /// worker (never spawned, or already removed after shutdown).
    pub fn get(&self, worker_id: &Uuid) -> Result<Arc<dyn AgentSession>, AppError> {
        self.entries
            .get(worker_id)
            .map(|entry| entry.session.clone())
            .ok_or_else(|| AppError::WorkerNotFound {
                id: worker_id.to_string(),
            })
    }

    /// Removes and returns `worker_id`'s session, if any. The caller is
    /// responsible for calling `shutdown()` on it (this registry never
    /// tears a removed session down on its own, matching
    /// [`crate::worker::registry::WorkerRegistry::remove_worker`]'s
    /// "caller cleans up" contract). The worker's turn lock goes with it.
    pub fn remove(&self, worker_id: &Uuid) -> Option<Arc<dyn AgentSession>> {
        self.entries
            .remove(worker_id)
            .map(|(_, entry)| entry.session)
    }
}

#[cfg(test)]
mod tests {
    use std::assert_matches;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::Duration;

    use super::*;
    use crate::agent::adapter::{
        BoxFuture, ExitSummary, PermissionDecision, PermissionId, SessionKey, TurnId, TurnInput,
    };
    use crate::agent::scheduler::{
        AgentScheduler, AgentSchedulerConfig, AgentTurnRequest, TurnPriority,
    };

    /// A session that does nothing except count `shutdown` calls.
    struct NoopSession {
        key: SessionKey,
        shutdowns: Arc<AtomicUsize>,
    }

    impl NoopSession {
        fn new(key: &str) -> Self {
            Self {
                key: key.to_string(),
                shutdowns: Arc::default(),
            }
        }
    }

    impl AgentSession for NoopSession {
        fn session_key(&self) -> &SessionKey {
            &self.key
        }
        fn send_turn(&self, _turn: TurnInput) -> BoxFuture<'_, Result<TurnId, AppError>> {
            Box::pin(async { Ok("t".to_string()) })
        }
        fn await_turn_completion(&self, _turn: TurnId) -> BoxFuture<'_, Result<(), AppError>> {
            // `send_turn` above has nothing further to execute.
            Box::pin(async { Ok(()) })
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
            self.shutdowns.fetch_add(1, Ordering::SeqCst);
            Box::pin(async {
                Ok(ExitSummary {
                    exit_code: Some(0),
                    signal: None,
                })
            })
        }
    }

    #[test]
    fn test_insert_get_remove_roundtrip() {
        let registry = AgentSessionRegistry::new();
        let worker_id = Uuid::new_v4();
        registry.insert(worker_id, Arc::new(NoopSession::new("key-1")));

        let fetched = registry.get(&worker_id).expect("session should exist");
        assert_eq!(fetched.session_key(), "key-1");

        assert!(registry.remove(&worker_id).is_some());
        assert!(registry.get(&worker_id).is_err());
    }

    #[test]
    fn test_get_missing_worker_returns_worker_not_found() {
        let registry = AgentSessionRegistry::new();
        // `.err()`: `dyn AgentSession` is not `Debug`, which
        // `assert_matches!` needs to print a mismatch.
        assert_matches!(
            registry.get(&Uuid::new_v4()).err(),
            Some(AppError::WorkerNotFound { .. })
        );
    }

    #[test]
    fn test_turn_lock_is_shared_per_session_and_dropped_with_it() {
        let registry = AgentSessionRegistry::new();
        let worker_id = Uuid::new_v4();
        registry.insert(worker_id, Arc::new(NoopSession::new("k")));

        let a = registry.turn_lock(&worker_id);
        let b = registry.turn_lock(&worker_id);
        assert!(Arc::ptr_eq(&a, &b), "one lock per registered session");

        registry.remove(&worker_id);
        assert_eq!(
            Arc::strong_count(&a),
            2,
            "removing the session drops the registry's reference to its lock"
        );
        let detached = registry.turn_lock(&worker_id);
        assert!(
            !Arc::ptr_eq(&a, &detached),
            "an unregistered worker gets a fresh, unshared lock"
        );
    }

    /// A replaced live session is shut down, never silently dropped with
    /// its child process still running.
    #[tokio::test]
    async fn test_insert_over_a_live_session_shuts_the_replaced_one_down() {
        let registry = AgentSessionRegistry::new();
        let worker_id = Uuid::new_v4();
        let first = NoopSession::new("first");
        let first_shutdowns = first.shutdowns.clone();
        registry.insert(worker_id, Arc::new(first));
        let lock_before = registry.turn_lock(&worker_id);

        registry.insert(worker_id, Arc::new(NoopSession::new("second")));

        let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
        while first_shutdowns.load(Ordering::SeqCst) == 0 {
            assert!(
                tokio::time::Instant::now() < deadline,
                "the replaced session was never shut down"
            );
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        assert_eq!(registry.get(&worker_id).unwrap().session_key(), "second");
        assert!(
            Arc::ptr_eq(&lock_before, &registry.turn_lock(&worker_id)),
            "the turn lock carries over to the replacement"
        );
    }

    // ── send_turn -> await_turn_completion -> release, per-session
    // serialization, and real semaphore bounding ──────────────────────

    /// Mutable state behind [`GatedSession`], in its own `Arc` so the
    /// detached task in `send_turn` can own a clone.
    #[derive(Default)]
    struct GatedInner {
        in_flight: parking_lot::Mutex<Option<TurnId>>,
        last_settled: parking_lot::Mutex<Option<TurnId>>,
    }

    #[derive(Default)]
    struct ConcurrencyTracker {
        in_flight: AtomicUsize,
        max_observed: AtomicUsize,
        completed: AtomicUsize,
    }

    /// A session whose `send_turn` returns almost immediately (like a
    /// real adapter's: acceptance, not execution) while the "work" runs
    /// on a detached task for `delay` and only then marks the turn
    /// settled — `await_turn_completion` blocks until that happens. This
    /// is what makes these tests exercise a permit held across real
    /// executing time.
    struct GatedSession {
        key: SessionKey,
        label: &'static str,
        delay: Duration,
        inner: Arc<GatedInner>,
        exec_log: Arc<parking_lot::Mutex<Vec<String>>>,
        tracker: Arc<ConcurrencyTracker>,
    }

    impl GatedSession {
        fn new(
            key: SessionKey,
            label: &'static str,
            delay: Duration,
            exec_log: Arc<parking_lot::Mutex<Vec<String>>>,
            tracker: Arc<ConcurrencyTracker>,
        ) -> Self {
            Self {
                key,
                label,
                delay,
                inner: Arc::default(),
                exec_log,
                tracker,
            }
        }
    }

    impl AgentSession for GatedSession {
        fn session_key(&self) -> &SessionKey {
            &self.key
        }

        fn send_turn(&self, turn: TurnInput) -> BoxFuture<'_, Result<TurnId, AppError>> {
            let inner = self.inner.clone();
            let delay = self.delay;
            let exec_log = self.exec_log.clone();
            let tracker = self.tracker.clone();
            let label = self.label;
            Box::pin(async move {
                let turn_id: TurnId = Uuid::new_v4().to_string();
                {
                    let mut in_flight = inner.in_flight.lock();
                    if in_flight.is_some() {
                        return Err(AppError::AgentSessionBusy);
                    }
                    *in_flight = Some(turn_id.clone());
                }
                exec_log
                    .lock()
                    .push(format!("{label}:{}:start", turn.prompt));
                let now = tracker.in_flight.fetch_add(1, Ordering::SeqCst) + 1;
                tracker.max_observed.fetch_max(now, Ordering::SeqCst);

                let turn_id_bg = turn_id.clone();
                tokio::spawn(async move {
                    tokio::time::sleep(delay).await;
                    exec_log.lock().push(format!("{label}:{}:end", turn.prompt));
                    tracker.in_flight.fetch_sub(1, Ordering::SeqCst);
                    tracker.completed.fetch_add(1, Ordering::SeqCst);
                    *inner.in_flight.lock() = None;
                    *inner.last_settled.lock() = Some(turn_id_bg);
                });
                Ok(turn_id)
            })
        }

        fn await_turn_completion(&self, turn: TurnId) -> BoxFuture<'_, Result<(), AppError>> {
            let inner = self.inner.clone();
            Box::pin(async move {
                while inner.last_settled.lock().as_deref() != Some(turn.as_str()) {
                    tokio::time::sleep(Duration::from_millis(2)).await;
                }
                Ok(())
            })
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

    /// The dispatch half of the production executor in
    /// `crate::runtime::Runtime::start`: hold the worker's turn lock, look
    /// up the session, `send_turn`, then `await_turn_completion` before
    /// the future (and therefore the scheduler's permit) resolves. The
    /// production executor additionally synthesizes an error
    /// `agent_turn_settled` when dispatch fails; that path needs an event
    /// sink and is not what these tests measure.
    fn make_test_executor(
        registry: AgentSessionRegistry,
    ) -> impl Fn(AgentTurnRequest) -> BoxFuture<'static, ()> + Send + Sync + 'static {
        move |request: AgentTurnRequest| {
            let registry = registry.clone();
            Box::pin(async move {
                let lock = registry.turn_lock(&request.worker_id);
                let _guard = lock.lock().await;
                if let Ok(session) = registry.get(&request.worker_id)
                    && let Ok(turn_id) = session.send_turn(request.turn).await
                {
                    let _ = session.await_turn_completion(turn_id).await;
                }
            })
        }
    }

    async fn wait_for_completed(
        tracker: &ConcurrencyTracker,
        total: usize,
        exec_log: &parking_lot::Mutex<Vec<String>>,
    ) {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
        while tracker.completed.load(Ordering::SeqCst) < total {
            assert!(
                tokio::time::Instant::now() < deadline,
                "timed out: {}/{total} completed, log: {:?}",
                tracker.completed.load(Ordering::SeqCst),
                exec_log.lock()
            );
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    }

    #[tokio::test]
    async fn test_two_rapid_turns_to_one_session_complete_in_order_not_dropped() {
        let registry = AgentSessionRegistry::new();
        let worker_id = Uuid::new_v4();
        let exec_log = Arc::new(parking_lot::Mutex::new(Vec::new()));
        let tracker = Arc::new(ConcurrencyTracker::default());
        registry.insert(
            worker_id,
            Arc::new(GatedSession::new(
                worker_id.to_string(),
                "w",
                Duration::from_millis(30),
                exec_log.clone(),
                tracker.clone(),
            )),
        );

        let scheduler = AgentScheduler::new(
            AgentSchedulerConfig {
                concurrent_limit: 4,
            },
            make_test_executor(registry.clone()),
        );

        // Two turns for the SAME worker, back-to-back: the second must
        // wait for the first to settle rather than hit AgentSessionBusy.
        for prompt in ["A", "B"] {
            scheduler
                .enqueue(AgentTurnRequest {
                    worker_id,
                    turn: TurnInput {
                        prompt: prompt.to_string(),
                    },
                    priority: TurnPriority::Normal,
                })
                .unwrap();
        }

        wait_for_completed(&tracker, 2, &exec_log).await;
        assert_eq!(
            *exec_log.lock(),
            ["w:A:start", "w:A:end", "w:B:start", "w:B:end"],
            "turn B must never start before turn A ends — both must complete, in order"
        );
    }

    #[tokio::test]
    async fn test_semaphore_bounds_concurrent_executions_across_three_sessions_two_turns_each() {
        const CONCURRENT_LIMIT: usize = 2;
        const TURNS_PER_SESSION: usize = 2;
        let labels = ["s0", "s1", "s2"];

        let registry = AgentSessionRegistry::new();
        let exec_log = Arc::new(parking_lot::Mutex::new(Vec::new()));
        let tracker = Arc::new(ConcurrencyTracker::default());
        let worker_ids: Vec<Uuid> = labels
            .iter()
            .map(|&label| {
                let worker_id = Uuid::new_v4();
                registry.insert(
                    worker_id,
                    Arc::new(GatedSession::new(
                        worker_id.to_string(),
                        label,
                        Duration::from_millis(40),
                        exec_log.clone(),
                        tracker.clone(),
                    )),
                );
                worker_id
            })
            .collect();

        let scheduler = AgentScheduler::new(
            AgentSchedulerConfig {
                concurrent_limit: CONCURRENT_LIMIT,
            },
            make_test_executor(registry.clone()),
        );
        for &worker_id in &worker_ids {
            for t in 0..TURNS_PER_SESSION {
                scheduler
                    .enqueue(AgentTurnRequest {
                        worker_id,
                        turn: TurnInput {
                            prompt: format!("t{t}"),
                        },
                        priority: TurnPriority::Normal,
                    })
                    .unwrap();
            }
        }

        wait_for_completed(&tracker, labels.len() * TURNS_PER_SESSION, &exec_log).await;
        assert_eq!(
            tracker.max_observed.load(Ordering::SeqCst),
            CONCURRENT_LIMIT,
            "expected the semaphore to both REACH and never EXCEED the concurrency limit"
        );

        // Each session's own two turns ran in order, never interleaved
        // with itself, while different sessions ran concurrently.
        let log = exec_log.lock().clone();
        for label in labels {
            let own: Vec<&str> = log
                .iter()
                .filter(|entry| entry.starts_with(&format!("{label}:")))
                .map(String::as_str)
                .collect();
            assert_eq!(
                own,
                [
                    format!("{label}:t0:start"),
                    format!("{label}:t0:end"),
                    format!("{label}:t1:start"),
                    format!("{label}:t1:end"),
                ],
                "session {label} must run t0 to completion before t1 starts"
            );
        }
    }
}
