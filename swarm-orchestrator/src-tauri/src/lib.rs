//! # SWARM Orchestrator Desktop Shell
//!
//! The Tauri desktop shell for the SWARM Orchestrator application. All
//! domain logic (worker management, AI streaming, session CRUD, the
//! ordered event log, the inter-agent message bus) lives in the
//! Tauri-free `swarm-core` crate; this crate wires that domain layer to
//! Tauri: it registers plugins and IPC command handlers, resolves
//! filesystem paths from `app.path()`, and forwards the ordered event
//! stream onto the `swarm://events` webview channel.
//!
//! ## Runtime construction (headless-daemon plan Phase 2)
//!
//! Everything that used to be built by hand in this file's `setup()`
//! closure (the worker registry, session manager, message bus, ordered
//! event log, agent scheduler, background metrics loop, git capability
//! probe, startup worktree prune) is now
//! [`swarm_core::runtime::Runtime::start`] — the SAME constructor
//! `swarmd` calls. This shell's only remaining jobs are: resolve
//! `Paths` from `app.path()`, supply the PRIMARY lossless `emit`
//! closure (`app.emit(EVENT_CHANNEL, envelope)` — unchanged from
//! before the split), and `app.manage()` the result. Every
//! `#[tauri::command]` wrapper in `commands::*` is now thin: it packs
//! its args into JSON and calls
//! [`swarm_core::commands::Registry::dispatch`] — the SAME dispatch
//! table `swarmd`'s WS `rpc` frames use (see `commands::mod`'s doc and
//! `commands::registry_contract`'s drift-proof test).
//!
//! All async work runs on a Tokio multi-threaded runtime scaled to the
//! number of logical CPU cores. CPU-bound operations are dispatched
//! through `tokio::task::spawn_blocking` to avoid starving the async
//! executor.

use std::sync::Arc;

use tauri::{Emitter, Manager};
use tauri_plugin_dialog::DialogExt;

mod commands;

use swarm_core::Paths;
use swarm_core::commands::{Ctx, Registry};
use swarm_core::error::AppError;
use swarm_core::orchestration::EVENT_CHANNEL;
use swarm_core::runtime::{Runtime, RuntimeConfig, RuntimeStartError};

/// Initializes the tracing subscriber for structured logging.
///
/// Configures output format based on the build profile:
/// - **Debug mode:** Pretty-printed, human-readable output with thread names
/// - **Release mode:** JSON-formatted output for structured log aggregation
///
/// The default log filter is `swarm_core=debug,swarm_desktop=debug,warn`
/// unless overridden by the `RUST_LOG` environment variable.
fn init_tracing() {
    use tracing_subscriber::EnvFilter;

    let env_filter = EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| EnvFilter::new("swarm_core=debug,swarm_desktop=debug,warn"));

    if cfg!(debug_assertions) {
        tracing_subscriber::fmt()
            .with_env_filter(env_filter)
            .with_target(true)
            .with_thread_names(true)
            .pretty()
            .init();
    } else {
        tracing_subscriber::fmt()
            .with_env_filter(env_filter)
            .with_target(true)
            .json()
            .init();
    }

    tracing::info!("tracing initialized");
}

/// Resolves the shared [`swarm_core::Paths`] from the Tauri app handle,
/// creating the app data directory if it does not exist yet.
pub(crate) fn resolve_paths(app: &tauri::AppHandle) -> Result<Paths, AppError> {
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| AppError::Config(format!("failed to resolve app data dir: {e}")))?;
    std::fs::create_dir_all(&data_dir)?;
    Ok(Paths { data_dir })
}

