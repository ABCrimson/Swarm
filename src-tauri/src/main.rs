// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

/// SWARM Orchestrator binary entry point.
///
/// Configures and starts the Tokio multi-threaded async runtime
/// with one worker thread per logical CPU core, then delegates
/// to [`swarm_desktop::run`] for Tauri application setup.
///
/// # Panics
///
/// Panics if the Tokio runtime fails to build (e.g., insufficient
/// system resources or OS-level thread creation failure).
///
/// # Examples
///
/// This is the binary entry point and is not invoked directly.
/// Launch the application via:
///
/// ```bash
/// pnpm tauri:dev
/// # or, against an already-running `pnpm dev` server:
/// cargo run -p swarm-desktop
/// ```
fn main() {
    // Explicit Tokio multi-thread runtime with CPU-scaled worker threads
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(
            std::thread::available_parallelism()
                .map(|n| n.get())
                .unwrap_or(1),
        )
        .enable_all()
        .build()
        .expect("failed to build Tokio runtime");

    runtime.block_on(async {
        swarm_desktop::run();
    });
}
