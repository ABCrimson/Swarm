//! Agent turn scheduler.
//!
//! Absorbed from the deleted `ai/queue.rs` (see `docs/architecture.md`'s
//! adapter-layer section and the multi-provider plan's dead-code
//! disposition table) — the BinaryHeap-priority + Semaphore-gated +
//! JoinSet-tracked + bounded-mpsc(256) machinery transfers essentially
//! unmodified, retyped from `AiRequest`/`AiPriority` to
//! [`AgentTurnRequest`]/[`TurnPriority`]. What changed structurally: the
//! old queue owned a concrete `AiClient` and called
//! `client.stream_message(..)` directly, emitting `ai_stream_settled`
//! itself; this scheduler is provider-agnostic (Phase 3 adapters land
//! after this module), so it is generic over an injected `executor`
//! closure instead. The executor owns everything provider-specific —
//! driving the [`crate::agent::adapter::AgentSession`], emitting the
//! `agent_*` event family (including the terminal `agent_turn_settled`,
//! Condition B's synthesized-on-kill guarantee included) — while this
//! module's only job stays "concurrent agent turns are the scarce
//! resource; gate and order them."
//!
//! Concurrent agent turns are the new scarce resource for exactly the
//! reason the plan gives: you do not want 20 Claude Code processes
//! running tools against one repo at once.
//!
//! Constructed lazily — Phase 2 ships this fully tested but unwired;
//! the shell (`swarm-desktop`) does not `app.manage()` an
//! [`AgentScheduler`] until Phase 3's adapters exist to give the
//! `executor` closure something real to call.

use std::cmp::Ordering;
use std::collections::BinaryHeap;
use std::future::Future;
use std::sync::Arc;

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use tokio::sync::{Semaphore, mpsc};
use tokio::task::JoinSet;
use uuid::Uuid;

use super::adapter::TurnInput;

/// Bounded channel capacity for the agent-turn scheduler — unchanged
/// from `ai/queue.rs`'s `AI_QUEUE_CAPACITY`.
const AGENT_TURN_QUEUE_CAPACITY: usize = 256;

/// Priority levels for scheduled agent turns.
///
/// Replaces `AiPriority` (retired per the plan's dead-code disposition
/// table) — identical ordering semantics (`Low (0) < Normal (1) <
/// High (2) < Critical (3)`), renamed to describe what is actually
/// being prioritized now: agent turns, not raw AI API requests.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TurnPriority {
    /// Lowest priority, processed last.
    Low = 0,
    /// Default priority level.
    #[default]
    Normal = 1,
    /// Elevated priority, processed before Normal and Low.
    High = 2,
    /// Highest priority, processed before all others.
    Critical = 3,
}

/// One agent turn awaiting a concurrency slot.
///
/// Replaces `AiRequest` — carries a [`TurnInput`] bound to a specific
/// worker rather than raw Messages-API `messages`/`system` fields,
/// since turn content is now provider-owned (see
/// `crate::agent::adapter::AgentSession::send_turn`) rather than
/// something this crate constructs an API request body from.
#[derive(Debug, Clone)]
pub struct AgentTurnRequest {
    /// UUID of the worker whose session this turn is sent to.
    pub worker_id: Uuid,
    /// The turn's input.
    pub turn: TurnInput,
    /// Queue priority level.
    pub priority: TurnPriority,
}

/// A priority-wrapped turn request for the internal heap.
///
/// Requests are ordered by priority (descending) and then by insertion
/// sequence (ascending / FIFO) for stable ordering within the same
/// priority level.
#[derive(Debug)]
struct PrioritizedRequest {
    /// The original turn request.
    request: AgentTurnRequest,
    /// Numeric priority (higher = processed first).
    priority: i32,
    /// Insertion order for stable ordering within same priority.
    sequence: u64,
}

impl PartialEq for PrioritizedRequest {
    fn eq(&self, other: &Self) -> bool {
        self.priority == other.priority && self.sequence == other.sequence
    }
}

impl Eq for PrioritizedRequest {}

