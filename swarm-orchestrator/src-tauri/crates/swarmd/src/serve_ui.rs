//! `--serve-ui <dir>`: serves the `pnpm build:web` static bundle at `/`
//! via `tower-http`'s `ServeDir`, with the browser-build CSP response
//! header the plan calls for — `connect-src 'self' ws: wss:` and
//! deliberately WITHOUT `api.anthropic.com` (the webview-direct AI chat
//! path is capability-gated off in a `TRANSPORT=ws` build; remote AI
//! goes through the agent-adapter RPC surface instead, never a direct
//! browser fetch to Anthropic).
//!
//! Embedding the bundle into the `swarmd` binary itself (`include_dir`,
//! for a single-file release artifact) is explicitly deferred to Phase
//! 5's release wiring per the plan ("embedding via include_dir can wait
//! for Phase 5's release wiring — document") — this serves from a
//! plain directory on disk, which is what local/Tailscale/`ssh -L`
//! deployment needs today.

use std::path::Path;

use axum::Router;
use axum::http::HeaderValue;
use tower_http::services::{ServeDir, ServeFile};
use tower_http::set_header::SetResponseHeaderLayer;

const CSP: &str = "default-src 'self'; connect-src 'self' ws: wss:; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'";

/// Builds the static-file-serving sub-router for `dir`. SPA-style
/// fallback: an unmatched path (e.g. a client-side route) falls back to
/// `dir/index.html` rather than a bare 404, matching how the Vite dev
/// server and every other SPA host behaves.
pub fn router(dir: &Path) -> Router<crate::AppState> {
    let index = dir.join("index.html");
    let serve_dir = ServeDir::new(dir).fallback(ServeFile::new(index));

    Router::new()
        .fallback_service(serve_dir)
        .layer(SetResponseHeaderLayer::if_not_present(
            axum::http::header::CONTENT_SECURITY_POLICY,
            HeaderValue::from_static(CSP),
        ))
}
