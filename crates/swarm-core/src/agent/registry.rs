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
//!
//! The registry also owns each worker's lifecycle fence, which keeps a
//! kill from interleaving with a session attach or another session stop:
//! an attach holds an [`AttachPermit`] from before its handshake until it
//! has registered (or abandoned) its session; a stop holds a
//! [`SessionStop`] ([`AgentSessionRegistry::take_session`]) until the
//! session's shutdown has finished; and a kill
//! ([`AgentSessionRegistry::begin_close`]) marks the worker closing,
//! waits for every permit to drop, stops the session, then waits for
//! every stop to finish ([`AgentSessionRegistry::wait_stopped`]). While a
//! worker is closing, a new attach, a registration and a session lookup
//! (so turn dispatch, cancel and permission answers) fail with
//! [`AppError::WorkerClosing`]; `agent_send_turn` refuses a turn through
//! [`AgentSessionRegistry::ensure_open`] before it queues it.

use std::ops::Deref;
use std::sync::Arc;

use dashmap::DashMap;
use dashmap::mapref::entry::Entry;
use tokio::sync::watch;
use uuid::Uuid;

use super::adapter::AgentSession;
use crate::error::AppError;

/// One worker's lifecycle fence. Exists only while a kill is closing the
/// worker, an attach is in flight or a session stop is running; idle
/// fences are removed.
#[derive(Default)]
struct Fence {
    /// Kills in progress. A count, so of two overlapping kills of one
    /// worker, the first to finish does not reopen it under the other.
    closing: usize,
    /// Live [`AttachPermit`]s. A closer subscribes and waits for zero.
    attaches: watch::Sender<usize>,
    /// Live [`SessionStop`]s. [`AgentSessionRegistry::wait_stopped`]
    /// subscribes and waits for zero.
    stops: watch::Sender<usize>,
}

impl Fence {
    fn is_idle(&self) -> bool {
        self.closing == 0 && *self.attaches.borrow() == 0 && *self.stops.borrow() == 0
    }
}

/// Shuts a replaced session down in the background, so replacing a live
/// session never orphans its child process; the stop is released once
/// the shutdown is done. Without a Tokio runtime to run it on, the
/// session is dropped (and the stop released) with an error log.
fn shut_down_replaced(stop: SessionStop) {
    let worker_id = stop.worker_id;
    match tokio::runtime::Handle::try_current() {
        Ok(runtime) => {
            runtime.spawn(async move {
                if let Err(e) = stop.shutdown().await {
                    tracing::warn!(%worker_id, error = %e, "shutting down a replaced agent session failed");
                }
            });
        }
        Err(_) => {
            tracing::error!(%worker_id, "no Tokio runtime to shut down a replaced agent session; dropping it");
        }
    }
}

/// A session taken out of the registry to be shut down, from
/// [`AgentSessionRegistry::take_session`]. It derefs to the session; until
/// it drops, [`AgentSessionRegistry::wait_stopped`] waits, so drop it
/// once `shutdown()` has finished.
#[must_use = "a session stop fences the worker only while it is held"]
pub struct SessionStop {
    session: Arc<dyn AgentSession>,
    registry: AgentSessionRegistry,
    worker_id: Uuid,
}

impl Deref for SessionStop {
    type Target = dyn AgentSession;

    fn deref(&self) -> &Self::Target {
        &*self.session
    }
}

impl Drop for SessionStop {
    fn drop(&mut self) {
        if let Some(fence) = self.registry.fences.get(&self.worker_id) {
            fence.stops.send_modify(|stops| *stops -= 1);
        }
        self.registry.remove_fence_if_idle(self.worker_id);
    }
}

/// The refusal for an attach, registration or lookup on a closing worker.
fn worker_closing(worker_id: Uuid) -> AppError {
    AppError::WorkerClosing {
        id: worker_id.to_string(),
    }
}

/// An attach in flight for one worker, from
/// [`AgentSessionRegistry::begin_attach`]. Held across the provider
/// handshake and the registration, it makes
/// [`AgentSessionRegistry::begin_close`] wait; dropping it lets the
/// close proceed.
#[must_use = "an attach permit fences the worker only while it is held"]
pub struct AttachPermit {
    registry: AgentSessionRegistry,
    worker_id: Uuid,
}

