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

use std::collections::VecDeque;
use std::io::{Read, Write};
use std::process::{Child, Command, Stdio};
use std::sync::Arc;

use anyhow::Context;
use parking_lot::Mutex;
use tokio::sync::mpsc;

use crate::error::AppError;

/// Hard cap on a single NDJSON line's buffered size before a
/// terminating `\n` arrives.
///
/// Real provider protocol lines (tool inputs, block content) are well
/// under this. A provider that never terminates a line — protocol
/// desync, a bug, or a non-NDJSON stream accidentally piped here —
/// must fail loudly (see [`AppError::LineTooLong`]) rather than grow
/// this buffer without bound. Measured before this cap existed: an
/// unterminated stream retained 10MB+ in the framer's buffer with no
/// ceiling at all.
pub const MAX_LINE_BYTES: usize = 10 * 1024 * 1024;

/// Bytes of stderr tail retained for diagnostics (see
/// [`PipedHandle::stderr_tail`]) — enough to recover a provider's
/// fatal startup message without buffering the whole stream.
const STDERR_TAIL_CAP: usize = 4096;

/// Efficient NDJSON line framer.
///
/// Buffers partial lines across `push()` calls and returns every
/// complete (`\n`-terminated), non-empty, trimmed line found in the
/// newly-fed bytes.
///
/// # Two fixes over the first cut (review round)
///
/// 1. **Linear scanning, not quadratic.** The first cut re-scanned
///    `buf` from byte 0 on every `push()` call, including the retained
///    partial-line prefix from every prior call — for a large line fed
///    in `spawn_piped`'s 4096-byte read chunks, this re-scanned the
///    same growing prefix on every chunk, an O(n²) amplification
///    (measured: ~13.4B byte-comparisons for a single 10MB line fed in
///    4096-byte chunks — a >1000x blowup over the ~10MB of actual
///    work). [`Self::scan_from`] persists across calls: each byte is
///    now scanned by [`Self::push`]'s `\n` search **at most once** over
///    the framer's whole lifetime, whether or not it happens to land in
///    the same `push()` call as its line's terminator.
/// 2. **A line cap.** Unlike a framer that reallocates the remaining
///    buffer after every single line found (the shape the deleted
///    `ai/client.rs`'s SSE loop used, which pays an `O(remaining
///    bytes)` copy per line), this framer's buffer compaction
///    (`Vec::drain`) still runs once per `push()` call rather than once
///    per line — but with no cap, a provider that never emits `\n`
///    would grow that buffer without bound. See [`MAX_LINE_BYTES`].
#[derive(Debug, Default)]
pub struct NdjsonFramer {
    buf: Vec<u8>,
    /// Index into `buf` (always relative to `buf`'s CURRENT,
    /// post-compaction contents) from which the next `\n` search
    /// should start. Persists across `push()` calls — see the type
    /// doc's fix #1.
    scan_from: usize,
    /// Test-only instrumented byte-scan counter, incremented by
    /// exactly the number of bytes each `\n` search actually looks at.
    /// Exists so a test can assert linear (not quadratic) total scan
    /// work with a precise counter rather than a flaky wall-clock
    /// bound.
    #[cfg(test)]
    scan_bytes: u64,
}

impl NdjsonFramer {
    /// Creates an empty framer.
    pub fn new() -> Self {
        Self::default()
    }

