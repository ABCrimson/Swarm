//! `--serve-ui DIR`: serves the browser build of the frontend from a
//! directory on disk. `pnpm build:web` produces it (in `dist-web/`) with the
//! Vite define `__SWARM_TRANSPORT__` set to `"ws"`, so the bundle talks to
//! the daemon that served it over `/ws` instead of Tauri IPC.
//!
//! - `/assets/*` holds Vite's content-hashed files. They are cached for a
//!   year (`immutable`). A missing one is a plain 404 with
//!   `Cache-Control: no-store` (the file may be about to land, mid
//!   `pnpm build:web`), never `index.html` (which a browser would reject as
//!   a script with the wrong MIME type).
//! - Any other path serves the file under `DIR`, falling back to
//!   `index.html` for client-side routes, with `Cache-Control: no-cache` so
//!   an upgraded bundle is picked up on the next load.
//! - A path with a hidden segment (`.git`, `.env`, ...) is a 404.
//! - Every response carries [`CSP`] and the other headers in
//!   [`SECURITY_HEADERS`].
//!
//! The router-wide `Host`/`Origin` allow-list (see `crate::auth`) runs
//! before any of this, exactly as for `/ws`.
//!
//! The bundle is not embedded in the binary. Embedding it would mean a
//! `tower_http::services::fs::Backend` over compiled-in assets, served
//! through `ServeDir::with_backend`.

use std::io;
use std::path::Path;

use axum::Router;
use axum::body::Body;
use axum::extract::Request;
use axum::http::{HeaderName, HeaderValue, Response, StatusCode, header};
use axum::middleware::{self, Next};
use axum::response::IntoResponse;
use tower_http::services::{ServeDir, ServeFile};
use tower_http::set_header::SetResponseHeader;
use tower_http::set_header::response::SetMultipleResponseHeadersLayer;

use crate::AppState;

/// The Content Security Policy of every served response.
///
/// - Scripts load only from this origin: no inline script and no `eval`
///   (zod probes for `Function` and falls back when it is refused).
///   Workers may also be `blob:` URLs, as in the desktop policy.
/// - Stylesheets load from this origin. `<style>` elements may be inline
///   (`style-src-elem`), because libraries inject them at runtime: sonner
///   its toast styles, motion its `popLayout` positioning rules. Style
///   attributes stay restricted. Without this, toasts render unstyled.
/// - Images and fonts may also be `data:` URIs (Vite inlines small assets,
///   a font among them).
/// - `connect-src 'self'` covers the page's own `ws:`/`wss:` connection back
///   to this daemon, and nothing else: no other host, and no
///   `api.anthropic.com` (the browser build has no webview-direct AI chat;
///   agents run daemon-side).
/// - `frame-ancestors 'none'`: the authenticated UI can never be framed by
///   another page (clickjacking).
/// - `object-src`, `base-uri` and `form-action` are locked down as well.
pub const CSP: &str = "default-src 'self'; script-src 'self'; style-src 'self'; \
style-src-elem 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; \
connect-src 'self'; worker-src 'self' blob:; \
object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

/// Security headers on every served response, [`CSP`] included.
pub const SECURITY_HEADERS: [(HeaderName, &str); 5] = [
    (header::CONTENT_SECURITY_POLICY, CSP),
    (header::X_CONTENT_TYPE_OPTIONS, "nosniff"),
    (header::REFERRER_POLICY, "no-referrer"),
    (
        HeaderName::from_static("cross-origin-opener-policy"),
        "same-origin",
    ),
    (
        HeaderName::from_static("cross-origin-resource-policy"),
        "same-origin",
    ),
];

const IMMUTABLE: HeaderValue = HeaderValue::from_static("public, max-age=31536000, immutable");
const NO_CACHE: HeaderValue = HeaderValue::from_static("no-cache");
const NO_STORE: HeaderValue = HeaderValue::from_static("no-store");

/// Checks that `dir` holds a web bundle (an `index.html`), so a mistyped
/// path fails at startup instead of serving 404s, or serving the wrong
/// directory.
///
/// # Errors
///
/// `dir/index.html` is missing or unreadable.
pub fn check_bundle(dir: &Path) -> io::Result<()> {
    let index = dir.join("index.html");
    if std::fs::metadata(&index)?.is_file() {
        Ok(())
    } else {
        Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("{} Is Not A File", index.display()),
        ))
    }
}

/// The static-file router for `dir` (see the module doc).
pub fn router(dir: &Path) -> Router<AppState> {
    let assets = SetResponseHeader::overriding(
        ServeDir::new(dir.join("assets")),
        header::CACHE_CONTROL,
        asset_cache_control,
    );
    let pages = SetResponseHeader::overriding(
        ServeDir::new(dir).fallback(ServeFile::new(dir.join("index.html"))),
        header::CACHE_CONTROL,
        NO_CACHE,
    );
    let headers = SECURITY_HEADERS
        .into_iter()
        .map(|(name, value)| (name, HeaderValue::from_static(value)).into())
        .collect();

    Router::new()
        .nest_service("/assets", assets)
        .fallback_service(pages)
        .layer(middleware::from_fn(deny_hidden))
        .layer(SetMultipleResponseHeadersLayer::<Response<Body>>::overriding(headers))
}

/// `immutable` for a served asset (or a `304` revalidating one), and
/// `no-store` for an error, so a 404 is never cached for a year.
fn asset_cache_control<B>(response: &Response<B>) -> Option<HeaderValue> {
    let status = response.status();
    Some(
        if status.is_success() || status == StatusCode::NOT_MODIFIED {
            IMMUTABLE
        } else {
            NO_STORE
        },
    )
}

/// 404s any path with a hidden segment, percent-encoded or not.
async fn deny_hidden(request: Request, next: Next) -> Response<Body> {
    let hidden = request.uri().path().split('/').any(|segment| {
        segment.starts_with('.')
            || segment
                .get(..3)
                .is_some_and(|prefix| prefix.eq_ignore_ascii_case("%2e"))
    });
    if hidden {
        return StatusCode::NOT_FOUND.into_response();
    }
    next.run(request).await
}
