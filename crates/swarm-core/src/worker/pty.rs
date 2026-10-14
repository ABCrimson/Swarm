//! Running a worker's shell on a pseudo-terminal.
//!
//! `portable-pty` supplies the platform PTY (ConPTY on Windows, a Unix
//! pty elsewhere). [`spawn_pty`] opens a pair, starts the shell on the
//! slave side and returns every handle the worker keeps ([`PtySpawn`]).
//! Two named threads per worker then do the ongoing work, both created
//! parked ([`Parked`]) so the caller can register the worker and emit
//! `worker_spawned` before either of them acts:
//!
//! - [`spawn_output_pump`] (`pty-<id8>`) streams the master's output as
//!   ordered `worker_output` events.
//! - [`spawn_exit_watcher`] (`pty-exit-<id8>`) notices the shell exiting
//!   on its own.
//!
//! ```text
//! ┌──────────────┐ blocking read ┌──────────────────┐  emit  ┌───────────┐
//! │  PTY master  │──────────────▶│ pty-<id8> thread │───────▶│ EventSink │
//! │ (reader dup) │  8 KiB chunks │ UTF-8 carry-over │        │ (ordered) │
//! └──────────────┘               └──────────────────┘        └───────────┘
//! ```
//!
//! # Handle lifetimes
//!
//! - **Slave**: dropped as soon as the shell is spawned; the shell holds
//!   its own copy of the terminal.
//! - **Master**: kept for the worker's lifetime. It is the only handle
//!   that can resize the terminal, and on Windows it owns the
//!   pseudoconsole: dropping it calls `ClosePseudoConsole`, which tears
//!   the console down under the shell. The kill path releases it only
//!   after the shell has been reaped.
//! - **Reader**: moved into the output pump, which ends at end of
//!   stream: on Unix once every holder of the slave side is gone (the
//!   kernel reports `EIO`), on Windows once the pseudoconsole closes.
//!   On Windows the stream does not end when the shell exits (the
//!   pseudoconsole outlives it), which is why exits are detected by
//!   polling the process rather than by the end of its output.
//! - **Writer**: the shell's stdin; see [`write_to_pty`].
//!
//! # Windows: the cursor-position query
//!
//! `portable-pty` creates the pseudoconsole with
//! `PSEUDOCONSOLE_INHERIT_CURSOR`, so its first output is a
//! cursor-position query (`ESC [ 6 n`) and it renders nothing else until
//! the terminal answers with a cursor-position report. xterm.js answers
//! it once the worker's terminal is attached; a headless consumer has to
//! write a report such as `ESC [ 1 ; 1 R` itself.

use std::collections::HashMap;
use std::io::{self, Read, Write};
use std::sync::Weak;
use std::sync::mpsc::{SyncSender, sync_channel};
use std::thread::Thread;
use std::time::Duration;

use anyhow::Context;
use parking_lot::Mutex;
use portable_pty::{Child, CommandBuilder, ExitStatus, MasterPty, PtySize, native_pty_system};
use uuid::Uuid;

use super::short_id8;
use crate::events::{EventSink, SwarmEvent, WorkerOutputPayload};

/// Size of each blocking read from the PTY master.
const READ_CHUNK: usize = 8 * 1024;

/// How often the exit watcher polls the shell between wake-ups.
const EXIT_POLL: Duration = Duration::from_millis(250);

/// Every handle a freshly spawned PTY worker owns.
pub struct PtySpawn {
    /// Master side of the PTY: resize, and (Windows) the pseudoconsole
    /// itself. Must outlive the shell; see the module doc.
    pub master: Box<dyn MasterPty + Send>,
    /// The shell's stdin.
    pub writer: Box<dyn Write + Send>,
    /// The shell's output, for [`spawn_output_pump`].
    pub reader: Box<dyn Read + Send>,
    /// The shell process.
    pub child: Box<dyn Child + Send + Sync>,
    /// OS process ID of the shell, if the OS reported one.
    pub pid: Option<u32>,
}

