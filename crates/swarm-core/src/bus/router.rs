//! Turns a bus send into its `bus_message` event.

use std::time::Duration;

use serde_json::Value;
use uuid::Uuid;

use super::channel::MessageBus;
use crate::events::{BusMessagePayload, EventSink, Provenance, SwarmEvent};

/// How long [`Router::send`] waits for the event log to record a
/// `bus_message` before it reports the send as failed.
const BUS_MESSAGE_ACK_TIMEOUT: Duration = Duration::from_secs(5);

/// Routes bus sends onto the ordered event stream. Cheap to clone.
#[derive(Clone)]
pub struct Router {
    bus: MessageBus,
    sink: EventSink,
}

impl Router {
    /// A router registering topics in `bus` and recording every send
    /// through `sink`.
    pub fn new(bus: MessageBus, sink: EventSink) -> Self {
        Self { bus, sink }
    }

    /// Sends `payload` from worker `from` on `topic`, to worker `to` or,
    /// when `to` is `None`, to every listener: records a `bus_message`
    /// event whose `originWorker` is `from` and whose `causeSeq` is
    /// `cause_seq` — the seq of the event that prompted the send (an
    /// agent handing off after a tool call, say), or `None` for a
    /// human-initiated send. Returns the new message's id once the event
    /// is recorded.
    ///
    /// # Errors
    ///
    /// * When `topic` is new and the topic registry is full (see
    ///   [`MessageBus::register`]); nothing is recorded then.
    /// * `Event Writer Unavailable.` when the event was dropped (the
    ///   engine is shut down, or the writer could not persist it); nothing
    ///   is delivered.
    /// * `Bus Send Timed Out.` when the event was not recorded within
    ///   five seconds. It stays queued and may still be recorded and
    ///   delivered, so a retry can duplicate the hand-off.
    pub async fn send(
        &self,
        from: Uuid,
        to: Option<Uuid>,
        topic: String,
        payload: Value,
        cause_seq: Option<u64>,
    ) -> Result<Uuid, String> {
        self.bus.register(&topic)?;
        let message_id = Uuid::new_v4();
        let ack = self.sink.emit_awaiting_seq(
            SwarmEvent::BusMessage(BusMessagePayload {
                message_id,
                from_worker: from,
                to_worker: to,
                topic,
                payload,
            }),
            Provenance {
                origin_worker: Some(from),
                cause_seq,
            },
        );
        match tokio::time::timeout(BUS_MESSAGE_ACK_TIMEOUT, ack).await {
            Ok(Ok(_seq)) => Ok(message_id),
            Ok(Err(_)) => Err("Event Writer Unavailable.".to_owned()),
            Err(_elapsed) => Err("Bus Send Timed Out.".to_owned()),
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::mpsc;

    use serde_json::json;

    use super::*;
    use crate::orchestration::{DomainEvent, EventLog, OrchestrationEngine};

    /// A router over a live in-memory engine, plus every envelope it
    /// emits.
    fn router() -> (Router, OrchestrationEngine, mpsc::Receiver<DomainEvent>) {
        let (tx, rx) = mpsc::channel();
        let engine =
            OrchestrationEngine::start(EventLog::open_in_memory().unwrap(), None, move |e| {
                let _ = tx.send(e.clone());
            });
        (Router::new(MessageBus::new(), engine.sink()), engine, rx)
    }

    #[tokio::test]
    async fn test_direct_send_records_a_stamped_bus_message() {
        let (router, engine, events) = router();
        let (from, to) = (Uuid::new_v4(), Uuid::new_v4());

        let id = router
            .send(
                from,
                Some(to),
                "handoff".to_owned(),
                json!({"task": "review"}),
                Some(7),
            )
            .await
            .unwrap();
        engine.flush().await.unwrap();

        let envelope = events.try_recv().unwrap();
        assert_eq!(envelope.origin_worker, Some(from));
        assert_eq!(envelope.cause_seq, Some(7));
        let SwarmEvent::BusMessage(message) = envelope.event else {
            panic!("expected bus_message");
        };
        assert_eq!(message.message_id, id);
        assert_eq!(message.to_worker, Some(to));
        assert_eq!(message.topic, "handoff");
        assert_eq!(message.payload, json!({"task": "review"}));
    }

    #[tokio::test]
    async fn test_broadcast_send_has_no_recipient_and_registers_its_topic() {
        let (router, engine, events) = router();
        router
            .send(
                Uuid::new_v4(),
                None,
                "results".to_owned(),
                json!("done"),
                None,
            )
            .await
            .unwrap();
        engine.flush().await.unwrap();

        let SwarmEvent::BusMessage(message) = events.try_recv().unwrap().event else {
            panic!("expected bus_message");
        };
        assert_eq!(message.to_worker, None);
        assert_eq!(router.bus.list_channels(), ["results"]);
    }

    /// A send refused by the topic cap records nothing.
    #[tokio::test]
    async fn test_a_refused_send_records_nothing() {
        let (router, engine, events) = router();
        for i in 0..crate::bus::channel::MAX_TOPICS {
            router.bus.register(&format!("t{i}")).unwrap();
        }
        assert!(
            router
                .send(Uuid::new_v4(), None, "new".to_owned(), json!(1), None)
                .await
                .is_err()
        );
        engine.flush().await.unwrap();
        assert!(events.try_recv().is_err());
    }

    /// A send whose event the engine drops (it is shut down) fails
    /// rather than reporting a hand-off nobody recorded.
    #[tokio::test]
    async fn test_a_send_after_engine_shutdown_reports_the_writer_unavailable() {
        let (router, engine, _events) = router();
        tokio::task::spawn_blocking(move || engine.shutdown())
            .await
            .unwrap()
            .unwrap();

        assert_eq!(
            router
                .send(Uuid::new_v4(), None, "late".to_owned(), json!(1), None)
                .await,
            Err("Event Writer Unavailable.".to_owned())
        );
    }
}
