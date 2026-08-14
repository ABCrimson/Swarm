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
/// `tauri-plugin-store`) supplies the implementation today; Phase 2's
/// `swarmd` daemon is the second consumer, migrating sessions onto
/// `swarm_core::config`'s atomic JSON storage behind the same port
/// (see the headless-daemon plan).
pub trait SessionStore {
    /// Loads all persisted sessions.
    ///
    /// `None` means the store has never held a sessions key at all (a
    /// fresh install) — distinct from `Some(vec![])`, a store that once
    /// held sessions which were all since deleted. Callers that only
    /// care about "any sessions to restore?" can treat both the same
    /// way; callers that log should keep the distinction.
    fn load(&self) -> anyhow::Result<Option<Vec<manager::Session>>>;

    /// Persists the full session list, replacing any prior contents.
    fn save(&self, sessions: &[manager::Session]) -> anyhow::Result<()>;
}