/// Opens a PTY of `size` and starts `shell` on it.
///
/// `shell` is a program path or a name resolved on `PATH`, with no
/// arguments; `None` selects the platform default:
///
/// | Platform | Default shell |
/// |----------|---------------|
/// | Unix     | the user's shell (`$SHELL`, else the passwd entry, else `/bin/sh`), started as a login shell |
/// | Windows  | `pwsh.exe` (PowerShell 7+) when it is on `PATH`, else `powershell.exe` |
///
/// The shell inherits the process environment plus `env`, and starts in
/// `cwd` (the user's home directory when `cwd` is empty or not a
/// directory). `TERM=xterm-256color` (Unix) and `COLORTERM=truecolor`
/// describe the xterm.js frontend unless `env` overrides them: a desktop
/// app launched from a GUI has no `TERM` of its own, and full-screen
/// programs refuse to run without one.
///
/// # Errors
///
/// Fails if the PTY cannot be opened, the shell cannot be spawned (for
/// example a `shell` that does not exist), or the master's reader or
/// writer cannot be obtained. The error chain keeps `portable-pty`'s
/// underlying OS error.
//
// `skip_all`: `env` carries per-profile API keys, and every captured
// span field is printed by the fmt/json subscribers alongside any event
// raised inside the span (including `portable-pty`'s own `log` records
// when a spawn fails). Only the key count is recorded.
#[tracing::instrument(
    skip_all,
    fields(
        %worker_id,
        shell = shell.unwrap_or("<platform default>"),
        cwd = %cwd,
        rows = size.rows,
        cols = size.cols,
        env_key_count = env.len(),
    )
)]
pub fn spawn_pty(
    worker_id: Uuid,
    shell: Option<&str>,
    cwd: &str,
    env: &HashMap<String, String>,
    size: PtySize,
) -> anyhow::Result<PtySpawn> {
    let pair = native_pty_system()
        .openpty(size)
        .context("failed to open a PTY pair")?;

    let mut cmd = shell.map_or_else(default_shell_command, CommandBuilder::new);
    if !cwd.is_empty() {
        cmd.cwd(cwd);
    }
    #[cfg(unix)]
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    for (key, value) in env {
        cmd.env(key, value);
    }

    let child = pair
        .slave
        .spawn_command(cmd)
        .context("failed to spawn the shell on the PTY")?;
    // The shell holds its own handle to the terminal; ours is not needed.
    drop(pair.slave);

    let pid = child.process_id();
    let writer = pair
        .master
        .take_writer()
        .context("failed to take the PTY master writer")?;
    let reader = pair
        .master
        .try_clone_reader()
        .context("failed to clone the PTY master reader")?;

    Ok(PtySpawn {
        master: pair.master,
        writer,
        reader,
        child,
        pid,
    })
}

/// The platform default shell; see [`spawn_pty`]'s table.
#[cfg(unix)]
fn default_shell_command() -> CommandBuilder {
    CommandBuilder::new_default_prog()
}

/// The platform default shell; see [`spawn_pty`]'s table.
#[cfg(windows)]
fn default_shell_command() -> CommandBuilder {
    let on_path = |exe: &str| {
        std::env::var_os("PATH")
            .is_some_and(|path| std::env::split_paths(&path).any(|dir| dir.join(exe).is_file()))
    };
    CommandBuilder::new(if on_path("pwsh.exe") {
        "pwsh.exe"
    } else {
        "powershell.exe"
    })
}

/// A named thread held at its start line.
///
/// Its body runs only after [`Self::start`]; dropping the `Parked`
/// instead ends the thread without running the body.
#[must_use = "a parked thread does nothing until it is started"]
pub struct Parked {
    go: SyncSender<()>,
    thread: Thread,
}

