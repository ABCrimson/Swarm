//! Multi-provider agent execution.
//!
//! One Rust trait pair ([`adapter::AgentAdapter`] / [`adapter::AgentSession`])
//! every provider CLI implements, so every provider's turns land as
//! normalized `agent_*` events (`crate::events::emitter`) on the
//! ordered spine (`crate::orchestration`). `docs/architecture.md`'s
//! Adapter Layer section has the full design.
//!
//! ## Module Layout
//!
//! - [`adapter`] — the trait pair, [`adapter::Capabilities`], and every
//!   supporting type (`ProviderId`, `AgentSpawnSpec`, `TurnInput`, ...)
//! - [`claude_code`] — `ClaudeCodeAdapter`/`ClaudeCodeSession`: the
//!   `claude` CLI's `stream-json` protocol and its control requests
//!   (handshake, interrupt, interactive permissions) over
//!   [`crate::worker::proc::spawn_piped`]
//! - [`codex`] — `CodexAdapter`/`CodexSession`: `codex app-server`'s
//!   JSON-RPC 2.0 protocol over the same [`crate::worker::proc::spawn_piped`]
//!   substrate
//! - [`scheduler`] — priority + concurrency gating for agent turns
//! - [`registry`] — live `Arc<dyn AgentSession>` handles keyed by
//!   worker id, the counterpart to
//!   [`crate::worker::registry::WorkerRegistry`] for provider sessions
//!
//! ## Wiring
//!
//! [`crate::runtime::Runtime::start`] builds one adapter per implemented
//! provider, one [`registry::AgentSessionRegistry`] and one
//! [`scheduler::AgentScheduler`], which both shells (the desktop app and
//! `swarmd`) share. `agent_spawn`/`agent_probe` pick the adapter by
//! [`adapter::ProviderId`]; every other agent command reaches the live
//! session through the registry by worker id.

use std::collections::VecDeque;
use std::time::Duration;

use parking_lot::Mutex;

use crate::worker::proc::STDERR_TAIL_CAP;

pub mod adapter;
pub mod claude_code;
pub mod codex;
pub mod registry;
pub mod scheduler;

pub use adapter::{
    AgentAdapter, AgentSession, AgentSpawnSpec, AgentTurnStatus, BoxFuture, CancelGranularity,
    Capabilities, ExitSummary, PermissionDecision, PermissionId, ProbeReport, ProviderId,
    SessionKey, TurnId, TurnInput,
};
pub use claude_code::{ClaudeCodeAdapter, ClaudeCodeSession, ClaudeCodeTrustTier};
pub use codex::{CodexAdapter, CodexSession, CodexTrustTier};
pub use registry::AgentSessionRegistry;
pub use scheduler::{
    AgentScheduler, AgentSchedulerConfig, AgentTurnRequest, MAX_AGENT_CONCURRENCY,
    MIN_AGENT_CONCURRENCY, TurnPriority,
};

/// Prefix of the synthesized settlement error for every ungraceful exit of
/// a provider child (killed, crashed, or an NDJSON framer failure) —
/// Condition B. In parentheses it is followed by the cause SWARM knows (a
/// framer error), else [`stderr_snippet`] of the child's stderr tail
/// (`Stderr: …` or `No Stderr Output`). Both adapters settle with it.
pub(crate) const PROCESS_EXITED_WITHOUT_RECEIPT: &str = "Process Exited Without A Receipt";

/// The terminating signal's name for a Unix exit status (`SIGKILL` for
/// signal 9), `signal <n>` for one outside the table, and `None` for a
/// normal exit. Shared by both adapters so an [`ExitSummary`]'s `signal`
/// reads the same whichever provider produced it.
#[cfg(unix)]
pub(crate) fn signal_name(status: &std::process::ExitStatus) -> Option<String> {
    use std::os::unix::process::ExitStatusExt;
    /// Signals whose numbers agree across Linux and macOS.
    const NAMES: [(i32, &str); 9] = [
        (1, "SIGHUP"),
        (2, "SIGINT"),
        (3, "SIGQUIT"),
        (6, "SIGABRT"),
        (9, "SIGKILL"),
        (11, "SIGSEGV"),
        (13, "SIGPIPE"),
        (14, "SIGALRM"),
        (15, "SIGTERM"),
    ];
    status.signal().map(|signal| {
        NAMES
            .iter()
            .find(|(number, _)| *number == signal)
            .map_or_else(
                || format!("signal {signal}"),
                |(_, name)| (*name).to_owned(),
            )
    })
}

/// Windows has no signals: a killed process has only an exit code.
#[cfg(not(unix))]
pub(crate) fn signal_name(_status: &std::process::ExitStatus) -> Option<String> {
    None
}