    /// Feeds newly-read bytes in and returns every complete line found
    /// (UTF-8-lossily decoded, trimmed, empty lines dropped). Any
    /// trailing partial line is retained internally for the next call.
    ///
    /// # Errors
    ///
    /// Returns [`AppError::LineTooLong`] if the buffered, unterminated
    /// line grows past [`MAX_LINE_BYTES`]. The framer's buffer is
    /// cleared as part of returning this error (not left in a stuck
    /// state) — subsequent `push()` calls parse normally, but per the
    /// "never silently truncate JSON" rule the caller MUST treat this
    /// as a session-level failure, not resume as if the dropped line
    /// never happened.
    pub fn push(&mut self, bytes: &[u8]) -> Result<Vec<String>, AppError> {
        self.buf.extend_from_slice(bytes);

        let mut lines = Vec::new();
        let mut start = 0usize;
        loop {
            let search_from = self.scan_from.max(start);
            let haystack = &self.buf[search_from..];
            let found = haystack.iter().position(|&b| b == b'\n');
            #[cfg(test)]
            {
                self.scan_bytes += match found {
                    Some(rel) => (rel + 1) as u64,
                    None => haystack.len() as u64,
                };
            }
            let Some(rel_pos) = found else {
                self.scan_from = self.buf.len();
                break;
            };
            let pos = search_from + rel_pos;
            let line = String::from_utf8_lossy(&self.buf[start..pos])
                .trim()
                .to_owned();
            if !line.is_empty() {
                lines.push(line);
            }
            start = pos + 1;
            self.scan_from = start;
        }

        if start > 0 {
            self.buf.drain(0..start);
            self.scan_from -= start;
        }

        if self.buf.len() > MAX_LINE_BYTES {
            let overrun = self.buf.len();
            self.buf.clear();
            self.scan_from = 0;
            return Err(AppError::LineTooLong {
                bytes: overrun,
                max: MAX_LINE_BYTES,
            });
        }

        Ok(lines)
    }

    /// Number of bytes currently buffered as an incomplete trailing
    /// line — exposed for tests (giant-line handling) rather than any
    /// production caller.
    #[cfg(test)]
    fn buffered_len(&self) -> usize {
        self.buf.len()
    }

    /// Total bytes visited across every `\n` search this framer has
    /// ever performed — see the [`Self::scan_bytes`] field doc.
    #[cfg(test)]
    fn scan_bytes(&self) -> u64 {
        self.scan_bytes
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
    /// The child process handle (kill/wait) — prefer
    /// [`Self::kill_and_wait`] over reaching in here directly, unless a
    /// caller specifically needs the lower-level access.
    pub child: Child,
    /// PID of the spawned process, if available.
    pub pid: Option<u32>,
    /// Complete NDJSON lines framed from the child's stdout. Bounded
    /// (capacity 4096) — same backpressure shape as `spawn_pty`'s
    /// `worker_output` bridge: a slow consumer backs up this channel
    /// rather than lines being silently dropped.
    pub lines: mpsc::Receiver<String>,
    /// Resolves the NDJSON framer's [`AppError::LineTooLong`] if the
    /// child ever emits an unterminated line past [`MAX_LINE_BYTES`].
    /// The framer itself recovers (subsequent lines keep parsing — see
    /// [`NdjsonFramer::push`]'s doc), but per the "never silently
    /// truncate JSON" rule the caller MUST treat a value received here
    /// as a session-level failure.
    pub framer_errors: mpsc::UnboundedReceiver<AppError>,
    /// Last ~4KB of the child's stderr, updated live as bytes arrive —
    /// enough to recover a provider's fatal startup message (e.g. "not
    /// authenticated") for diagnostics without buffering the whole
    /// stream. Read with `.lock()`; the background drain thread (see
    /// [`spawn_piped`]'s doc) is the only other writer.
    pub stderr_tail: Arc<Mutex<VecDeque<u8>>>,
}

impl PipedHandle {
    /// Kills the child process and waits for it to exit, mirroring the
    /// PTY reap pattern in `worker::lifecycle::do_kill_worker`: drop
    /// the stdin writer first (closes the pipe, so the child sees EOF
    /// on read), kill, then wait — avoiding both a hung child blocked
    /// on stdin and a zombie process left behind.
    ///
    /// Consumes `self`: once a handle has been torn down there is
    /// nothing left to do with it (the `lines`/`framer_errors`
    /// channels stop yielding once the reader/forwarder tasks observe
    /// the closed stdout pipe, which follows shortly after the child
    /// dies — same as `spawn_pty`'s reader task, neither is explicitly
    /// joined here, only tied to the child's lifetime by construction).
    ///
    /// # Errors
    ///
    /// Returns `anyhow::Error` if waiting on the child fails (killing a
    /// process that already exited is not itself an error — logged at
    /// `warn` and otherwise ignored, since the end state — "the process
    /// is not running" — is identical either way).
    pub fn kill_and_wait(self) -> anyhow::Result<std::process::ExitStatus> {
        drop(self.stdin);
        let mut child = self.child;
        if let Err(e) = child.kill() {
            tracing::warn!(
                error = %e,
                "failed to kill piped child process (it may have already exited)"
            );
        }
        child
            .wait()
            .context("failed to wait on piped child process")
    }
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
/// stderr is drained on a separate background thread, purely to
/// prevent the child from blocking on a full OS pipe buffer if it
/// writes diagnostics there. That thread's lifetime is tied to the
/// child's: `read()` on the stderr pipe unblocks with EOF as soon as
/// the child exits (cleanly or via [`PipedHandle::kill_and_wait`]),
/// closing the write end from the OS side — there is no separate
/// signal needed to stop it, and no forever-parked thread once the
/// child is gone. Unlike the first cut, the last [`STDERR_TAIL_CAP`]
/// bytes are retained (not just counted) in [`PipedHandle::stderr_tail`]
/// so a provider's fatal startup message is actually recoverable for
/// diagnostics.
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
///
/// # Panics
///
/// Panics if called outside a running Tokio runtime. Like `spawn_pty`,
/// this function calls `tokio::spawn`/`tokio::task::spawn_blocking`
/// internally to bridge stdout/stderr reads onto the async world, and
/// both panic immediately if no runtime is active on the calling
/// thread — callers must invoke this from within `#[tokio::main]`/
/// `#[tokio::test]` (or any task already running on one).
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

