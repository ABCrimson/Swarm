//! Agent turn scheduler: gates how many agent turns run at once and
//! decides which queued turn runs next.
//!
//! Concurrent agent turns are the scarce resource — you do not want 20
//! provider processes running tools against one repo at once — so every
//! `agent_send_turn` goes through one app-wide [`AgentScheduler`]
//! ([`crate::runtime::Runtime::start`] builds it for both shells). The
//! scheduler is provider-agnostic: it is generic over an injected
//! `executor` closure that owns everything provider-specific (looking up
//! the [`crate::agent::adapter::AgentSession`], `send_turn`, awaiting the
//! turn's settlement, emitting the `agent_*` family). This module only
//! answers "may this turn start now, and which one goes first?".
//!
//! ## Admission rules
//!
//! A queued request is **admissible** when no other turn for the same
//! worker is currently running. Among admissible requests, the highest
//! [`TurnPriority`] wins, then the oldest (FIFO within a priority). A
//! request is dispatched only when a concurrency permit is free AND it is
//! admissible, so:
//!
//! - **One turn per worker at a time.** Follow-ups queued for a busy
//!   worker wait in the queue *without* holding a permit, so they never
//!   starve other workers' turns.
//! - **Priority is decided at dispatch time.** The dispatch loop drains
//!   the intake channel before it hands out a permit, so a `Critical`
//!   request that arrives while `Low` requests wait is considered for the
//!   very next free permit.
//! - **No preemption.** A running turn is never cancelled to make room;
//!   a `Critical` request still waits for a permit to free naturally.
//!
//! Backpressure is on the number of requests waiting to be dispatched:
//! [`AgentScheduler::enqueue`] returns [`AppError::QueueFull`] once
//! [`AGENT_TURN_QUEUE_CAPACITY`] requests are queued.

use std::cmp::{Ordering, Reverse};
use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering as AtomicOrdering};

use serde::{Deserialize, Serialize};
use tokio::sync::{OwnedSemaphorePermit, Semaphore, mpsc};
use tokio::task::JoinSet;
use uuid::Uuid;

use super::adapter::TurnInput;
use crate::error::AppError;

/// Maximum number of turns that may wait for dispatch at once.
pub const AGENT_TURN_QUEUE_CAPACITY: usize = 256;

/// Lowest accepted live agent-turn concurrency limit
/// ([`AgentScheduler::set_concurrency`] / the `set_agent_concurrency`
/// command). Smaller values are clamped up to it.
pub const MIN_AGENT_CONCURRENCY: u32 = 1;
/// Highest accepted live agent-turn concurrency limit — beyond this,
/// running more concurrent provider processes against one repo is almost
/// certainly a misconfiguration (mirrors
/// `worker::registry::MAX_MAX_WORKERS`'s reasoning for a different
/// resource). Larger values are clamped down to it.
pub const MAX_AGENT_CONCURRENCY: u32 = 16;

/// Priority levels for scheduled agent turns, lowest to highest.
///
/// Wire form is camelCase (`"low"`, `"normal"`, `"high"`, `"critical"`).
#[derive(
    Debug, Default, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize,
)]
#[serde(rename_all = "camelCase")]
pub enum TurnPriority {
    /// Lowest priority, dispatched last.
    Low,
    /// Default priority level.
    #[default]
    Normal,
    /// Elevated priority, dispatched before Normal and Low.
    High,
    /// Highest priority, dispatched before all others.
    Critical,
}

/// One agent turn awaiting dispatch.
#[derive(Debug, Clone)]
pub struct AgentTurnRequest {
    /// UUID of the worker whose session this turn is sent to.
    pub worker_id: Uuid,
    /// The turn's input.
    pub turn: TurnInput,
    /// Queue priority level.
    pub priority: TurnPriority,
}

/// Configuration for the agent-turn scheduler.
///
/// # Defaults
///
/// | Field              | Default |
/// |--------------------|---------|
/// | `concurrent_limit` | 3       |
#[derive(Debug, Clone)]
pub struct AgentSchedulerConfig {
    /// Maximum number of concurrently running agent turns, clamped to
    /// [`MIN_AGENT_CONCURRENCY`]`..=`[`MAX_AGENT_CONCURRENCY`].
    pub concurrent_limit: usize,
}

