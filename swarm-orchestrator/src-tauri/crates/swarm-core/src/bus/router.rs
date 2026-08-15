//! Message routing between workers.
//!
//! Provides two routing modes for inter-agent communication: **direct**
//! (worker A sends a message to worker B on a topic) and **broadcast**
//! (worker A sends to all subscribers of a topic).
//!
//! ## Phase 4 disposition: the bus is the routing layer, not dead
//! (`docs/architecture.md`'s former "Built, Not Wired" entry)
//!
//! Two things changed here in the multi-provider plan's Phase 4 ("bus
//! disposition, part 2"):
//!
//! 1. **DELETED**: `create_pipeline`/`execute_pipeline`/`PipelineStage`/
//!    `apply_transform` (~150 lines) — `execute_pipeline` never awaited
//!    any stage's completion and `apply_transform` only ever narrowed
//!    the INITIAL payload, never any worker's actual output. A
//!    synchronous fan-out wearing a pipeline's name, not a real one. Real
//!    multi-stage handoffs are handoff CHAINS derived from
//!    `causedBySeq` on successive `bus_message`/`agent_turn_started`
//!    events — an ordered causal log already gives you a pipeline for
//!    free, without a separate stage-registration API to keep in sync
//!    with reality.
//! 2. **[`Router::send_direct`]/[`Router::send_broadcast`] now emit
//!    `bus_message` THEMSELVES**, synchronously, via the [`EventSink`]
//!    they're constructed with — this is the actual fix that makes the
//!    bus a real routing layer instead of "implemented but not exposed."
//!    Before this change, a sent message only reached the frontend if
//!    SOME caller had an active `bus_subscribe` forwarder task running
//!    for that exact topic (and `bus_subscribe` had zero callers anywhere
//!    in the app — see the now-deleted command's history). Every send now
//!    reaches the ordered spine unconditionally, the same guarantee every
//!    other `agent_*`/`worker_*` event already had.

use uuid::Uuid;

use super::channel::{BusMessage, MessageBus};
use crate::events::{BusMessagePayload, EventSink, Provenance, SwarmEvent};

/// Routes messages between workers using direct and broadcast modes.
///
/// The router holds a reference to the [`MessageBus`] for sending
/// messages and an [`EventSink`] for promoting every send onto the
/// ordered spine as a `bus_message` event — see the module doc's Phase 4
/// disposition note.
#[derive(Clone)]
pub struct Router {
    /// Reference to the shared message bus.
    bus: MessageBus,
    /// Every [`Self::send_direct`]/[`Self::send_broadcast`] call emits
    /// `bus_message` through this sink — see the module doc.
    sink: EventSink,
}

impl Router {
    /// Creates a new router backed by the given message bus and event
    /// sink.
    ///
    /// # Arguments
    ///
    /// * `bus` - The shared [`MessageBus`] for message delivery
    /// * `sink` - The [`EventSink`] every routed message is promoted onto
    pub fn new(bus: MessageBus, sink: EventSink) -> Self {
        Self { bus, sink }
    }

    /// Sends a direct message from one worker to another on a topic and
    /// emits it onto the ordered spine as `bus_message`.
    ///
    /// The message's `to_worker` field is set to the target worker UUID.
    /// This does not guarantee the target worker is subscribed to the
    /// topic at the bus level; it is a hint that the message is intended
    /// for a specific recipient. `bus_message`'s delivery to the
    /// frontend does NOT depend on any bus-level subscriber — see the
    /// module doc.
    ///
    /// # Arguments
    ///
    /// * `from` - UUID of the sending worker (also stamped as the
    ///   event's `originWorker`)
    /// * `to` - UUID of the target worker
    /// * `topic` - Topic channel to send on
    /// * `payload` - JSON payload
    /// * `cause_seq` - The `seq` of the event that caused this send
    ///   (e.g. an `agent_turn_started`/`agent_tool_call` an adapter is
    ///   handing off from), `None` for a human-initiated send with no
    ///   single causing event.
    ///
    /// # Returns
    ///
    /// The number of bus-level receivers that received the message
    /// (independent of, and typically `0` for, the guaranteed
    /// `bus_message` event emission above).
    pub fn send_direct(
        &self,
        from: Uuid,
        to: Uuid,
        topic: &str,
        payload: serde_json::Value,
        cause_seq: Option<u64>,
    ) -> Result<usize, String> {
        self.bus.create_channel(topic);

        let msg = BusMessage {
            id: Uuid::new_v4(),
            from_worker: from,
            to_worker: Some(to),
            topic: topic.to_string(),
            payload: payload.clone(),
            timestamp: now_ms(),
        };

        let count = self.bus.send(msg.clone())?;
        self.emit_bus_message(&msg, cause_seq);
        Ok(count)
    }