/// The tail of a child's stderr as one line for a failure message:
/// `Stderr: <text>`, or `No Stderr Output` when it wrote nothing.
/// Shared by both provider adapters, which keep the same bounded byte
/// tail of their CLI's stderr.
///
/// Recognized credentials are redacted ([`crate::git::redact::redact`])
/// because the snippet lands in persisted settlement errors. A full tail
/// (`STDERR_TAIL_CAP` bytes) had its front cut off by the ring, possibly
/// inside a token, and a token's tail alone matches no redaction pattern
/// (`ant-api03-…`, `//u:tok@h`). Every pattern excludes whitespace, so the
/// leading run of non-whitespace bytes is dropped before redacting; a full
/// tail without any whitespace yields `Stderr: [Truncated]`.
pub(crate) fn stderr_snippet(tail: &Mutex<VecDeque<u8>>) -> String {
    let mut tail = tail.lock();
    let full = tail.len() >= STDERR_TAIL_CAP;
    let mut bytes: &[u8] = tail.make_contiguous();
    if full {
        let partial = bytes
            .iter()
            .position(u8::is_ascii_whitespace)
            .unwrap_or(bytes.len());
        bytes = &bytes[partial..];
        if bytes.is_empty() {
            return "Stderr: [Truncated]".to_owned();
        }
    }
    let text = crate::git::redact::redact(&String::from_utf8_lossy(bytes));
    match text.trim() {
        "" => "No Stderr Output".to_owned(),
        text => format!("Stderr: {text}"),
    }
}

/// The child's last stderr bytes as [`stderr_snippet`], after waiting up to
/// 200 ms for the piped stderr drain thread, which can trail the child's
/// exit: without the wait, a crash that wrote a panic message could settle
/// as "No Stderr Output". Shared by both provider adapters.
pub(crate) async fn drained_stderr_snippet(tail: &Mutex<VecDeque<u8>>) -> String {
    for _ in 0..10 {
        if !tail.lock().is_empty() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    stderr_snippet(tail)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_stderr_snippet_redacts_credentials() {
        let tail = Mutex::new(VecDeque::from(
            b"proxy http://u:p@h failed sk-ant-abcdefghijk".to_vec(),
        ));
        let snippet = stderr_snippet(&tail);
        assert!(snippet.contains("[REDACTED]"), "{snippet}");
        assert!(!snippet.contains("u:p"), "{snippet}");
        assert!(!snippet.contains("sk-ant-"), "{snippet}");
    }

    #[test]
    fn test_stderr_snippet_redacts_url_userinfo_tokens_and_api_keys() {
        let tail = Mutex::new(VecDeque::from(
            b"clone https://u:ghp_aaaaaaaaaaaaaaaaaaaaaaaa@h failed; key sk-ant-api03-SECRETSECRET"
                .to_vec(),
        ));
        let snippet = stderr_snippet(&tail);
        assert!(!snippet.contains("ghp_"), "{snippet}");
        assert!(!snippet.contains("SECRET"), "{snippet}");
    }

    #[test]
    fn test_stderr_snippet_redacts_a_bare_github_token_outside_any_url() {
        let token = format!("ghp_{}", "a".repeat(36));
        let tail = Mutex::new(VecDeque::from(
            format!("push rejected, token {token} expired").into_bytes(),
        ));
        let snippet = stderr_snippet(&tail);
        assert!(snippet.contains("[REDACTED]"), "{snippet}");
        assert!(!snippet.contains(&token), "{snippet}");
    }

    /// A tail as the stderr ring leaves it when full: exactly the cap,
    /// starting with `head` and padded with whitespace-separated filler.
    fn full_tail(head: &str) -> Mutex<VecDeque<u8>> {
        let mut bytes = head.as_bytes().to_vec();
        while bytes.len() < STDERR_TAIL_CAP {
            bytes.extend_from_slice(b"x ");
        }
        bytes.truncate(STDERR_TAIL_CAP);
        Mutex::new(VecDeque::from(bytes))
    }

    #[test]
    fn test_stderr_snippet_drops_a_partial_api_key_at_the_front_of_a_full_tail() {
        let snippet = stderr_snippet(&full_tail("ant-api03-SECRETSECRETSECRET rest"));
        assert!(!snippet.contains("SECRET"), "{snippet}");
        assert!(snippet.contains("rest"), "{snippet}");
    }

    #[test]
    fn test_stderr_snippet_drops_a_partial_url_userinfo_at_the_front_of_a_full_tail() {
        let snippet = stderr_snippet(&full_tail("//u:tok3n@host/x rest"));
        assert!(!snippet.contains("tok3n"), "{snippet}");
        assert!(snippet.contains("rest"), "{snippet}");
    }

    #[test]
    fn test_stderr_snippet_keeps_a_short_tail_whole() {
        let tail = Mutex::new(VecDeque::from(b"fatal: boom".to_vec()));
        assert_eq!(stderr_snippet(&tail), "Stderr: fatal: boom");
    }

    #[test]
    fn test_stderr_snippet_of_a_full_tail_without_whitespace_is_not_empty() {
        let tail = Mutex::new(VecDeque::from(vec![b'a'; STDERR_TAIL_CAP]));
        let snippet = stderr_snippet(&tail);
        assert_ne!(snippet, "No Stderr Output");
        assert!(!snippet.contains("aaaa"), "{snippet}");
    }
    #[cfg(unix)]
    #[test]
    fn test_signal_name_maps_signals_and_ignores_normal_exits() {
        use std::os::unix::process::ExitStatusExt;
        let name = |raw| signal_name(&std::process::ExitStatus::from_raw(raw));
        assert_eq!(name(9).as_deref(), Some("SIGKILL"));
        assert_eq!(name(14).as_deref(), Some("SIGALRM"));
        assert_eq!(name(10).as_deref(), Some("signal 10"));
        // Raw status 0 is a normal exit; an exit code lives in bits 8..16.
        assert_eq!(name(0), None);
        assert_eq!(name(1 << 8), None);
    }
}