impl AttachPermit {
    /// Registers the attached `session` for the permit's worker. A live
    /// session it replaces is shut down in the background under a counted
    /// [`SessionStop`], so [`AgentSessionRegistry::wait_stopped`] waits for it.
    ///
    /// # Errors
    ///
    /// [`AppError::WorkerClosing`] — a kill began while the handshake ran.
    /// The session is not registered; the caller still owns it and must
    /// shut it down.
    pub fn insert(&self, session: Arc<dyn AgentSession>) -> Result<(), AppError> {
        // The fence's shard guard is held across the registration, so a
        // concurrent `begin_close` either sees the session registered (and
        // its kill removes it) or this check sees the worker closing. The
        // permit's attach count keeps the fence in the map.
        let fence = self.registry.fences.get(&self.worker_id);
        if fence.as_ref().is_some_and(|fence| fence.closing > 0) {
            return Err(worker_closing(self.worker_id));
        }
        let replaced = self.registry.register(self.worker_id, session);
        // A replaced session leaves the registry like any other: counted
        // as a stop under the fence (`send_modify` needs only `&self`, so
        // the read guard suffices), released once its shutdown is done.
        let stop = replaced.map(|stale| {
            if let Some(fence) = &fence {
                fence.stops.send_modify(|stops| *stops += 1);
            }
            SessionStop {
                session: stale,
                registry: self.registry.clone(),
                worker_id: self.worker_id,
            }
        });
        // Released before the stop can drop: its `Drop` writes this shard.
        drop(fence);
        if let Some(stop) = stop {
            shut_down_replaced(stop);
        }
        Ok(())
    }
}

impl Drop for AttachPermit {
    fn drop(&mut self) {
        if let Some(fence) = self.registry.fences.get(&self.worker_id) {
            fence.attaches.send_modify(|attaches| *attaches -= 1);
        }
        self.registry.remove_fence_if_idle(self.worker_id);
    }
}

/// A kill's closing mark on one worker, from
/// [`AgentSessionRegistry::begin_close`]. The worker stays closing until
/// every guard for it drops.
#[must_use = "the worker is closing only while the guard is held"]
pub struct ClosingGuard {
    registry: AgentSessionRegistry,
    worker_id: Uuid,
}

impl Drop for ClosingGuard {
    fn drop(&mut self) {
        if let Some(mut fence) = self.registry.fences.get_mut(&self.worker_id) {
            fence.closing -= 1;
        }
        self.registry.remove_fence_if_idle(self.worker_id);
    }
}

/// Per-worker turn lock type — see [`AgentSessionRegistry::turn_lock`].
pub type TurnLock = Arc<tokio::sync::Mutex<()>>;

/// One registered session and the turn lock that lives exactly as long
/// as it does.
struct SessionEntry {
    session: Arc<dyn AgentSession>,
    turn_lock: TurnLock,
}

/// Thread-safe map of worker id -> live agent session handle, plus each
/// worker's attach/close fence (see the module docs).
///
/// One entry per worker that currently has an attached provider session.
/// The value is the trait object, so every adapter (Claude Code, Codex,
/// any future one) shares this one registry.
#[derive(Clone, Default)]
pub struct AgentSessionRegistry {
    entries: Arc<DashMap<Uuid, SessionEntry>>,
    fences: Arc<DashMap<Uuid, Fence>>,
}

impl AgentSessionRegistry {
    /// Creates an empty registry.
    pub fn new() -> Self {
        Self::default()
    }

    /// Starts an attach for `worker_id`: the returned permit is held
    /// across the provider handshake and [`AttachPermit::insert`], and
    /// [`Self::begin_close`] waits for it to drop.
    ///
    /// # Errors
    ///
    /// [`AppError::WorkerClosing`] — a kill is closing the worker.
    pub fn begin_attach(&self, worker_id: Uuid) -> Result<AttachPermit, AppError> {
        let fence = self.fences.entry(worker_id).or_default();
        if fence.closing > 0 {
            return Err(worker_closing(worker_id));
        }
        fence.attaches.send_modify(|attaches| *attaches += 1);
        drop(fence);
        Ok(AttachPermit {
            registry: self.clone(),
            worker_id,
        })
    }

