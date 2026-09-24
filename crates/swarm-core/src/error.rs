//! Application-wide error types for the SWARM Orchestrator backend.
//!
//! All error variants are serializable for Tauri IPC transport.
//! The [`AppError`] enum uses `thiserror` 2.0.18 for ergonomic
//! `Display` and `From` implementations, and a custom [`Serialize`]
//! impl that serializes each variant as its display string.

use serde::Serialize;

/// Application-wide error types for SWARM Orchestrator.
///
/// Uses `thiserror` 2.0.18 at library boundaries.
/// All variants are serializable for Tauri IPC transport,
/// allowing errors to propagate cleanly from the Rust backend
/// to the React frontend over the IPC bridge.
///
/// # Variants
///
/// | Variant            | Trigger                                          |
/// |--------------------|--------------------------------------------------|
/// | `WorkerNotFound`   | Worker ID does not exist in the registry          |
/// | `PtySpawn`         | PTY process creation failed                      |
/// | `Ipc`              | IPC communication failure (write, flush, parse)   |
/// | `Ai`               | AI API request or streaming error                 |
/// | `Io`               | Underlying `std::io::Error`                       |
/// | `PermissionDenied` | Filesystem or resource access denied               |
/// | `RegistryFull`     | Worker registry has reached `max_workers` capacity |
/// | `Serialization`    | JSON serialization/deserialization failure         |
/// | `SessionNotFound`  | Session ID does not exist in the manager           |
/// | `ChannelClosed`    | Tokio mpsc or broadcast channel was dropped        |
/// | `EventLog`         | SQLite event-log operation failed                 |
/// | `QueueFull`        | AI request queue is full (backpressure)           |
/// | `Config`           | App config file read/write/resolve failed         |
///
/// # Examples
///
/// ```
/// use swarm_core::error::AppError;
///
/// let err = AppError::WorkerNotFound { id: "abc-123".to_string() };
/// assert_eq!(err.to_string(), "Worker `abc-123` not found");
///
/// // Serializes as a plain string for IPC:
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

    /// An IPC communication error occurred (write, flush, or parse failure).
    #[error("IPC error: {0}")]
    Ipc(String),

    /// An AI API request or streaming operation failed.
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

    /// SQLite event-log operation failed.
    #[error("event log: {0}")]
    EventLog(String),

    /// The AI request queue is full (backpressure).
    #[error("AI queue full ({capacity} capacity)")]
    QueueFull {
        /// The configured capacity of the bounded channel.
        capacity: usize,
    },

    /// The app config file could not be resolved, read, or written.
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

    /// A `git` invocation exceeded its wall-clock budget and was
    /// terminated. A typed variant (not an [`AppError::Git`] string) so
    /// callers classify timeouts by variant, never by sniffing message
    /// text. `command` is the git subcommand only (e.g. `"commit"`),
    /// never the full argv, which can carry a commit message.
    #[error("Git error: `git {command}` timed out after {}s", timeout.as_secs())]
    GitTimeout {
        /// The git subcommand that timed out.
        command: String,
        /// The budget it exceeded.
        timeout: std::time::Duration,
    },

    /// A [`crate::agent::adapter::AgentSession::send_turn`] call arrived
    /// while a turn was already in flight on that session. A typed
    /// variant (not a generic `Ipc` string) because callers are
    /// expected to match on it: per the trait's concurrency contract, a
    /// session never queues a second turn internally — turn-level
    /// queueing across multiple turns is
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

/// Serializes [`AppError`] as a plain string for Tauri IPC transport.
///
/// Rather than serializing the enum structure, this produces the
/// `Display` representation as a JSON string, which the frontend
/// can display directly to the user.
impl Serialize for AppError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(&self.to_string())
    }
}

#[cfg(test)]
mod tests {
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
    fn test_queue_full_display() {
        let err = AppError::QueueFull { capacity: 256 };
        let msg = err.to_string();
        assert!(
            msg.contains("256"),
            "expected capacity '256' in display, got: {msg}"
        );
        assert_eq!(msg, "AI queue full (256 capacity)");
    }

    #[test]
    fn test_queue_full_serialize() {
        let err = AppError::QueueFull { capacity: 128 };
        let json = serde_json::to_string(&err).expect("serialize");
        assert_eq!(json, r#""AI queue full (128 capacity)""#);
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
    fn test_git_timeout_display_names_only_the_subcommand() {
        let err = AppError::GitTimeout {
            command: "commit".to_string(),
            timeout: std::time::Duration::from_secs(900),
        };
        assert_eq!(
            err.to_string(),
            "Git error: `git commit` timed out after 900s"
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
    fn test_serialize_as_string() {
        let err = AppError::WorkerNotFound {
            id: "xyz".to_string(),
        };
        let json = serde_json::to_string(&err).expect("serialize");
        assert_eq!(json, r#""Worker `xyz` not found""#);
    }
}
