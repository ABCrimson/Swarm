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
//! ## Runtime
//!
//! All async work runs on a Tokio multi-threaded runtime scaled to the
//! number of logical CPU cores. CPU-bound operations are dispatched
//! through `tokio::task::spawn_blocking` to avoid starving the async
//! executor.

use tauri::{Emitter, Manager};
use tokio_util::sync::CancellationToken;

mod commands;
mod session;

use commands::metrics::SharedSystem;
use swarm_core::Paths;
use swarm_core::ai::{AiClient, AiClientConfig, AiQueue, AiQueueConfig};
use swarm_core::bus::channel::MessageBus;
use swarm_core::bus::router::Router;
use swarm_core::error::AppError;
use swarm_core::events::{SwarmEvent, SystemLogPayload};
use swarm_core::git::{self, GitCapability, RepoLocks};
use swarm_core::orchestration::{EVENT_CHANNEL, EventLog, OrchestrationEngine};
use swarm_core::session::SessionManager;
use swarm_core::worker::registry::WorkerRegistry;

/// Initializes the tracing subscriber for structured logging.
///
/// Configures output format based on the build profile:
/// - **Debug mode:** Pretty-printed, human-readable output with thread names
/// - **Release mode:** JSON-formatted output for structured log aggregation
///
/// The default log filter is `swarm_core=debug,swarm_desktop=debug,warn`
/// unless overridden by the `RUST_LOG` environment variable.
///
/// # Examples
///
/// ```bash
/// # Override log level at runtime
/// RUST_LOG=swarm_core=trace,swarm_desktop=trace cargo run
/// ```
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
///
/// Used both by `setup()` (to locate the event log) and by the config
/// commands (to locate `swarm-config.json`) — one resolution site keeps
/// the two from ever disagreeing on where app data lives.
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
/// This is the main application entry point called from `main.rs`.
/// It performs the following setup sequence:
///
/// 1. Initializes structured tracing/logging
/// 2. Creates the [`WorkerRegistry`], [`SessionManager`], [`MessageBus`],
///    and [`Router`] shared state
/// 3. Registers Tauri plugins (fs, dialog, shell, store, updater, notification)
/// 4. Registers all IPC command handlers
/// 5. In the `setup` closure:
///    - Sets the window icon programmatically for crisp taskbar rendering
///    - Starts the ordered event core (SQLite log + single-writer engine),
///      passing it a closure that synchronously emits each event on
///      `swarm://events` — the primary, lossless delivery path
///    - Loads persisted sessions from disk
///    - Starts the background metrics collection loop (500ms interval)
///    - Initializes the AI client and priority queue
///
/// # Panics
///
/// Panics if:
/// - The main webview window cannot be found
/// - The AI client fails to initialize
/// - The Tauri application fails to start
///
/// # Examples
///
/// ```no_run
/// // Called from the binary entry point:
/// swarm_desktop::run();
/// ```
pub fn run() {
    init_tracing();

    let registry = WorkerRegistry::new();
    let session_manager = SessionManager::new();

    // Per-repo git-operation serialization for worktree-per-worker
    // isolation (spawn/kill). See swarm_core::git::RepoLocks.
    let repo_locks = RepoLocks::new();

    // Inter-agent message bus and router
    let message_bus = MessageBus::new();
    let router = Router::new(message_bus.clone());

    // Single shared sysinfo::System, reused by both the background metrics
    // loop and the on-demand get_metrics command for one CPU-delta tracker.
    let shared_system = SharedSystem::new();

    // AI client with default (empty) config — user configures API key at runtime
    let ai_config = AiClientConfig::default();

    tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_notification::init())
        .manage(registry.clone())
        .manage(session_manager.clone())
        .manage(shared_system.clone())
        .manage(message_bus)
        .manage(router)
        .manage(repo_locks.clone())
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
            // AI commands
            commands::ai::ai_request,
            // Config commands
            commands::config::read_config,
            commands::config::write_config,
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

            // Ordered event core: SQLite log + single-writer engine. The
            // `emit` closure below is the PRIMARY delivery path — called
            // synchronously, in order, for every event, exactly mirroring
            // the pre-split direct `app.emit` call (lossless; a slow
            // webview backs up the writer channel rather than dropping
            // events). No forwarder task is spawned: the engine's
            // broadcast fanout (OrchestrationEngine::subscribe) is a
            // secondary, intentionally-lossy path reserved for future
            // remote (Phase 2 swarmd) subscribers, which this shell does
            // not use.
            let paths = resolve_paths(app.handle())?;
            let db_path = paths.data_dir.join("swarm-events.db");
            let event_log = EventLog::open(&db_path)
                .map_err(|e| Box::<dyn std::error::Error>::from(e.to_string()))?;

            let emit_app = app.handle().clone();
            let engine = OrchestrationEngine::start(event_log, Some(db_path), move |envelope| {
                if let Err(e) = emit_app.emit(EVENT_CHANNEL, envelope) {
                    tracing::error!(error = %e, "failed to emit domain event");
                }
            });

            let sink = engine.sink();
            app.manage(sink.clone());
            app.manage(engine);

            // Load persisted sessions
            let app_handle = app.handle().clone();
            if let Err(e) = session::store::load_sessions(&app_handle, &session_manager) {
                tracing::warn!(error = %e, "failed to load persisted sessions");
            }

            // Apply the persisted worker-registry cap (set via Settings →
            // set_max_workers). An absent/invalid value keeps the default.
            if let Some(max) = commands::config::read_config_value_sync(&app_handle, "max_workers")
                .and_then(|v| v.as_u64())
            {
                let reg = app.state::<WorkerRegistry>();
                if let Err(e) = reg.set_max_workers(max as usize) {
                    tracing::warn!(error = %e, "ignoring persisted max_workers");
                }
            }

            // Worktree isolation startup probe (item 1 of Phase 1): never
            // silently degrade. A missing/too-old git only actually blocks
            // a spawn that supplies `repoRoot` (see
            // `worker::lifecycle::do_spawn_worker`'s hard-fail path) — this
            // just makes that fact visible up front, in the console, before
            // the user hits it as a spawn error.
            match git::probe_capability() {
                GitCapability::Available { version } => {
                    tracing::info!(
                        version = format!("{}.{}.{}", version.0, version.1, version.2),
                        "git worktree isolation available"
                    );
                }
                GitCapability::Unavailable { reason } => {
                    tracing::warn!(reason = %reason, "git worktree isolation unavailable");
                    // DIRECTIVE F4: the old copy ("Workers Will Spawn
                    // Without Isolation") was a lie — do_spawn_worker
                    // hard-fails a repoRoot-bearing spawn when git is
                    // unavailable (see worker::lifecycle's failure
                    // policy), it never silently drops isolation.
                    sink.emit(SwarmEvent::SystemLog(SystemLogPayload {
                        level: "warn".to_string(),
                        message: format!(
                            "Git Unavailable — Isolated Spawns Will Fail Until Git Is Installed Or Upgraded: {reason}"
                        ),
                        target: "swarm_core::git".to_string(),
                        timestamp: std::time::SystemTime::now()
                            .duration_since(std::time::UNIX_EPOCH)
                            .map(|d| d.as_millis() as i64)
                            .unwrap_or(0),
                    }));
                }
            }

            // `git worktree prune` for the one repo Phase 1 tracks by
            // default (the persisted "default_repo_root" — see
            // commands::config), logging the count. A fuller multi-repo
            // orphan reconciliation is out of scope for Phase 1.
            if let Some(default_repo_root) =
                commands::config::read_config_value_sync(&app_handle, "default_repo_root")
                    .and_then(|v| v.as_str().map(str::to_string))
            {
                match git::worktree::prune(std::path::Path::new(&default_repo_root)) {
                    Ok(count) => {
                        tracing::info!(
                            repo_root = %default_repo_root,
                            pruned = count,
                            "startup worktree prune complete"
                        );
                    }
                    Err(e) => {
                        tracing::warn!(
                            repo_root = %default_repo_root,
                            error = %e,
                            "startup worktree prune failed"
                        );
                    }
                }
            }

            // Start metrics collection loop with cancellation token
            let metrics_cancel = CancellationToken::new();
            app.manage(metrics_cancel.clone());
            commands::metrics::start_metrics_loop(
                sink.clone(),
                registry.clone(),
                shared_system.clone(),
                metrics_cancel,
            );

            // Initialize AI queue (requires an EventSink for event emission)
            let ai_client = AiClient::new(ai_config.clone())
                .map_err(|e| Box::<dyn std::error::Error>::from(e.to_string()))?;
            let ai_queue = AiQueue::new(sink, ai_client, AiQueueConfig::default());
            app.manage(ai_queue);

            tracing::info!("SWARM Orchestrator setup complete");
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("failed to run SWARM Orchestrator");
}
