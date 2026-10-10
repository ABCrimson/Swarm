//! The `swarmd` library: everything the `swarmd` binary (`src/main.rs`)
//! wires together, exposed as a library so `tests/integration.rs` runs a
//! real server against real WebSocket clients.
//!
//! - [`auth`]: the daemon token and the `Host`/`Origin` allow-list.
//! - [`cli`]: command-line parsing and the default data directory.
//! - [`ws`]: the `/ws` WebSocket transport (handshake, replay, live events,
//!   RPC).
//! - [`serve_ui`]: the optional `--serve-ui` static bundle.
//!
//! [`serve`] runs the HTTP server on a bound listener until the
//! [`AppState::shutdown_token`] is cancelled, then waits (bounded by
//! [`Limits::drain_timeout`]) for every WebSocket connection to send its
//! `1001 Going Away` close and for in-flight RPCs to finish.

pub mod auth;
pub mod cli;
pub mod serve_ui;
pub mod ws;

use std::io;
use std::net::SocketAddr;
use std::ops::Deref;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use axum::Router;
use axum::extract::connect_info::Connected;
use axum::extract::{ConnectInfo, Request, State};
use axum::http::{StatusCode, header};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::serve::{IncomingStream, Listener};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::Semaphore;
use tokio_util::sync::CancellationToken;
use tokio_util::task::TaskTracker;

use swarm_core::commands::{Ctx, Registry};
use swarm_core::protocol::ServerCaps;
use swarm_core::runtime::Runtime;

use crate::auth::{DaemonToken, HostPolicy, Rejection};

/// Connection and message limits. [`Limits::default`] is what the daemon
/// runs with; tests shrink the timeouts.
#[derive(Clone, Debug)]
pub struct Limits {
    /// Authenticated WebSocket connections served at once. Advertised to
    /// clients in `ready`.
    pub max_connections: usize,
    /// WebSocket upgrades allowed to sit in the handshake (before a valid
    /// token) at once. Separate from [`Self::max_connections`], so
    /// unauthenticated sockets can never occupy an authenticated client's
    /// slot.
    pub max_pending_handshakes: usize,
    /// How many of those handshakes one client IP address may hold, so a
    /// single address cannot keep the whole pool busy with idle sockets.
    pub max_pending_handshakes_per_peer: usize,
    /// Largest message, and largest single frame, a client may send.
    /// Advertised to clients in `ready`.
    pub max_message_bytes: usize,
    /// How long a client has, after the upgrade, to send `hello`.
    pub handshake_deadline: Duration,
    /// How long [`serve`] waits, after shutdown starts, for HTTP requests,
    /// WebSocket connections and in-flight RPCs to finish.
    pub drain_timeout: Duration,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            max_connections: 32,
            max_pending_handshakes: 16,
            max_pending_handshakes_per_peer: 4,
            max_message_bytes: 2 * 1024 * 1024,
            handshake_deadline: Duration::from_secs(5),
            drain_timeout: Duration::from_secs(5),
        }
    }
}

impl Limits {
    /// The caps advertised to clients in `ready`.
    pub fn caps(&self) -> ServerCaps {
        ServerCaps {
            max_frame_bytes: self.max_message_bytes,
            max_connections: self.max_connections,
            replay_page_size: ws::REPLAY_PAGE_SIZE,
        }
    }
}

/// Shared application state handed to every handler. Cloning is one
/// reference-count bump.
#[derive(Clone)]
pub struct AppState(Arc<Shared>);

/// The contents of [`AppState`].
pub struct Shared {
    pub(crate) ctx: Ctx,
    pub(crate) registry: Registry,
    pub(crate) token: DaemonToken,
    pub(crate) hosts: HostPolicy,
    pub(crate) limits: Limits,
    /// Permits for WebSocket upgrades still inside their handshake.
    pub(crate) handshakes: Arc<Semaphore>,
    /// The per-address share of those handshakes.
    pub(crate) peer_handshakes: Arc<ws::PeerHandshakes>,
    /// Permits for authenticated WebSocket connections.
    pub(crate) connections: Arc<Semaphore>,
    /// Cancelled once to stop the server and close every connection.
    pub(crate) shutdown: CancellationToken,
    /// Every WebSocket connection and in-flight RPC, so [`serve`] can wait
    /// for them after shutdown starts.
    pub(crate) tasks: TaskTracker,
}

impl Deref for AppState {
    type Target = Shared;

    fn deref(&self) -> &Shared {
        &self.0
    }
}

impl AppState {
    /// Builds the state for a live [`Runtime`].
    pub fn new(runtime: &Runtime, token: DaemonToken, hosts: HostPolicy, limits: Limits) -> Self {
        Self(Arc::new(Shared {
            ctx: Ctx::from_runtime(runtime),
            registry: Registry::new(),
            token,
            hosts,
            handshakes: Arc::new(Semaphore::new(limits.max_pending_handshakes)),
            peer_handshakes: ws::PeerHandshakes::new(limits.max_pending_handshakes_per_peer),
            connections: Arc::new(Semaphore::new(limits.max_connections)),
            limits,
            shutdown: CancellationToken::new(),
            tasks: TaskTracker::new(),
        }))
    }

    /// The token that stops [`serve`]: cancelling it stops accepting
    /// connections and closes every WebSocket with `1001 Going Away`.
    pub fn shutdown_token(&self) -> CancellationToken {
        self.shutdown.clone()
    }

    /// The command context every RPC runs against.
    pub fn ctx(&self) -> &Ctx {
        &self.ctx
    }

