//! Piped-stdio children for JSON-protocol provider CLIs.
//!
//! The agent adapters run Claude Code (`stream-json`) and Codex
//! (`app-server` JSON-RPC) through [`spawn_piped`]: stdin, stdout and
//! stderr are plain pipes, and stdout is framed into newline-delimited
//! JSON lines ([`NdjsonFramer`]).
//!
//! # Why not a PTY
//!
//! A terminal's line discipline echoes input back onto the stream the
//! structured output is read from, turns `\n` into `\r\n` (sometimes a
//! bare `\r`), and invites ANSI escape sequences from any program that
//! thinks it is talking to a terminal. Each of these corrupts NDJSON,
//! which assumes exactly one JSON value per `\n`-terminated line and
//! nothing else on the wire. Interactive shells stay on
//! [`super::pty::spawn_pty`], whose output is meant to be raw terminal
//! bytes; newline-delimited JSON over stdio always comes through here.

use std::collections::{HashMap, VecDeque};
use std::io::{self, Read, Write};
use std::process::{Child, ChildStderr, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::Arc;

use anyhow::Context;
use parking_lot::Mutex;
use tokio::sync::mpsc;

use crate::error::AppError;

/// Hard cap on a single NDJSON line's buffered size before its
/// terminating `\n` arrives.
///
/// Real provider protocol lines (tool inputs, block content) stay far
/// below it. A provider that never terminates a line (protocol desync,
/// a bug, or a non-NDJSON stream) fails loudly with
/// [`AppError::LineTooLong`] instead of growing the buffer without
/// bound.
pub const MAX_LINE_BYTES: usize = 10 * 1024 * 1024;

/// Bytes of stderr kept for diagnostics (see
/// [`PipedHandle::stderr_tail`]): enough for a provider's fatal startup
/// message without buffering the whole stream.
const STDERR_TAIL_CAP: usize = 4096;

/// Size of each blocking read from the child's stdout and stderr.
const READ_CHUNK: usize = 4096;

/// Capacity of the raw-bytes and framed-lines channels. A slow consumer
/// backs these up (and, through them, the child's stdout pipe) rather
/// than anything being dropped.
const CHANNEL_CAPACITY: usize = 4096;

/// Windows `CREATE_NO_WINDOW` process-creation flag: the child gets no
/// console window. Without it a console-subsystem child (`claude`,
/// `codex`, `node`) of the windowless release build of the desktop app
/// opens a visible console window of its own.
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Incremental NDJSON line framer.
///
/// Buffers a partial line across [`Self::push`] calls and returns every
/// complete (`\n`-terminated), non-empty, whitespace-trimmed line.
///
/// # Guarantees
///
/// - **Linear work.** Each byte is examined by the `\n` search at most
///   once over the framer's lifetime, however the stream is chunked: the
///   search resumes where the previous `push` stopped instead of
///   rescanning the retained partial line. The buffer is compacted once
///   per `push`, not once per line.
/// - **Bounded memory.** A partial line longer than [`MAX_LINE_BYTES`]
///   is an error (see [`Self::push`]), never an unbounded buffer.
/// - **No fragments after an overrun.** Once a line has overrun the
///   cap, the rest of that line is discarded up to and including its
///   `\n`; framing resumes with the next line, so the tail of an
///   oversized value is never reported as a line of its own.
#[derive(Debug, Default)]
pub struct NdjsonFramer {
    buf: Vec<u8>,
    /// Offset into `buf` (after compaction) where the next `\n` search
    /// starts.
    scan_from: usize,
    /// `true` while dropping the rest of a line that overran
    /// [`MAX_LINE_BYTES`].
    discarding: bool,
    /// Bytes examined by `\n` searches so far, so a test can assert the
    /// linear-work guarantee with an exact count instead of a timing.
    #[cfg(test)]
    scan_bytes: u64,
}

impl NdjsonFramer {
    /// Creates an empty framer.
    pub fn new() -> Self {
        Self::default()
    }

    /// Feeds newly read bytes in and returns every line they complete
    /// (UTF-8-lossily decoded, trimmed, empty lines dropped). A trailing
    /// partial line is kept for the next call.
    ///
    /// # Errors
    ///
    /// [`AppError::LineTooLong`] once the buffered, unterminated line
    /// grows past [`MAX_LINE_BYTES`]. That push's complete lines are
    /// dropped with it, the buffer is cleared, and the rest of the
    /// oversized line is skipped by later calls; framing then continues
    /// normally. The caller must still treat the error as a failure of
    /// the whole session: a protocol message was lost.
    pub fn push(&mut self, mut bytes: &[u8]) -> Result<Vec<String>, AppError> {
        if self.discarding {
            let Some(end) = bytes.iter().position(|&b| b == b'\n') else {
                return Ok(Vec::new());
            };
            self.discarding = false;
            bytes = &bytes[end + 1..];
        }
        self.buf.extend_from_slice(bytes);

        let mut lines = Vec::new();
        let mut start = 0;
        loop {
            let haystack = &self.buf[self.scan_from..];
            let found = haystack.iter().position(|&b| b == b'\n');
            #[cfg(test)]
            {
                self.scan_bytes += found.map_or(haystack.len(), |rel| rel + 1) as u64;
            }
            let Some(rel) = found else {
                self.scan_from = self.buf.len();
                break;
            };
            let end = self.scan_from + rel;
            let line = String::from_utf8_lossy(&self.buf[start..end]);
            let line = line.trim();
            if !line.is_empty() {
                lines.push(line.to_owned());
            }
            start = end + 1;
            self.scan_from = start;
        }

        self.buf.drain(..start);
        self.scan_from -= start;

        if self.buf.len() > MAX_LINE_BYTES {
            let bytes = self.buf.len();
            self.buf.clear();
            self.scan_from = 0;
            self.discarding = true;
            return Err(AppError::LineTooLong {
                bytes,
                max: MAX_LINE_BYTES,
            });
        }
        Ok(lines)
    }

    /// Bytes currently buffered as an incomplete trailing line.
    #[cfg(test)]
    fn buffered_len(&self) -> usize {
        self.buf.len()
    }

    /// Bytes examined by every `\n` search so far.
    #[cfg(test)]
    fn scan_bytes(&self) -> u64 {
        self.scan_bytes
    }
}

/// A child process spawned by [`spawn_piped`], with its stdin and its
/// framed stdout.
pub struct PipedHandle {
    /// The child's stdin, for protocol input (see [`write_to_piped`]).
    pub stdin: Box<dyn Write + Send>,
    /// The child process, for `kill`/`wait`; or use
    /// [`Self::kill_and_wait`].
    pub child: Child,
    /// OS process ID of the child.
    pub pid: Option<u32>,
    /// Complete NDJSON lines framed from the child's stdout, in order.
    /// Bounded: a slow consumer backs the stream up, nothing is dropped.
    /// Closes once stdout reaches end of stream (the child exited or
    /// closed it).
    pub lines: mpsc::Receiver<String>,
    /// Receives the framer's [`AppError::LineTooLong`] if the child ever
    /// writes an unterminated line past [`MAX_LINE_BYTES`]. Framing goes
    /// on afterwards, but a value here means a protocol message was lost:
    /// the caller must treat it as a failure of the whole session.
    pub framer_errors: mpsc::UnboundedReceiver<AppError>,
    /// The last [`STDERR_TAIL_CAP`] bytes of the child's stderr, updated
    /// as they arrive, for diagnostics such as a provider's fatal startup
    /// message. The `piped-err-<pid>` thread is the only writer.
    pub stderr_tail: Arc<Mutex<VecDeque<u8>>>,
}

impl PipedHandle {
    /// Closes the child's stdin, kills it and waits for it to exit, so
    /// no zombie is left behind.
    ///
    /// Only the child itself is signalled; processes it started are not.
    /// The reader threads and the framing task end on their own once the
    /// child's pipes close.
    ///
    /// # Errors
    ///
    /// Fails if waiting on the child fails. A kill that fails because the
    /// child already exited is only logged: the end state is the same.
    pub fn kill_and_wait(self) -> anyhow::Result<std::process::ExitStatus> {
        drop(self.stdin);
        let mut child = self.child;
        if let Err(e) = child.kill() {
            tracing::warn!(error = %e, "failed to kill piped child process (it may have already exited)");
        }
        child
            .wait()
            .context("failed to wait on piped child process")
    }
}

/// Spawns `program` with piped stdio and frames its stdout as NDJSON.
///
/// ```text
/// ┌──────────┐ blocking read ┌───────────────────┐ mpsc(Vec<u8>) ┌──────────────┐ mpsc(String) ┌────────┐
/// │  child   │──────────────▶│ piped-out-<pid>   │──────────────▶│ framing task │─────────────▶│ caller │
/// │ (stdout) │  4 KiB chunks │ thread            │               │ NdjsonFramer │   `lines`    │        │
/// └──────────┘               └───────────────────┘               └──────────────┘              └────────┘
/// ```
///
/// stderr is drained by a `piped-err-<pid>` thread, so a child writing
/// diagnostics can never block on a full pipe, and its last bytes are
/// kept in [`PipedHandle::stderr_tail`]. Both reader threads are plain
/// named threads, not the runtime's blocking pool (they live as long as
/// the child), and both end at end of stream, which the OS reports as
/// soon as the child exits.
///
/// `args` is an argument vector, never a shell string. The child
/// inherits the process environment plus `env`, and starts in `cwd`
/// (the current directory when empty). On Windows it gets no console
/// window.
///
/// Only the program, the working directory and the argument and
/// environment counts are recorded in the tracing span: arguments and
/// environment values can carry credentials.
///
/// # Errors
///
/// Fails if the child cannot be spawned, its stdio cannot be captured,
/// or a reader thread cannot be created (the child is then killed and
/// reaped first).
///
/// # Panics
///
/// Panics outside a Tokio runtime: the framing task is spawned on the
/// current one.
#[tracing::instrument(
    skip_all,
    fields(%program, %cwd, arg_count = args.len(), env_key_count = env.len())
)]
pub fn spawn_piped(
    program: &str,
    args: &[String],
    cwd: &str,
    env: &HashMap<String, String>,
) -> anyhow::Result<PipedHandle> {
    let mut cmd = Command::new(program);
    cmd.args(args)
        .envs(env)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if !cwd.is_empty() {
        cmd.current_dir(cwd);
    }
    #[cfg(windows)]
    std::os::windows::process::CommandExt::creation_flags(&mut cmd, CREATE_NO_WINDOW);

    let mut child = cmd.spawn().context("failed to spawn piped child process")?;
    let pid = child.id();

    let Readers {
        stdin,
        raw,
        stderr_tail,
    } = match start_readers(&mut child, pid) {
        Ok(readers) => readers,
        Err(e) => {
            let _ = child.kill();
            let _ = child.wait();
            return Err(e);
        }
    };

    let (lines, framer_errors) = frame_lines(raw);
    Ok(PipedHandle {
        stdin: Box::new(stdin),
        child,
        pid: Some(pid),
        lines,
        framer_errors,
        stderr_tail,
    })
}

