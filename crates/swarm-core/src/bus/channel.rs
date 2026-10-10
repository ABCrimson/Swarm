//! The registry of bus topic names ("channels") in use.
//!
//! Topics are created implicitly by the first send on them, and callers
//! choose their names — remote clients included — so the registry is
//! bounded at [`MAX_TOPICS`].

use std::collections::BTreeSet;
use std::sync::Arc;

use parking_lot::RwLock;

/// How many distinct topics the registry holds before refusing a send
/// on a new one.
pub const MAX_TOPICS: usize = 1024;

/// The shared topic registry. Cloning is one `Arc` bump.
///
/// # Examples
///
/// ```
/// use swarm_core::bus::channel::MessageBus;
///
/// let bus = MessageBus::new();
/// bus.register("review").unwrap();
/// bus.register("logs").unwrap();
/// bus.register("review").unwrap(); // already known: no-op
/// assert_eq!(bus.list_channels(), ["logs", "review"]);
/// ```
#[derive(Clone, Default)]
pub struct MessageBus {
    topics: Arc<RwLock<BTreeSet<String>>>,
}

impl MessageBus {
    /// An empty registry.
    pub fn new() -> Self {
        Self::default()
    }

    /// Records that `topic` is in use. Idempotent.
    ///
    /// # Errors
    ///
    /// A Title Case message when `topic` is new and the registry already
    /// holds [`MAX_TOPICS`] topics.
    pub fn register(&self, topic: &str) -> Result<(), String> {
        if self.topics.read().contains(topic) {
            return Ok(());
        }
        let mut topics = self.topics.write();
        if topics.len() >= MAX_TOPICS && !topics.contains(topic) {
            return Err(format!("Too Many Bus Topics: The Limit Is {MAX_TOPICS}."));
        }
        if topics.insert(topic.to_owned()) {
            tracing::debug!(topic, "bus topic registered");
        }
        Ok(())
    }

    /// Every topic in use, sorted.
    pub fn list_channels(&self) -> Vec<String> {
        self.topics.read().iter().cloned().collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_register_is_idempotent_and_listing_is_sorted() {
        let bus = MessageBus::new();
        for topic in ["b", "a", "b", "c"] {
            bus.register(topic).unwrap();
        }
        assert_eq!(bus.list_channels(), ["a", "b", "c"]);
    }

    /// The registry refuses a new topic once it holds `MAX_TOPICS`; a topic
    /// it already holds still registers.
    #[test]
    fn test_registry_is_bounded_but_known_topics_still_work() {
        let bus = MessageBus::new();
        for i in 0..MAX_TOPICS {
            bus.register(&format!("t{i}")).unwrap();
        }
        assert!(bus.register("one-too-many").is_err());
        assert!(bus.register("t0").is_ok(), "an existing topic is not new");
        assert_eq!(bus.list_channels().len(), MAX_TOPICS);
    }

    #[test]
    fn test_clones_share_one_registry() {
        let bus = MessageBus::new();
        bus.clone().register("shared").unwrap();
        assert_eq!(bus.list_channels(), ["shared"]);
    }
}
