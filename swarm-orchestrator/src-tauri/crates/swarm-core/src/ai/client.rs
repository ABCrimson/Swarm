//! AI provider client abstraction.
//!
//! Manages HTTP connections to AI APIs (Anthropic Claude)
//! with streaming SSE response support via `reqwest`. The client
//! handles request construction, authentication, and response
//! parsing, emitting incremental text deltas as ordered events.

use anyhow::Context;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use tokio_stream::StreamExt;

use crate::error::AppError;
use crate::events::{AiStreamDeltaPayload, EventSink, SwarmEvent};

use super::stream::{extract_delta_text, is_message_stop, is_refusal, parse_sse_line};

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
/// | `model`     | `claude-sonnet-5`                       |
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
/// assert_eq!(config.model, "claude-sonnet-5");
/// ```
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiClientConfig {
    /// Anthropic API key for authentication.
    #[serde(skip_serializing)]
    pub api_key: String,
    /// Base URL for the Anthropic API.
    pub base_url: String,
    /// Model identifier (e.g., `"claude-sonnet-5"`).
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
            model: "claude-sonnet-5".to_string(),
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

/// Builds the Anthropic Messages API request body.
///
/// Pulled out of [`AiClient::stream_message_inner`] as a pure function so
/// request construction is unit-testable without a network stack.
///
/// # Fable-tier safety
///
/// Deliberately never sets `thinking`, `temperature`, `top_p`, or `top_k`,
/// for any model. This matters most for Fable-tier models
/// (`claude-fable-5`, `claude-mythos-5`), which run thinking always-on
/// and reject an explicit `thinking` config or any sampling parameter
/// with a 400 — and for `claude-opus-4-8`, which rejects `budget_tokens`
/// and sampling parameters. Omitting these fields entirely is valid (and
/// required) across the whole current model catalog (see
/// `src/lib/models.ts` on the frontend), so no per-model branching is
/// needed here. If a future field like `thinking` or `temperature` is
/// added to [`AiClientConfig`], it must be gated off for `claude-fable-5`
/// / `claude-mythos-5` before being included in the body.
fn build_request_body(config: &AiClientConfig, request: &AiRequest) -> serde_json::Value {
    let mut body = serde_json::json!({
        "model": config.model,
        "max_tokens": config.max_tokens,
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

    body
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
    /// Each text delta chunk is emitted as an `ai_stream_delta` event
    /// on `swarm://events`. A final event with `done: true` is emitted
    /// when the message is complete.
    ///
    /// # Arguments
    ///
    /// * `sink` - Event sink for emitting stream delta events
    /// * `request` - The AI request containing messages and configuration
    ///
    /// # Returns
    ///
    /// The complete accumulated response text.
    ///
    /// # Errors
    ///
    /// Returns [`AppError::Ai`] if:
    /// - The HTTP request fails to send
    /// - The API returns a non-2xx status code
    /// - An SSE stream chunk cannot be read
    ///
    /// On every error path, a final `ai_stream_delta` event with
    /// `done: true` is emitted before the error is returned, so
    /// listeners never hang waiting for a terminal event.
    #[tracing::instrument(skip(self, sink, request), fields(request_id = %request.request_id))]
    pub async fn stream_message(
        &self,
        sink: &EventSink,
        request: &AiRequest,
    ) -> Result<String, AppError> {
        match self.stream_message_inner(sink, request).await {
            Ok(text) => Ok(text),
            Err(e) => {
                // Guarantee a terminal event reaches listeners on any
                // failure path (send failure, non-2xx status, stream
                // read error) so they never hang indefinitely.
                sink.emit(SwarmEvent::AiStreamDelta(AiStreamDeltaPayload {
                    request_id: request.request_id.clone(),
                    delta: String::new(),
                    done: true,
                }));
                Err(e)
            }
        }
    }

    /// Inner implementation of [`Self::stream_message`].
    ///
    /// Separated so the outer method can guarantee a `done: true`
    /// event is emitted on every exit path, including errors raised
    /// by `?` from this function.
    async fn stream_message_inner(
        &self,
        sink: &EventSink,
        request: &AiRequest,
    ) -> Result<String, AppError> {
        let url = format!("{}/messages", self.config.base_url);
        let body = build_request_body(&self.config, request);

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
            .map_err(|e| AppError::Ai(format!("failed to send AI API request: {e}")))?;

        if !response.status().is_success() {
            let status = response.status();
            let text = response
                .text()
                .await
                .unwrap_or_else(|_| "unknown error".to_string());
            return Err(AppError::Ai(format!("AI API returned {status}: {text}")));
        }

        let mut full_text = String::new();
        let mut stream = response.bytes_stream();

        let mut buffer = String::new();
        let mut done_sent = false;

        while let Some(chunk) = stream.next().await {
            let chunk =
                chunk.map_err(|e| AppError::Ai(format!("error reading SSE stream chunk: {e}")))?;
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
                    // Safety-classifier decline (Fable-tier models in particular).
                    // Bail out immediately — do not treat whatever text has
                    // streamed so far as a normal, complete reply. The `?`
                    // caller (`stream_message`) still guarantees a terminal
                    // `done: true` `AiStreamDelta` event on this error path,
                    // and the AI queue's error branch surfaces it via the
                    // existing `ai_stream_settled` (status: "error") path.
                    if is_refusal(&event) {
                        return Err(AppError::Ai(
                            "Request Declined By Safety Classifiers".to_string(),
                        ));
                    }

                    if let Some(delta) = extract_delta_text(&event) {
                        full_text.push_str(&delta);
                        sink.emit(SwarmEvent::AiStreamDelta(AiStreamDeltaPayload {
                            request_id: request.request_id.clone(),
                            delta,
                            done: false,
                        }));
                    }

                    if is_message_stop(&event) {
                        sink.emit(SwarmEvent::AiStreamDelta(AiStreamDeltaPayload {
                            request_id: request.request_id.clone(),
                            delta: String::new(),
                            done: true,
                        }));
                        done_sent = true;
                        break;
                    }
                }
            }
        }

        // Guarantee done signal even if stream ended without message_stop
        if !done_sent {
            sink.emit(SwarmEvent::AiStreamDelta(AiStreamDeltaPayload {
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

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_request() -> AiRequest {
        AiRequest {
            request_id: "req-1".to_string(),
            messages: vec![AiMessage {
                role: "user".to_string(),
                content: "Hello".to_string(),
            }],
            system: None,
            priority: AiPriority::Normal,
        }
    }

    /// Fable-tier models (`claude-fable-5`, `claude-mythos-5`) run thinking
    /// always-on and reject an explicit `thinking` config or any sampling
    /// parameter (`temperature`/`top_p`/`top_k`) with a 400. The request
    /// builder must never emit these fields.
    #[test]
    fn test_build_request_body_fable_sends_no_thinking_or_sampling_params() {
        let config = AiClientConfig {
            model: "claude-fable-5".to_string(),
            ..AiClientConfig::default()
        };
        let body = build_request_body(&config, &sample_request());

        assert!(body.get("thinking").is_none());
        assert!(body.get("temperature").is_none());
        assert!(body.get("top_p").is_none());
        assert!(body.get("top_k").is_none());
        assert!(body.get("budget_tokens").is_none());
        assert_eq!(body["model"], "claude-fable-5");
    }

    /// Same constraints apply to Project Glasswing's `claude-mythos-5`.
    #[test]
    fn test_build_request_body_mythos_sends_no_thinking_or_sampling_params() {
        let config = AiClientConfig {
            model: "claude-mythos-5".to_string(),
            ..AiClientConfig::default()
        };
        let body = build_request_body(&config, &sample_request());

        assert!(body.get("thinking").is_none());
        assert!(body.get("temperature").is_none());
        assert!(body.get("top_p").is_none());
        assert!(body.get("top_k").is_none());
    }

    /// `claude-opus-4-8` also rejects `budget_tokens` and sampling params
    /// (adaptive-thinking-only surface) — verify the builder never sends
    /// them for Opus either.
    #[test]
    fn test_build_request_body_opus_sends_no_budget_tokens_or_sampling_params() {
        let config = AiClientConfig {
            model: "claude-opus-4-8".to_string(),
            ..AiClientConfig::default()
        };
        let body = build_request_body(&config, &sample_request());

        assert!(body.get("thinking").is_none());
        assert!(body.get("temperature").is_none());
        assert!(body.get("top_p").is_none());
        assert!(body.get("top_k").is_none());
        assert!(body.get("budget_tokens").is_none());
    }

    #[test]
    fn test_build_request_body_includes_core_fields() {
        let config = AiClientConfig::default();
        let body = build_request_body(&config, &sample_request());

        assert_eq!(body["model"], config.model);
        assert_eq!(body["max_tokens"], config.max_tokens);
        assert_eq!(body["stream"], true);
        assert_eq!(body["messages"][0]["role"], "user");
        assert_eq!(body["messages"][0]["content"], "Hello");
    }

    #[test]
    fn test_build_request_body_includes_system_prompt_when_present() {
        let config = AiClientConfig::default();
        let mut request = sample_request();
        request.system = Some("You are helpful.".to_string());

        let body = build_request_body(&config, &request);
        assert_eq!(body["system"], "You are helpful.");
    }

    #[test]
    fn test_build_request_body_omits_system_when_absent() {
        let config = AiClientConfig::default();
        let body = build_request_body(&config, &sample_request());
        assert!(body.get("system").is_none());
    }
}
