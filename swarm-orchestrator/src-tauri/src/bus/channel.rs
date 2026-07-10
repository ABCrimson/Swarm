//! Core message bus using `tokio::sync::broadcast` channels.
//!
//! The [`MessageBus`] manages named topic channels. Workers subscribe
//! to topics they care about and receive messages through broadcast
//! receivers. Each topic is backed by a `broadcast::Sender` with a
//! configurable buffer capacity (default: 256 messages).

use dashmap::DashMap;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tokio::sync::broadcast;
use uuid::Uuid;

/// Default capacity for broadcast channels.
const DEFAULT_CHANNEL_CAPACITY: usize = 256;

/// A message transmitted through the inter-agent message bus.
///
/// Messages carry a JSON payload from one worker to another (direct)
/// or to all subscribers of a topic (broadcast). The `to_worker` field
/// distinguishes between targeted and broadcast messages.
///
/// # Fields
///
/// * `id` - Unique message identifier (UUID v4)
/// * `from_worker` - UUID of the sending worker
/// * `to_worker` - Target worker UUID, or `None` for broadcast
/// * `topic` - The topic channel this message is published to
/// * `payload` - Arbitrary JSON payload
/// * `timestamp` - When the message was created
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BusMessage {
    /// Unique message identifier.
    pub id: Uuid,
    /// UUID of the worker that sent this message.
    pub from_worker: Uuid,
    /// Target worker UUID. `None` means broadcast to all subscribers.
    pub to_worker: Option<Uuid>,
    /// Topic channel this message belongs to.
    pub topic: String,
    /// Arbitrary JSON payload.
    pub payload: serde_json::Value,
    /// Timestamp when the message was created (Unix milliseconds).
    pub timestamp: i64,
}

/// Inter-agent message bus backed by `tokio::sync::broadcast` channels.
///
/// Each topic maps to a `broadcast::Sender`. Workers subscribe to topics
/// to receive a `broadcast::Receiver`. Messages are cloned to all active
/// subscribers on the topic.
///
/// # Concurrency
///
/// The channel map uses `DashMap` for lock-free concurrent reads. Creating
/// and removing channels are the only mutating operations on the map itself;
/// sending and subscribing use the cloneable `broadcast::Sender`.
///
/// # Examples
///
/// ```
/// use swarm_core::bus::channel::MessageBus;
///
/// let bus = MessageBus::new();
/// bus.create_channel("logs");
/// let mut rx = bus.subscribe("logs").unwrap();
/// ```
#[derive(Clone)]
pub struct MessageBus {
    /// Map of topic name to broadcast sender.
    channels: Arc<DashMap<String, broadcast::Sender<BusMessage>>>,
}

impl MessageBus {
    /// Creates a new empty message bus with no topic channels.
    ///
    /// # Returns
    ///
    /// A `MessageBus` with zero channels.
    pub fn new() -> Self {
        Self {
            channels: Arc::new(DashMap::new()),
        }
    }

    /// Creates a new topic channel with the default buffer capacity.
    ///
    /// If the channel already exists, this is a no-op.
    ///
    /// # Arguments
    ///
    /// * `topic` - The name of the topic channel to create
    pub fn create_channel(&self, topic: &str) {
        self.channels.entry(topic.to_string()).or_insert_with(|| {
            let (tx, _) = broadcast::channel(DEFAULT_CHANNEL_CAPACITY);
            tracing::info!(topic = topic, "bus channel created");
            tx
        });
    }

    /// Sends a message to a specific topic channel.
    ///
    /// The message is broadcast to all active subscribers on the topic.
    /// If no subscribers are listening, the message is dropped silently.
    ///
    /// # Arguments
    ///
    /// * `msg` - The [`BusMessage`] to send
    ///
    /// # Returns
    ///
    /// The number of receivers that received the message, or an error
    /// string if the topic channel does not exist.
    pub fn send(&self, msg: BusMessage) -> Result<usize, String> {
        let topic = msg.topic.clone();
        let entry = self
            .channels
            .get(&topic)
            .ok_or_else(|| format!("bus channel '{}' does not exist", topic))?;

        match entry.send(msg) {
            Ok(count) => {
                tracing::debug!(topic = %topic, receivers = count, "bus message sent");
                Ok(count)
            }
            Err(_) => {
                // No active receivers — not an error, just means nobody is listening
                tracing::debug!(topic = %topic, "bus message sent but no active receivers");
                Ok(0)
            }
        }
    }

