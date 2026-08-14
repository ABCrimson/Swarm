//! AI request queue.
//!
//! Manages backpressure and rate limiting for outbound AI API
//! requests using a priority queue backed by `BinaryHeap`.
//! Concurrency is controlled by a Tokio `Semaphore`, ensuring
//! at most `concurrent_limit` requests are in-flight at once.
//!
//! Uses a bounded mpsc channel (capacity 256) for backpressure
//! and a `JoinSet` to track spawned tasks for clean shutdown.

use std::cmp::Ordering;
use std::collections::BinaryHeap;
use std::sync::Arc;

use parking_lot::Mutex;
use tokio::sync::{Semaphore, mpsc};
use tokio::task::JoinSet;

use super::client::{AiClient, AiRequest};
use crate::events::{AiStreamSettledPayload, EventSink, SwarmEvent};

/// Bounded channel capacity for the AI request queue.
const AI_QUEUE_CAPACITY: usize = 256;

/// A priority-wrapped AI request for the internal heap.
///
/// Requests are ordered by priority (descending) and then
/// by insertion sequence (ascending / FIFO) for stable ordering
/// within the same priority level.
#[derive(Debug)]
struct PrioritizedRequest {
    /// The original AI request.
    request: AiRequest,
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

/// Configuration for the AI request queue.
///
/// # Defaults
///
/// | Field              | Default |
/// |--------------------|---------|
/// | `concurrent_limit` | 3       |
#[derive(Debug, Clone)]
pub struct AiQueueConfig {
    /// Maximum number of concurrent in-flight AI requests.
    pub concurrent_limit: usize,
}

impl Default for AiQueueConfig {
    fn default() -> Self {
        Self {
            concurrent_limit: 3,
        }
    }
}

/// Priority queue for AI requests with concurrency limiting.
///
/// Accepts requests via a bounded mpsc channel (capacity 256),
/// orders them by priority in a `BinaryHeap`, and processes them
/// through a Tokio `Semaphore` gate that limits concurrency.
/// Spawned tasks are tracked via a `JoinSet` for clean shutdown.
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
///                         JoinSet::spawn(client.stream_message())
/// ```
///
/// # Examples
///
/// ```ignore
/// use swarm_core::ai::{AiQueue, AiQueueConfig, AiClient, AiClientConfig, AiRequest};
///
/// // Created during shell setup:
/// // let queue = AiQueue::new(engine.sink(), ai_client, AiQueueConfig::default());
/// // app.manage(queue);
/// ```
pub struct AiQueue {
    /// Channel sender for submitting new requests.
    sender: mpsc::Sender<AiRequest>,
}

impl AiQueue {
    /// Creates a new AI queue and starts the background processing loop.
    ///
    /// The queue processes requests in priority order with a
    /// configurable concurrency limit. Uses a bounded channel
    /// with capacity [`AI_QUEUE_CAPACITY`] for backpressure.
    ///
    /// # Arguments
    ///
    /// * `sink` - Event sink for emitting events during streaming
    /// * `client` - The AI client for making API requests
    /// * `config` - Queue configuration (concurrency limit)
    ///
    /// # Returns
    ///
    /// A new `AiQueue` instance ready to accept requests via [`enqueue`](Self::enqueue).
    pub fn new(sink: EventSink, client: AiClient, config: AiQueueConfig) -> Self {
        let (sender, receiver) = mpsc::channel::<AiRequest>(AI_QUEUE_CAPACITY);

        tokio::spawn(Self::process_loop(sink, client, receiver, config));

        Self { sender }
    }