    /// Marks `worker_id` closing, then waits until every in-flight
    /// [`AttachPermit`] for it has dropped. From the mark on,
    /// [`Self::begin_attach`], [`AttachPermit::insert`] and [`Self::get`]
    /// refuse the worker with [`AppError::WorkerClosing`]; the mark lasts
    /// until the returned guard drops (also when this future is dropped
    /// mid-wait).
    ///
    /// The wait is bounded by the attaches themselves: each runs one
    /// adapter handshake, which the adapter bounds (30 s for Claude Code
    /// and Codex), then shuts down the session it can no longer register.
    /// That bound is longer than `swarmd`'s 10 s `STOP_WORKERS_TIMEOUT`,
    /// so a daemon stop can give up on a kill that is still waiting here.
    /// Once this returns, every session attached to the worker is either
    /// in the registry, where [`Self::take_session`] finds it, or already
    /// held by a [`SessionStop`], which [`Self::wait_stopped`] waits for.
    pub async fn begin_close(&self, worker_id: Uuid) -> ClosingGuard {
        let mut attaches = {
            let mut fence = self.fences.entry(worker_id).or_default();
            fence.closing += 1;
            fence.attaches.subscribe()
        };
        let guard = ClosingGuard {
            registry: self.clone(),
            worker_id,
        };
        // The sender lives in the fence, which `guard`'s closing count
        // keeps in the map, so the channel cannot close under this wait.
        let drained = attaches.wait_for(|in_flight| *in_flight == 0).await.is_ok();
        debug_assert!(drained, "a closing worker's fence outlives its closers");
        guard
    }

    /// Whether a kill is closing `worker_id`.
    pub fn is_closing(&self, worker_id: &Uuid) -> bool {
        self.fences
            .get(worker_id)
            .is_some_and(|fence| fence.closing > 0)
    }

