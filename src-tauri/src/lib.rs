//! # SWARM Orchestrator desktop shell
//!
//! The Tauri 3 shell around `swarm-core`. All domain logic (workers,
//! provider agents, sessions, the ordered event log, the message bus, git
//! and the ship chain) lives in the Tauri-free `swarm-core` crate, which the
//! headless `swarmd` daemon embeds as well. This crate only connects that
//! core to a desktop window:
//!
//! - [`install_async_runtime`] creates the process's one Tokio runtime and
//!   hands it to Tauri, so IPC commands and swarm-core's background tasks
//!   share a single worker pool.
//! - [`startup`] starts [`swarm_core::runtime::Runtime`] against the app
//!   data directory, forwards its ordered event stream to the webview on
//!   [`swarm_core::orchestration::EVENT_CHANNEL`], and shows the main
//!   window, or reports why it could not start.
//! - [`dialog_grants`] lets a folder opened in a dialog reach its dot
//!   entries on macOS and Linux.
//! - [`commands`] exposes every [`swarm_core::commands::Registry`] command
//!   under its own name (the same table `swarmd` serves as WebSocket `rpc`
//!   frames), plus the two desktop-only commands that drive OS integrations.
//! - [`lifecycle`] shuts the runtime down when the event loop exits, and
//!   the release log is flushed after it.

use std::path::PathBuf;

use tauri::{Manager, RunEvent};
use tracing_appender::non_blocking::WorkerGuard;

mod commands;
mod dialog_grants;
mod lifecycle;
mod startup;

#[cfg(test)]
mod capability_contract;
#[cfg(test)]
mod config_contract;
#[cfg(test)]
mod test_support;

/// Builds the process's Tokio runtime and installs it as Tauri's async
/// runtime.
///
/// Tauri runs async commands and plugin tasks on
/// [`tauri::async_runtime`], which creates a runtime of its own on first
/// use unless one is installed first. Installing this one means commands,
/// plugins and every task swarm-core spawns (with `tokio::spawn`, from
/// inside the runtime context [`run`] enters) share one worker pool, whose
/// threads are named `swarm-tokio`.
///
/// # Panics
///
/// If the runtime cannot be built (the OS refused to create its threads),
/// or if Tauri's async runtime was already initialized, since the second
/// runtime this function exists to prevent would then already be running.
pub fn install_async_runtime() -> tokio::runtime::Runtime {
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .thread_name("swarm-tokio")
        .build()
        .expect("failed to build the Tokio runtime");
    tauri::async_runtime::set(runtime.handle().clone());
    runtime
}

