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
    /// Per-worker admission lock (review B2) — held by the scheduler's
    /// executor across `send_turn` + `await_turn_completion` for a
    /// given worker, so two turns queued back-to-back for the SAME
    /// session serialize (turn 2 waits for turn 1 to fully settle
    /// before ever calling `send_turn`) instead of turn 2 racing turn
    /// 1 and hitting `AgentSessionBusy`. This is deliberately NOT the
    /// same lock [`AgentSession::send_turn`]'s own busy-check uses
    /// internally — the trait's `AgentSessionBusy` contract (a session
    /// never queues internally) stays exactly as documented for any
    /// OTHER caller that bypasses this registry's lock and calls
    /// `send_turn` directly; this lock only changes ordering for
    /// traffic that goes through the scheduler.
    turn_locks: Arc<DashMap<Uuid, Arc<tokio::sync::Mutex<()>>>>,
}

impl AgentSessionRegistry {
    /// Creates an empty registry.
    pub fn new() -> Self {
        Self::default()
    }

    /// Returns the per-worker admission lock used to serialize turns
    /// queued through the scheduler for one session — see
    /// [`Self::turn_locks`]'s doc. Get-or-insert: the same `Arc` is
    /// returned for repeated calls with the same `worker_id`, so every
    /// caller actually contends on the same mutex instance. Never
    /// removed on [`Self::remove`] (a lock briefly outliving its
    /// session is harmless — the next `get()` inside the held guard
    /// simply returns [`AppError::WorkerNotFound`] — whereas removing
    /// it here would risk two concurrent callers each minting a
    /// DIFFERENT fresh lock for a session that briefly appeared absent
    /// between DashMap operations, defeating the whole point).
    pub fn turn_lock(&self, worker_id: &Uuid) -> Arc<tokio::sync::Mutex<()>> {
        self.turn_locks
            .entry(*worker_id)
            .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(())))
            .clone()
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
    use std::collections::HashSet;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::Duration;

    use super::*;
    use crate::agent::adapter::{
        BoxFuture, ExitSummary, PermissionDecision, PermissionId, SessionKey, TurnId, TurnInput,
    };
    use crate::agent::scheduler::{
        AgentScheduler, AgentSchedulerConfig, AgentTurnRequest, TurnPriority,
    };

    struct NoopSession(SessionKey);
    impl AgentSession for NoopSession {
        fn session_key(&self) -> &SessionKey {
            &self.0
        }
        fn send_turn(&self, _turn: TurnInput) -> BoxFuture<'_, Result<TurnId, AppError>> {
            Box::pin(async { Ok("t".to_string()) })
        }
        fn await_turn_completion(&self, _turn: TurnId) -> BoxFuture<'_, Result<(), AppError>> {
            // This mock's send_turn already "settles" synchronously
            // (there is nothing further to execute) — nothing to wait for.
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

    #[test]
    fn test_turn_lock_returns_the_same_arc_for_the_same_worker() {
        let registry = AgentSessionRegistry::new();
        let worker_id = Uuid::new_v4();
        let a = registry.turn_lock(&worker_id);
        let b = registry.turn_lock(&worker_id);
        assert!(Arc::ptr_eq(&a, &b), "expected the same lock instance back");
    }

    // ── B2: send_turn -> await_turn_completion -> release, per-session
    // serialization, and real semaphore bounding ─────────────────────

    /// Mutable state behind [`GatedSession`], held in its own `Arc` so
    /// the detached background task in `send_turn` (below) can hold an
    /// owned clone rather than reaching back through `&self` — no
    /// `unsafe`, no raw pointers.
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

    /// A session whose `send_turn` returns almost immediately (mirrors
    /// the real `ClaudeCodeSession`: a stdin write, not the turn's full
    /// execution) while the "work" happens on a detached background
    /// task for `delay`, only THEN marking the turn settled —
    /// `await_turn_completion` blocks until that happens. This is what
    /// makes a test against this mock actually exercise B2's fix
    /// (permit held across real executing time) rather than
    /// accidentally passing against the OLD, disqualified design
    /// (permit released at `send_turn`'s return).
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
                inner: Arc::new(GatedInner::default()),
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
                    let mut f = inner.in_flight.lock();
                    if f.is_some() {
                        return Err(AppError::AgentSessionBusy);
                    }
                    *f = Some(turn_id.clone());
                }
                exec_log
                    .lock()
                    .push(format!("{label}:{}:start", turn.prompt));
                let now = tracker.in_flight.fetch_add(1, Ordering::SeqCst) + 1;
                tracker.max_observed.fetch_max(now, Ordering::SeqCst);

                // Detached, like the real adapter's background reader
                // task settling a turn independently of send_turn's own
                // (already-returned) future — an owned Arc clone, not a
                // borrow of `self`.
                let inner_bg = inner.clone();
                let exec_log_bg = exec_log.clone();
                let tracker_bg = tracker.clone();
                let prompt = turn.prompt.clone();
                let turn_id_bg = turn_id.clone();
                tokio::spawn(async move {
                    tokio::time::sleep(delay).await;
                    exec_log_bg.lock().push(format!("{label}:{prompt}:end"));
                    tracker_bg.in_flight.fetch_sub(1, Ordering::SeqCst);
                    tracker_bg.completed.fetch_add(1, Ordering::SeqCst);
                    *inner_bg.in_flight.lock() = None;
                    *inner_bg.last_settled.lock() = Some(turn_id_bg);
                });
                Ok(turn_id)
            })
        }

        fn await_turn_completion(&self, turn: TurnId) -> BoxFuture<'_, Result<(), AppError>> {
            let inner = self.inner.clone();
            Box::pin(async move {
                loop {
                    if inner.last_settled.lock().as_deref() == Some(turn.as_str()) {
                        return Ok(());
                    }
                    tokio::time::sleep(Duration::from_millis(2)).await;
                }
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

    /// The production executor shape (mirrors `swarm-desktop`'s
    /// `lib.rs` setup exactly): acquire the per-session turn lock,
    /// look up the session, `send_turn` then `await_turn_completion`
    /// before the closure (and therefore the scheduler's semaphore
    /// permit) resolves.
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

    #[tokio::test]
    async fn test_two_rapid_turns_to_one_session_complete_in_order_not_dropped() {
        let registry = AgentSessionRegistry::new();
        let worker_id = Uuid::new_v4();
        let exec_log: Arc<parking_lot::Mutex<Vec<String>>> =
            Arc::new(parking_lot::Mutex::new(Vec::new()));
        let tracker = Arc::new(ConcurrencyTracker::default());
        let session: Arc<dyn AgentSession> = Arc::new(GatedSession::new(
            worker_id.to_string(),
            "w",
            Duration::from_millis(30),
            exec_log.clone(),
            tracker.clone(),
        ));
        registry.insert(worker_id, session);

        let scheduler = AgentScheduler::new(
            AgentSchedulerConfig {
                concurrent_limit: 4,
            },
            make_test_executor(registry.clone()),
        );

        // Two turns for the SAME worker, enqueued back-to-back with no
        // gap — without B2's per-session lock, the second would race
        // the first's still-in-flight turn and be dropped on
        // AgentSessionBusy (only a warn, per the disqualified design).
        scheduler
            .enqueue(AgentTurnRequest {
                worker_id,
                turn: TurnInput {
                    prompt: "A".to_string(),
                },
                priority: TurnPriority::Normal,
            })
            .unwrap();
        scheduler
            .enqueue(AgentTurnRequest {
                worker_id,
                turn: TurnInput {
                    prompt: "B".to_string(),
                },
                priority: TurnPriority::Normal,
            })
            .unwrap();

        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while tracker.completed.load(Ordering::SeqCst) < 2 {
            if std::time::Instant::now() > deadline {
                panic!(
                    "timed out waiting for both turns to complete, log so far: {:?}",
                    exec_log.lock()
                );
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }

        let log = exec_log.lock().clone();
        assert_eq!(
            log,
            vec!["w:A:start", "w:A:end", "w:B:start", "w:B:end"],
            "turn B must never start before turn A ends — both must complete, in order"
        );
    }

    #[tokio::test]
    async fn test_semaphore_bounds_concurrent_executions_across_three_sessions_two_turns_each() {
        let registry = AgentSessionRegistry::new();
        let exec_log: Arc<parking_lot::Mutex<Vec<String>>> =
            Arc::new(parking_lot::Mutex::new(Vec::new()));
        let tracker = Arc::new(ConcurrencyTracker::default());
        const CONCURRENT_LIMIT: usize = 2;
        const SESSIONS: usize = 3;
        const TURNS_PER_SESSION: usize = 2;

        let labels: [&'static str; SESSIONS] = ["s0", "s1", "s2"];
        let mut worker_ids = Vec::new();
        for label in labels {
            let worker_id = Uuid::new_v4();
            worker_ids.push(worker_id);
            let session: Arc<dyn AgentSession> = Arc::new(GatedSession::new(
                worker_id.to_string(),
                label,
                Duration::from_millis(40),
                exec_log.clone(),
                tracker.clone(),
            ));
            registry.insert(worker_id, session);
        }

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

        let total = SESSIONS * TURNS_PER_SESSION;
        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        while tracker.completed.load(Ordering::SeqCst) < total {
            if std::time::Instant::now() > deadline {
                panic!(
                    "timed out: {}/{} completed, log: {:?}",
                    tracker.completed.load(Ordering::SeqCst),
                    total,
                    exec_log.lock()
                );
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }

        assert_eq!(
            tracker.max_observed.load(Ordering::SeqCst),
            CONCURRENT_LIMIT,
            "expected the semaphore to both REACH and never EXCEED the concurrency limit"
        );

        // Every session's own two turns still ran in order (never
        // interleaved with itself), even while different sessions ran
        // concurrently with each other.
        let log = exec_log.lock().clone();
        for label in labels {
            let starts_and_ends: Vec<&String> =
                log.iter().filter(|l| l.starts_with(label)).collect();
            let seen: HashSet<&String> = starts_and_ends.iter().copied().collect();
            assert_eq!(
                seen.len(),
                4,
                "expected 2 start + 2 end markers for {label}"
            );
        }
    }
}
