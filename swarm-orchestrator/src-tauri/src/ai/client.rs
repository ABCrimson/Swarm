//! AI provider client abstraction.
//!
//! Manages HTTP connections to AI APIs (Anthropic Claude)
//! with streaming SSE response support via `reqwest`. The client
//! handles request construction, authentication, and response
//! parsing, emitting incremental text deltas as Tauri events.

use anyhow::Context;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use tauri::AppHandle;
use tokio_stream::StreamExt;

use crate::events::{emit_event, AiStreamDeltaPayload, SwarmEvent};

use super::stream::{extract_delta_text, is_message_stop, parse_sse_line};

/// Configuration for the AI client.
///
/// Controls which API endpoint, model, and authentication
/// credentials are used for AI requests.
///
/// # Defaults
///
/// | Field       | Default Value                          |
/// |-------------|----------------------------------------|
/// | `api_key`   | `""` (must be configured at runtime)    |
/// | `base_url`  | `https://api.anthropic.com/v1`          |
/// | `model`     | `claude-sonnet-4-20250514`              |
/// | `max_tokens`| `4096`                                  |
///
/// # Examples
///
/// ```ignore
/// use swarm_core::ai::AiClientConfig;
///
/// let config = AiClientConfig {
///     api_key: "sk-ant-...".to_string(),
///     ..AiClientConfig::default()
/// };
/// assert_eq!(config.model, "claude-sonnet-4-20250514");
/// ```
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiClientConfig {
    /// Anthropic API key for authentication.
    #[serde(skip_serializing)]
    pub api_key: String,
    /// Base URL for the Anthropic API.
    pub base_url: String,
    /// Model identifier (e.g., `"claude-sonnet-4-20250514"`).
    pub model: String,
    /// Maximum number of tokens to generate per response.
    pub max_tokens: u32,
}

impl std::fmt::Debug for AiClientConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AiClientConfig")
            .field("api_key", &"[REDACTED]")
            .field("base_url", &self.base_url)
            .field("model", &self.model)
            .field("max_tokens", &self.max_tokens)
            .finish()
    }
}

impl Default for AiClientConfig {
    fn default() -> Self {
        Self {
            api_key: String::new(),
            base_url: "https://api.anthropic.com/v1".to_string(),
            model: "claude-sonnet-4-20250514".to_string(),
            max_tokens: 4096,
        }
    }
}

/// A single message in an AI conversation.
///
/// Maps directly to the Anthropic Messages API message format.
///
/// # Fields
///
/// * `role` - Either `"user"` or `"assistant"`
/// * `content` - The message text content
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiMessage {
    /// The role of the message author (`"user"` or `"assistant"`).
    pub role: String,
    /// The text content of the message.
    pub content: String,
}

/// A request to the AI API.
///
/// Sent from the frontend via the `ai_request` Tauri command.
/// Contains the conversation messages, an optional system prompt,
/// and a priority level for queue ordering.
///
/// # Fields
///
/// * `request_id` - Unique correlation ID for matching stream events
/// * `messages` - Conversation history
/// * `system` - Optional system prompt
/// * `priority` - Queue priority level (default: `Normal`)
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiRequest {
    /// Unique identifier for correlating stream delta events.
    pub request_id: String,
    /// The conversation messages to send.
    pub messages: Vec<AiMessage>,
    /// Optional system prompt prepended to the conversation.
    #[serde(default)]
    pub system: Option<String>,
    /// Priority level for queue ordering.
    #[serde(default)]
    pub priority: AiPriority,
}