/// A child's stdin plus what its running reader threads feed.
struct Readers {
    stdin: ChildStdin,
    /// Raw stdout bytes from the `piped-out-<pid>` thread.
    raw: mpsc::Receiver<Vec<u8>>,
    /// Kept up to date by the `piped-err-<pid>` thread.
    stderr_tail: Arc<Mutex<VecDeque<u8>>>,
}

/// Takes the child's stdio and starts both reader threads.
fn start_readers(child: &mut Child, pid: u32) -> anyhow::Result<Readers> {
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
    let stderr_tail = Arc::new(Mutex::new(VecDeque::with_capacity(STDERR_TAIL_CAP)));
    drain_stderr(pid, stderr, Arc::clone(&stderr_tail))
        .context("failed to start the stderr reader thread")?;
    let raw = read_stdout(pid, stdout).context("failed to start the stdout reader thread")?;
    Ok(Readers {
        stdin,
        raw,
        stderr_tail,
    })
}

/// Starts the `piped-err-<pid>` thread: reads stderr to its end, keeping
/// the last [`STDERR_TAIL_CAP`] bytes in `tail`.
fn drain_stderr(
    pid: u32,
    mut stderr: ChildStderr,
    tail: Arc<Mutex<VecDeque<u8>>>,
) -> io::Result<()> {
    std::thread::Builder::new()
        .name(format!("piped-err-{pid}"))
        .spawn(move || {
            let mut buf = [0u8; READ_CHUNK];
            loop {
                match stderr.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        tracing::debug!(pid, bytes = n, "piped child stderr chunk");
                        let mut tail = tail.lock();
                        tail.extend(&buf[..n]);
                        let excess = tail.len().saturating_sub(STDERR_TAIL_CAP);
                        tail.drain(..excess);
                    }
                    Err(e) if e.kind() == io::ErrorKind::Interrupted => {}
                    Err(e) => {
                        tracing::debug!(pid, error = %e, "piped child stderr read failed");
                        break;
                    }
                }
            }
        })
        .map(drop)
}

