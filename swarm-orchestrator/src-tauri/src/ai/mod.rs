//! AI integration subsystem.
//!
//! Provides streaming AI capabilities via the Anthropic Messages API.
//! Requests flow through a priority queue with concurrency limiting,
//! and responses stream back to the frontend as Tauri events.
//!
//! ## Module Layout
//!
//! - [`client`] — HTTP client for the Anthropic API with SSE streaming
//! - [`queue`] — Priority queue with semaphore-based concurrency control
//! - [`stream`] — SSE (Server-Sent Events) parser for Anthropic responses
//!
//! ## Data Flow
//!
//! ```text
//! Frontend ──invoke──> ai_request ──> AiQueue (BinaryHeap)
//!                                         │
//!                                    Semaphore gate
//!                                         │
//!                                    AiClient.stream_message()
//!                                         │
//!                                    SSE parser (stream.rs)
//!                                         │
//!                                    emit ai_stream_delta (swarm://events)
//!                                         │
//!                                    Frontend (accumulate)
//! ```

pub mod client;
pub mod queue;
pub mod stream;

pub use client::{AiClient, AiClientConfig, AiRequest};
pub use queue::{AiQueue, AiQueueConfig};
