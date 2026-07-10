//! Message routing between workers.
//!
//! Provides three routing modes for inter-agent communication:
//!
//! - **Direct:** Worker A sends a message to Worker B on a topic
//! - **Broadcast:** Worker A sends to all subscribers of a topic
//! - **Pipeline:** Chain worker outputs as the next worker's inputs
//!
//! Pipelines are stored in a `DashMap` and can be created, removed,
//! and executed. Each pipeline stage optionally applies a jq-like
//! field selector to transform the payload between stages.

use dashmap::DashMap;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use uuid::Uuid;

use super::channel::{BusMessage, MessageBus};

/// A single stage in a message processing pipeline.
///
/// Each stage represents a worker that will receive the pipeline
/// message. An optional `transform` field specifies a jq-like
/// field selector to extract or reshape the payload before
/// forwarding to the next stage.
///
/// # Fields
///
/// * `worker_id` - UUID of the worker at this pipeline stage
/// * `transform` - Optional jq-like field selector (e.g., `".result"`, `".data.items"`)
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PipelineStage {
    /// UUID of the worker that processes this pipeline stage.
    pub worker_id: Uuid,
    /// Optional jq-like field selector to transform the payload.
    /// Currently supports simple dot-notation field access (e.g., `".field"`).
    pub transform: Option<String>,
}

/// A multi-stage message processing pipeline.
///
/// Pipelines chain multiple workers together so that the output
/// of one stage feeds into the next. Each stage can optionally
/// transform the payload using a simple field selector.
///
/// # Fields
///
/// * `id` - Unique pipeline identifier (UUID v4)
/// * `stages` - Ordered list of pipeline stages
///
/// # Examples
///
/// ```
/// use swarm_core::bus::router::{Pipeline, PipelineStage};
/// use uuid::Uuid;
///
/// let pipeline = Pipeline {
///     id: Uuid::new_v4(),
///     stages: vec![
///         PipelineStage { worker_id: Uuid::new_v4(), transform: None },
///         PipelineStage { worker_id: Uuid::new_v4(), transform: Some(".result".to_string()) },
///     ],
/// };
/// assert_eq!(pipeline.stages.len(), 2);
/// ```
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Pipeline {
    /// Unique pipeline identifier.
    pub id: Uuid,
    /// Ordered list of processing stages.
    pub stages: Vec<PipelineStage>,
}

/// Serializable pipeline info for IPC transport.
///
/// A lightweight representation of a pipeline suitable for
/// sending to the frontend.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PipelineInfo {
    /// Pipeline identifier.
    pub id: Uuid,
    /// Number of stages in the pipeline.
    pub stage_count: usize,
    /// Worker IDs in pipeline order.
    pub worker_ids: Vec<Uuid>,
}

/// Routes messages between workers using direct, broadcast, and pipeline modes.
///
/// The router holds a reference to the [`MessageBus`] for sending messages
/// and a `DashMap` of named pipelines for chained processing.
///
/// # Concurrency
///
/// Pipeline storage uses `DashMap` for lock-free concurrent reads.
/// All routing operations are non-blocking.
#[derive(Clone)]
pub struct Router {
    /// Reference to the shared message bus.
    bus: MessageBus,
    /// Named pipelines for chained worker processing.
    pipelines: Arc<DashMap<Uuid, Pipeline>>,
}

impl Router {
    /// Creates a new router backed by the given message bus.
    ///
    /// # Arguments
    ///
    /// * `bus` - The shared [`MessageBus`] for message delivery
    pub fn new(bus: MessageBus) -> Self {
        Self {
            bus,
            pipelines: Arc::new(DashMap::new()),
        }
    }

    /// Sends a direct message from one worker to another on a topic.
    ///
    /// The message's `to_worker` field is set to the target worker UUID.
    /// This does not guarantee the target worker is subscribed to the topic;
    /// it is a hint that the message is intended for a specific recipient.
    ///
    /// # Arguments
    ///
    /// * `from` - UUID of the sending worker
    /// * `to` - UUID of the target worker
    /// * `topic` - Topic channel to send on
    /// * `payload` - JSON payload
    ///
    /// # Returns
    ///
    /// The number of receivers that received the message.
    pub fn send_direct(
        &self,
        from: Uuid,
        to: Uuid,
        topic: &str,
        payload: serde_json::Value,
    ) -> Result<usize, String> {
        self.bus.create_channel(topic);

        let msg = BusMessage {
            id: Uuid::new_v4(),
            from_worker: from,
            to_worker: Some(to),
            topic: topic.to_string(),
            payload,
            timestamp: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis() as i64)
                .unwrap_or(0),
        };