    /// Enqueues an AI request for processing.
    ///
    /// The request is sent to the background processing loop via
    /// a bounded mpsc channel. If the channel is full, returns
    /// [`AppError::QueueFull`](crate::error::AppError::QueueFull)
    /// immediately (non-blocking backpressure).
    ///
    /// # Arguments
    ///
    /// * `request` - The AI request to enqueue
    ///
    /// # Errors
    ///
    /// * [`AppError::QueueFull`](crate::error::AppError::QueueFull) -
    ///   The bounded channel is at capacity
    /// * [`AppError::ChannelClosed`](crate::error::AppError::ChannelClosed) -
    ///   The processing loop has shut down and the channel is closed
    pub fn enqueue(&self, request: AiRequest) -> Result<(), crate::error::AppError> {
        self.sender.try_send(request).map_err(|e| match e {
            mpsc::error::TrySendError::Full(_) => crate::error::AppError::QueueFull {
                capacity: AI_QUEUE_CAPACITY,
            },
            mpsc::error::TrySendError::Closed(_) => {
                crate::error::AppError::ChannelClosed("AI queue channel closed".to_string())
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
    /// 5. Spawns a task in a `JoinSet` to process the request
    ///
    /// When the channel closes, drains the `JoinSet` to wait for
    /// all in-flight tasks to complete before exiting.
    ///
    /// # Arguments
    ///
    /// * `sink` - Event sink for event emission
    /// * `client` - The AI client for making API requests
    /// * `receiver` - The mpsc channel receiver for incoming requests
    /// * `config` - Queue configuration (concurrency limit)
    #[tracing::instrument(skip(sink, client, receiver), fields(concurrent_limit = config.concurrent_limit))]
    async fn process_loop(
        sink: EventSink,
        client: AiClient,
        mut receiver: mpsc::Receiver<AiRequest>,
        config: AiQueueConfig,
    ) {
        let semaphore = Arc::new(Semaphore::new(config.concurrent_limit));
        let heap = Arc::new(Mutex::new(BinaryHeap::<PrioritizedRequest>::new()));
        let sequence = Arc::new(std::sync::atomic::AtomicU64::new(0));
        let mut join_set = JoinSet::new();

        tracing::info!(
            concurrent_limit = config.concurrent_limit,
            channel_capacity = AI_QUEUE_CAPACITY,
            "AI queue processing loop started"
        );

        loop {
            // Wait for a request to arrive
            let Some(request) = receiver.recv().await else {
                tracing::info!("AI queue channel closed, stopping processing loop");
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
                        tracing::error!(error = %e, "AI queue semaphore closed unexpectedly");
                        return;
                    }
                };

                let client = client.clone();
                let sink = sink.clone();

                join_set.spawn(async move {
                    let request_id = prioritized.request.request_id.clone();
                    match client.stream_message(&sink, &prioritized.request).await {
                        Ok(_) => {
                            sink.emit(SwarmEvent::AiStreamSettled(AiStreamSettledPayload {
                                request_id: request_id.clone(),
                                status: "ok".to_string(),
                                error: None,
                            }));
                        }
                        Err(e) => {
                            tracing::error!(
                                request_id = %request_id,
                                error = %e,
                                "AI request failed"
                            );
                            sink.emit(SwarmEvent::AiStreamSettled(AiStreamSettledPayload {
                                request_id: request_id.clone(),
                                status: "error".to_string(),
                                error: Some(e.to_string()),
                            }));
                        }
                    }
                    drop(permit);
                });
            }
        }

        // Drain the join set — wait for all in-flight tasks to complete
        tracing::info!("draining AI queue join set");
        while let Some(result) = join_set.join_next().await {
            if let Err(e) = result {
                tracing::error!(error = %e, "AI request task panicked");
            }
        }
        tracing::info!("AI queue processing loop stopped");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai::client::{AiMessage, AiPriority, AiRequest};

    /// Helper to build a minimal AiRequest for testing.
    fn make_request(id: &str, priority: AiPriority) -> AiRequest {
        AiRequest {
            request_id: id.to_string(),
            messages: vec![AiMessage {
                role: "user".to_string(),
                content: "test".to_string(),
            }],
            system: None,
            priority,
        }
    }

    #[test]
    fn test_queue_full_returns_error() {
        // Create a very small bounded channel to simulate backpressure
        let (sender, _receiver) = mpsc::channel::<AiRequest>(2);

        // Fill the channel to capacity using try_send
        sender
            .try_send(make_request("r1", AiPriority::Normal))
            .expect("first send should succeed");
        sender
            .try_send(make_request("r2", AiPriority::Normal))
            .expect("second send should succeed");

        // Third send should fail with Full
        let result = sender.try_send(make_request("r3", AiPriority::Normal));
        assert!(result.is_err());
        match result.unwrap_err() {
            mpsc::error::TrySendError::Full(_) => {} // expected
            other => panic!("expected TrySendError::Full, got: {:?}", other),
        }
    }

    #[test]
    fn test_queue_full_maps_to_app_error() {
        // Simulate the AiQueue::enqueue error mapping path
        let (sender, _receiver) = mpsc::channel::<AiRequest>(1);

        sender
            .try_send(make_request("r1", AiPriority::Normal))
            .unwrap();

        // Map the error exactly as AiQueue::enqueue does
        let result = sender
            .try_send(make_request("r2", AiPriority::Normal))
            .map_err(|e| match e {
                mpsc::error::TrySendError::Full(_) => {
                    crate::error::AppError::QueueFull { capacity: 1 }
                }
                mpsc::error::TrySendError::Closed(_) => {
                    crate::error::AppError::ChannelClosed("AI queue channel closed".to_string())
                }
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
            request: make_request("low", AiPriority::Low),
            priority: AiPriority::Low as i32,
            sequence: 0,
        });
        heap.push(PrioritizedRequest {
            request: make_request("critical", AiPriority::Critical),
            priority: AiPriority::Critical as i32,
            sequence: 1,
        });
        heap.push(PrioritizedRequest {
            request: make_request("normal", AiPriority::Normal),
            priority: AiPriority::Normal as i32,
            sequence: 2,
        });
        heap.push(PrioritizedRequest {
            request: make_request("high", AiPriority::High),
            priority: AiPriority::High as i32,
            sequence: 3,
        });

        // Pop order should be: Critical > High > Normal > Low
        assert_eq!(heap.pop().unwrap().request.request_id, "critical");
        assert_eq!(heap.pop().unwrap().request.request_id, "high");
        assert_eq!(heap.pop().unwrap().request.request_id, "normal");
        assert_eq!(heap.pop().unwrap().request.request_id, "low");
    }

    #[test]
    fn test_fifo_within_same_priority() {
        let mut heap = BinaryHeap::<PrioritizedRequest>::new();

        // All same priority — FIFO by sequence (lower sequence = earlier)
        heap.push(PrioritizedRequest {
            request: make_request("first", AiPriority::Normal),
            priority: AiPriority::Normal as i32,
            sequence: 0,
        });
        heap.push(PrioritizedRequest {
            request: make_request("second", AiPriority::Normal),
            priority: AiPriority::Normal as i32,
            sequence: 1,
        });
        heap.push(PrioritizedRequest {
            request: make_request("third", AiPriority::Normal),
            priority: AiPriority::Normal as i32,
            sequence: 2,
        });

        // Within same priority, lower sequence pops first (FIFO)
        assert_eq!(heap.pop().unwrap().request.request_id, "first");
        assert_eq!(heap.pop().unwrap().request.request_id, "second");
        assert_eq!(heap.pop().unwrap().request.request_id, "third");
    }

    #[tokio::test]
    async fn test_enqueue_and_receive() {
        let (sender, mut receiver) = mpsc::channel::<AiRequest>(AI_QUEUE_CAPACITY);

        let request = make_request("test-recv", AiPriority::High);
        sender.try_send(request).expect("enqueue should succeed");

        // Verify the request arrives on the receiver
        let received = receiver.recv().await.expect("should receive a request");
        assert_eq!(received.request_id, "test-recv");
        assert_eq!(received.priority, AiPriority::High);
    }

    #[tokio::test]
    async fn test_channel_closed_returns_error() {
        let (sender, receiver) = mpsc::channel::<AiRequest>(4);

        // Drop the receiver to close the channel
        drop(receiver);

        let result = sender
            .try_send(make_request("orphan", AiPriority::Normal))
            .map_err(|e| match e {
                mpsc::error::TrySendError::Full(_) => {
                    crate::error::AppError::QueueFull { capacity: 4 }
                }
                mpsc::error::TrySendError::Closed(_) => {
                    crate::error::AppError::ChannelClosed("AI queue channel closed".to_string())
                }
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
            request: make_request("a", AiPriority::Normal),
            priority: AiPriority::Normal as i32,
            sequence: 5,
        };
        let b = PrioritizedRequest {
            request: make_request("b", AiPriority::Normal),
            priority: AiPriority::Normal as i32,
            sequence: 5,
        };
        let c = PrioritizedRequest {
            request: make_request("c", AiPriority::High),
            priority: AiPriority::High as i32,
            sequence: 5,
        };

        // Same priority and sequence => equal
        assert_eq!(a, b);
        // Different priority => not equal
        assert_ne!(a, c);
    }
}