impl Default for AgentSchedulerConfig {
    fn default() -> Self {
        Self {
            concurrent_limit: 3,
        }
    }
}

/// Clamps a requested concurrency limit into the accepted range — a
/// limit of `0` would stall every queued turn forever.
fn clamp_limit(limit: usize) -> usize {
    limit.clamp(
        MIN_AGENT_CONCURRENCY as usize,
        MAX_AGENT_CONCURRENCY as usize,
    )
}

/// Priority queue + concurrency gate for agent turns.
///
/// ```text
/// enqueue() ──intake channel──> dispatch loop ──> JoinSet::spawn(executor(request))
///                                 │  pending queue (priority, FIFO)
///                                 │  busy workers (one turn each)
///                                 └  Semaphore permits (concurrency)
/// ```
pub struct AgentScheduler {
    /// Intake for new requests. Unbounded: the bound is `queued`.
    sender: mpsc::UnboundedSender<AgentTurnRequest>,
    /// Requests accepted by [`Self::enqueue`] and not yet dispatched —
    /// the backpressure counter behind [`AppError::QueueFull`].
    queued: Arc<AtomicUsize>,
    /// The live concurrency gate, shared with the dispatch loop so
    /// [`Self::set_concurrency`] can resize it. See that method's doc
    /// for how resizing is realized on top of `add_permits`/
    /// `forget_permits`.
    semaphore: Arc<Semaphore>,
    /// Permits still owed to be permanently forgotten (rather than
    /// returned to `semaphore`) the next time a running turn releases
    /// one — see [`Self::set_concurrency`].
    pending_forgets: Arc<AtomicUsize>,
    /// The current target concurrency limit, tracked independently of
    /// `semaphore.available_permits()` (which fluctuates with running
    /// turns and can't alone tell `set_concurrency` how big a delta to
    /// apply).
    concurrency_limit: AtomicUsize,
}

impl AgentScheduler {
    /// Creates a scheduler and starts its dispatch loop, which runs each
    /// admitted [`AgentTurnRequest`] through `executor`.
    ///
    /// # Executor contract
    ///
    /// `executor` owns everything provider-specific: looking up the
    /// target [`crate::agent::adapter::AgentSession`], calling
    /// `send_turn`, and emitting the resulting `agent_*` events
    /// (including a terminal `agent_turn_settled` when dispatch itself
    /// fails). Its future **must not resolve before the turn has
    /// settled** — i.e. it must await
    /// [`crate::agent::adapter::AgentSession::await_turn_completion`].
    /// The concurrency permit (and the worker's one-turn slot) is held
    /// exactly as long as that future runs; a future that resolved at
    /// `send_turn`'s return would bound nothing, since `send_turn` only
    /// proves the provider *accepted* the turn.
    ///
    /// The scheduler never runs two executor futures for the same
    /// `worker_id` at once, so an executor needs no locking of its own
    /// to keep one worker's turns from racing into `AgentSessionBusy`.
    ///
    /// Must be called from within a Tokio runtime (it spawns the
    /// dispatch loop).
    pub fn new<F, Fut>(config: AgentSchedulerConfig, executor: F) -> Self
    where
        F: Fn(AgentTurnRequest) -> Fut + Send + Sync + 'static,
        Fut: Future<Output = ()> + Send + 'static,
    {
        let limit = clamp_limit(config.concurrent_limit);
        let (sender, receiver) = mpsc::unbounded_channel();
        let queued = Arc::new(AtomicUsize::new(0));
        let semaphore = Arc::new(Semaphore::new(limit));
        let pending_forgets = Arc::new(AtomicUsize::new(0));

        tokio::spawn(dispatch_loop(
            receiver,
            queued.clone(),
            semaphore.clone(),
            pending_forgets.clone(),
            executor,
        ));

        Self {
            sender,
            queued,
            semaphore,
            pending_forgets,
            concurrency_limit: AtomicUsize::new(limit),
        }
    }