    // stderr drain — prevents pipe-buffer deadlock, retains a bounded
    // tail for diagnostics. Tied to the child's lifetime: see the doc
    // above.
    let stderr_tail: Arc<Mutex<VecDeque<u8>>> = Arc::new(Mutex::new(VecDeque::new()));
    let stderr_tail_writer = stderr_tail.clone();
    tokio::task::spawn_blocking(move || {
        let mut reader = stderr;
        let mut buf = [0u8; 4096];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    tracing::debug!(bytes = n, "piped child stderr chunk");
                    let mut tail = stderr_tail_writer.lock();
                    tail.extend(&buf[..n]);
                    while tail.len() > STDERR_TAIL_CAP {
                        tail.pop_front();
                    }
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
    let (err_tx, err_rx) = mpsc::unbounded_channel::<AppError>();
    let forwarder_handle = tokio::spawn(async move {
        let mut framer = NdjsonFramer::new();
        while let Some(bytes) = raw_rx.recv().await {
            match framer.push(&bytes) {
                Ok(lines) => {
                    for line in lines {
                        if line_tx.send(line).await.is_err() {
                            return;
                        }
                    }
                }
                Err(e) => {
                    tracing::error!(error = %e, "NDJSON framer error — session-level failure");
                    // Non-blocking by construction (unbounded); if
                    // nobody is listening on framer_errors this is
                    // dropped, not a stall. The framer's own buffer was
                    // already cleared by push() — subsequent lines
                    // keep parsing.
                    let _ = err_tx.send(e);
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
        framer_errors: err_rx,
        stderr_tail,
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
        let first = framer.push(b"{\"type\":\"sys").unwrap();
        assert!(first.is_empty(), "no complete line yet");
        let second = framer.push(b"tem_init\"}\n").unwrap();
        assert_eq!(second, vec![r#"{"type":"system_init"}"#.to_string()]);
        assert_eq!(framer.buffered_len(), 0);
    }

    #[test]
    fn test_framer_handles_multiple_complete_lines_in_one_push() {
        let mut framer = NdjsonFramer::new();
        let lines = framer.push(b"{\"a\":1}\n{\"a\":2}\n{\"a\":3}\n").unwrap();
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
        let lines = framer.push(b"\n\n{\"a\":1}\n\n").unwrap();
        assert_eq!(lines, vec![r#"{"a":1}"#.to_string()]);
    }

    #[test]
    fn test_framer_trims_trailing_carriage_return() {
        // Defensive: even though pipes (unlike a PTY) should never
        // inject \r, a provider on Windows writing text-mode output
        // could still emit \r\n line endings.
        let mut framer = NdjsonFramer::new();
        let lines = framer.push(b"{\"a\":1}\r\n").unwrap();
        assert_eq!(lines, vec![r#"{"a":1}"#.to_string()]);
    }

    #[test]
    fn test_framer_handles_a_giant_line_across_many_pushes() {
        let mut framer = NdjsonFramer::new();
        let big_value = "x".repeat(200_000);
        let chunk1 = format!("{{\"big\":\"{}", &big_value[..100_000]);
        let chunk2 = format!("{}\"}}\n", &big_value[100_000..]);

        assert!(framer.push(chunk1.as_bytes()).unwrap().is_empty());
        assert_eq!(framer.buffered_len(), chunk1.len());

        let lines = framer.push(chunk2.as_bytes()).unwrap();
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
        let lines = framer.push(b"{\"incomplete\":true}").unwrap();
        assert!(lines.is_empty());
        assert!(framer.buffered_len() > 0);
    }

    // ── FIX-1: linear scan, not quadratic ────────────────────────────

    /// DIRECTIVE (review FIX-1): a large line fed in MANY small chunks
    /// must cost the framer O(total bytes) of `\n`-scanning work, not
    /// O(total bytes²). Reproduces the reviewer's exact scenario
    /// (`spawn_piped`'s 4096-byte read chunks) at a reduced but still
    /// sharply distinguishing size — a 2MB line in 4096-byte chunks is
    /// ~488 pushes; the pre-fix framer (rescanning from byte 0 every
    /// push) would scan on the order of 4096 * (488 * 489 / 2) ≈ 489M
    /// bytes for this input, versus this test's generous linear bound
    /// of `total_bytes * 4`. This is what the reviewer's own repro
    /// measured (13.4B byte-scans for a 10MB line at this chunk size)
    /// scaled down for a fast, non-flaky, exact-counter assertion
    /// instead of a wall-clock bound.
    #[test]
    fn test_framer_scans_a_giant_line_fed_in_many_small_chunks_linearly() {
        const CHUNK: usize = 4096;
        const LINE_BODY: usize = 2 * 1024 * 1024; // 2MB, well under MAX_LINE_BYTES

        let mut framer = NdjsonFramer::new();
        let body = "y".repeat(LINE_BODY);
        let line = format!("{{\"big\":\"{body}\"}}\n");
        let bytes = line.as_bytes();

        let mut total_fed = 0usize;
        for chunk in bytes.chunks(CHUNK) {
            let lines = framer.push(chunk).unwrap();
            total_fed += chunk.len();
            // Only the very last chunk (carrying the trailing `\n`)
            // should ever complete a line.
            if total_fed < bytes.len() {
                assert!(lines.is_empty());
            }
        }

        let scanned = framer.scan_bytes();
        assert!(
            scanned <= (total_fed as u64) * 4,
            "expected roughly linear scan work (~{total_fed} bytes), got {scanned} — \
             the O(n\u{b2}) rescan-from-zero regression is back"
        );
    }

    // ── FIX-2: a line cap ─────────────────────────────────────────────

    /// DIRECTIVE (review FIX-2): an unterminated line past
    /// `MAX_LINE_BYTES` errors instead of growing the buffer forever —
    /// the "never silently truncate JSON" rule means this must be a
    /// loud, typed failure, not a quiet drop.
    #[test]
    fn test_framer_errors_on_line_exceeding_max_line_bytes() {
        let mut framer = NdjsonFramer::new();
        let oversized = vec![b'z'; MAX_LINE_BYTES + 1];
        let result = framer.push(&oversized);
        assert!(matches!(
            result,
            Err(AppError::LineTooLong { max, .. }) if max == MAX_LINE_BYTES
        ));
    }

    /// DIRECTIVE (review FIX-2): after an overrun error, the framer's
    /// buffer was cleared as part of returning the error — subsequent
    /// pushes must parse normally, proving the framer recovers rather
    /// than staying permanently wedged (even though the CALLER is
    /// still expected to treat the error as a session-level failure —
    /// see `spawn_piped`'s `framer_errors` doc).
    #[test]
    fn test_framer_parses_normally_after_an_overrun_error() {
        let mut framer = NdjsonFramer::new();
        let oversized = vec![b'z'; MAX_LINE_BYTES + 1];
        assert!(framer.push(&oversized).is_err());
        assert_eq!(
            framer.buffered_len(),
            0,
            "buffer must be cleared on overrun"
        );

        let lines = framer.push(b"{\"a\":1}\n").unwrap();
        assert_eq!(lines, vec![r#"{"a":1}"#.to_string()]);
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

    /// A long-running platform-default command that does not exit on
    /// its own — for `kill_and_wait` tests that need a genuinely alive
    /// child to kill (an already-exited `cat`/`$input` proves nothing
    /// about zombie-reaping).
    fn platform_sleep() -> (&'static str, Vec<String>) {
        if cfg!(windows) {
            (
                "powershell.exe",
                vec![
                    "-NoProfile".to_string(),
                    "-NonInteractive".to_string(),
                    "-Command".to_string(),
                    "Start-Sleep -Seconds 60".to_string(),
                ],
            )
        } else {
            ("/bin/sh", vec!["-c".to_string(), "sleep 60".to_string()])
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

    // ── nit B: PipedHandle::kill_and_wait ────────────────────────────

    /// DIRECTIVE (review nit B): `kill_and_wait` actually reaps the
    /// child — a long-running process (not one that would exit on its
    /// own) is killed and waited on within a generous bound, proving no
    /// zombie is left behind even if Phase 3 forgets to call this
    /// explicitly on every teardown path.
    #[tokio::test]
    async fn test_kill_and_wait_reaps_a_long_running_child() {
        let (program, args) = platform_sleep();
        let handle = spawn_piped(program, &args, "", &std::collections::HashMap::new())
            .expect("spawn_piped should succeed against a platform-default shell");

        let result = tokio::time::timeout(
            std::time::Duration::from_secs(10),
            tokio::task::spawn_blocking(move || handle.kill_and_wait()),
        )
        .await
        .expect("kill_and_wait must not hang")
        .expect("spawn_blocking task must not panic");

        assert!(
            result.is_ok(),
            "kill_and_wait should successfully reap the child, got: {result:?}"
        );
    }

    // ── nit A: bounded stderr tail ────────────────────────────────────

    /// DIRECTIVE (review nit A): a provider's fatal stderr message is
    /// recoverable via `stderr_tail`, not just counted.
    #[tokio::test]
    async fn test_stderr_tail_retains_diagnostic_output() {
        const EXPECTED: &str = "fatal: not authenticated";
        let (program, args) = if cfg!(windows) {
            (
                "powershell.exe",
                vec![
                    "-NoProfile".to_string(),
                    "-NonInteractive".to_string(),
                    "-Command".to_string(),
                    format!("[Console]::Error.WriteLine('{EXPECTED}')"),
                ],
            )
        } else {
            (
                "/bin/sh",
                vec!["-c".to_string(), format!("echo '{EXPECTED}' 1>&2")],
            )
        };

        let handle = spawn_piped(program, &args, "", &std::collections::HashMap::new())
            .expect("spawn_piped should succeed against a platform-default shell");
        let stderr_tail = handle.stderr_tail.clone();
        // Partial move: takes ownership of `child` only. The rest of
        // `handle` (including `stdin`) drops at end of scope, which is
        // fine — this child reads no stdin.
        let mut child = handle.child;

        let _ = tokio::time::timeout(
            std::time::Duration::from_secs(10),
            tokio::task::spawn_blocking(move || child.wait()),
        )
        .await;

        // Poll briefly: the stderr-drain background thread races the
        // child's own exit reported above.
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(5);
        loop {
            let observed = {
                let tail = stderr_tail.lock();
                String::from_utf8_lossy(&tail.iter().copied().collect::<Vec<u8>>()).into_owned()
            };
            if observed.contains(EXPECTED) {
                return;
            }
            if tokio::time::Instant::now() > deadline {
                panic!(
                    "stderr_tail never observed the expected diagnostic \
                     message, got: {observed:?}"
                );
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
    }
}