impl PartialOrd for PrioritizedRequest {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

impl Ord for PrioritizedRequest {
    fn cmp(&self, other: &Self) -> Ordering {
        // Higher priority first, then lower sequence (FIFO within priority)
        self.priority
            .cmp(&other.priority)
            .then_with(|| other.sequence.cmp(&self.sequence))
    }
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
    /// Maximum number of concurrent in-flight agent turns.
    pub concurrent_limit: usize,
}

impl Default for AgentSchedulerConfig {
    fn default() -> Self {
        Self {
            concurrent_limit: 3,
        }
    }
}

/// Priority queue for agent turns with concurrency limiting.
///
/// Accepts requests via a bounded mpsc channel (capacity
/// [`AGENT_TURN_QUEUE_CAPACITY`]), orders them by priority in a
/// `BinaryHeap`, and processes them through a Tokio `Semaphore` gate
/// that limits concurrency. Spawned tasks are tracked via a `JoinSet`
/// for clean shutdown.
///
/// # Architecture
///
/// ```text
/// enqueue() ──mpsc(256)──> process_loop()
///                              │
///                         BinaryHeap (priority sort)
///                              │
///                         Semaphore::acquire()
///                              │
///                         JoinSet::spawn(executor(request))
/// ```
pub struct AgentScheduler {
    /// Channel sender for submitting new requests.
    sender: mpsc::Sender<AgentTurnRequest>,
}

impl AgentScheduler {
    /// Creates a new scheduler and starts the background processing
    /// loop, which drives each admitted [`AgentTurnRequest`] through
    /// `executor`.
    ///
    /// `executor` is responsible for everything provider-specific:
    /// looking up the target [`crate::agent::adapter::AgentSession`],
    /// calling `send_turn`, and emitting the resulting `agent_*` events
    /// (including the terminal `agent_turn_settled`) — this scheduler
    /// only gates concurrency and priority order around that call.
    ///
    /// # Arguments
    ///
    /// * `config` - Queue configuration (concurrency limit)
    /// * `executor` - Async closure invoked once per admitted turn
    pub fn new<F, Fut>(config: AgentSchedulerConfig, executor: F) -> Self
    where
        F: Fn(AgentTurnRequest) -> Fut + Send + Sync + 'static,
        Fut: Future<Output = ()> + Send + 'static,
    {
        let (sender, receiver) = mpsc::channel::<AgentTurnRequest>(AGENT_TURN_QUEUE_CAPACITY);

        tokio::spawn(Self::process_loop(receiver, config, Arc::new(executor)));

        Self { sender }
    }

    /// Enqueues an agent turn for processing.
    ///
    /// The request is sent to the background processing loop via a
    /// bounded mpsc channel. If the channel is full, returns
    /// [`AppError::QueueFull`](crate::error::AppError::QueueFull)
    /// immediately (non-blocking backpressure).
    ///
    /// # Errors
    ///
    /// * [`AppError::QueueFull`](crate::error::AppError::QueueFull) -
    ///   The bounded channel is at capacity
    /// * [`AppError::ChannelClosed`](crate::error::AppError::ChannelClosed) -
    ///   The processing loop has shut down and the channel is closed
    pub fn enqueue(&self, request: AgentTurnRequest) -> Result<(), crate::error::AppError> {
        self.sender.try_send(request).map_err(|e| match e {
            mpsc::error::TrySendError::Full(_) => crate::error::AppError::QueueFull {
                capacity: AGENT_TURN_QUEUE_CAPACITY,
            },
            mpsc::error::TrySendError::Closed(_) => {
                crate::error::AppError::ChannelClosed("agent turn queue channel closed".to_string())
            }
        })
    }