    /// Adjusts the live concurrency cap, clamped to
    /// [`MIN_AGENT_CONCURRENCY`]`..=`[`MAX_AGENT_CONCURRENCY`].
    ///
    /// `tokio::sync::Semaphore` has no resize operation, so this composes
    /// the two primitives that come closest:
    ///
    /// * **Decrease:** `Semaphore::forget_permits` reclaims as many
    ///   currently **idle** permits as it can (permanently). If running
    ///   turns hold the rest, the shortfall is recorded in
    ///   `pending_forgets` and paid off lazily: the next turns to finish
    ///   [`OwnedSemaphorePermit::forget`] their permit instead of
    ///   returning it, until the debt reaches zero. The new cap is
    ///   honored going forward without cancelling any running turn.
    /// * **Increase:** retires outstanding `pending_forgets` debt FIRST
    ///   (one atomic `update` that only ever decreases the counter), then calls
    ///   `Semaphore::add_permits` for whatever increase is left over.
    ///   **Binding invariant:** debt is capacity still checked out by
    ///   RUNNING turns. Adding permits for the full delta while debt is
    ///   outstanding makes real concurrency `new_limit + debt`, and
    ///   repeated cycles compound it. Cancelling debt first means those
    ///   turns simply return their permits normally — exactly the
    ///   capacity being asked for back — so total capacity never exceeds
    ///   `new_limit` at any point in the transition.
    ///
    /// A no-op when the (clamped) limit equals the current one.
    pub fn set_concurrency(&self, new_limit: usize) {
        let new_limit = clamp_limit(new_limit);
        let old_limit = self
            .concurrency_limit
            .swap(new_limit, AtomicOrdering::SeqCst);
        match new_limit.cmp(&old_limit) {
            Ordering::Greater => {
                let delta = new_limit - old_limit;
                let paid = self
                    .pending_forgets
                    .update(AtomicOrdering::SeqCst, AtomicOrdering::SeqCst, |debt| {
                        debt - debt.min(delta)
                    })
                    .min(delta);
                if delta > paid {
                    self.semaphore.add_permits(delta - paid);
                }
            }
            Ordering::Less => {
                let want = old_limit - new_limit;
                let forgotten = self.semaphore.forget_permits(want);
                let debt = want - forgotten;
                if debt > 0 {
                    self.pending_forgets.fetch_add(debt, AtomicOrdering::SeqCst);
                }
            }
            Ordering::Equal => {}
        }
    }

    /// Queues an agent turn for dispatch. Non-blocking.
    ///
    /// # Errors
    ///
    /// * [`AppError::QueueFull`] — [`AGENT_TURN_QUEUE_CAPACITY`]
    ///   requests are already waiting for dispatch.
    /// * [`AppError::ChannelClosed`] — the dispatch loop is gone (its
    ///   runtime shut down).
    pub fn enqueue(&self, request: AgentTurnRequest) -> Result<(), AppError> {
        self.queued
            .try_update(AtomicOrdering::SeqCst, AtomicOrdering::SeqCst, |n| {
                (n < AGENT_TURN_QUEUE_CAPACITY).then_some(n + 1)
            })
            .map_err(|_| AppError::QueueFull {
                capacity: AGENT_TURN_QUEUE_CAPACITY,
            })?;
        self.sender.send(request).map_err(|_| {
            self.queued.fetch_sub(1, AtomicOrdering::SeqCst);
            AppError::ChannelClosed("agent turn queue channel closed".to_string())
        })
    }
}

/// A queued request plus its arrival order.
#[derive(Debug)]
struct Pending {
    request: AgentTurnRequest,
    sequence: u64,
}

impl Pending {
    /// Dispatch rank: higher priority first, then lower sequence (FIFO).
    fn rank(&self) -> (TurnPriority, Reverse<u64>) {
        (self.request.priority, Reverse(self.sequence))
    }
}

/// Index of the best admissible request in `pending` — the highest
/// rank whose worker has no running turn — or `None` if every queued
/// request belongs to a busy worker. A linear scan: the queue is bounded
/// by [`AGENT_TURN_QUEUE_CAPACITY`].
fn next_admissible(pending: &[Pending], busy: &HashSet<Uuid>) -> Option<usize> {
    pending
        .iter()
        .enumerate()
        .filter(|(_, p)| !busy.contains(&p.request.worker_id))
        .max_by_key(|(_, p)| p.rank())
        .map(|(index, _)| index)
}

