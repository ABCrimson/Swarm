//! Piped-process substrate for JSON-protocol provider CLIs.
//!
//! A sibling to [`super::pty::spawn_pty`], reusing the same proven
//! backpressure shape (`spawn_blocking` reader → bounded
//! `mpsc::channel(4096)` → forwarder task) but over `Stdio::piped()`
//! instead of a pseudo-terminal.
//!
//! # Why not a PTY for JSON protocols
//!
//! **A PTY is wrong for JSON.** Line discipline echoes input back onto
//! the same stream it's supposed to be reading structured output from,
//! injects `\r` (and sometimes bare `\r` without a following `\n`) into
//! line boundaries, and can inject ANSI escape sequences from anything
//! the child writes expecting a real terminal — all of which corrupt
//! NDJSON framing, which assumes exactly one JSON value per `\n`-
//! terminated line with nothing else on the wire. `spawn_pty` stays the
//! right substrate for interactive shells (the `worker_output` stream
//! IS meant to be raw terminal bytes); this module exists because
//! Claude Code's `stream-json` protocol (and Codex's `app-server`
//! JSON-RPC, and any future provider speaking newline-delimited JSON
//! over stdio) is not a terminal session and must never be treated like
//! one. Pipes only, for JSON protocols only.

use std::io::{Read, Write};
use std::process::{Child, Command, Stdio};

use anyhow::Context;
use tokio::sync::mpsc;

/// Efficient NDJSON line framer.
///
/// Buffers partial lines across `push()` calls and returns every
/// complete (`\n`-terminated), non-empty, trimmed line found in the
/// newly-fed bytes. Unlike a framer that reallocates the remaining
/// buffer after every single line found (the shape `ai/client.rs`'s
/// deleted SSE loop used, which pays an `O(remaining bytes)` copy per
/// line — quadratic in the pathological case of many small lines
/// arriving in one chunk), this framer compacts its internal buffer
/// **once per `push()` call**, not once per line: `Vec::drain` runs
/// exactly once regardless of how many complete lines were found,
/// bounding total work across the framer's lifetime to the total bytes
/// fed in (each byte is copied at most twice: once on append, once on
/// the trailing compaction).
#[derive(Debug, Default)]
pub struct NdjsonFramer {
    buf: Vec<u8>,
}

impl NdjsonFramer {
    /// Creates an empty framer.
    pub fn new() -> Self {
        Self::default()
    }

    /// Feeds newly-read bytes in and returns every complete line found
    /// (UTF-8-lossily decoded, trimmed, empty lines dropped). Any
    /// trailing partial line is retained internally for the next call.
    pub fn push(&mut self, bytes: &[u8]) -> Vec<String> {
        self.buf.extend_from_slice(bytes);

        let mut lines = Vec::new();
        let mut start = 0usize;
        while let Some(rel_pos) = self.buf[start..].iter().position(|&b| b == b'\n') {
            let pos = start + rel_pos;
            let line = String::from_utf8_lossy(&self.buf[start..pos])
                .trim()
                .to_owned();
            if !line.is_empty() {
                lines.push(line);
            }
            start = pos + 1;
        }

        if start > 0 {
            self.buf.drain(0..start);
        }

        lines
    }

    /// Number of bytes currently buffered as an incomplete trailing
    /// line — exposed for tests (giant-line handling) rather than any
    /// production caller.
    #[cfg(test)]
    fn buffered_len(&self) -> usize {
        self.buf.len()
    }
}

/// Result of spawning a piped-stdio child process.
///
/// Contains the stdin writer for sending protocol input, the child
/// process handle for lifecycle management, the OS process ID, and a
/// bounded channel of complete NDJSON lines already framed from the
/// child's stdout — ready for a Phase 3 adapter to `serde_json::from_str`
/// each one against its provider's protocol schema.
pub struct PipedHandle {
    /// Writer to send input to the child's stdin.
    pub stdin: Box<dyn Write + Send>,
    /// The child process handle (kill/wait).
    pub child: Child,
    /// PID of the spawned process, if available.
    pub pid: Option<u32>,
    /// Complete NDJSON lines framed from the child's stdout. Bounded
    /// (capacity 4096) — same backpressure shape as `spawn_pty`'s
    /// `worker_output` bridge: a slow consumer backs up this channel
    /// rather than lines being silently dropped.
    pub lines: mpsc::Receiver<String>,
}

