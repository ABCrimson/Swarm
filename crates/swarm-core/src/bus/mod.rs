//! The inter-agent message bus.
//!
//! A worker sends a JSON payload on a named topic, either to one other
//! worker or to every listener. The bus does not deliver messages
//! itself: every send becomes a `bus_message` event on the ordered event
//! stream, stamped with the sender as its `originWorker` and, when
//! given, the event that caused it as its `causeSeq` — so every
//! frontend and remote client sees it live and a replay sees it again.
//! A multi-stage hand-off is simply a chain of `causeSeq` links.
//!
//! - [`channel`] — [`channel::MessageBus`], the bounded registry of topic
//!   names in use (for `bus_list_channels`).
//! - [`router`] — [`router::Router`], which turns a send into its
//!   `bus_message` event.

pub mod channel;
pub mod router;