/// Builds and runs SWARM Orchestrator. Does not return: the event loop
/// exits the process when the app quits.
///
/// # Panics
///
/// If the Tauri app cannot be built, which only happens for an invalid
/// bundled configuration. Failures to start swarm-core are not panics:
/// [`startup`] reports them in a dialog and exits with status 1.
pub fn run() {
    let tokio = install_async_runtime();
    let _tokio_context = tokio.enter();

    // Tauri 3 takes the webview runtime as a value: `Builder::default()`
    // is the type-erased `tauri::DynRuntime` builder, and wry is the
    // system webview (WebView2 / WKWebView / WebKitGTK).
    let app = tauri::Builder::default()
        .runtime(tauri_runtime_wry::Wry::default())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        // The frontend opens exactly two things, both explicitly: the
        // ship chain's GitHub compare page (`openUrl`) and a worker's
        // worktree folder (`openPath`), each scoped in
        // capabilities/default.json. The plugin's injected click handler
        // (routing `target="_blank"` links to `open_url`) stays off: the
        // app renders no such links.
        .plugin(
            tauri_plugin_opener::Builder::new()
                .open_js_links_on_click(false)
                .build(),
        )
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_notification::init())
        .invoke_handler(commands::handler())
        .setup(|app| {
            dialog_grants::mirror_dialog_grants(app.handle());
            startup::setup(app.handle());
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("failed to build the SWARM Orchestrator app");

    let mut log_writer = init_tracing(app.path().app_log_dir().ok());
    app.run(move |app, event| {
        let exiting = matches!(event, RunEvent::Exit);
        lifecycle::on_run_event(app, event);
        if exiting {
            // Tauri exits the process right after this callback: flush
            // what the log writer thread still holds, the shutdown's own
            // lines included.
            drop(log_writer.take());
        }
    });
}

/// Name of the release log file inside the app log directory.
const LOG_FILE: &str = "swarm-desktop.log";

/// A release log larger than this is moved to `swarm-desktop.log.1`
/// (replacing the previous one) when the app starts, so the two files
/// together stay bounded.
const LOG_ROTATE_BYTES: u64 = 8 * 1024 * 1024;

/// Installs the global `tracing` subscriber, which also receives the `log`
/// records Tauri and its plugins write.
///
/// Debug builds print human-readable events with thread names to stdout,
/// at `debug` for SWARM's own crates. Release builds have no console (a
/// GUI-subsystem executable on Windows, a detached process when launched
/// from a macOS or Linux desktop), so they write JSON lines to
/// `swarm-desktop.log` in `log_dir` at `info`; without a log directory they
/// fall back to stderr. `RUST_LOG` overrides either default filter.
///
/// The release log file is written by a dedicated thread, so logging from
/// a Tokio worker or the main thread never waits on the disk. The returned
/// guard owns that thread: dropping it writes out every queued line, which
/// [`run`] does after the exit teardown, because Tauri then exits the
/// process without running destructors.
fn init_tracing(log_dir: Option<PathBuf>) -> Option<WorkerGuard> {
    use tracing_subscriber::EnvFilter;

    let mut writer_guard = None;
    if cfg!(debug_assertions) {
        tracing_subscriber::fmt()
            .with_env_filter(
                EnvFilter::try_from_default_env().unwrap_or_else(|_| {
                    EnvFilter::new("swarm_core=debug,swarm_desktop=debug,warn")
                }),
            )
            .with_thread_names(true)
            .pretty()
            .init();
    } else {
        let filter = EnvFilter::try_from_default_env()
            .unwrap_or_else(|_| EnvFilter::new("swarm_core=info,swarm_desktop=info,warn"));
        let subscriber = tracing_subscriber::fmt()
            .with_env_filter(filter)
            .with_ansi(false)
            .json();
        match log_dir.and_then(|dir| open_log_file(&dir).ok()) {
            Some(file) => {
                let (writer, guard) = tracing_appender::non_blocking::NonBlockingBuilder::default()
                    // Past 128,000 queued lines a logging thread waits
                    // for the writer instead of dropping lines: the log is
                    // the only record a release build keeps.
                    .lossy(false)
                    .thread_name("swarm-log")
                    .finish(file);
                writer_guard = Some(guard);
                subscriber.with_writer(writer).init();
            }
            None => subscriber.with_writer(std::io::stderr).init(),
        }
    }

    tracing::info!(version = env!("CARGO_PKG_VERSION"), "tracing initialized");
    writer_guard
}

/// Opens the release log for appending, rotating it first when it has
/// grown past [`LOG_ROTATE_BYTES`].
fn open_log_file(dir: &std::path::Path) -> std::io::Result<std::fs::File> {
    std::fs::create_dir_all(dir)?;
    let path = dir.join(LOG_FILE);
    if std::fs::metadata(&path).is_ok_and(|meta| meta.len() > LOG_ROTATE_BYTES) {
        // A rename can fail while another instance still has the file
        // open on Windows; appending to the oversized log is harmless.
        let _ = std::fs::rename(&path, path.with_extension("log.1"));
    }
    std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::temp_dir;

    #[test]
    fn log_file_is_rotated_once_it_outgrows_the_limit() {
        let dir = temp_dir("log");
        let log = dir.join(LOG_FILE);

        drop(open_log_file(&dir).unwrap());
        std::fs::write(
            &log,
            vec![b'x'; usize::try_from(LOG_ROTATE_BYTES).unwrap() + 1],
        )
        .unwrap();
        drop(open_log_file(&dir).unwrap());

        assert_eq!(std::fs::metadata(&log).unwrap().len(), 0);
        assert_eq!(
            std::fs::metadata(dir.join("swarm-desktop.log.1"))
                .unwrap()
                .len(),
            LOG_ROTATE_BYTES + 1
        );
    }
}
