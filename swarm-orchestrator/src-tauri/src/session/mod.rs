//! Session persistence shell.
//!
//! Session domain types and CRUD live in `swarm_core::session`; this
//! module provides the concrete `tauri-plugin-store`-backed
//! implementation of `swarm_core::session::SessionStore`.
//!
//! ## Module Layout
//!
//! - [`store`] — Persistent serialization/deserialization via `tauri-plugin-store`

pub mod store;