/// Priority levels for AI requests in the queue.
///
/// Higher priority requests are processed first. Within the
/// same priority level, requests are processed in FIFO order.
///
/// # Ordering
///
/// `Low (0) < Normal (1) < High (2) < Critical (3)`
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AiPriority {
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

/// AI provider client wrapping `reqwest` for streaming SSE.
///
/// Handles HTTP communication with the Anthropic Messages API,
/// including request construction, authentication headers, and
/// SSE response stream parsing.
///
/// # Thread Safety
///
/// `AiClient` is `Clone` + `Send` + `Sync` and can be safely
/// shared across Tokio tasks.
#[derive(Clone)]
pub struct AiClient {
    /// The underlying HTTP client.
    http: Client,
    /// Client configuration (API key, model, etc.).
    config: AiClientConfig,
}

impl AiClient {
    /// Creates a new AI client with the given configuration.
    ///
    /// Builds a `reqwest::Client` with default settings.
    ///
    /// # Arguments
    ///
    /// * `config` - The AI client configuration
    ///
    /// # Returns
    ///
    /// A new `AiClient` instance.
    ///
    /// # Errors
    ///
    /// Returns `anyhow::Error` if the HTTP client fails to build
    /// (e.g., TLS initialization failure).
    pub fn new(config: AiClientConfig) -> anyhow::Result<Self> {
        let http = Client::builder()
            .timeout(std::time::Duration::from_secs(120))
            .connect_timeout(std::time::Duration::from_secs(10))
            .build()
            .context("failed to build HTTP client")?;
        Ok(Self { http, config })
    }

    /// Sends a streaming request to the Anthropic Messages API.
    ///
    /// Constructs the API request body, sends it with SSE streaming
    /// enabled, and processes the response stream line by line.
    /// Each text delta chunk is emitted as an `ai:stream_delta`
    /// Tauri event. A final event with `done: true` is emitted
    /// when the message is complete.
    ///
    /// # Arguments
    ///
    /// * `app` - Tauri app handle for emitting stream delta events
    /// * `request` - The AI request containing messages and configuration
    ///
    /// # Returns
    ///
    /// The complete accumulated response text.
    ///
    /// # Errors
    ///
    /// Returns `anyhow::Error` if:
    /// - The HTTP request fails to send
    /// - The API returns a non-2xx status code
    /// - An SSE stream chunk cannot be read
    #[tracing::instrument(skip(self, app, request), fields(request_id = %request.request_id))]
    pub async fn stream_message(
        &self,
        app: &AppHandle,
        request: &AiRequest,
    ) -> anyhow::Result<String> {
        let url = format!("{}/messages", self.config.base_url);

        // Build the Anthropic API request body
        let mut body = serde_json::json!({
            "model": self.config.model,
            "max_tokens": self.config.max_tokens,
            "stream": true,
            "messages": request.messages.iter().map(|m| {
                serde_json::json!({
                    "role": m.role,
                    "content": m.content,
                })
            }).collect::<Vec<_>>(),
        });

        if let Some(ref system) = request.system {
            body["system"] = serde_json::json!(system);
        }

        let response = self
            .http
            .post(&url)
            .header("x-api-key", &self.config.api_key)
            .header("anthropic-version", "2023-06-01")
            .header("content-type", "application/json")
            .header("accept", "text/event-stream")
            .json(&body)
            .send()
            .await
            .context("failed to send AI API request")?;

        if !response.status().is_success() {
            let status = response.status();
            let text = response
                .text()
                .await
                .unwrap_or_else(|_| "unknown error".to_string());
            anyhow::bail!("AI API returned {}: {}", status, text);
        }

        let mut full_text = String::new();
        let mut stream = response.bytes_stream();

        let mut buffer = String::new();
        let mut done_sent = false;

        while let Some(chunk) = stream.next().await {
            let chunk = chunk.context("error reading SSE stream chunk")?;
            let text = String::from_utf8_lossy(&chunk);
            buffer.push_str(&text);

            // Process complete lines (avoid O(n²) drain by splitting and keeping remainder)
            while let Some(pos) = buffer.find('\n') {
                let line = buffer[..pos].trim().to_owned();
                buffer = buffer[pos + 1..].to_owned();

                if line.is_empty() {
                    continue;
                }

                if let Some(event) = parse_sse_line(&line) {
                    if let Some(delta) = extract_delta_text(&event) {
                        full_text.push_str(&delta);
                        emit_event(
                            app,
                            SwarmEvent::AiStreamDelta(AiStreamDeltaPayload {
                                request_id: request.request_id.clone(),
                                delta,
                                done: false,
                            }),
                        );
                    }

                    if is_message_stop(&event) {
                        emit_event(
                            app,
                            SwarmEvent::AiStreamDelta(AiStreamDeltaPayload {
                                request_id: request.request_id.clone(),
                                delta: String::new(),
                                done: true,
                            }),
                        );
                        done_sent = true;
                        break;
                    }
                }
            }
        }

        // Guarantee done signal even if stream ended without message_stop
        if !done_sent {
            emit_event(app, SwarmEvent::AiStreamDelta(AiStreamDeltaPayload {
                request_id: request.request_id.clone(),
                delta: String::new(),
                done: true,
            }));
        }

        tracing::debug!(
            request_id = %request.request_id,
            response_len = full_text.len(),
            "AI stream completed"
        );

        Ok(full_text)
    }
}
