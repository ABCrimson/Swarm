//! PTY integration module.
//!
//! Uses `portable-pty` 0.9.0 for cross-platform pseudo-terminal
//! spawning. PTY reads are bridged to Tokio via `spawn_blocking`
//! and a bounded mpsc channel (capacity 4096), enabling non-blocking
//! output streaming to the React frontend as Tauri events with
//! backpressure when the consumer falls behind.

use anyhow::Context;
use portable_pty::{CommandBuilder, PtySize, native_pty_system};
use std::io::{Read, Write};
use tauri::AppHandle;
use tokio::sync::mpsc;
use uuid::Uuid;

use crate::events::{SwarmEvent, WorkerOutputPayload, emit_event};

/// Result of spawning a PTY process.
///
/// Contains the writer fd for sending input, the child process
/// handle for lifecycle management, and the OS process ID.
///
/// # Fields
///
/// * `writer` - Writer to send input bytes to the PTY master fd
/// * `child` - Child process handle for kill/wait operations
/// * `pid` - OS process ID of the spawned process (if available)
pub struct PtyHandle {
    /// Writer to send input to the PTY master fd.
    pub writer: Box<dyn Write + Send>,
    /// The child process handle.
    pub child: Box<dyn portable_pty::Child + Send>,
    /// PID of the spawned process (if available).
    pub pid: Option<u32>,
}

/// Spawns a new PTY process with the given shell command.
///
/// Creates a cross-platform pseudo-terminal pair, spawns the
/// requested shell as a child process in the slave PTY, and
/// starts a background reader task that emits PTY output as
/// `worker:output` Tauri events.
///
/// # Architecture
///
/// ```text
/// ┌──────────┐  spawn_blocking  ┌─────────────┐  mpsc  ┌───────────┐
/// │ PTY Slave│──────────────────>│ Reader Task │───────>│ Async Task│
/// │ (shell)  │  blocking read   │ (4KB buffer) │        │ emit_event│
/// └──────────┘                  └─────────────┘        └───────────┘
/// ```
///
/// # Arguments
///
/// * `app` - Tauri app handle for event emission
/// * `worker_id` - UUID of the worker this PTY belongs to
/// * `shell` - Shell executable path (e.g., `powershell.exe`, `/bin/bash`)
/// * `cwd` - Initial working directory for the shell process
/// * `env` - Additional environment variables to set
/// * `rows` - Number of terminal rows
/// * `cols` - Number of terminal columns
///
/// # Returns
///
/// A [`PtyHandle`] containing the writer, child, and PID.
///
/// # Errors
///
/// Returns `anyhow::Error` if:
/// - The PTY pair cannot be opened
/// - The shell command fails to spawn
/// - The PTY master writer or reader cannot be obtained
#[tracing::instrument(skip(app), fields(worker_id = %worker_id))]
pub fn spawn_pty(
    app: &AppHandle,
    worker_id: Uuid,
    shell: &str,
    cwd: &str,
    env: &std::collections::HashMap<String, String>,
    rows: u16,
    cols: u16,
) -> anyhow::Result<PtyHandle> {
    let pty_system = native_pty_system();

    let pty_size = PtySize {
        rows,
        cols,
        pixel_width: 0,
        pixel_height: 0,
    };

    let pair = pty_system
        .openpty(pty_size)
        .map_err(|e| anyhow::anyhow!("{}", e))
        .context("failed to open PTY pair")?;

    let mut cmd = CommandBuilder::new(shell);
    if !cwd.is_empty() {
        cmd.cwd(cwd);
    }
    for (key, value) in env {
        cmd.env(key, value);
    }

    let child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| anyhow::anyhow!("{}", e))
        .context("failed to spawn command in PTY")?;

    let pid = child.process_id();

    let writer = pair
        .master
        .take_writer()
        .map_err(|e| anyhow::anyhow!("{}", e))
        .context("failed to take PTY master writer")?;

    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| anyhow::anyhow!("{}", e))
        .context("failed to clone PTY master reader")?;

    // Bridge PTY output reads to Tokio via spawn_blocking + bounded mpsc channel
    let (tx, mut rx) = mpsc::channel::<Vec<u8>>(4096);

    // Blocking reader task — track the JoinHandle via a monitoring task
    let wid_reader = worker_id;
    let reader_handle = tokio::task::spawn_blocking(move || {
        let mut buf = [0u8; 4096];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    // Use blocking_send since we are in a spawn_blocking context.
                    // This applies backpressure if the channel is full.
                    if tx.blocking_send(buf[..n].to_vec()).is_err() {
                        break;
                    }
                }
                Err(e) => {
                    tracing::error!(error = %e, "PTY read error");
                    break;
                }
            }
        }
    });
    tokio::spawn(async move {
        if let Err(e) = reader_handle.await {
            tracing::error!(worker_id = %wid_reader, error = %e, "PTY reader task panicked");
        }
    });

    // Async task to forward chunks as Tauri events — track the JoinHandle
    let app_handle = app.clone();
    let wid_forwarder = worker_id;
    let forwarder_handle = tokio::spawn(async move {
        while let Some(bytes) = rx.recv().await {
            let data = String::from_utf8_lossy(&bytes).into_owned();
            emit_event(
                &app_handle,
                SwarmEvent::WorkerOutput(WorkerOutputPayload { worker_id, data }),
            );
        }
        tracing::debug!(worker_id = %worker_id, "PTY output reader finished");
    });
    tokio::spawn(async move {
        if let Err(e) = forwarder_handle.await {
            tracing::error!(worker_id = %wid_forwarder, error = %e, "PTY forwarder task panicked");
        }
    });

    Ok(PtyHandle { writer, child, pid })
}

/// Writes input bytes to a PTY master file descriptor.
///
/// Performs a `write_all` followed by `flush` to ensure all
/// bytes are delivered to the PTY immediately.
///
/// # Arguments
///
/// * `writer` - The PTY master writer (obtained from [`PtyHandle`])
/// * `data` - The raw bytes to write
///
/// # Errors
///
/// Returns `anyhow::Error` if the write or flush operation fails.
pub fn write_to_pty(writer: &mut dyn Write, data: &[u8]) -> anyhow::Result<()> {
    writer.write_all(data).context("failed to write to PTY")?;
    writer.flush().context("failed to flush PTY writer")?;
    Ok(())
}