impl Parked {
    /// Lets the thread run its body.
    pub fn start(self) {
        // The thread is blocked on this channel until it receives this
        // message or sees the sender dropped, so the send cannot fail.
        let _ = self.go.send(());
    }

    /// The parked thread, for [`Thread::unpark`].
    pub fn thread(&self) -> &Thread {
        &self.thread
    }
}

/// Spawns a thread named `name` that runs `body` once released by
/// [`Parked::start`].
fn spawn_parked(name: String, body: impl FnOnce() + Send + 'static) -> io::Result<Parked> {
    let (go, parked) = sync_channel::<()>(1);
    let handle = std::thread::Builder::new().name(name).spawn(move || {
        if parked.recv().is_ok() {
            body();
        }
    })?;
    Ok(Parked {
        go,
        thread: handle.thread().clone(),
    })
}

/// Spawns the `pty-<id8>` thread that streams `reader` as
/// `worker_output` events, parked until [`Parked::start`].
///
/// The thread decodes the byte stream as UTF-8 across read boundaries:
/// a character split between two reads is emitted whole, and only
/// genuinely invalid bytes become U+FFFD. At end of stream it calls
/// `on_end`, which the lifecycle uses to wake the exit watcher.
///
/// # Errors
///
/// Fails only if the OS refuses to create the thread.
pub fn spawn_output_pump(
    sink: EventSink,
    worker_id: Uuid,
    mut reader: Box<dyn Read + Send>,
    on_end: impl FnOnce() + Send + 'static,
) -> io::Result<Parked> {
    spawn_parked(format!("pty-{}", short_id8(worker_id)), move || {
        let emit = |data: String| {
            sink.emit(SwarmEvent::WorkerOutput(WorkerOutputPayload {
                worker_id,
                data,
            }));
        };
        let mut decoder = Utf8Stream::default();
        let mut buf = [0u8; READ_CHUNK];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    let text = decoder.decode(&buf[..n]);
                    if !text.is_empty() {
                        emit(text);
                    }
                }
                Err(e) if e.kind() == io::ErrorKind::Interrupted => {}
                Err(e) if is_hangup(&e) => break,
                Err(e) => {
                    tracing::error!(%worker_id, error = %e, "PTY read failed");
                    break;
                }
            }
        }
        if let Some(rest) = decoder.finish() {
            emit(rest);
        }
        tracing::debug!(%worker_id, "PTY output ended");
        on_end();
    })
}

/// Spawns the `pty-exit-<id8>` thread that detects the shell exiting on
/// its own, parked until [`Parked::start`].
///
/// Once started, it checks the shell with the non-blocking `try_wait`
/// every [`EXIT_POLL`], and immediately whenever it is unparked (the
/// output pump unparks it at end of stream). When the shell has exited
/// it calls `on_exit` with the status and ends. It holds only a `Weak`
/// reference to the process: once the worker's handle is gone (the kill
/// path reaps the shell itself) it ends without calling `on_exit`.
///
/// # Errors
///
/// Fails only if the OS refuses to create the thread.
pub fn spawn_exit_watcher(
    worker_id: Uuid,
    process: Weak<Mutex<Box<dyn Child + Send + Sync>>>,
    on_exit: impl FnOnce(ExitStatus) + Send + 'static,
) -> io::Result<Parked> {
    spawn_parked(format!("pty-exit-{}", short_id8(worker_id)), move || {
        loop {
            let Some(process) = process.upgrade() else {
                return;
            };
            // Bind the result first: the guard must be released before
            // `on_exit` runs.
            let status = process.lock().try_wait();
            match status {
                Ok(Some(status)) => {
                    on_exit(status);
                    return;
                }
                Ok(None) => {}
                Err(e) => {
                    tracing::warn!(%worker_id, error = %e, "cannot poll the worker's shell; exit detection stopped");
                    return;
                }
            }
            drop(process);
            std::thread::park_timeout(EXIT_POLL);
        }
    })
}