/// Starts the `piped-out-<pid>` thread: forwards stdout's raw bytes to
/// the returned channel until end of stream or until the receiver is
/// gone.
fn read_stdout(pid: u32, mut stdout: ChildStdout) -> io::Result<mpsc::Receiver<Vec<u8>>> {
    let (tx, rx) = mpsc::channel(CHANNEL_CAPACITY);
    std::thread::Builder::new()
        .name(format!("piped-out-{pid}"))
        .spawn(move || {
            let mut buf = [0u8; READ_CHUNK];
            loop {
                match stdout.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        if tx.blocking_send(buf[..n].to_vec()).is_err() {
                            break;
                        }
                    }
                    Err(e) if e.kind() == io::ErrorKind::Interrupted => {}
                    Err(e) => {
                        tracing::error!(pid, error = %e, "piped child stdout read failed");
                        break;
                    }
                }
            }
        })?;
    Ok(rx)
}

/// Spawns the task that frames `raw` stdout bytes into NDJSON lines,
/// returning the lines and the framer's errors (see [`PipedHandle`]).
fn frame_lines(
    mut raw: mpsc::Receiver<Vec<u8>>,
) -> (mpsc::Receiver<String>, mpsc::UnboundedReceiver<AppError>) {
    let (line_tx, line_rx) = mpsc::channel(CHANNEL_CAPACITY);
    let (err_tx, err_rx) = mpsc::unbounded_channel();
    tokio::spawn(async move {
        let mut framer = NdjsonFramer::new();
        while let Some(bytes) = raw.recv().await {
            match framer.push(&bytes) {
                Ok(lines) => {
                    for line in lines {
                        if line_tx.send(line).await.is_err() {
                            return;
                        }
                    }
                }
                Err(e) => {
                    tracing::error!(error = %e, "NDJSON framer error; the session has lost a message");
                    // Unbounded, so never a stall; dropped if nobody
                    // listens.
                    let _ = err_tx.send(e);
                }
            }
        }
    });
    (line_rx, err_rx)
}