/// Spawns a child process over piped stdio, framing its stdout as
/// NDJSON lines.
///
/// # Architecture
///
/// ```text
/// ┌──────────┐  spawn_blocking  ┌─────────────┐  mpsc(Vec<u8>) ┌───────────────┐  mpsc(String) ┌────────┐
/// │  Child   │──────────────────>│ Reader Task │───────────────>│ Forwarder Task│───────────────>│ Caller │
/// │ (stdout) │  blocking read   │ (4KB buffer) │                │ NdjsonFramer  │                │        │
/// └──────────┘                  └─────────────┘                └───────────────┘                └────────┘
/// ```
///
/// stderr is drained on a separate best-effort background thread
/// (logged at `debug`, never exposed structurally) purely to prevent
/// the child from blocking on a full OS pipe buffer if it writes
/// diagnostics there — Phase 3 adapters that need structured stderr
/// handling can extend this; Phase 2's substrate only needs to not
/// deadlock.
///
/// # Arguments
///
/// * `program` - Executable to spawn (e.g. `"claude"`)
/// * `args` - Argument vector (never a shell string — matches
///   `swarm_core::git::cli::run`'s arg-vector-only discipline)
/// * `cwd` - Working directory for the child process
/// * `env` - Additional environment variables to set
///
/// # Errors
///
/// Returns `anyhow::Error` if the child fails to spawn or its stdio
/// handles cannot be captured.
#[tracing::instrument(skip(env), fields(%program))]
pub fn spawn_piped(
    program: &str,
    args: &[String],
    cwd: &str,
    env: &std::collections::HashMap<String, String>,
) -> anyhow::Result<PipedHandle> {
    let mut cmd = Command::new(program);
    cmd.args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if !cwd.is_empty() {
        cmd.current_dir(cwd);
    }
    for (key, value) in env {
        cmd.env(key, value);
    }

    let mut child = cmd.spawn().context("failed to spawn piped child process")?;
    let pid = Some(child.id());

    let stdin = child
        .stdin
        .take()
        .context("failed to capture child stdin")?;
    let stdout = child
        .stdout
        .take()
        .context("failed to capture child stdout")?;
    let stderr = child
        .stderr
        .take()
        .context("failed to capture child stderr")?;

    // stderr drain — best-effort, prevents pipe-buffer deadlock only.
    tokio::task::spawn_blocking(move || {
        let mut reader = stderr;
        let mut buf = [0u8; 4096];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    tracing::debug!(bytes = n, "piped child stderr (drained, not surfaced)");
                }
                Err(e) => {
                    tracing::debug!(error = %e, "piped child stderr read error");
                    break;
                }
            }
        }
    });

    // Stage 1: spawn_blocking reader — raw bytes off the child's stdout.
    let (raw_tx, mut raw_rx) = mpsc::channel::<Vec<u8>>(4096);
    let reader_handle = tokio::task::spawn_blocking(move || {
        let mut reader = stdout;
        let mut buf = [0u8; 4096];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    if raw_tx.blocking_send(buf[..n].to_vec()).is_err() {
                        break;
                    }
                }
                Err(e) => {
                    tracing::error!(error = %e, "piped child stdout read error");
                    break;
                }
            }
        }
    });
    tokio::spawn(async move {
        if let Err(e) = reader_handle.await {
            tracing::error!(error = %e, "piped stdout reader task panicked");
        }
    });

    // Stage 2: forwarder — frame raw bytes into complete NDJSON lines.
    let (line_tx, line_rx) = mpsc::channel::<String>(4096);
    let forwarder_handle = tokio::spawn(async move {
        let mut framer = NdjsonFramer::new();
        while let Some(bytes) = raw_rx.recv().await {
            for line in framer.push(&bytes) {
                if line_tx.send(line).await.is_err() {
                    return;
                }
            }
        }
    });
    tokio::spawn(async move {
        if let Err(e) = forwarder_handle.await {
            tracing::error!(error = %e, "piped NDJSON forwarder task panicked");
        }
    });

    Ok(PipedHandle {
        stdin: Box::new(stdin),
        child,
        pid,
        lines: line_rx,
    })
}

