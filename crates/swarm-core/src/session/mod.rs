//! User sessions: named groups of workers plus a free-form JSON config.
//!
//! - [`manager`] — [`SessionManager`], the concurrent in-memory session
//!   set every command handler shares.
//! - [`persist`] — `sessions.json` in [`crate::Paths::data_dir`]: loaded
//!   once by [`crate::runtime::Runtime::start`], rewritten atomically
//!   after every mutation. Both shells share the one file.

pub mod manager;
pub mod persist;

pub use manager::{Session, SessionManager};
