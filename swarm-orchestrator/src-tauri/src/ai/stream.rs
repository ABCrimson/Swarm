//! AI streaming response handler.
//!
//! Parses Server-Sent Events (SSE) from the Anthropic Messages API
//! and extracts text delta content. The SSE protocol sends events
//! as `data: {json}\n` lines, which this module deserializes into
//! typed [`SseEvent`] variants.

use serde::{Deserialize, Serialize};

/// Represents an SSE event from the Anthropic Messages API.
///
/// Each variant corresponds to an event type in the Anthropic
/// streaming response protocol.
///
/// # Event Sequence
///
/// A typical stream produces events in this order:
///
/// ```text
/// MessageStart -> ContentBlockStart -> ContentBlockDelta* -> ContentBlockStop -> MessageDelta -> MessageStop
/// ```
///
/// # Examples
///
/// ```ignore
/// use swarm_core::ai::stream::SseEvent;
///
/// let json = r#"{"type":"message_stop"}"#;
/// let event: SseEvent = serde_json::from_str(json).unwrap();
/// assert!(matches!(event, SseEvent::MessageStop {}));
/// ```
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", tag = "type")]
pub enum SseEvent {
    /// Initial message metadata (model, usage, etc.).
    MessageStart {
        /// Full message object with metadata.
        message: serde_json::Value,
    },
    /// Start of a content block (text, tool_use, etc.).
    ContentBlockStart {
        /// Zero-based index of the content block.
        index: usize,
        /// The content block object.
        content_block: serde_json::Value,
    },
    /// Keep-alive ping from the server.
    Ping {},
    /// An incremental text delta within a content block.
    ContentBlockDelta {
        /// Zero-based index of the content block.
        index: usize,
        /// The delta content (text chunk).
        delta: ContentDelta,
    },
    /// End of a content block.
    ContentBlockStop {
        /// Zero-based index of the completed content block.
        index: usize,
    },
    /// Final message metadata (stop reason, usage).
    MessageDelta {
        /// Delta containing stop_reason and other metadata.
        delta: serde_json::Value,
        /// Token usage statistics, if available.
        usage: Option<serde_json::Value>,
    },
    /// End of the message stream. No more events will follow.
    MessageStop {},
}

/// Delta content from a `content_block_delta` event.
///
/// Currently only supports `text_delta` type. Future variants
/// may include `input_json_delta` for tool use streaming.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", tag = "type")]
pub enum ContentDelta {
    /// A text delta containing a chunk of the response text.
    TextDelta {
        /// The text content of this delta chunk.
        text: String,
    },
}

/// Parses a raw SSE data line into an [`SseEvent`].
///
/// SSE lines arrive in the format `data: {json}\n`. This function
/// strips the `"data: "` prefix, trims whitespace, and deserializes
/// the JSON payload. Returns `None` for non-data lines, empty data,
/// and the `[DONE]` sentinel.
///
/// # Arguments
///
/// * `line` - A single line from the SSE stream
///
/// # Returns
///
/// `Some(SseEvent)` if the line contains valid event data,
/// `None` otherwise.
///
/// # Examples
///
/// ```ignore
/// use swarm_core::ai::stream::parse_sse_line;
///
/// let line = r#"data: {"type":"message_stop"}"#;
/// let event = parse_sse_line(line).unwrap();
/// ```
pub fn parse_sse_line(line: &str) -> Option<SseEvent> {
    let data = line.strip_prefix("data: ")?;
    let trimmed = data.trim();

    if trimmed.is_empty() || trimmed == "[DONE]" {
        return None;
    }

    match serde_json::from_str::<SseEvent>(trimmed) {
        Ok(event) => Some(event),
        Err(e) => {
            tracing::warn!(error = %e, line = %trimmed, "failed to parse SSE event");
            None
        }
    }
}

/// Extracts the text delta string from an [`SseEvent`], if applicable.
///
/// Only [`SseEvent::ContentBlockDelta`] with a [`ContentDelta::TextDelta`]
/// produces a text string. All other event types return `None`.
///
/// # Arguments
///
/// * `event` - The SSE event to extract text from
///
/// # Returns
///
/// `Some(String)` containing the delta text, or `None` if
/// the event does not contain a text delta.
///
/// # Examples
///
/// ```ignore
/// use swarm_core::ai::stream::{parse_sse_line, extract_delta_text};
///
/// let line = r#"data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hi"}}"#;
/// let event = parse_sse_line(line).unwrap();
/// assert_eq!(extract_delta_text(&event), Some("Hi".to_string()));
/// ```
pub fn extract_delta_text(event: &SseEvent) -> Option<String> {
    match event {
        SseEvent::ContentBlockDelta {
            delta: ContentDelta::TextDelta { text },
            ..
        } => Some(text.clone()),
        _ => None,
    }
}

/// Returns `true` if this event signals the end of the message stream.
///
/// # Arguments
///
/// * `event` - The SSE event to check
///
/// # Returns
///
/// `true` if the event is [`SseEvent::MessageStop`], `false` otherwise.
///
/// # Examples
///
/// ```ignore
/// use swarm_core::ai::stream::{parse_sse_line, is_message_stop};
///
/// let line = r#"data: {"type":"message_stop"}"#;
/// let event = parse_sse_line(line).unwrap();
/// assert!(is_message_stop(&event));
/// ```
pub fn is_message_stop(event: &SseEvent) -> bool {
    matches!(event, SseEvent::MessageStop {})
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_content_block_delta() {
        let line = r#"data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}"#;
        let event = parse_sse_line(line).expect("should parse");
        let text = extract_delta_text(&event).expect("should have text");
        assert_eq!(text, "Hello");
    }

    #[test]
    fn test_parse_message_stop() {
        let line = r#"data: {"type":"message_stop"}"#;
        let event = parse_sse_line(line).expect("should parse");
        assert!(is_message_stop(&event));
    }

    #[test]
    fn test_parse_done() {
        let line = "data: [DONE]";
        assert!(parse_sse_line(line).is_none());
    }

    #[test]
    fn test_parse_empty() {
        let line = "data: ";
        assert!(parse_sse_line(line).is_none());
    }

    #[test]
    fn test_non_data_line() {
        let line = "event: message_start";
        assert!(parse_sse_line(line).is_none());
    }
}