    /// Broadcasts a message to all subscribers of a topic and emits it
    /// onto the ordered spine as `bus_message` — see [`Self::send_direct`]'s
    /// doc for the delivery-guarantee note.
    ///
    /// # Arguments
    ///
    /// * `from` - UUID of the sending worker
    /// * `topic` - Topic to broadcast on
    /// * `payload` - JSON payload
    /// * `cause_seq` - See [`Self::send_direct`]'s doc.
    ///
    /// # Returns
    ///
    /// The number of bus-level receivers that received the message.
    pub fn send_broadcast(
        &self,
        from: Uuid,
        topic: &str,
        payload: serde_json::Value,
        cause_seq: Option<u64>,
    ) -> Result<usize, String> {
        self.bus.create_channel(topic);

        let msg = BusMessage {
            id: Uuid::new_v4(),
            from_worker: from,
            to_worker: None,
            topic: topic.to_string(),
            payload: payload.clone(),
            timestamp: now_ms(),
        };

        let count = self.bus.send(msg.clone())?;
        self.emit_bus_message(&msg, cause_seq);
        Ok(count)
    }

    fn emit_bus_message(&self, msg: &BusMessage, cause_seq: Option<u64>) {
        self.sink.emit_with(
            SwarmEvent::BusMessage(BusMessagePayload {
                message_id: msg.id,
                from_worker: msg.from_worker,
                to_worker: msg.to_worker,
                topic: msg.topic.clone(),
                payload: msg.payload.clone(),
            }),
            Provenance {
                origin_worker: Some(msg.from_worker),
                cause_seq,
            },
        );
    }
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::orchestration::{EventLog, OrchestrationEngine};

    fn test_router() -> (Router, crate::events::EventSink, std::path::PathBuf) {
        let db_path = std::env::temp_dir().join(format!("swarm-router-test-{}.db", Uuid::new_v4()));
        let log = EventLog::open(&db_path).expect("open file-backed log");
        let engine = OrchestrationEngine::start(log, Some(db_path.clone()), |_| {});
        let sink = engine.sink();
        let bus = MessageBus::new();
        let router = Router::new(bus, sink.clone());
        (router, sink, db_path)
    }

    fn cleanup(db_path: &std::path::Path) {
        std::fs::remove_file(db_path).ok();
        std::fs::remove_file(format!("{}-wal", db_path.display())).ok();
        std::fs::remove_file(format!("{}-shm", db_path.display())).ok();
    }

    async fn wait_for_event_type(db_path: &std::path::Path, event_type: &str) {
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        loop {
            let log = EventLog::open(db_path).expect("reopen log");
            let events = log.events_since(0, 100).expect("read events");
            if events.iter().any(|e| e.event_type == event_type) {
                return;
            }
            if std::time::Instant::now() > deadline {
                panic!("timed out waiting for {event_type}");
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    }

    /// DIRECTIVE: `send_direct` emits `bus_message` onto the spine with
    /// ZERO active bus-level subscribers — the actual "bus is now the
    /// routing layer" fix. Before Phase 4, this required an active
    /// `bus_subscribe` forwarder task (which nothing in the app ever
    /// started).
    #[tokio::test]
    async fn test_send_direct_emits_bus_message_with_no_subscriber() {
        let (router, _sink, db_path) = test_router();
        let from = Uuid::new_v4();
        let to = Uuid::new_v4();

        let receivers = router
            .send_direct(
                from,
                to,
                "handoff",
                serde_json::json!({"task": "review"}),
                None,
            )
            .expect("send_direct should succeed");
        assert_eq!(receivers, 0, "no bus-level subscriber is active");

        wait_for_event_type(&db_path, "bus_message").await;

        let log = EventLog::open(&db_path).expect("reopen log");
        let events = log.events_since(0, 100).expect("read events");
        let row = events
            .iter()
            .find(|e| e.event_type == "bus_message")
            .expect("bus_message row");
        assert_eq!(row.payload["fromWorker"], from.to_string());
        assert_eq!(row.payload["toWorker"], to.to_string());
        assert_eq!(row.payload["topic"], "handoff");

        cleanup(&db_path);
    }

    /// DIRECTIVE: `cause_seq` threads through to the envelope's causal
    /// attribution — an agent-to-agent handoff can cite the turn/tool
    /// event that triggered it.
    #[tokio::test]
    async fn test_send_broadcast_threads_cause_seq_onto_the_envelope() {
        let (router, sink, db_path) = test_router();
        let from = Uuid::new_v4();

        // Manufacture a real seq to cite as the cause.
        let ack = sink.emit_awaiting_seq(
            SwarmEvent::AgentTurnStarted(crate::events::AgentTurnStartedPayload {
                worker_id: from,
                model: "test-model".to_string(),
                request_id: "req-1".to_string(),
            }),
            Provenance::default(),
        );
        let cause_seq = ack.await.expect("ack should resolve");

        router
            .send_broadcast(from, "results", serde_json::json!("done"), Some(cause_seq))
            .expect("send_broadcast should succeed");

        wait_for_event_type(&db_path, "bus_message").await;

        let log = EventLog::open(&db_path).expect("reopen log");
        let events = log.events_since(0, 100).expect("read events");
        let row = events
            .iter()
            .find(|e| e.event_type == "bus_message")
            .expect("bus_message row");
        assert_eq!(row.cause_seq, Some(cause_seq));
        assert_eq!(row.origin_worker, Some(from));

        cleanup(&db_path);
    }
}