/// The scheduler's single dispatch task: drains the intake channel into
/// the pending queue, dispatches admissible requests whenever a permit is
/// free, and reaps finished turns (releasing their permit and their
/// worker's slot — also when an executor panicked). Exits once the
/// intake channel has closed and every queued and running turn is done.
#[tracing::instrument(skip_all, fields(initial_permits = semaphore.available_permits()))]
async fn dispatch_loop<F, Fut>(
    mut receiver: mpsc::UnboundedReceiver<AgentTurnRequest>,
    queued: Arc<AtomicUsize>,
    semaphore: Arc<Semaphore>,
    pending_forgets: Arc<AtomicUsize>,
    executor: F,
) where
    F: Fn(AgentTurnRequest) -> Fut + Send + Sync + 'static,
    Fut: Future<Output = ()> + Send + 'static,
{
    let mut pending: Vec<Pending> = Vec::new();
    let mut next_sequence: u64 = 0;
    let mut busy: HashSet<Uuid> = HashSet::new();
    let mut running: JoinSet<()> = JoinSet::new();
    let mut running_slots: HashMap<tokio::task::Id, (Uuid, OwnedSemaphorePermit)> = HashMap::new();
    let mut intake_open = true;

    tracing::info!(
        capacity = AGENT_TURN_QUEUE_CAPACITY,
        "agent turn scheduler dispatch loop started"
    );

    loop {
        if !intake_open && pending.is_empty() && running.is_empty() {
            break;
        }
        let admissible = next_admissible(&pending, &busy).is_some();

        // `biased`: every request already in the intake channel is queued,
        // and every finished turn reaped, before a permit is handed out —
        // that is what makes dispatch order follow priority rather than
        // arrival order. The intake cannot starve dispatch: `enqueue`
        // stops accepting at `AGENT_TURN_QUEUE_CAPACITY`.
        tokio::select! {
            biased;
            request = receiver.recv(), if intake_open => match request {
                Some(request) => {
                    pending.push(Pending { request, sequence: next_sequence });
                    next_sequence += 1;
                }
                None => {
                    tracing::info!("agent turn queue channel closed; draining queued and running turns");
                    intake_open = false;
                }
            },
            Some(joined) = running.join_next_with_id(), if !running.is_empty() => {
                let id = match joined {
                    Ok((id, ())) => id,
                    Err(e) => {
                        tracing::error!(error = %e, "agent turn executor panicked or was cancelled");
                        e.id()
                    }
                };
                if let Some((worker_id, permit)) = running_slots.remove(&id) {
                    busy.remove(&worker_id);
                    release_or_forget_permit(permit, &pending_forgets);
                }
            },
            permit = semaphore.clone().acquire_owned(), if admissible => {
                let Ok(permit) = permit else {
                    tracing::error!("agent turn scheduler semaphore closed unexpectedly");
                    return;
                };
                // The admissible set only shrinks when this loop dispatches,
                // so the request seen before the await is still there.
                let Some(index) = next_admissible(&pending, &busy) else {
                    drop(permit);
                    continue;
                };
                let Pending { request, .. } = pending.swap_remove(index);
                queued.fetch_sub(1, AtomicOrdering::SeqCst);
                let worker_id = request.worker_id;
                busy.insert(worker_id);
                let handle = running.spawn(executor(request));
                running_slots.insert(handle.id(), (worker_id, permit));
            },
            // Unreachable: with the intake closed and nothing running,
            // every queued request is admissible (or the loop already
            // exited above) — kept so `select!` can never panic.
            else => break,
        }
    }
    tracing::info!("agent turn scheduler dispatch loop stopped");
}

