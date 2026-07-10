//! Event-sourced orchestration core: ordered event log + single push bus.

pub mod log;

pub use log::{EventLog, StoredEvent};