/// Writes input bytes to a piped child's stdin.
///
/// Performs a `write_all` followed by `flush`, mirroring
/// [`super::pty::write_to_pty`]'s contract.
///
/// # Errors
///
/// Returns `anyhow::Error` if the write or flush operation fails.
pub fn write_to_piped(writer: &mut dyn Write, data: &[u8]) -> anyhow::Result<()> {
    writer
        .write_all(data)
        .context("failed to write to piped child stdin")?;
    writer
        .flush()
        .context("failed to flush piped stdin writer")?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── NdjsonFramer ──────────────────────────────────────────────────

    #[test]
    fn test_framer_handles_line_split_across_two_pushes() {
        let mut framer = NdjsonFramer::new();
        let first = framer.push(b"{\"type\":\"sys");
        assert!(first.is_empty(), "no complete line yet");
        let second = framer.push(b"tem_init\"}\n");
        assert_eq!(second, vec![r#"{"type":"system_init"}"#.to_string()]);
        assert_eq!(framer.buffered_len(), 0);
    }

    #[test]
    fn test_framer_handles_multiple_complete_lines_in_one_push() {
        let mut framer = NdjsonFramer::new();
        let lines = framer.push(b"{\"a\":1}\n{\"a\":2}\n{\"a\":3}\n");
        assert_eq!(
            lines,
            vec![
                r#"{"a":1}"#.to_string(),
                r#"{"a":2}"#.to_string(),
                r#"{"a":3}"#.to_string(),
            ]
        );
    }

    #[test]
    fn test_framer_skips_empty_lines() {
        let mut framer = NdjsonFramer::new();
        let lines = framer.push(b"\n\n{\"a\":1}\n\n");
        assert_eq!(lines, vec![r#"{"a":1}"#.to_string()]);
    }

    #[test]
    fn test_framer_trims_trailing_carriage_return() {
        // Defensive: even though pipes (unlike a PTY) should never
        // inject \r, a provider on Windows writing text-mode output
        // could still emit \r\n line endings.
        let mut framer = NdjsonFramer::new();
        let lines = framer.push(b"{\"a\":1}\r\n");
        assert_eq!(lines, vec![r#"{"a":1}"#.to_string()]);
    }

    #[test]
    fn test_framer_handles_a_giant_line_across_many_pushes() {
        let mut framer = NdjsonFramer::new();
        let big_value = "x".repeat(200_000);
        let chunk1 = format!("{{\"big\":\"{}", &big_value[..100_000]);
        let chunk2 = format!("{}\"}}\n", &big_value[100_000..]);

        assert!(framer.push(chunk1.as_bytes()).is_empty());
        assert_eq!(framer.buffered_len(), chunk1.len());

        let lines = framer.push(chunk2.as_bytes());
        assert_eq!(lines.len(), 1);
        let expected = format!("{{\"big\":\"{big_value}\"}}");
        assert_eq!(lines[0], expected);
        assert_eq!(
            framer.buffered_len(),
            0,
            "buffer fully compacted after the giant line"
        );
    }

    #[test]
    fn test_framer_no_trailing_newline_keeps_partial_line_buffered() {
        let mut framer = NdjsonFramer::new();
        let lines = framer.push(b"{\"incomplete\":true}");
        assert!(lines.is_empty());
        assert!(framer.buffered_len() > 0);
    }

    // ── spawn_piped round-trip ────────────────────────────────────────

    /// Platform-default echo command: mirrors the established
    /// platform-default-shell test pattern in
    /// `worker::lifecycle::tests` (DIRECTIVE B1) rather than
    /// hardcoding one OS's binary. Both branches read stdin and echo
    /// it verbatim to stdout, byte for byte.
    fn platform_echo() -> (&'static str, Vec<String>) {
        if cfg!(windows) {
            (
                "powershell.exe",
                vec![
                    "-NoProfile".to_string(),
                    "-NonInteractive".to_string(),
                    "-Command".to_string(),
                    "$input".to_string(),
                ],
            )
        } else {
            ("/bin/sh", vec!["-c".to_string(), "cat".to_string()])
        }
    }

    /// DIRECTIVE: `spawn_piped` round-trips with a real child process —
    /// bytes written to `stdin` come back out through the framed
    /// `lines` channel. Platform-neutral per the established
    /// default-shell test pattern; no PTY, no ANSI/CR injection to
    /// account for.
    #[tokio::test]
    async fn test_spawn_piped_round_trips_ndjson_lines_with_a_real_child() {
        let (program, args) = platform_echo();
        let mut handle = spawn_piped(program, &args, "", &std::collections::HashMap::new())
            .expect("spawn_piped should succeed against a platform-default shell");

        write_to_piped(
            handle.stdin.as_mut(),
            b"{\"type\":\"one\"}\n{\"type\":\"two\"}\n",
        )
        .expect("write to child stdin should succeed");
        // Close stdin so `cat`/`$input` sees EOF and exits — otherwise
        // this test would hang waiting for lines that never arrive.
        drop(handle.stdin);

        let mut received = Vec::new();
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(10);
        while received.len() < 2 {
            let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
            if remaining.is_zero() {
                panic!("timed out waiting for echoed NDJSON lines, got: {received:?}");
            }
            match tokio::time::timeout(remaining, handle.lines.recv()).await {
                Ok(Some(line)) => received.push(line),
                Ok(None) => break,
                Err(_) => panic!("timed out waiting for echoed NDJSON lines, got: {received:?}"),
            }
        }

        assert_eq!(received, vec![r#"{"type":"one"}"#, r#"{"type":"two"}"#]);

        let _ = tokio::task::spawn_blocking(move || handle.child.wait()).await;
    }
}
