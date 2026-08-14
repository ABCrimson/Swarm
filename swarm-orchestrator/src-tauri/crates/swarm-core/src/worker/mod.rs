//! Worker management subsystem.
//!
//! Provides the complete worker lifecycle — from PTY process spawning
//! through state transitions (idle, running, paused, error) to cleanup
//! on kill. Workers are stored in a concurrent [`registry::WorkerRegistry`]
//! backed by `DashMap` and communicated with via `portable-pty`.
//!
//! ## Module Layout
//!
//! - [`handle`] — Worker state, configuration, and handle types
//! - [`registry`] — Thread-safe concurrent worker store with aggregate metrics
//! - [`pty`] — Cross-platform PTY spawning and I/O bridging to Tokio
//! - [`lifecycle`] — High-level spawn, pause, resume, kill operations

pub mod handle;
pub mod lifecycle;
pub mod pty;
pub mod registry;