/// Builds and runs the SWARM Orchestrator Tauri application.
///
/// # Panics
///
/// Panics if:
/// - The main webview window cannot be found
/// - The single-instance lock is already held by another process (see
///   [`swarm_core::lock::SingleInstanceLock`]) — this is the ONE
///   intentional early exit: a second engine on the same data
///   directory would collide on the event log's primary key (see the
///   headless-daemon plan's Phase 2 item 1), so this shell refuses to
///   proceed at all rather than run in a corrupted state.
/// - The Tauri application fails to start
pub fn run() {
    init_tracing();

    tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_notification::init())
        .invoke_handler(tauri::generate_handler![
            // Worker commands
            commands::worker::spawn_worker,
            commands::worker::pause_worker,
            commands::worker::resume_worker,
            commands::worker::kill_worker,
            commands::worker::list_workers,
            commands::worker::worker_input,
            commands::worker::set_max_workers,
            // Git commands
            commands::git::validate_repo_root,
            commands::git::git_ship_preflight,
            commands::git::git_stage_commit,
            commands::git::git_push,
            commands::git::ship_compare_url,
            // Session commands
            commands::session::create_session,
            commands::session::delete_session,
            commands::session::list_sessions,
            commands::session::get_session,
            commands::session::session_add_worker,
            // Agent commands
            commands::agent::agent_turn_started,
            commands::agent::agent_spawn,
            commands::agent::agent_send_turn,
            commands::agent::agent_cancel,
            commands::agent::agent_shutdown,
            commands::agent::agent_probe,
            // Config commands
            commands::config::read_config,
            commands::config::write_config,
            // File system commands
            commands::fs::read_file,
            commands::fs::write_file,
            // Metrics commands
            commands::metrics::get_metrics,
            // Orchestration commands
            commands::orchestration::events_since,
            // Bus commands
            commands::bus::bus_send,
            commands::bus::bus_subscribe,
            commands::bus::bus_create_pipeline,
            commands::bus::bus_list_channels,
            commands::bus::bus_list_pipelines,
            // Updater commands
            commands::updater::check_for_updates,
            // Notification commands
            commands::notification::send_notification,
        ])
        .setup(move |app| {
            let window = app
                .get_webview_window("main")
                .ok_or("failed to get main window")?;

            let icon_bytes = include_bytes!("../icons/icon.png");
            let icon = tauri::image::Image::from_bytes(icon_bytes)?;
            window.set_icon(icon)?;

            let paths = resolve_paths(app.handle())?;

            // The PRIMARY delivery path — called synchronously, in
            // order, for every event, exactly mirroring the pre-split
            // direct `app.emit` call (lossless; a slow webview backs up
            // the writer channel rather than dropping events). Passed
            // straight through to `Runtime::start`, which wires it into
            // the engine exactly as `lib.rs` used to do by hand.
            let emit_app = app.handle().clone();
            let runtime = match Runtime::start(
                RuntimeConfig {
                    paths,
                    shell_name: "swarm-desktop",
                    bind: None, // no network listener — this is the desktop shell
                },
                move |envelope| {
                    if let Err(e) = emit_app.emit(EVENT_CHANNEL, envelope) {
                        tracing::error!(error = %e, "failed to emit domain event");
                    }
                },
            ) {
                Ok(rt) => rt,
                Err(RuntimeStartError::Lock(lock_err)) => {
                    // security-review FIX-7: `eprintln!` alone is
                    // invisible on a `windows_subsystem = "windows"`
                    // release build (no console) — this runs INSIDE
                    // `setup()`, where the app handle (and therefore
                    // `tauri-plugin-dialog`, already a registered
                    // plugin) exists, so a blocking native dialog
                    // surfaces the SAME Title Case, pid-and-shell-bearing
                    // message (see `LockError`'s `Display`, which now
                    // names which shell holds the lock) on every
                    // platform, console or not.
                    eprintln!("{lock_err}");
                    tracing::error!(error = %lock_err, "single-instance lock held by another process");
                    app.dialog()
                        .message(lock_err.to_string())
                        .title("SWARM Orchestrator")
                        .kind(tauri_plugin_dialog::MessageDialogKind::Error)
                        .blocking_show();
                    std::process::exit(1);
                }
                Err(other) => {
                    eprintln!("Failed To Start The SWARM Runtime: {other}");
                    app.dialog()
                        .message(other.to_string())
                        .title("SWARM Orchestrator")
                        .kind(tauri_plugin_dialog::MessageDialogKind::Error)
                        .blocking_show();
                    std::process::exit(1);
                }
            };

            let ctx = Ctx::from_runtime(&runtime);
            app.manage(ctx);
            app.manage(Arc::new(Registry::new()));
            // Keeps the single-instance lock (and every background task
            // `Runtime::start` spawned) alive for the app's entire
            // lifetime — dropping `runtime` early would release the
            // lock immediately, defeating its purpose.
            app.manage(runtime);

            tracing::info!("SWARM Orchestrator setup complete");
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("failed to run SWARM Orchestrator");
}