/// Writes `data` to a piped child's stdin and flushes it.
///
/// Blocks while the pipe is full (the child is not reading); call it off
/// the async runtime's worker threads.
///
/// # Errors
///
/// Fails if the write or the flush fails, for example once the child
/// has exited.
pub fn write_to_piped(writer: &mut dyn Write, data: &[u8]) -> anyhow::Result<()> {
    writer
        .write_all(data)
        .context("failed to write to piped child stdin")?;
    writer.flush().context("failed to flush piped stdin writer")
}

#[cfg(test)]
mod tests {
    use std::assert_matches;
    use std::time::Duration;

    use super::*;

    // ── NdjsonFramer ──────────────────────────────────────────────────

    #[test]
    fn test_framer_handles_line_split_across_two_pushes() {
        let mut framer = NdjsonFramer::new();
        let first = framer.push(b"{\"type\":\"sys").unwrap();
        assert!(first.is_empty(), "no complete line yet");
        let second = framer.push(b"tem_init\"}\n").unwrap();
        assert_eq!(second, [r#"{"type":"system_init"}"#]);
        assert_eq!(framer.buffered_len(), 0);
    }

    #[test]
    fn test_framer_handles_multiple_complete_lines_in_one_push() {
        let mut framer = NdjsonFramer::new();
        let lines = framer.push(b"{\"a\":1}\n{\"a\":2}\n{\"a\":3}\n").unwrap();
        assert_eq!(lines, [r#"{"a":1}"#, r#"{"a":2}"#, r#"{"a":3}"#]);
    }

    #[test]
    fn test_framer_skips_empty_lines() {
        let mut framer = NdjsonFramer::new();
        let lines = framer.push(b"\n\n{\"a\":1}\n\n").unwrap();
        assert_eq!(lines, [r#"{"a":1}"#]);
    }

    /// A provider writing text-mode output on Windows can end lines with
    /// `\r\n`; the `\r` is trimmed.
    #[test]
    fn test_framer_trims_trailing_carriage_return() {
        let mut framer = NdjsonFramer::new();
        let lines = framer.push(b"{\"a\":1}\r\n").unwrap();
        assert_eq!(lines, [r#"{"a":1}"#]);
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
        assert_eq!(lines, [format!("{{\"big\":\"{big_value}\"}}")]);
        assert_eq!(framer.buffered_len(), 0, "buffer fully compacted");
    }

    #[test]
    fn test_framer_no_trailing_newline_keeps_partial_line_buffered() {
        let mut framer = NdjsonFramer::new();
        let lines = framer.push(b"{\"incomplete\":true}").unwrap();
        assert!(lines.is_empty());
        assert!(framer.buffered_len() > 0);
    }

    /// A 2 MiB line fed in `spawn_piped`'s 4 KiB read chunks (512
    /// pushes) costs linear `\n`-search work. A framer that rescanned the
    /// retained partial line on every push would examine about
    /// 4096 × 512² / 2 ≈ 537M bytes here, far past the bound of four
    /// times the input.
    #[test]
    fn test_framer_scans_a_giant_line_fed_in_many_small_chunks_linearly() {
        let mut framer = NdjsonFramer::new();
        let line = format!("{{\"big\":\"{}\"}}\n", "y".repeat(2 * 1024 * 1024));
        let bytes = line.as_bytes();

        let mut fed = 0;
        for chunk in bytes.chunks(READ_CHUNK) {
            let lines = framer.push(chunk).unwrap();
            fed += chunk.len();
            // Only the last chunk, carrying the `\n`, completes a line.
            assert_eq!(lines.len(), usize::from(fed == bytes.len()));
        }

        let scanned = framer.scan_bytes();
        assert!(
            scanned <= fed as u64 * 4,
            "expected about {fed} bytes of scanning, got {scanned}"
        );
    }

    /// An unterminated line past `MAX_LINE_BYTES` is a typed error, not
    /// an ever-growing buffer.
    #[test]
    fn test_framer_errors_on_line_exceeding_max_line_bytes() {
        let mut framer = NdjsonFramer::new();
        let result = framer.push(&vec![b'z'; MAX_LINE_BYTES + 1]);
        assert_matches!(
            result,
            Err(AppError::LineTooLong { bytes, max: MAX_LINE_BYTES }) if bytes == MAX_LINE_BYTES + 1
        );
        assert_eq!(framer.buffered_len(), 0, "buffer cleared on overrun");
    }

    /// The rest of an oversized line, still streaming in after the
    /// overrun, is dropped up to and including its `\n`, so no JSON
    /// fragment is ever framed as a line; framing resumes with the next
    /// line.
    #[test]
    fn test_framer_discards_the_rest_of_an_overrun_line() {
        let mut framer = NdjsonFramer::new();
        assert!(framer.push(&vec![b'z'; MAX_LINE_BYTES + 1]).is_err());

        assert!(framer.push(b"zzzz still the same line").unwrap().is_empty());
        assert!(framer.push(b"zz\"}").unwrap().is_empty());
        assert_eq!(
            framer.push(b"\n{\"a\":1}\n{\"b\"").unwrap(),
            [r#"{"a":1}"#],
            "the oversized line's tail is dropped, the next line is kept"
        );
        assert_eq!(framer.push(b":2}\n").unwrap(), [r#"{"b":2}"#]);
    }

    /// An overrun whose `\n` arrives in the very next byte: nothing is
    /// emitted for it and the following line frames normally.
    #[test]
    fn test_framer_resumes_right_after_an_overrun_lines_newline() {
        let mut framer = NdjsonFramer::new();
        assert!(framer.push(&vec![b'z'; MAX_LINE_BYTES + 1]).is_err());
        assert_eq!(framer.push(b"\n{\"a\":1}\n").unwrap(), [r#"{"a":1}"#]);
    }

    // ── spawn_piped ───────────────────────────────────────────────────

    /// A command that copies its stdin to its stdout, byte for byte.
    fn platform_echo() -> (&'static str, Vec<String>) {
        if cfg!(windows) {
            (
                "powershell.exe",
                ["-NoProfile", "-NonInteractive", "-Command", "$input"]
                    .map(String::from)
                    .into(),
            )
        } else {
            ("/bin/sh", ["-c", "cat"].map(String::from).into())
        }
    }

    /// A command that runs for a minute unless killed.
    fn platform_sleep() -> (&'static str, Vec<String>) {
        if cfg!(windows) {
            (
                "powershell.exe",
                [
                    "-NoProfile",
                    "-NonInteractive",
                    "-Command",
                    "Start-Sleep -Seconds 60",
                ]
                .map(String::from)
                .into(),
            )
        } else {
            ("/bin/sh", ["-c", "sleep 60"].map(String::from).into())
        }
    }

    /// A command that writes `bytes` `x`s and then `END` to stderr.
    fn platform_stderr_flood(bytes: usize) -> (&'static str, Vec<String>) {
        if cfg!(windows) {
            (
                "powershell.exe",
                vec![
                    "-NoProfile".to_owned(),
                    "-NonInteractive".to_owned(),
                    "-Command".to_owned(),
                    format!("[Console]::Error.Write('x' * {bytes} + 'END')"),
                ],
            )
        } else {
            (
                "/bin/sh",
                vec![
                    "-c".to_owned(),
                    format!("head -c {bytes} /dev/zero | tr '\\0' x 1>&2; printf END 1>&2"),
                ],
            )
        }
    }

    /// Polls `tail` until `done` accepts its contents, or panics after
    /// ten seconds. The stderr thread races the child's exit.
    async fn wait_for_tail(tail: &Arc<Mutex<VecDeque<u8>>>, done: impl Fn(&[u8]) -> bool) {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
        loop {
            let observed: Vec<u8> = tail.lock().iter().copied().collect();
            if done(&observed) {
                return;
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "stderr_tail never reached the expected state, got: {:?}",
                String::from_utf8_lossy(&observed)
            );
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }

    /// Lines written to a real child's stdin come back, framed, on
    /// `lines`.
    #[tokio::test]
    async fn test_spawn_piped_round_trips_ndjson_lines_with_a_real_child() {
        let (program, args) = platform_echo();
        let mut handle = spawn_piped(program, &args, "", &HashMap::new()).expect("spawns");

        write_to_piped(
            handle.stdin.as_mut(),
            b"{\"type\":\"one\"}\n{\"type\":\"two\"}\n",
        )
        .expect("write to child stdin should succeed");
        // EOF on stdin lets the echo command finish.
        drop(handle.stdin);

        let mut received = Vec::new();
        while received.len() < 2 {
            match tokio::time::timeout(Duration::from_secs(10), handle.lines.recv()).await {
                Ok(Some(line)) => received.push(line),
                Ok(None) => break,
                Err(_) => panic!("timed out waiting for echoed NDJSON lines, got: {received:?}"),
            }
        }
        assert_eq!(received, [r#"{"type":"one"}"#, r#"{"type":"two"}"#]);

        let _ = tokio::task::spawn_blocking(move || handle.child.wait()).await;
    }

    /// A program that does not exist is a spawn error, not a panic or a
    /// half-built handle.
    #[tokio::test]
    async fn test_spawn_piped_reports_a_missing_program() {
        let result = spawn_piped("swarm-no-such-program", &[], "", &HashMap::new());
        let err = result.err().expect("spawning a missing program fails");
        assert!(format!("{err:#}").contains("failed to spawn"), "{err:#}");
    }

    /// `kill_and_wait` kills and reaps a child that would otherwise run
    /// for a minute.
    #[tokio::test]
    async fn test_kill_and_wait_reaps_a_long_running_child() {
        let (program, args) = platform_sleep();
        let handle = spawn_piped(program, &args, "", &HashMap::new()).expect("spawns");

        let result = tokio::time::timeout(
            Duration::from_secs(10),
            tokio::task::spawn_blocking(move || handle.kill_and_wait()),
        )
        .await
        .expect("kill_and_wait must not hang")
        .expect("spawn_blocking task must not panic");

        let status = result.expect("kill_and_wait reaps the child");
        assert!(!status.success(), "a killed child does not exit cleanly");
    }

    /// A provider's fatal stderr message can be read from `stderr_tail`.
    #[tokio::test]
    async fn test_stderr_tail_retains_diagnostic_output() {
        const EXPECTED: &str = "fatal: not authenticated";
        let (program, args) = if cfg!(windows) {
            (
                "powershell.exe",
                vec![
                    "-NoProfile".to_owned(),
                    "-NonInteractive".to_owned(),
                    "-Command".to_owned(),
                    format!("[Console]::Error.WriteLine('{EXPECTED}')"),
                ],
            )
        } else {
            (
                "/bin/sh",
                vec!["-c".to_owned(), format!("echo '{EXPECTED}' 1>&2")],
            )
        };

        let handle = spawn_piped(program, &args, "", &HashMap::new()).expect("spawns");
        let mut child = handle.child;
        let _ = tokio::task::spawn_blocking(move || child.wait()).await;

        wait_for_tail(&handle.stderr_tail, |tail| {
            String::from_utf8_lossy(tail).contains(EXPECTED)
        })
        .await;
    }

    /// Past its cap the tail keeps exactly the most recent
    /// `STDERR_TAIL_CAP` bytes.
    #[tokio::test]
    async fn test_stderr_tail_keeps_only_the_last_bytes() {
        let (program, args) = platform_stderr_flood(3 * STDERR_TAIL_CAP);
        let handle = spawn_piped(program, &args, "", &HashMap::new()).expect("spawns");
        let mut child = handle.child;
        let _ = tokio::task::spawn_blocking(move || child.wait()).await;

        wait_for_tail(&handle.stderr_tail, |tail| tail.ends_with(b"END")).await;
        let tail = handle.stderr_tail.lock();
        assert_eq!(tail.len(), STDERR_TAIL_CAP);
        assert!(tail.iter().rev().skip(3).all(|&b| b == b'x'));
    }
}
