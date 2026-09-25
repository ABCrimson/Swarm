//! The shared application error type.
//!
//! [`AppError`] is `thiserror`-derived for `Display`/`From`, and
//! serializes as its `Display` string — the error shape both transports
//! carry to the frontend: a Tauri IPC command's rejection and a
//! `swarmd` `rpcResult` frame's `error` field.

use serde::Serialize;

/// Application-wide error type for the SWARM Orchestrator backend.
///
/// Every variant is serializable (see the [`Serialize`] impl below), so
/// an error propagates from a registry handler to the React frontend
/// unchanged over either transport.
///
/// # Variants
///
/// | Variant            | Trigger                                                   |
/// |--------------------|-----------------------------------------------------------|
/// | `WorkerNotFound`   | Worker ID does not exist in the registry                  |
/// | `PtySpawn`         | PTY process creation failed                               |
/// | `Ipc`              | Process I/O plumbing failed (write, flush, parse)         |
/// | `Ai`               | A provider-agent CLI failed to start or rejected a request |
/// | `Io`               | Underlying `std::io::Error`                               |
/// | `PermissionDenied` | Resource access denied (e.g. an unknown permission mode)  |
/// | `RegistryFull`     | Worker registry has reached `max_workers` capacity        |
/// | `Serialization`    | JSON serialization/deserialization failure                |
/// | `SessionNotFound`  | Session ID does not exist in the manager                  |
/// | `ChannelClosed`    | A Tokio mpsc or broadcast channel was dropped             |
/// | `EventLog`         | SQLite event-log operation failed, or the engine is down  |
/// | `QueueFull`        | The agent-turn scheduler's queue is full (backpressure)   |
/// | `Config`           | `swarm-config.json` could not be read, parsed or written  |
/// | `Git`              | A `git` invocation failed, timed out, or `git` is missing |
/// | `AgentSessionBusy` | A turn was sent while another was in flight               |
/// | `LineTooLong`      | A provider's NDJSON line exceeded the framer's cap        |
///
/// # Examples
///
/// ```
/// use swarm_core::error::AppError;
///
/// let err = AppError::WorkerNotFound { id: "abc-123".to_string() };
/// assert_eq!(err.to_string(), "Worker `abc-123` not found");
///
/// // Serializes as a plain string on the wire:
/// let json = serde_json::to_string(&err).unwrap();
/// assert_eq!(json, r#""Worker `abc-123` not found""#);
/// ```
#[derive(Debug, thiserror::Error)]
pub enum AppError {
    /// The requested worker ID does not exist in the registry.
    #[error("Worker `{id}` not found")]
    WorkerNotFound {
        /// The UUID string of the missing worker.
        id: String,
    },

    /// A PTY process failed to spawn.
    #[error("PTY spawn failed: {0}")]
    PtySpawn(String),

    /// A child-process I/O operation failed (write, flush, or parse).
    #[error("IPC error: {0}")]
    Ipc(String),

    /// A provider-agent operation failed: the provider CLI could not be
    /// started, or it rejected a session or turn request.
    #[error("AI error: {0}")]
    Ai(String),

    /// An underlying I/O operation failed.
    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),

    /// Access to a resource was denied.
    #[error("Permission denied: {0}")]
    PermissionDenied(String),

    /// The worker registry has reached its maximum capacity.
    #[error("Registry at capacity ({max})")]
    RegistryFull {
        /// The configured maximum number of workers.
        max: usize,
    },

    /// JSON serialization or deserialization failed.
    #[error("Serialization error: {0}")]
    Serialization(#[from] serde_json::Error),

    /// The requested session ID does not exist in the manager.
    #[error("Session `{id}` not found")]
    SessionNotFound {
        /// The UUID string of the missing session.
        id: String,
    },

    /// A Tokio channel (mpsc or broadcast) was closed unexpectedly.
    #[error("Channel closed: {0}")]
    ChannelClosed(String),

    /// An event-log operation failed: a SQLite error, or the
    /// orchestration engine's writer thread is shut down or gone.
    #[error("event log: {0}")]
    EventLog(String),

    /// The agent-turn scheduler's bounded queue is full (backpressure).
    #[error("AI queue full ({capacity} capacity)")]
    QueueFull {
        /// The configured capacity of the bounded channel.
        capacity: usize,
    },

    /// `swarm-config.json` could not be read, parsed, or written.
    ///
    /// Never carries secret values (e.g. API keys) in its message —
    /// only path/IO context, so it is safe to log and display.
    #[error("Config error: {0}")]
    Config(String),

    /// A `git` CLI invocation (worktree/repo discovery) failed, timed
    /// out, or the installed `git` binary is missing/too old. Carries
    /// only command/stderr context — never repo file contents — so it
    /// is safe to log.
    #[error("Git error: {0}")]
    Git(String),

    /// A [`crate::agent::adapter::AgentSession::send_turn`] call arrived
    /// while a turn was already in flight on that session. Its own
    /// variant because the trait's concurrency contract makes it an
    /// expected outcome: a session never queues a second turn
    /// internally — turn-level queueing is
    /// [`crate::agent::scheduler::AgentScheduler`]'s job.
    #[error("agent session busy: a turn is already in flight")]
    AgentSessionBusy,

    /// A piped provider process's NDJSON framer buffered a single line
    /// past [`crate::worker::proc::MAX_LINE_BYTES`] without a
    /// terminating `\n` — a provider bug (or a non-NDJSON stream) that
    /// must fail loudly rather than grow the buffer unboundedly or
    /// silently truncate the line.
    #[error("NDJSON line exceeded {max} bytes without a terminator (buffered {bytes})")]
    LineTooLong {
        /// Bytes buffered when the cap was hit.
        bytes: usize,
        /// The configured cap.
        max: usize,
    },
}

