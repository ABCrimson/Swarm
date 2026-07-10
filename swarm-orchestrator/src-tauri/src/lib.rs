//! # SWARM Orchestrator Core Library
//!
//! The Rust backend for the SWARM Orchestrator desktop application,
//! providing multi-agent worker management, AI streaming integration,
//! session persistence, real-time metrics collection, inter-agent
//! message bus, auto-updates, and OS notifications.
//!
//! ## Architecture
//!
//! The backend is organized into five domain modules:
//!
//! - [`worker`] — PTY-backed worker process registry and lifecycle management
//! - [`ai`] — Anthropic API client with SSE streaming and priority queue
//! - [`session`] — Session CRUD with crash-recovery persistence via `tauri-plugin-store`
//! - [`events`] — Typed event emission system bridging Rust state to the React frontend
//! - [`bus`] — Inter-agent message bus with broadcast channels and pipelines
//!
//! ## Runtime
//!
//! All async work runs on a Tokio multi-threaded runtime scaled to the
//! number of logical CPU cores. CPU-bound operations are dispatched
//! through `tokio::task::spawn_blocking` to avoid starving the async
//! executor.

use tauri::Manager;
use tokio_util::sync::CancellationToken;

mod ai;
pub mod bus;
mod commands;
pub mod error;
pub mod events;
pub mod orchestration;
mod session;
pub mod worker;

use ai::{AiClient, AiClientConfig, AiQueue, AiQueueConfig};
use bus::channel::MessageBus;
use bus::router::Router;
use commands::metrics::SharedSystem;
use orchestration::{EventLog, OrchestrationEngine};
use session::SessionManager;
use worker::registry::WorkerRegistry;

/// Initializes the tracing subscriber for structured logging.
///
/// Configures output format based on the build profile:
/// - **Debug mode:** Pretty-printed, human-readable output with thread names
/// - **Release mode:** JSON-formatted output for structured log aggregation
///
/// The default log filter is `swarm_core=debug,warn` unless overridden
/// by the `RUST_LOG` environment variable.
///
/// # Examples
///
/// ```bash
/// # Override log level at runtime
/// RUST_LOG=swarm_core=trace cargo run
/// ```
fn init_tracing() {
    use tracing_subscriber::EnvFilter;

    let env_filter = EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| EnvFilter::new("swarm_core=debug,warn"));

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
/// swarm_core::run();
/// ```
pub fn run() {
    init_tracing();

    let registry = WorkerRegistry::new();
    let session_manager = SessionManager::new();

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
        .invoke_handler(tauri::generate_handler![
            // Worker commands
            commands::worker::spawn_worker,
            commands::worker::pause_worker,
            commands::worker::resume_worker,
            commands::worker::kill_worker,
            commands::worker::list_workers,
            commands::worker::worker_input,
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

            // Ordered event core: SQLite log + single-writer engine.
            let db_path = app
                .path()
                .app_data_dir()
                .map_err(|e| Box::<dyn std::error::Error>::from(e.to_string()))?
                .join("swarm-events.db");
            if let Some(parent) = db_path.parent() {
                std::fs::create_dir_all(parent)?;
            }
            let event_log = EventLog::open(&db_path)
                .map_err(|e| Box::<dyn std::error::Error>::from(e.to_string()))?;
            let engine = OrchestrationEngine::start(app.handle().clone(), event_log, Some(db_path));
            app.manage(engine);

            // Load persisted sessions
            let app_handle = app.handle().clone();
            if let Err(e) = session::store::load_sessions(&app_handle, &session_manager) {
                tracing::warn!(error = %e, "failed to load persisted sessions");
            }

            // Start metrics collection loop with cancellation token
            let metrics_cancel = CancellationToken::new();
            app.manage(metrics_cancel.clone());
            commands::metrics::start_metrics_loop(
                app_handle.clone(),
                registry.clone(),
                shared_system.clone(),
                metrics_cancel,
            );

            // Initialize AI queue (requires app handle for event emission)
            let ai_client = AiClient::new(ai_config.clone())
                .map_err(|e| Box::<dyn std::error::Error>::from(e.to_string()))?;
            let ai_queue = AiQueue::new(app_handle.clone(), ai_client, AiQueueConfig::default());
            app.manage(ai_queue);

            tracing::info!("SWARM Orchestrator setup complete");
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("failed to run SWARM Orchestrator");
}