        self.bus.send(msg)
    }

    /// Broadcasts a message to all subscribers of a topic.
    ///
    /// Delegates to [`MessageBus::broadcast`].
    ///
    /// # Arguments
    ///
    /// * `from` - UUID of the sending worker
    /// * `topic` - Topic to broadcast on
    /// * `payload` - JSON payload
    ///
    /// # Returns
    ///
    /// The number of receivers that received the message.
    pub fn send_broadcast(
        &self,
        from: Uuid,
        topic: &str,
        payload: serde_json::Value,
    ) -> Result<usize, String> {
        self.bus.broadcast(from, topic, payload)
    }

    /// Creates a new processing pipeline and registers it.
    ///
    /// # Arguments
    ///
    /// * `stages` - Ordered list of pipeline stages
    ///
    /// # Returns
    ///
    /// The UUID of the newly created pipeline.
    pub fn create_pipeline(&self, stages: Vec<PipelineStage>) -> Uuid {
        let id = Uuid::new_v4();
        let pipeline = Pipeline { id, stages };
        self.pipelines.insert(id, pipeline);
        tracing::info!(pipeline_id = %id, "pipeline created");
        id
    }

    /// Executes a pipeline by sending the initial payload through each stage.
    ///
    /// The payload is forwarded from stage to stage, with optional transforms
    /// applied between each stage. Each stage sends the message to its worker
    /// on a pipeline-specific topic.
    ///
    /// # Arguments
    ///
    /// * `pipeline_id` - UUID of the pipeline to execute
    /// * `initial_payload` - Starting JSON payload for the first stage
    ///
    /// # Errors
    ///
    /// Returns an error string if the pipeline does not exist or message
    /// delivery fails.
    pub fn execute_pipeline(
        &self,
        pipeline_id: &Uuid,
        initial_payload: serde_json::Value,
    ) -> Result<(), String> {
        let pipeline = self
            .pipelines
            .get(pipeline_id)
            .ok_or_else(|| format!("pipeline '{}' not found", pipeline_id))?
            .clone();

        let mut payload = initial_payload;

        for (i, stage) in pipeline.stages.iter().enumerate() {
            let topic = format!("pipeline:{}:stage:{}", pipeline_id, i);
            self.bus.create_channel(&topic);

            let msg = BusMessage {
                id: Uuid::new_v4(),
                from_worker: if i == 0 {
                    Uuid::nil()
                } else {
                    pipeline.stages[i - 1].worker_id
                },
                to_worker: Some(stage.worker_id),
                topic: topic.clone(),
                payload: payload.clone(),
                timestamp: std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_millis() as i64)
                    .unwrap_or(0),
            };

            self.bus.send(msg)?;

            // Apply transform for the next stage
            if let Some(ref transform) = stage.transform {
                payload = apply_transform(&payload, transform);
            }
        }

        tracing::debug!(pipeline_id = %pipeline_id, "pipeline execution dispatched");
        Ok(())
    }

    /// Lists all registered pipelines as serializable info snapshots.
    ///
    /// # Returns
    ///
    /// A `Vec<PipelineInfo>` of all registered pipelines.
    pub fn list_pipelines(&self) -> Vec<PipelineInfo> {
        self.pipelines
            .iter()
            .map(|entry| {
                let p = entry.value();
                PipelineInfo {
                    id: p.id,
                    stage_count: p.stages.len(),
                    worker_ids: p.stages.iter().map(|s| s.worker_id).collect(),
                }
            })
            .collect()
    }
}

/// Applies a simple dot-notation field selector to a JSON value.
///
/// Supports basic dot-separated field access (e.g., `".data.items"`).
/// If the transform is invalid or the field does not exist, the
/// original payload is returned unchanged.
///
/// # Arguments
///
/// * `payload` - The JSON value to transform
/// * `selector` - Dot-notation field path (e.g., `".field"`, `".a.b.c"`)
///
/// # Returns
///
/// The selected JSON sub-value, or the original payload if selection fails.
fn apply_transform(payload: &serde_json::Value, selector: &str) -> serde_json::Value {
    let path = selector.trim_start_matches('.');
    if path.is_empty() {
        return payload.clone();
    }

    let mut current = payload;
    for field in path.split('.') {
        match current.get(field) {
            Some(v) => current = v,
            None => return payload.clone(),
        }
    }
    current.clone()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_apply_transform_simple() {
        let payload = serde_json::json!({"result": 42, "meta": {"status": "ok"}});
        let result = apply_transform(&payload, ".result");
        assert_eq!(result, serde_json::json!(42));
    }

    #[test]
    fn test_apply_transform_nested() {
        let payload = serde_json::json!({"data": {"items": [1, 2, 3]}});
        let result = apply_transform(&payload, ".data.items");
        assert_eq!(result, serde_json::json!([1, 2, 3]));
    }

    #[test]
    fn test_apply_transform_missing_field() {
        let payload = serde_json::json!({"a": 1});
        let result = apply_transform(&payload, ".missing");
        assert_eq!(result, payload);
    }

    #[test]
    fn test_apply_transform_empty() {
        let payload = serde_json::json!("hello");
        let result = apply_transform(&payload, ".");
        assert_eq!(result, payload);
    }

    #[test]
    fn test_create_pipeline() {
        let bus = MessageBus::new();
        let router = Router::new(bus);

        let id = router.create_pipeline(vec![
            PipelineStage {
                worker_id: Uuid::new_v4(),
                transform: None,
            },
            PipelineStage {
                worker_id: Uuid::new_v4(),
                transform: Some(".output".to_string()),
            },
        ]);

        let pipelines = router.list_pipelines();
        assert_eq!(pipelines.len(), 1);
        assert_eq!(pipelines[0].id, id);
        assert_eq!(pipelines[0].stage_count, 2);
    }

    #[test]
    fn test_pipeline_serialization() {
        let pipeline = Pipeline {
            id: Uuid::nil(),
            stages: vec![PipelineStage {
                worker_id: Uuid::nil(),
                transform: Some(".data".to_string()),
            }],
        };
        let json = serde_json::to_string(&pipeline).expect("serialize");
        assert!(json.contains("\"stages\""));
        assert!(json.contains("\"workerId\""));
        assert!(json.contains("\"transform\""));
    }
}