/// Every SQLite failure is an event-log failure: the event log is the
/// crate's only SQLite database. Lets [`crate::orchestration::EventLog`]
/// use `?` on `rusqlite` calls.
impl From<rusqlite::Error> for AppError {
    fn from(e: rusqlite::Error) -> Self {
        Self::EventLog(e.to_string())
    }
}

/// Serializes [`AppError`] as its `Display` string — the wire shape
/// every IPC and WS error carries today, which the frontend displays
/// (and classifies) directly.
impl Serialize for AppError {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.collect_str(self)
    }
}

#[cfg(test)]
mod tests {
    use std::assert_matches;

    use super::*;

    #[test]
    fn test_worker_not_found_display() {
        let err = AppError::WorkerNotFound {
            id: "abc-123".to_string(),
        };
        assert_eq!(err.to_string(), "Worker `abc-123` not found");
    }

    #[test]
    fn test_pty_spawn_display() {
        let err = AppError::PtySpawn("no such file".to_string());
        assert_eq!(err.to_string(), "PTY spawn failed: no such file");
    }

    #[test]
    fn test_ipc_display() {
        let err = AppError::Ipc("timeout".to_string());
        assert_eq!(err.to_string(), "IPC error: timeout");
    }

    #[test]
    fn test_ai_display() {
        let err = AppError::Ai("rate limited".to_string());
        assert_eq!(err.to_string(), "AI error: rate limited");
    }

    #[test]
    fn test_permission_denied_display() {
        let err = AppError::PermissionDenied("read /etc/shadow".to_string());
        assert_eq!(err.to_string(), "Permission denied: read /etc/shadow");
    }

    #[test]
    fn test_registry_full_display() {
        let err = AppError::RegistryFull { max: 64 };
        assert_eq!(err.to_string(), "Registry at capacity (64)");
    }

    #[test]
    fn test_session_not_found_display() {
        let err = AppError::SessionNotFound {
            id: "sess-456".to_string(),
        };
        assert_eq!(err.to_string(), "Session `sess-456` not found");
    }

    #[test]
    fn test_channel_closed_display() {
        let err = AppError::ChannelClosed("queue dropped".to_string());
        assert_eq!(err.to_string(), "Channel closed: queue dropped");
    }

    #[test]
    fn test_queue_full_display_and_serialize() {
        let err = AppError::QueueFull { capacity: 256 };
        assert_eq!(err.to_string(), "AI queue full (256 capacity)");
        assert_eq!(
            serde_json::to_string(&err).expect("serialize"),
            r#""AI queue full (256 capacity)""#
        );
    }

    #[test]
    fn test_git_display() {
        let err = AppError::Git("worktree add refused: index.lock exists".to_string());
        assert_eq!(
            err.to_string(),
            "Git error: worktree add refused: index.lock exists"
        );
    }

    #[test]
    fn test_config_display() {
        let err = AppError::Config("failed to resolve app data dir".to_string());
        assert_eq!(
            err.to_string(),
            "Config error: failed to resolve app data dir"
        );
    }

    #[test]
    fn test_rusqlite_error_maps_to_event_log() {
        let err = AppError::from(rusqlite::Error::InvalidQuery);
        assert_matches!(&err, AppError::EventLog(msg) if !msg.is_empty());
        assert!(err.to_string().starts_with("event log: "));
    }

    #[test]
    fn test_serialize_as_string() {
        let err = AppError::WorkerNotFound {
            id: "xyz".to_string(),
        };
        let json = serde_json::to_string(&err).expect("serialize");
        assert_eq!(json, r#""Worker `xyz` not found""#);
    }
}