/// `EIO`, the same value on every Unix this crate targets.
#[cfg(unix)]
const EIO: i32 = 5;

/// Whether a PTY read error is the ordinary end of the stream rather
/// than a failure: `EIO` once the slave side is gone (Unix), or a broken
/// pipe once the pseudoconsole closes (Windows).
fn is_hangup(e: &io::Error) -> bool {
    #[cfg(unix)]
    if e.raw_os_error() == Some(EIO) {
        return true;
    }
    e.kind() == io::ErrorKind::BrokenPipe
}

/// Incremental UTF-8 decoder for a byte stream delivered in arbitrary
/// chunks.
///
/// Holds back an incomplete trailing sequence (at most 3 bytes) until
/// the next chunk completes it; replaces each genuinely invalid
/// sequence with U+FFFD, as [`String::from_utf8_lossy`] does.
#[derive(Debug, Default)]
struct Utf8Stream {
    pending: Vec<u8>,
}

impl Utf8Stream {
    /// Appends `bytes` and returns all text that is now complete.
    fn decode(&mut self, bytes: &[u8]) -> String {
        self.pending.extend_from_slice(bytes);
        let mut text = String::with_capacity(self.pending.len());
        let mut keep_from = self.pending.len();
        let mut chunks = self.pending.utf8_chunks().peekable();
        while let Some(chunk) = chunks.next() {
            text.push_str(chunk.valid());
            let invalid = chunk.invalid();
            if invalid.is_empty() {
                continue;
            }
            // Only the stream's last bytes can be the start of a
            // character the next read completes.
            let incomplete_tail = chunks.peek().is_none()
                && std::str::from_utf8(invalid).is_err_and(|e| e.error_len().is_none());
            if incomplete_tail {
                keep_from = self.pending.len() - invalid.len();
            } else {
                text.push(char::REPLACEMENT_CHARACTER);
            }
        }
        self.pending.drain(..keep_from);
        text
    }

    /// Flushes a trailing incomplete sequence at end of stream (as
    /// U+FFFD); `None` when nothing is held back.
    fn finish(self) -> Option<String> {
        (!self.pending.is_empty()).then(|| String::from_utf8_lossy(&self.pending).into_owned())
    }
}