    /// Refuses work for a worker a kill is closing.
    ///
    /// # Errors
    ///
    /// [`AppError::WorkerClosing`] — see [`Self::begin_close`].
    pub fn ensure_open(&self, worker_id: &Uuid) -> Result<(), AppError> {
        if self.is_closing(worker_id) {
            return Err(worker_closing(*worker_id));
        }
        Ok(())
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
    /// lock — the caller's subsequent [`Self::get`] fails anyway, with
    /// [`AppError::WorkerNotFound`] (or [`AppError::WorkerClosing`] while
    /// a kill is closing the worker).
    pub fn turn_lock(&self, worker_id: &Uuid) -> TurnLock {
        self.entries
            .get(worker_id)
            .map(|entry| entry.turn_lock.clone())
            .unwrap_or_default()
    }

    /// Registers a newly spawned session for `worker_id` and returns the
    /// live session it replaced, if any; only [`AttachPermit::insert`]
    /// calls it, after the closing check, and shuts the replaced one down
    /// (its turn lock is kept for the new session, so a turn still running
    /// against the old one serializes with the next).
    fn register(
        &self,
        worker_id: Uuid,
        session: Arc<dyn AgentSession>,
    ) -> Option<Arc<dyn AgentSession>> {
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
        if replaced.is_some() {
            tracing::warn!(%worker_id, "agent session replaced while still registered — shutting the old one down");
        }
        replaced
    }

    /// Looks up the live session for `worker_id`.
    ///
    /// # Errors
    ///
    /// * [`AppError::WorkerClosing`] — a kill is closing the worker; its
    ///   session is about to be shut down, so nothing new may reach it.
    /// * [`AppError::WorkerNotFound`] — no session is registered for this
    ///   worker (never spawned, or already removed after shutdown).
    pub fn get(&self, worker_id: &Uuid) -> Result<Arc<dyn AgentSession>, AppError> {
        self.ensure_open(worker_id)?;
        self.entries
            .get(worker_id)
            .map(|entry| entry.session.clone())
            .ok_or_else(|| AppError::WorkerNotFound {
                id: worker_id.to_string(),
            })
    }

    /// Removes `worker_id`'s session, if any, closing or not, and returns
    /// it as a [`SessionStop`]. The caller is responsible for calling
    /// `shutdown()` on it and then dropping the stop (this registry never
    /// tears a removed session down on its own, matching
    /// [`crate::worker::registry::WorkerRegistry::remove_worker`]'s
    /// "caller cleans up" contract). The worker's turn lock goes with it.
    ///
    /// The removal and the stop's count happen under the worker's fence,
    /// so a [`Self::wait_stopped`] that starts after the session is gone
    /// from the registry always sees this stop.
    pub fn take_session(&self, worker_id: &Uuid) -> Option<SessionStop> {
        let fence = self.fences.entry(*worker_id).or_default();
        let Some((_, entry)) = self.entries.remove(worker_id) else {
            drop(fence);
            self.remove_fence_if_idle(*worker_id);
            return None;
        };
        fence.stops.send_modify(|stops| *stops += 1);
        drop(fence);
        Some(SessionStop {
            session: entry.session,
            registry: self.clone(),
            worker_id: *worker_id,
        })
    }

    /// Waits until every [`SessionStop`] for `worker_id` has dropped, so
    /// a kill never touches a worker whose session another caller (a
    /// second kill, `agent_shutdown`) is still shutting down. Bounded by
    /// those shutdowns, which each adapter bounds itself.
    pub async fn wait_stopped(&self, worker_id: Uuid) {
        let Some(mut stops) = self
            .fences
            .get(&worker_id)
            .map(|fence| fence.stops.subscribe())
        else {
            return;
        };
        // A closed channel means the fence went idle: no stop remains.
        let _stopped = stops.wait_for(|running| *running == 0).await.is_ok();
    }

    /// Drops `worker_id`'s fence once no kill, attach or stop holds it.
    fn remove_fence_if_idle(&self, worker_id: Uuid) {
        self.fences
            .remove_if(&worker_id, |_, fence| fence.is_idle());
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

    /// Registers `session` for `worker_id` through an attach permit, as
    /// `commands::agent::attach_session` does.
    fn attach(registry: &AgentSessionRegistry, worker_id: Uuid, session: Arc<dyn AgentSession>) {
        registry
            .begin_attach(worker_id)
            .unwrap()
            .insert(session)
            .unwrap();
    }

    #[test]
    fn test_insert_get_remove_roundtrip() {
        let registry = AgentSessionRegistry::new();
        let worker_id = Uuid::new_v4();
        attach(&registry, worker_id, Arc::new(NoopSession::new("key-1")));

        let fetched = registry.get(&worker_id).expect("session should exist");
        assert_eq!(fetched.session_key(), "key-1");

        assert!(registry.take_session(&worker_id).is_some());
        assert!(registry.get(&worker_id).is_err());
    }

    /// While a kill holds a worker closing, a new attach and a lookup are
    /// refused as closing, other workers are untouched, and the worker
    /// reopens once the guard drops, its fence gone.
    #[tokio::test]
    async fn test_a_closing_worker_refuses_attach_and_lookup_until_the_guard_drops() {
        let registry = AgentSessionRegistry::new();
        let (closing_id, other_id) = (Uuid::new_v4(), Uuid::new_v4());
        attach(&registry, closing_id, Arc::new(NoopSession::new("a")));

        let guard = registry.begin_close(closing_id).await;

        assert!(registry.is_closing(&closing_id));
        assert_matches!(
            registry.begin_attach(closing_id).err(),
            Some(AppError::WorkerClosing { id }) if id == closing_id.to_string()
        );
        assert_matches!(
            registry.get(&closing_id).err(),
            Some(AppError::WorkerClosing { .. })
        );
        assert_matches!(
            registry.ensure_open(&closing_id),
            Err(AppError::WorkerClosing { .. })
        );
        assert!(
            registry.take_session(&closing_id).is_some(),
            "the kill still reaches the session it must stop"
        );
        assert!(registry.ensure_open(&other_id).is_ok());

        drop(guard);
        assert!(!registry.is_closing(&closing_id));
        assert!(registry.begin_attach(closing_id).is_ok());
        assert!(registry.fences.is_empty(), "idle fences are removed");
    }

    /// `begin_close` waits for an attach already holding a permit, and
    /// that attach can no longer register its session.
    #[tokio::test]
    async fn test_begin_close_waits_for_an_in_flight_attach_that_may_not_register() {
        let registry = AgentSessionRegistry::new();
        let worker_id = Uuid::new_v4();
        let permit = registry.begin_attach(worker_id).unwrap();

        let close = tokio::spawn({
            let registry = registry.clone();
            async move { registry.begin_close(worker_id).await }
        });
        let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
        while !registry.is_closing(&worker_id) {
            assert!(tokio::time::Instant::now() < deadline, "never closed");
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert!(!close.is_finished(), "the close must wait for the permit");

        assert_matches!(
            permit.insert(Arc::new(NoopSession::new("late"))),
            Err(AppError::WorkerClosing { .. })
        );
        assert!(
            registry.take_session(&worker_id).is_none(),
            "nothing registered"
        );
        drop(permit);

        let guard = tokio::time::timeout(Duration::from_secs(5), close)
            .await
            .expect("the close finishes once the permit drops")
            .unwrap();
        assert!(registry.is_closing(&worker_id));
        drop(guard);
        assert!(registry.fences.is_empty());
    }

    /// Of two overlapping kills, the first to finish leaves the worker
    /// closing for the second.
    #[tokio::test]
    async fn test_overlapping_closes_keep_the_worker_closing_until_the_last_ends() {
        let registry = AgentSessionRegistry::new();
        let worker_id = Uuid::new_v4();
        let first = registry.begin_close(worker_id).await;
        let second = registry.begin_close(worker_id).await;

        drop(first);
        assert!(registry.is_closing(&worker_id));
        drop(second);
        assert!(!registry.is_closing(&worker_id));
        assert!(registry.fences.is_empty());
    }

    /// A session whose `shutdown` resolves only once `release` fires.
    struct HeldShutdownSession {
        key: SessionKey,
        release: Arc<tokio::sync::Notify>,
    }

    impl AgentSession for HeldShutdownSession {
        fn session_key(&self) -> &SessionKey {
            &self.key
        }
        fn send_turn(&self, _turn: TurnInput) -> BoxFuture<'_, Result<TurnId, AppError>> {
            Box::pin(async { Ok("t".to_string()) })
        }
        fn await_turn_completion(&self, _turn: TurnId) -> BoxFuture<'_, Result<(), AppError>> {
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
                self.release.notified().await;
                Ok(ExitSummary {
                    exit_code: Some(0),
                    signal: None,
                })
            })
        }
    }

    /// A session replaced by a later attach is shut down under a counted
    /// stop: a kill's `wait_stopped` waits for that background shutdown
    /// as for any other.
    #[tokio::test]
    async fn test_wait_stopped_waits_for_a_replaced_sessions_shutdown() {
        let registry = AgentSessionRegistry::new();
        let worker_id = Uuid::new_v4();
        let release = Arc::new(tokio::sync::Notify::new());
        attach(
            &registry,
            worker_id,
            Arc::new(HeldShutdownSession {
                key: "stale".to_owned(),
                release: Arc::clone(&release),
            }),
        );
        attach(&registry, worker_id, Arc::new(NoopSession::new("fresh")));

        let closing = registry.begin_close(worker_id).await;
        drop(
            registry
                .take_session(&worker_id)
                .expect("the fresh session"),
        );
        let waiting =
            tokio::time::timeout(Duration::from_millis(100), registry.wait_stopped(worker_id))
                .await;
        assert!(
            waiting.is_err(),
            "the kill must wait for the replaced session's shutdown"
        );

        release.notify_one();
        tokio::time::timeout(Duration::from_secs(5), registry.wait_stopped(worker_id))
            .await
            .expect("the wait ends once the replaced session is shut down");
        drop(closing);
        assert!(registry.fences.is_empty());
    }

    /// `wait_stopped` waits for a taken session's stop to drop, and
    /// returns at once when no stop is running.
    #[tokio::test]
    async fn test_wait_stopped_waits_for_a_taken_session_to_be_released() {
        let registry = AgentSessionRegistry::new();
        let worker_id = Uuid::new_v4();
        registry.wait_stopped(worker_id).await;
        attach(&registry, worker_id, Arc::new(NoopSession::new("s")));
        let stop = registry.take_session(&worker_id).unwrap();
        assert_eq!(stop.session_key(), "s", "the stop derefs to the session");

        let waiting =
            tokio::time::timeout(Duration::from_millis(50), registry.wait_stopped(worker_id)).await;
        assert!(waiting.is_err(), "the wait holds while the stop is held");

        drop(stop);
        tokio::time::timeout(Duration::from_secs(5), registry.wait_stopped(worker_id))
            .await
            .expect("the wait ends once the stop drops");
        assert!(registry.fences.is_empty());
    }

    /// A close whose wait is abandoned (its kill future dropped) still
    /// clears its mark.
    #[tokio::test]
    async fn test_an_abandoned_close_clears_its_mark() {
        let registry = AgentSessionRegistry::new();
        let worker_id = Uuid::new_v4();
        let permit = registry.begin_attach(worker_id).unwrap();

        let abandoned =
            tokio::time::timeout(Duration::from_millis(20), registry.begin_close(worker_id)).await;

        assert!(abandoned.is_err(), "the close waits on the permit");
        assert!(!registry.is_closing(&worker_id));
        drop(permit);
        assert!(registry.fences.is_empty());
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
        attach(&registry, worker_id, Arc::new(NoopSession::new("k")));

        let a = registry.turn_lock(&worker_id);
        let b = registry.turn_lock(&worker_id);
        assert!(Arc::ptr_eq(&a, &b), "one lock per registered session");

        drop(registry.take_session(&worker_id));
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
        attach(&registry, worker_id, Arc::new(first));
        let lock_before = registry.turn_lock(&worker_id);

        attach(&registry, worker_id, Arc::new(NoopSession::new("second")));

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
        attach(
            &registry,
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
                attach(
                    &registry,
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