    /// The command registry RPCs are dispatched through.
    pub fn registry(&self) -> &Registry {
        &self.registry
    }
}

/// The addresses of one accepted TCP connection, attached to every request
/// as [`ConnectInfo`].
#[derive(Clone, Copy, Debug)]
pub struct ConnectionAddrs {
    /// The client's address.
    pub remote: SocketAddr,
    /// The local address the connection arrived on: the concrete interface
    /// address, even when the daemon is bound to a wildcard address. `None`
    /// if the OS could not report it.
    pub local: Option<SocketAddr>,
}

/// The daemon's listener: a [`TcpListener`] whose accepted connections have
/// Nagle's algorithm disabled (keystroke echoes and RPC results are small
/// frames it would hold back) and report both of their addresses.
struct DaemonListener(TcpListener);

impl Listener for DaemonListener {
    type Io = TcpStream;
    type Addr = ConnectionAddrs;

    async fn accept(&mut self) -> (TcpStream, ConnectionAddrs) {
        // axum's own accept loop, which backs off on errors like EMFILE.
        let (tcp, remote) = Listener::accept(&mut self.0).await;
        if let Err(error) = tcp.set_nodelay(true) {
            tracing::debug!(%error, "failed to set TCP_NODELAY on an accepted connection");
        }
        let local = tcp.local_addr().ok();
        (tcp, ConnectionAddrs { remote, local })
    }

    /// The bound address, as both halves (a listener has no peer).
    fn local_addr(&self) -> io::Result<ConnectionAddrs> {
        let local = self.0.local_addr()?;
        Ok(ConnectionAddrs {
            remote: local,
            local: Some(local),
        })
    }
}

impl Connected<IncomingStream<'_, DaemonListener>> for ConnectionAddrs {
    fn connect_info(stream: IncomingStream<'_, DaemonListener>) -> Self {
        *stream.remote_addr()
    }
}

/// Builds the router: `/ws`, plus the static bundle at `/` when
/// `serve_ui_dir` is given. Every route sits behind the `Host`/`Origin`
/// allow-list.
pub fn router(state: AppState, serve_ui_dir: Option<&Path>) -> Router {
    let mut router = Router::new().route("/ws", get(ws::upgrade));
    if let Some(dir) = serve_ui_dir {
        router = router.merge(serve_ui::router(dir));
    }
    router
        .layer(middleware::from_fn_with_state(state.clone(), guard_host))
        .with_state(state)
}

/// Rejects, with 403, any request whose `Host` or `Origin` does not name
/// this daemon (see [`HostPolicy`]).
async fn guard_host(State(state): State<AppState>, request: Request, next: Next) -> Response {
    let addrs = request
        .extensions()
        .get::<ConnectInfo<ConnectionAddrs>>()
        .map(|ConnectInfo(addrs)| *addrs);
    let headers = request.headers();
    // A `Host` that is present but not visible ASCII is malformed, not missing.
    let host_unreadable = headers
        .get(header::HOST)
        .is_some_and(|value| value.to_str().is_err());
    // HTTP/2 carries the authority in the request line instead of `Host`.
    let host = headers
        .get(header::HOST)
        .and_then(|value| value.to_str().ok())
        .or_else(|| {
            request
                .uri()
                .authority()
                .map(|authority| authority.as_str())
        });
    let origin = headers
        .get(header::ORIGIN)
        .and_then(|value| value.to_str().ok());
    let checked = if host_unreadable {
        Err(Rejection::MalformedHost)
    } else {
        state
            .hosts
            .check(addrs.and_then(|addrs| addrs.local), host, origin)
    };
    if let Err(rejection) = checked {
        tracing::warn!(
            peer = ?addrs.map(|addrs| addrs.remote),
            host,
            origin,
            path = request.uri().path(),
            %rejection,
            "request rejected by the Host/Origin allow-list"
        );
        return (StatusCode::FORBIDDEN, rejection.to_string()).into_response();
    }
    next.run(request).await
}

/// Serves `state` on `listener` until [`AppState::shutdown_token`] is
/// cancelled, then drains: waits up to [`Limits::drain_timeout`] for HTTP
/// requests, and again for WebSocket connections and in-flight RPCs.
///
/// # Errors
///
/// An I/O error from the server itself.
pub async fn serve(
    listener: TcpListener,
    state: AppState,
    serve_ui_dir: Option<&Path>,
) -> io::Result<()> {
    let app = router(state.clone(), serve_ui_dir)
        .into_make_service_with_connect_info::<ConnectionAddrs>();
    let shutdown = state.shutdown_token();
    let server = std::pin::pin!(
        axum::serve(DaemonListener(listener), app)
            .with_graceful_shutdown(shutdown.clone().cancelled_owned())
            .into_future()
    );
    let limits = &state.limits;
    tokio::select! {
        result = server => result?,
        () = async {
            shutdown.cancelled().await;
            tokio::time::sleep(limits.drain_timeout).await;
        } => tracing::warn!("HTTP requests still open after the drain timeout; stopping anyway"),
    }

    // Upgraded WebSockets are not tracked by axum's graceful shutdown; each
    // one saw the same token and is sending its close frame.
    state.tasks.close();
    if tokio::time::timeout(limits.drain_timeout, state.tasks.wait())
        .await
        .is_err()
    {
        tracing::warn!(
            remaining = state.tasks.len(),
            "WebSocket connections or RPCs still running after the drain timeout"
        );
    }
    Ok(())
}