/// Writes `data` to a PTY writer and flushes it.
///
/// Blocks while the terminal's input queue is full, which happens when
/// the program in the foreground is not reading its stdin; never call it
/// while holding a lock other callers need (see
/// [`super::handle::WorkerHandle::pty_writer`]).
///
/// # Errors
///
/// Fails if the write or the flush fails, for example once the shell
/// has exited.
pub fn write_to_pty(writer: &mut dyn Write, data: &[u8]) -> anyhow::Result<()> {
    writer
        .write_all(data)
        .context("failed to write to the PTY")?;
    writer.flush().context("failed to flush the PTY writer")
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use super::*;

    const BOX_DRAWING: &str = "─│┌"; // 3 bytes each
    const EMOJI: &str = "🦀"; // 4 bytes

    #[test]
    fn test_utf8_stream_joins_a_character_split_across_reads() {
        for text in [BOX_DRAWING, EMOJI, "aé€🦀z"] {
            let bytes = text.as_bytes();
            for split in 1..bytes.len() {
                let mut stream = Utf8Stream::default();
                let mut out = stream.decode(&bytes[..split]);
                out.push_str(&stream.decode(&bytes[split..]));
                assert_eq!(out, text, "split at byte {split}");
                assert_eq!(stream.finish(), None);
            }
        }
    }

    #[test]
    fn test_utf8_stream_decodes_one_byte_at_a_time() {
        let text = "prompt ❯ ⠋ loading 🦀 done";
        let mut stream = Utf8Stream::default();
        let out: String = text
            .as_bytes()
            .iter()
            .map(|b| stream.decode(std::slice::from_ref(b)))
            .collect();
        assert_eq!(out, text);
    }

    #[test]
    fn test_utf8_stream_replaces_invalid_bytes_but_keeps_decoding() {
        let mut stream = Utf8Stream::default();
        assert_eq!(stream.decode(b"ok\xFFstill ok"), "ok\u{FFFD}still ok");
        // A lone continuation byte is invalid on its own, not a prefix.
        assert_eq!(stream.decode(b"\x80x"), "\u{FFFD}x");
        // An invalid byte followed by a split character: the first is
        // replaced, the second is held back and completed.
        let crab = EMOJI.as_bytes();
        assert_eq!(stream.decode(&[b'\xFF', crab[0], crab[1]]), "\u{FFFD}");
        assert_eq!(stream.decode(&crab[2..]), EMOJI);
    }

    #[test]
    fn test_utf8_stream_flushes_a_truncated_tail_at_end_of_stream() {
        let mut stream = Utf8Stream::default();
        let bytes = EMOJI.as_bytes();
        assert_eq!(stream.decode(&bytes[..2]), "");
        assert_eq!(stream.finish().as_deref(), Some("\u{FFFD}"));
    }

    #[test]
    fn test_hangup_errors_are_recognized() {
        assert!(is_hangup(&io::Error::from(io::ErrorKind::BrokenPipe)));
        #[cfg(unix)]
        assert!(is_hangup(&io::Error::from_raw_os_error(EIO)));
        assert!(!is_hangup(&io::Error::from(
            io::ErrorKind::PermissionDenied
        )));
    }

    #[test]
    fn test_a_parked_thread_runs_only_once_started() {
        let (tx, rx) = std::sync::mpsc::channel();
        let parked = spawn_parked("parked-test".to_owned(), move || tx.send(()).unwrap()).unwrap();
        assert_eq!(parked.thread().name(), Some("parked-test"));
        assert!(
            rx.recv_timeout(Duration::from_millis(100)).is_err(),
            "the body ran before start"
        );
        parked.start();
        rx.recv_timeout(Duration::from_secs(5))
            .expect("the body runs once started");
    }

    #[test]
    fn test_a_parked_thread_dropped_unstarted_never_runs() {
        let (tx, rx) = std::sync::mpsc::channel::<()>();
        drop(spawn_parked("dropped-test".to_owned(), move || tx.send(()).unwrap()).unwrap());
        // The body (the only holder of `tx`) is dropped without running.
        assert_eq!(
            rx.recv_timeout(Duration::from_secs(5)),
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected)
        );
    }

    /// A real shell on a real PTY: the watcher reports its exit status
    /// once it exits, and stays silent while it runs.
    #[test]
    fn test_exit_watcher_reports_the_shells_exit() {
        let spawned = spawn_pty(
            Uuid::new_v4(),
            None,
            "",
            &HashMap::new(),
            PtySize::default(),
        )
        .expect("the platform default shell spawns");
        // Drain the shell's output, as the output pump does in a real
        // worker. The shell is a session leader on the PTY, and macOS
        // (XNU `proc_exit` -> `ttywait`) holds a dying session leader
        // until its terminal's output queue drains, with no timeout: an
        // unread prompt would keep the killed shell from ever becoming
        // waitable.
        let mut reader = spawned.reader;
        std::thread::spawn(move || {
            let _ = std::io::copy(&mut reader, &mut std::io::sink());
        });
        let process = Arc::new(Mutex::new(spawned.child));
        let (tx, rx) = std::sync::mpsc::channel();
        spawn_exit_watcher(Uuid::new_v4(), Arc::downgrade(&process), move |status| {
            tx.send(status).unwrap();
        })
        .unwrap()
        .start();

        assert!(
            rx.recv_timeout(EXIT_POLL * 2).is_err(),
            "the shell is still running"
        );
        process.lock().kill().unwrap();
        let status = rx
            .recv_timeout(Duration::from_secs(10))
            .expect("the watcher reports the exit");
        assert!(!status.success());
    }
}