    /// Broadcasts a message from a worker to all subscribers of a topic.
    ///
    /// Convenience method that constructs a [`BusMessage`] with `to_worker: None`
    /// and sends it to the specified topic. Creates the channel if it does not exist.
    ///
    /// # Arguments
    ///
    /// * `from_worker` - UUID of the sending worker
    /// * `topic` - Topic to broadcast on
    /// * `payload` - JSON payload to include in the message
    ///
    /// # Returns
    ///
    /// The number of receivers that received the message.
    pub fn broadcast(
        &self,
        from_worker: Uuid,
        topic: &str,
        payload: serde_json::Value,
    ) -> Result<usize, String> {
        self.create_channel(topic);

        let msg = BusMessage {
            id: Uuid::new_v4(),
            from_worker,
            to_worker: None,
            topic: topic.to_string(),
            payload,
            timestamp: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis() as i64)
                .unwrap_or(0),
        };

        self.send(msg)
    }

    /// Subscribes to a topic channel and returns a broadcast receiver.
    ///
    /// The receiver will get copies of all messages sent to the topic
    /// after this subscription is created. Creates the channel if it
    /// does not exist.
    ///
    /// # Arguments
    ///
    /// * `topic` - The topic to subscribe to
    ///
    /// # Returns
    ///
    /// A `broadcast::Receiver<BusMessage>` for receiving messages.
    pub fn subscribe(&self, topic: &str) -> Result<broadcast::Receiver<BusMessage>, String> {
        self.create_channel(topic);

        let entry = self
            .channels
            .get(topic)
            .ok_or_else(|| format!("bus channel '{}' does not exist", topic))?;

        Ok(entry.subscribe())
    }

    /// Lists all active topic channel names.
    ///
    /// # Returns
    ///
    /// A `Vec<String>` of all topic names currently registered.
    pub fn list_channels(&self) -> Vec<String> {
        self.channels.iter().map(|e| e.key().clone()).collect()
    }
}

impl Default for MessageBus {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_create_and_list_channels() {
        let bus = MessageBus::new();
        bus.create_channel("topic-a");
        bus.create_channel("topic-b");

        let channels = bus.list_channels();
        assert_eq!(channels.len(), 2);
        assert!(channels.contains(&"topic-a".to_string()));
        assert!(channels.contains(&"topic-b".to_string()));
    }

    #[tokio::test]
    async fn test_send_and_receive() {
        let bus = MessageBus::new();
        bus.create_channel("test-topic");

        let mut rx = bus.subscribe("test-topic").unwrap();
        let worker_id = Uuid::new_v4();

        let count = bus
            .broadcast(worker_id, "test-topic", serde_json::json!({"key": "value"}))
            .unwrap();
        assert_eq!(count, 1);

        let msg = rx.recv().await.unwrap();
        assert_eq!(msg.from_worker, worker_id);
        assert_eq!(msg.topic, "test-topic");
        assert_eq!(msg.payload, serde_json::json!({"key": "value"}));
        assert!(msg.to_worker.is_none());
    }

    #[tokio::test]
    async fn test_broadcast_creates_channel() {
        let bus = MessageBus::new();
        let worker_id = Uuid::new_v4();

        // Subscribe first (auto-creates channel)
        let mut rx = bus.subscribe("auto-topic").unwrap();

        bus.broadcast(worker_id, "auto-topic", serde_json::json!("hello"))
            .unwrap();

        let msg = rx.recv().await.unwrap();
        assert_eq!(msg.payload, serde_json::json!("hello"));
    }

    #[test]
    fn test_bus_message_serialization() {
        let msg = BusMessage {
            id: Uuid::nil(),
            from_worker: Uuid::nil(),
            to_worker: None,
            topic: "test".to_string(),
            payload: serde_json::json!(42),
            timestamp: 0,
        };
        let json = serde_json::to_string(&msg).expect("serialize");
        assert!(json.contains("\"fromWorker\""));
        assert!(json.contains("\"toWorker\""));
        assert!(json.contains("\"topic\""));
    }
}