/// Releases `permit` back to its semaphore, unless a `set_concurrency`
/// decrease is still owed a forgotten permit — then `permit` is
/// [`OwnedSemaphorePermit::forget`]ten instead, permanently reducing
/// capacity by one. See [`AgentScheduler::set_concurrency`] for why the
/// debt can't always be paid synchronously.
///
/// `try_update` with `checked_sub` (rather than a plain `fetch_sub`) leaves
/// `pending_forgets` at `0` instead of underflowing it when no debt is owed.
fn release_or_forget_permit(permit: OwnedSemaphorePermit, pending_forgets: &AtomicUsize) {
    if pending_forgets
        .try_update(AtomicOrdering::SeqCst, AtomicOrdering::SeqCst, |debt| {
            debt.checked_sub(1)
        })
        .is_ok()
    {
        permit.forget();
    } else {
        drop(permit);
    }
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use tokio::sync::Notify;

    use super::*;

    fn make_request(worker_id: Uuid, priority: TurnPriority) -> AgentTurnRequest {
        make_labeled(worker_id, priority, "test")
    }

    fn make_labeled(worker_id: Uuid, priority: TurnPriority, label: &str) -> AgentTurnRequest {
        AgentTurnRequest {
            worker_id,
            turn: TurnInput {
                prompt: label.to_string(),
            },
            priority,
        }
    }

    /// Polls `condition` every 5ms until it holds, panicking with `what`
    /// after 5 seconds.
    async fn eventually(what: &str, condition: impl Fn() -> bool) {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
        while !condition() {
            assert!(
                tokio::time::Instant::now() < deadline,
                "timed out waiting for: {what}"
            );
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    }

    /// An executor whose turns log `"<prompt>:start"`, then block until
    /// the test releases them (`Notify::notify_waiters` wakes every
    /// currently-blocked turn), then log `"<prompt>:end"`.
    struct Gated {
        scheduler: AgentScheduler,
        in_flight: Arc<AtomicUsize>,
        release: Arc<Notify>,
        log: Arc<parking_lot::Mutex<Vec<String>>>,
    }

    fn gated_scheduler(concurrent_limit: usize) -> Gated {
        let in_flight = Arc::new(AtomicUsize::new(0));
        let release = Arc::new(Notify::new());
        let log = Arc::new(parking_lot::Mutex::new(Vec::new()));
        let scheduler = AgentScheduler::new(AgentSchedulerConfig { concurrent_limit }, {
            let in_flight = in_flight.clone();
            let release = release.clone();
            let log = log.clone();
            move |request: AgentTurnRequest| {
                let in_flight = in_flight.clone();
                let release = release.clone();
                let log = log.clone();
                async move {
                    // Register as a waiter BEFORE announcing the start, so
                    // a release fired right after a test observes the start
                    // is never lost.
                    let mut released = std::pin::pin!(release.notified());
                    released.as_mut().enable();
                    log.lock().push(format!("{}:start", request.turn.prompt));
                    in_flight.fetch_add(1, AtomicOrdering::SeqCst);
                    released.await;
                    in_flight.fetch_sub(1, AtomicOrdering::SeqCst);
                    log.lock().push(format!("{}:end", request.turn.prompt));
                }
            }
        });
        Gated {
            scheduler,
            in_flight,
            release,
            log,
        }
    }

    impl Gated {
        fn in_flight(&self) -> usize {
            self.in_flight.load(AtomicOrdering::SeqCst)
        }

        fn started(&self) -> Vec<String> {
            self.log
                .lock()
                .iter()
                .filter_map(|entry| entry.strip_suffix(":start").map(str::to_string))
                .collect()
        }

        /// Releases turns until none is running and the queue is empty.
        async fn drain(&self) {
            let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
            while self.in_flight() > 0 || self.scheduler.queued.load(AtomicOrdering::SeqCst) > 0 {
                assert!(
                    tokio::time::Instant::now() < deadline,
                    "turns never drained"
                );
                self.release.notify_waiters();
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        }
    }

    // ── Admission: priority, FIFO, per-worker exclusivity ─────────────

    #[test]
    fn test_next_admissible_prefers_priority_then_fifo_and_skips_busy_workers() {
        let (a, b, c) = (Uuid::new_v4(), Uuid::new_v4(), Uuid::new_v4());
        let pending = vec![
            Pending {
                request: make_request(a, TurnPriority::Normal),
                sequence: 0,
            },
            Pending {
                request: make_request(b, TurnPriority::High),
                sequence: 1,
            },
            Pending {
                request: make_request(c, TurnPriority::High),
                sequence: 2,
            },
        ];
        let mut busy = HashSet::new();
        assert_eq!(
            next_admissible(&pending, &busy),
            Some(1),
            "highest priority, oldest first"
        );
        busy.insert(b);
        assert_eq!(next_admissible(&pending, &busy), Some(2));
        busy.insert(c);
        assert_eq!(next_admissible(&pending, &busy), Some(0));
        busy.insert(a);
        assert_eq!(next_admissible(&pending, &busy), None);
    }

    /// Requests queued behind a running turn dispatch by priority, then
    /// FIFO — decided when the permit frees, not when they arrived. The
    /// release below races the requests still sitting in the intake
    /// channel; the biased dispatch loop must queue them all first.
    #[tokio::test]
    async fn test_live_scheduler_dispatches_by_priority_then_fifo() {
        let gated = gated_scheduler(1);
        gated
            .scheduler
            .enqueue(make_labeled(Uuid::new_v4(), TurnPriority::Low, "first"))
            .unwrap();
        eventually("first turn running", || gated.in_flight() == 1).await;

        for (priority, label) in [
            (TurnPriority::Low, "low"),
            (TurnPriority::Critical, "critical"),
            (TurnPriority::Normal, "normal-1"),
            (TurnPriority::High, "high"),
            (TurnPriority::Normal, "normal-2"),
        ] {
            gated
                .scheduler
                .enqueue(make_labeled(Uuid::new_v4(), priority, label))
                .unwrap();
        }

        gated.drain().await;
        assert_eq!(
            gated.started(),
            ["first", "critical", "high", "normal-1", "normal-2", "low"]
        );
    }

    /// Follow-ups queued for a busy worker must not hold permits, so
    /// another worker's turn starts while they wait (head-of-line
    /// blocking regression).
    #[tokio::test]
    async fn test_queued_follow_ups_for_one_worker_do_not_starve_other_workers() {
        let gated = gated_scheduler(2);
        let (a, b) = (Uuid::new_v4(), Uuid::new_v4());
        for label in ["a1", "a2", "a3"] {
            gated
                .scheduler
                .enqueue(make_labeled(a, TurnPriority::Normal, label))
                .unwrap();
        }
        gated
            .scheduler
            .enqueue(make_labeled(b, TurnPriority::Normal, "b1"))
            .unwrap();

        eventually("a1 and b1 running together", || gated.in_flight() == 2).await;
        assert_eq!(
            gated.started(),
            ["a1", "b1"],
            "worker A's follow-ups must wait without a permit; B runs beside A1"
        );

        gated.drain().await;
        let log = gated.log.lock().clone();
        let position = |entry: &str| log.iter().position(|e| e == entry).unwrap();
        assert!(position("a1:end") < position("a2:start"));
        assert!(position("a2:end") < position("a3:start"));
    }

    // ── Backpressure ──────────────────────────────────────────────────

    #[tokio::test]
    async fn test_enqueue_returns_queue_full_once_capacity_requests_are_waiting() {
        let gated = gated_scheduler(1);
        let worker = Uuid::new_v4();
        gated
            .scheduler
            .enqueue(make_request(worker, TurnPriority::Normal))
            .unwrap();
        eventually("first turn running", || gated.in_flight() == 1).await;

        for _ in 0..AGENT_TURN_QUEUE_CAPACITY {
            gated
                .scheduler
                .enqueue(make_request(worker, TurnPriority::Normal))
                .expect("capacity not reached yet");
        }
        let overflow = gated
            .scheduler
            .enqueue(make_request(worker, TurnPriority::Normal));
        assert!(
            matches!(
                overflow,
                Err(AppError::QueueFull {
                    capacity: AGENT_TURN_QUEUE_CAPACITY
                })
            ),
            "got {overflow:?}"
        );

        gated.drain().await;
        gated
            .scheduler
            .enqueue(make_request(worker, TurnPriority::Normal))
            .expect("capacity is available again once the queue drains");
        gated.drain().await;
    }

    #[test]
    fn test_enqueue_after_the_runtime_is_gone_returns_channel_closed() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let scheduler = runtime.block_on(async {
            AgentScheduler::new(AgentSchedulerConfig::default(), |_req| async {})
        });
        drop(runtime);

        let result = scheduler.enqueue(make_request(Uuid::new_v4(), TurnPriority::Normal));
        assert!(
            matches!(result, Err(AppError::ChannelClosed(_))),
            "got {result:?}"
        );
        assert_eq!(
            scheduler.queued.load(AtomicOrdering::SeqCst),
            0,
            "a rejected request must not leak queue capacity"
        );
    }

    // ── Executor failure ──────────────────────────────────────────────

    /// A panicking executor still releases its permit and its worker's
    /// slot — otherwise a limit-1 scheduler would stall forever.
    #[tokio::test]
    async fn test_panicking_executor_releases_its_permit_and_worker_slot() {
        let completed = Arc::new(AtomicUsize::new(0));
        let scheduler = AgentScheduler::new(
            AgentSchedulerConfig {
                concurrent_limit: 1,
            },
            {
                let completed = completed.clone();
                move |request: AgentTurnRequest| {
                    let completed = completed.clone();
                    async move {
                        assert_ne!(request.turn.prompt, "boom", "deliberate executor panic");
                        completed.fetch_add(1, AtomicOrdering::SeqCst);
                    }
                }
            },
        );
        let worker = Uuid::new_v4();
        scheduler
            .enqueue(make_labeled(worker, TurnPriority::Normal, "boom"))
            .unwrap();
        scheduler
            .enqueue(make_labeled(worker, TurnPriority::Normal, "after"))
            .unwrap();
        eventually("the turn after the panic ran", || {
            completed.load(AtomicOrdering::SeqCst) == 1
        })
        .await;
    }

    // ── Concurrency limit ─────────────────────────────────────────────

    /// The scheduler reaches, and never exceeds, the concurrency limit.
    #[tokio::test]
    async fn test_scheduler_reaches_but_never_exceeds_the_concurrency_limit() {
        let gated = gated_scheduler(2);
        for _ in 0..5 {
            gated
                .scheduler
                .enqueue(make_request(Uuid::new_v4(), TurnPriority::Normal))
                .unwrap();
        }
        eventually("two turns running", || gated.in_flight() == 2).await;
        tokio::time::sleep(Duration::from_millis(30)).await;
        assert_eq!(gated.in_flight(), 2, "must not exceed the limit");
        gated.drain().await;
        assert_eq!(gated.started().len(), 5);
    }

    #[tokio::test]
    async fn test_zero_limits_are_clamped_instead_of_stalling_forever() {
        let gated = gated_scheduler(0);
        assert_eq!(
            gated
                .scheduler
                .concurrency_limit
                .load(AtomicOrdering::SeqCst),
            1
        );
        gated
            .scheduler
            .enqueue(make_request(Uuid::new_v4(), TurnPriority::Normal))
            .unwrap();
        eventually("a turn runs at a clamped limit", || gated.in_flight() == 1).await;
        gated.drain().await;

        gated.scheduler.set_concurrency(0);
        assert_eq!(
            gated
                .scheduler
                .concurrency_limit
                .load(AtomicOrdering::SeqCst),
            1
        );
        gated.scheduler.set_concurrency(usize::MAX);
        assert_eq!(
            gated
                .scheduler
                .concurrency_limit
                .load(AtomicOrdering::SeqCst),
            MAX_AGENT_CONCURRENCY as usize
        );
    }

    /// Raising the live limit admits an already-queued turn immediately
    /// via `Semaphore::add_permits`.
    #[tokio::test]
    async fn test_set_concurrency_increase_admits_a_queued_turn_immediately() {
        let gated = gated_scheduler(1);
        for _ in 0..2 {
            gated
                .scheduler
                .enqueue(make_request(Uuid::new_v4(), TurnPriority::Normal))
                .unwrap();
        }
        eventually("first turn running", || gated.in_flight() == 1).await;
        tokio::time::sleep(Duration::from_millis(20)).await;
        assert_eq!(gated.in_flight(), 1, "the second turn must still be queued");

        gated.scheduler.set_concurrency(2);
        assert_eq!(
            gated
                .scheduler
                .concurrency_limit
                .load(AtomicOrdering::SeqCst),
            2
        );
        eventually("second turn admitted", || gated.in_flight() == 2).await;
        gated.drain().await;
    }

    /// Shrinking the limit while every permit is checked out defers the
    /// shortfall and realizes it as the running turns release.
    #[tokio::test]
    async fn test_set_concurrency_decrease_under_full_load_is_realized_on_release() {
        let gated = gated_scheduler(2);
        for _ in 0..2 {
            gated
                .scheduler
                .enqueue(make_request(Uuid::new_v4(), TurnPriority::Normal))
                .unwrap();
        }
        eventually("both permits checked out", || gated.in_flight() == 2).await;

        gated.scheduler.set_concurrency(1);
        assert_eq!(
            gated
                .scheduler
                .concurrency_limit
                .load(AtomicOrdering::SeqCst),
            1
        );
        gated.drain().await;

        for _ in 0..2 {
            gated
                .scheduler
                .enqueue(make_request(Uuid::new_v4(), TurnPriority::Normal))
                .unwrap();
        }
        eventually("one turn running", || gated.in_flight() == 1).await;
        tokio::time::sleep(Duration::from_millis(30)).await;
        assert_eq!(
            gated.in_flight(),
            1,
            "capacity should now be 1 — the deferred forget must have been paid off"
        );
        gated.drain().await;
    }

    /// A decrease applied while permits are idle reclaims synchronously.
    #[tokio::test]
    async fn test_set_concurrency_decrease_while_idle_applies_synchronously() {
        let gated = gated_scheduler(3);
        gated.scheduler.set_concurrency(1);
        assert_eq!(
            gated.scheduler.pending_forgets.load(AtomicOrdering::SeqCst),
            0,
            "shrinking fully-idle capacity should not need to defer anything"
        );
        for _ in 0..2 {
            gated
                .scheduler
                .enqueue(make_request(Uuid::new_v4(), TurnPriority::Normal))
                .unwrap();
        }
        eventually("one turn running", || gated.in_flight() == 1).await;
        tokio::time::sleep(Duration::from_millis(30)).await;
        assert_eq!(
            gated.in_flight(),
            1,
            "the new limit of 1 is already in effect"
        );
        gated.drain().await;
    }

    /// Three down/up cycles while the original turns never release their
    /// permits — peak concurrency must never exceed the configured limit
    /// at any point in the transition (see `set_concurrency`'s binding
    /// invariant).
    #[tokio::test]
    async fn test_set_concurrency_down_up_cycles_under_full_load_never_exceed_the_configured_peak()
    {
        let limit = 4;
        let gated = gated_scheduler(limit);
        let peak = AtomicUsize::new(0);
        let sample = |peak: &AtomicUsize| {
            peak.fetch_max(gated.in_flight(), AtomicOrdering::SeqCst);
        };

        for _ in 0..limit {
            gated
                .scheduler
                .enqueue(make_request(Uuid::new_v4(), TurnPriority::Normal))
                .unwrap();
        }
        eventually("every permit in use", || gated.in_flight() == limit).await;
        sample(&peak);

        for _ in 0..3 {
            gated.scheduler.set_concurrency(1);
            sample(&peak);
            gated.scheduler.set_concurrency(limit);
            sample(&peak);
            gated
                .scheduler
                .enqueue(make_request(Uuid::new_v4(), TurnPriority::Normal))
                .unwrap();
            tokio::time::sleep(Duration::from_millis(30)).await;
            sample(&peak);
        }

        assert!(
            peak.load(AtomicOrdering::SeqCst) <= limit,
            "peak concurrency {} exceeded the configured limit {limit}",
            peak.load(AtomicOrdering::SeqCst)
        );
        gated.drain().await;
        assert_eq!(
            gated
                .scheduler
                .concurrency_limit
                .load(AtomicOrdering::SeqCst),
            limit
        );
        assert_eq!(
            gated.scheduler.pending_forgets.load(AtomicOrdering::SeqCst),
            0
        );
    }

    #[tokio::test]
    async fn test_set_concurrency_same_limit_is_a_no_op() {
        let scheduler = AgentScheduler::new(
            AgentSchedulerConfig {
                concurrent_limit: 4,
            },
            |_req: AgentTurnRequest| async {},
        );
        scheduler.set_concurrency(4);
        assert_eq!(scheduler.concurrency_limit.load(AtomicOrdering::SeqCst), 4);
        assert_eq!(scheduler.pending_forgets.load(AtomicOrdering::SeqCst), 0);
    }

    // ── Wire shape ────────────────────────────────────────────────────

    #[test]
    fn test_turn_priority_orders_low_to_critical_defaults_to_normal_and_is_camel_case() {
        assert!(TurnPriority::Low < TurnPriority::Normal);
        assert!(TurnPriority::Normal < TurnPriority::High);
        assert!(TurnPriority::High < TurnPriority::Critical);
        assert_eq!(TurnPriority::default(), TurnPriority::Normal);
        assert_eq!(
            serde_json::to_string(&TurnPriority::Critical).unwrap(),
            "\"critical\""
        );
    }
}