    /// Main processing loop that drains requests in priority order.
    ///
    /// Runs as a long-lived Tokio task. On each iteration:
    /// 1. Waits for a request to arrive on the mpsc channel
    /// 2. Drains any additional pending requests into the heap
    /// 3. Pops requests from the heap in priority order
    /// 4. Acquires a semaphore permit for concurrency control
    /// 5. Spawns a task in a `JoinSet` that runs `executor(request)`
    ///
    /// When the channel closes, drains the `JoinSet` to wait for all
    /// in-flight tasks to complete before exiting.
    #[tracing::instrument(skip(receiver, executor), fields(concurrent_limit = config.concurrent_limit))]
    async fn process_loop<F, Fut>(
        mut receiver: mpsc::Receiver<AgentTurnRequest>,
        config: AgentSchedulerConfig,
        executor: Arc<F>,
    ) where
        F: Fn(AgentTurnRequest) -> Fut + Send + Sync + 'static,
        Fut: Future<Output = ()> + Send + 'static,
    {
        let semaphore = Arc::new(Semaphore::new(config.concurrent_limit));
        let heap = Arc::new(Mutex::new(BinaryHeap::<PrioritizedRequest>::new()));
        let sequence = Arc::new(std::sync::atomic::AtomicU64::new(0));
        let mut join_set = JoinSet::new();

        tracing::info!(
            concurrent_limit = config.concurrent_limit,
            channel_capacity = AGENT_TURN_QUEUE_CAPACITY,
            "agent turn scheduler processing loop started"
        );

        loop {
            // Wait for a request to arrive
            let Some(request) = receiver.recv().await else {
                tracing::info!("agent turn queue channel closed, stopping processing loop");
                break;
            };

            let priority = request.priority as i32;
            let seq = sequence.fetch_add(1, std::sync::atomic::Ordering::Relaxed);

            heap.lock().push(PrioritizedRequest {
                request,
                priority,
                sequence: seq,
            });

            // Drain any additional pending requests into the heap
            while let Ok(extra) = receiver.try_recv() {
                let p = extra.priority as i32;
                let s = sequence.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                heap.lock().push(PrioritizedRequest {
                    request: extra,
                    priority: p,
                    sequence: s,
                });
            }

            // Process from the priority heap — pop without holding guard across await
            loop {
                let Some(prioritized) = heap.lock().pop() else {
                    break;
                };

                let permit = match semaphore.clone().acquire_owned().await {
                    Ok(p) => p,
                    Err(e) => {
                        tracing::error!(error = %e, "agent turn scheduler semaphore closed unexpectedly");
                        return;
                    }
                };

                let executor = executor.clone();
                join_set.spawn(async move {
                    executor(prioritized.request).await;
                    drop(permit);
                });
            }
        }

        // Drain the join set — wait for all in-flight tasks to complete
        tracing::info!("draining agent turn scheduler join set");
        while let Some(result) = join_set.join_next().await {
            if let Err(e) = result {
                tracing::error!(error = %e, "agent turn task panicked");
            }
        }
        tracing::info!("agent turn scheduler processing loop stopped");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Helper to build a minimal AgentTurnRequest for testing.
    fn make_request(worker_id: Uuid, priority: TurnPriority) -> AgentTurnRequest {
        AgentTurnRequest {
            worker_id,
            turn: TurnInput {
                prompt: "test".to_string(),
            },
            priority,
        }
    }

    #[test]
    fn test_queue_full_returns_error() {
        // Create a very small bounded channel to simulate backpressure
        let (sender, _receiver) = mpsc::channel::<AgentTurnRequest>(2);

        // Fill the channel to capacity using try_send
        sender
            .try_send(make_request(Uuid::nil(), TurnPriority::Normal))
            .expect("first send should succeed");
        sender
            .try_send(make_request(Uuid::nil(), TurnPriority::Normal))
            .expect("second send should succeed");

        // Third send should fail with Full
        let result = sender.try_send(make_request(Uuid::nil(), TurnPriority::Normal));
        assert!(result.is_err());
        match result.unwrap_err() {
            mpsc::error::TrySendError::Full(_) => {} // expected
            other => panic!("expected TrySendError::Full, got: {:?}", other),
        }
    }

    #[test]
    fn test_queue_full_maps_to_app_error() {
        // Simulate the AgentScheduler::enqueue error mapping path
        let (sender, _receiver) = mpsc::channel::<AgentTurnRequest>(1);

        sender
            .try_send(make_request(Uuid::nil(), TurnPriority::Normal))
            .unwrap();

        // Map the error exactly as AgentScheduler::enqueue does
        let result = sender
            .try_send(make_request(Uuid::nil(), TurnPriority::Normal))
            .map_err(|e| match e {
                mpsc::error::TrySendError::Full(_) => {
                    crate::error::AppError::QueueFull { capacity: 1 }
                }
                mpsc::error::TrySendError::Closed(_) => crate::error::AppError::ChannelClosed(
                    "agent turn queue channel closed".to_string(),
                ),
            });

        assert!(result.is_err());
        let err_msg = result.unwrap_err().to_string();
        assert!(
            err_msg.contains("queue full")
                || err_msg.contains("Queue full")
                || err_msg.contains("1"),
            "expected queue full error with capacity, got: {err_msg}"
        );
    }

    #[test]
    fn test_priority_ordering() {
        let mut heap = BinaryHeap::<PrioritizedRequest>::new();

        // Insert requests with different priorities and sequences
        heap.push(PrioritizedRequest {
            request: make_request(Uuid::nil(), TurnPriority::Low),
            priority: TurnPriority::Low as i32,
            sequence: 0,
        });
        heap.push(PrioritizedRequest {
            request: make_request(Uuid::nil(), TurnPriority::Critical),
            priority: TurnPriority::Critical as i32,
            sequence: 1,
        });
        heap.push(PrioritizedRequest {
            request: make_request(Uuid::nil(), TurnPriority::Normal),
            priority: TurnPriority::Normal as i32,
            sequence: 2,
        });
        heap.push(PrioritizedRequest {
            request: make_request(Uuid::nil(), TurnPriority::High),
            priority: TurnPriority::High as i32,
            sequence: 3,
        });

        // Pop order should be: Critical > High > Normal > Low
        assert_eq!(heap.pop().unwrap().request.priority, TurnPriority::Critical);
        assert_eq!(heap.pop().unwrap().request.priority, TurnPriority::High);
        assert_eq!(heap.pop().unwrap().request.priority, TurnPriority::Normal);
        assert_eq!(heap.pop().unwrap().request.priority, TurnPriority::Low);
    }

    #[test]
    fn test_fifo_within_same_priority() {
        let mut heap = BinaryHeap::<PrioritizedRequest>::new();
        let a = Uuid::new_v4();
        let b = Uuid::new_v4();
        let c = Uuid::new_v4();

        // All same priority — FIFO by sequence (lower sequence = earlier)
        heap.push(PrioritizedRequest {
            request: make_request(a, TurnPriority::Normal),
            priority: TurnPriority::Normal as i32,
            sequence: 0,
        });
        heap.push(PrioritizedRequest {
            request: make_request(b, TurnPriority::Normal),
            priority: TurnPriority::Normal as i32,
            sequence: 1,
        });
        heap.push(PrioritizedRequest {
            request: make_request(c, TurnPriority::Normal),
            priority: TurnPriority::Normal as i32,
            sequence: 2,
        });

        // Within same priority, lower sequence pops first (FIFO)
        assert_eq!(heap.pop().unwrap().request.worker_id, a);
        assert_eq!(heap.pop().unwrap().request.worker_id, b);
        assert_eq!(heap.pop().unwrap().request.worker_id, c);
    }

    #[tokio::test]
    async fn test_enqueue_and_receive() {
        let (sender, mut receiver) = mpsc::channel::<AgentTurnRequest>(AGENT_TURN_QUEUE_CAPACITY);

        let worker_id = Uuid::new_v4();
        let request = make_request(worker_id, TurnPriority::High);
        sender.try_send(request).expect("enqueue should succeed");

        // Verify the request arrives on the receiver
        let received = receiver.recv().await.expect("should receive a request");
        assert_eq!(received.worker_id, worker_id);
        assert_eq!(received.priority, TurnPriority::High);
    }

    #[tokio::test]
    async fn test_channel_closed_returns_error() {
        let (sender, receiver) = mpsc::channel::<AgentTurnRequest>(4);

        // Drop the receiver to close the channel
        drop(receiver);

        let result = sender
            .try_send(make_request(Uuid::nil(), TurnPriority::Normal))
            .map_err(|e| match e {
                mpsc::error::TrySendError::Full(_) => {
                    crate::error::AppError::QueueFull { capacity: 4 }
                }
                mpsc::error::TrySendError::Closed(_) => crate::error::AppError::ChannelClosed(
                    "agent turn queue channel closed".to_string(),
                ),
            });

        assert!(result.is_err());
        let err_msg = result.unwrap_err().to_string();
        assert!(
            err_msg.contains("Channel closed"),
            "expected channel closed error, got: {err_msg}"
        );
    }

    #[test]
    fn test_prioritized_request_equality() {
        let a = PrioritizedRequest {
            request: make_request(Uuid::nil(), TurnPriority::Normal),
            priority: TurnPriority::Normal as i32,
            sequence: 5,
        };
        let b = PrioritizedRequest {
            request: make_request(Uuid::nil(), TurnPriority::Normal),
            priority: TurnPriority::Normal as i32,
            sequence: 5,
        };
        let c = PrioritizedRequest {
            request: make_request(Uuid::nil(), TurnPriority::High),
            priority: TurnPriority::High as i32,
            sequence: 5,
        };

        // Same priority and sequence => equal
        assert_eq!(a, b);
        // Different priority => not equal
        assert_ne!(a, c);
    }

    // ── AgentTurnRequest (new type) ──────────────────────────────────

    /// DIRECTIVE: the retyped request carries a worker id + a
    /// provider-agnostic [`TurnInput`] rather than `AiRequest`'s
    /// `messages`/`system` fields — this is the shape check for the
    /// new type itself, not just its ordering behavior (covered above).
    #[test]
    fn test_agent_turn_request_carries_worker_id_and_turn_input() {
        let worker_id = Uuid::new_v4();
        let request = AgentTurnRequest {
            worker_id,
            turn: TurnInput {
                prompt: "hello".to_string(),
            },
            priority: TurnPriority::Critical,
        };
        assert_eq!(request.worker_id, worker_id);
        assert_eq!(request.turn.prompt, "hello");
        assert_eq!(request.priority, TurnPriority::Critical);
        assert_eq!(TurnPriority::default(), TurnPriority::Normal);
    }

    // ── AgentScheduler end-to-end (executor closure) ─────────────────

    /// DIRECTIVE: the scheduler drives admitted requests through the
    /// injected `executor`, honoring the concurrency limit — proving
    /// the generic-executor redesign preserves the "at most
    /// concurrent_limit in flight" guarantee the plan's verification
    /// #11 requires, without a concrete `AiClient` to test against.
    #[tokio::test]
    async fn test_scheduler_respects_concurrency_limit_and_calls_executor_for_every_request() {
        use std::sync::atomic::{AtomicUsize, Ordering as AtomicOrdering};
        use tokio::sync::Barrier;

        let concurrent_limit = 2;
        let total_requests = 5;
        let in_flight = Arc::new(AtomicUsize::new(0));
        let max_observed = Arc::new(AtomicUsize::new(0));
        let completed = Arc::new(AtomicUsize::new(0));
        // Forces every spawned executor invocation to actually overlap
        // in time before releasing, rather than racing at closure-call
        // speed and reporting a max_observed of 1 by accident.
        let barrier = Arc::new(Barrier::new(concurrent_limit));

        let scheduler = AgentScheduler::new(AgentSchedulerConfig { concurrent_limit }, {
            let in_flight = in_flight.clone();
            let max_observed = max_observed.clone();
            let completed = completed.clone();
            let barrier = barrier.clone();
            move |_req: AgentTurnRequest| {
                let in_flight = in_flight.clone();
                let max_observed = max_observed.clone();
                let completed = completed.clone();
                let barrier = barrier.clone();
                async move {
                    let now = in_flight.fetch_add(1, AtomicOrdering::SeqCst) + 1;
                    max_observed.fetch_max(now, AtomicOrdering::SeqCst);
                    // Only the first `concurrent_limit` tasks reach
                    // the barrier concurrently by construction; wait
                    // briefly instead of a full barrier so this
                    // never deadlocks if the limit is ever violated
                    // downward.
                    let _ =
                        tokio::time::timeout(std::time::Duration::from_millis(200), barrier.wait())
                            .await;
                    in_flight.fetch_sub(1, AtomicOrdering::SeqCst);
                    completed.fetch_add(1, AtomicOrdering::SeqCst);
                }
            }
        });

        for _ in 0..total_requests {
            scheduler
                .enqueue(make_request(Uuid::new_v4(), TurnPriority::Normal))
                .expect("enqueue should succeed");
        }

        // Wait for all requests to complete.
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        while completed.load(AtomicOrdering::SeqCst) < total_requests {
            if std::time::Instant::now() > deadline {
                panic!("scheduler did not complete all requests in time");
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }

        assert_eq!(completed.load(AtomicOrdering::SeqCst), total_requests);
        assert!(
            max_observed.load(AtomicOrdering::SeqCst) <= concurrent_limit,
            "never more than concurrent_limit executors in flight"
        );
    }
}
