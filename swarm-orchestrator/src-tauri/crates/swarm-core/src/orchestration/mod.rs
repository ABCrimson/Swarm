//! Event-sourced orchestration core: ordered event log + single push bus.

pub mod engine;
pub mod log;

pub use engine::{DomainEvent, EVENT_CHANNEL, OrchestrationEngine, is_persistent};
pub use log::{EventLog, StoredEvent};
