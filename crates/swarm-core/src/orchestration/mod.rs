//! The ordered event core: the single-writer [`OrchestrationEngine`]
//! and the SQLite [`EventLog`] it persists to.

pub mod engine;
pub mod log;

pub use engine::{DomainEvent, EVENT_CHANNEL, OrchestrationEngine, is_persistent};
pub use log::{EventLog, StoredEvent};
