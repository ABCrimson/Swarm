//! Session management subsystem.
//!
//! Provides persistent user sessions that group workers and
//! configuration together. Sessions survive application restarts via
//! a pluggable [`SessionStore`] persistence port — the concrete
//! backend (`tauri-plugin-store` today) lives in the embedding shell,
//! not here.
//!
//! ## Module Layout
//!
//! - [`manager`] — Thread-safe session CRUD with `DashMap` storage

pub mod manager;

pub use manager::SessionManager;

/// Persistence port for [`manager::Session`] state.
///
/// `swarm-core` depends only on this trait, never on a specific
/// storage backend — the shell (e.g. the Tauri desktop app, backed by
/// `tauri-plugin-store`) supplies the implementation.
pub trait SessionStore {
    /// Loads all persisted sessions, or an empty list on a fresh install.
    fn load(&self) -> anyhow::Result<Vec<manager::Session>>;

    /// Persists the full session list, replacing any prior contents.
    fn save(&self, sessions: &[manager::Session]) -> anyhow::Result<()>;
}
