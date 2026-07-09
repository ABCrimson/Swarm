//! Session management subsystem.
//!
//! Provides persistent user sessions that group workers and
//! configuration together. Sessions survive application restarts
//! via `tauri-plugin-store` serialization to disk.
//!
//! ## Module Layout
//!
//! - [`manager`] — Thread-safe session CRUD with `DashMap` storage
//! - [`store`] — Persistent serialization/deserialization via `tauri-plugin-store`

pub mod manager;
pub mod store;

pub use manager::SessionManager;
