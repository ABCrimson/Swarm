//! `swarmd`'s library surface — everything `main.rs`'s CLI entry point
//! calls into, factored out as a `[lib]` target (alongside the
//! `[[bin]]`) specifically so `tests/integration.rs` can drive a REAL
//! axum server + REAL WebSocket client against it, rather than
//! re-implementing router wiring in the test itself.
//!
//! See [`main`] crate doc equivalent in `src/main.rs` for the daemon's
//! own description; this module is the "how", `main.rs` is the "CLI
//! glue".

pub mod auth;
pub mod serve_ui;
pub mod ws;

use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::AtomicUsize;

use axum::Router;
use axum::routing::get;

use swarm_core::commands::{Ctx, Registry};
use swarm_core::protocol::ServerCaps;
use swarm_core::runtime::Runtime;

/// Shared, `Clone`-able application state handed to every axum handler.
#[derive(Clone)]
pub struct AppState {
    pub ctx: Ctx,
    pub registry: Arc<Registry>,
    pub token: Arc<auth::DaemonToken>,
    pub caps: ServerCaps,
    pub bind_host_port: String,
    pub active_connections: Arc<AtomicUsize>,
}

/// The default `ServerCaps` swarmd advertises in `ready`.
pub fn default_caps() -> ServerCaps {
    ws::default_caps()
}

/// Builds an [`AppState`] from a live [`Runtime`].
pub fn build_state(
    runtime: &Runtime,
    bind_host_port: String,
    token: auth::DaemonToken,
    caps: ServerCaps,
) -> AppState {
    AppState {
        ctx: Ctx::from_runtime(runtime),
        registry: Arc::new(Registry::new()),
        token: Arc::new(token),
        caps,
        bind_host_port,
        active_connections: Arc::new(AtomicUsize::new(0)),
    }
}

/// Builds the full axum `Router` — `/ws` plus, when `serve_ui_dir` is
/// given, the static-file + CSP-header sub-router at `/`.
pub fn build_router(state: AppState, serve_ui_dir: Option<&Path>) -> Router {
    let mut app = Router::new().route("/ws", get(ws::ws_handler));
    if let Some(dir) = serve_ui_dir {
        app = app.merge(serve_ui::router(dir));
    }
    app.with_state(state)
}
