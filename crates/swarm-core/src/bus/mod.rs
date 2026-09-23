//! Inter-agent message bus subsystem.
//!
//! Provides a publish-subscribe message bus for communication between
//! workers in the SWARM Orchestrator. Workers can send direct messages,
//! broadcast to topics, and be chained into pipelines where the output
//! of one worker feeds the input of the next.
//!
//! ## Module Layout
//!
//! - [`channel`] — Core message bus with `tokio::sync::broadcast` channels
//! - [`router`] — Message routing: direct, broadcast, and pipeline modes

pub mod channel;
pub mod router;
