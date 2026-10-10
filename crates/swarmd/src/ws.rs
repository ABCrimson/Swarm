//! The `/ws` WebSocket transport: one connection per client, `hello` ->
//! `ready` -> (replay) -> `replayEnd` -> live events, with `rpc` requests
//! answered by `rpcResult` throughout. The frame shapes live in
//! [`swarm_core::protocol`]; `docs/api.md` ("Wire Protocol (swarmd)") is the
//! client-facing description.
//!
//! # Admission
//!
//! The router-wide `Host`/`Origin` check runs first (see `crate::auth`).
//! A valid `Authorization: Bearer` header then takes the connection slot
//! itself. Any other upgrade takes a handshake permit instead: from a
//! separate, smaller pool, so sockets that never authenticate cannot occupy
//! a client's slot, and at most [`Limits::max_pending_handshakes_per_peer`]
//! per remote client address (an IPv6 client by its `/64`, the block one
//! host usually holds), so one remote host cannot hold the whole pool.
//! Every refusal is a 503 before upgrading. A client that authenticates
//! through `hello` takes its slot after the token is checked, or is closed
//! with `1013 Try Again Later` if the daemon filled up in the meantime.
//!
//! Loopback peers have no per-address share, only the pool: on the default
//! loopback bind, over an `ssh -L` tunnel and behind a local TLS reverse
//! proxy EVERY client arrives from loopback, so a per-address cap would
//! shrink the pool to that cap for all of them at once. The limitation this
//! leaves: any local process (or, through such a proxy, any remote client
//! that has not authenticated) can keep the handshake pool full of idle
//! sockets, re-opening each one as its deadline closes it, and so hold off
//! browser clients, which authenticate through `hello`. Clients that can
//! send an `Authorization: Bearer` header are never affected.
//! Messages (and single frames) are capped at [`Limits::max_message_bytes`]
//! from the first byte, authenticated or not.
//!
//! # Handshake
//!
//! The client must send `hello` within [`Limits::handshake_deadline`], or it
//! is closed with `1008 Policy Violation`, as it is when its first message is
//! anything but a valid `hello`; a wrong token is closed with
//! [`CLOSE_UNAUTHORIZED`] (`4401`).
//!
//! # Event stream
//!
//! The connection subscribes to the engine's broadcast fanout BEFORE reading
//! the engine's head seq (`OrchestrationEngine::head_seq`, an in-memory
//! read), so nothing published in between is missed: anything the engine
//! emits after the subscription is buffered in the receiver, and a seq
//! filter drops whatever a replay already delivered. A warm `hello`
//! (`lastSeq: n`) replays every persisted event after `n` from SQLite, in
//! pages of [`REPLAY_PAGE_SIZE`]; a cold one (`lastSeq: null`) replays
//! nothing and starts at the head, because the client hydrates from the
//! snapshot `list_*` commands. `replayEnd` then marks the switch to live
//! events. If the receiver lags the fanout, the same replay heals the gap
//! from the log; a replay that cannot read the log closes the connection
//! with `1011 Internal Error`, so the client reconnects and retries instead
//! of believing it is caught up. Seqs never repeat across daemon restarts
//! (the engine reserves them in the log), so a client's `lastSeq` stays
//! valid when it reconnects to a restarted daemon.
//!
//! # Lanes and ordering
//!
//! `ready`, `replayEnd` and every event (replayed or live) share ONE bounded
//! FIFO lane, so wire order is seq order: splitting them across lanes that a
//! writer `select!`s between would let a lag-heal replay and a live event
//! race, and a client that advanced `lastSeq` past the out-of-order frame
//! would silently drop real output. Persistent events always enqueue,
//! blocking this connection (never the engine) while the lane is full.
//! Ephemeral events (everything [`is_persistent`] rejects: `worker_output`,
//! `system_metrics`, `system_log`, `agent_turn_delta`, terminal
//! `worker_input`) are dropped once 512 frames (`EPHEMERAL_WATERMARK`) are
//! queued, keeping headroom for persistent frames; they cannot be replayed
//! anyway. Whatever is enqueued keeps its FIFO position.
//!
//! `rpcResult` frames carry no seq and ride a second, low-volume lane that
//! the writer always serves first, so a PTY flood cannot delay RPC results
//! (the command that would stop the flood among them). Close frames use that
//! lane too. The writer coalesces whatever is already queued into one flush.
//!
//! # RPC
//!
//! Each `rpc` runs as its own task through
//! [`swarm_core::commands::Registry::dispatch_remote`], which applies each
//! command's remote policy. At most 8 (`MAX_CONCURRENT_RPC_PER_CONNECTION`)
//! run per connection; beyond that a request is answered at once with a
//! busy error. A malformed `rpc` frame whose `id` is readable is answered
//! with an error instead of being left to time out.
//!
//! # Shutdown
//!
//! When the daemon's shutdown token fires, every connection sends
//! `1001 Going Away` and ends, including one still waiting for its `hello`.
//! Its writer and feeder are aborted when it
//! ends; in-flight RPCs finish on the daemon's task tracker, which
//! [`crate::serve`] drains.

use std::collections::HashMap;
use std::collections::hash_map::Entry;
use std::net::{IpAddr, SocketAddr};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use axum::extract::ws::{CloseFrame, Message, Utf8Bytes, WebSocket, WebSocketUpgrade, close_code};
use axum::extract::{ConnectInfo, State};
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{IntoResponse, Response};
use futures_util::stream::{SplitSink, SplitStream};
use futures_util::{Sink, SinkExt, StreamExt};
use parking_lot::Mutex;
use serde::Deserialize;
use serde_json::Value;
use tokio::sync::broadcast::error::RecvError;
use tokio::sync::{OwnedSemaphorePermit, Semaphore, broadcast, mpsc};
use tokio::task::JoinSet;

use swarm_core::commands::orchestration::{PAGE_LIMIT, stored_event_to_json};
use swarm_core::error::AppError;
use swarm_core::orchestration::{DomainEvent, EventLog, is_persistent};
use swarm_core::protocol::{ClientFrame, PROTOCOL_VERSION, ServerFrame};

#[cfg(doc)]
use crate::Limits;
use crate::{AppState, ConnectionAddrs};

/// Replay page size: the same page limit the `events_since` command uses.
pub const REPLAY_PAGE_SIZE: u32 = PAGE_LIMIT;

/// Close code for a failed token check (an application code in the
/// 4000-4999 range, mirroring HTTP 401).
pub const CLOSE_UNAUTHORIZED: u16 = 4401;

/// Capacity of the ordered event lane (`ready`, `replayEnd`, events). A
/// queue of frames waiting for the socket, sized so a replay burst rarely
/// blocks while still bounding a wedged connection's memory.
const EVENT_LANE_CAPACITY: usize = 4096;

/// Queued frames above which new ephemeral events are dropped; well below
/// [`EVENT_LANE_CAPACITY`], so an ephemeral flood cannot take the room a
/// persistent frame needs.
const EPHEMERAL_WATERMARK: usize = 512;

/// Capacity of the control lane (`rpcResult` and close frames).
const CONTROL_LANE_CAPACITY: usize = 256;

/// In-flight `rpc` tasks allowed per connection.
const MAX_CONCURRENT_RPC_PER_CONNECTION: usize = 8;

/// Frames the writer coalesces into one flush.
const WRITE_BATCH: usize = 64;

/// How long a closing connection waits for its close frame to be written.
const CLOSE_GRACE: Duration = Duration::from_secs(1);

/// `GET /ws`: admits the upgrade (see the module doc) and hands the socket
/// to [`connection`].
pub(crate) async fn upgrade(
    State(state): State<AppState>,
    ConnectInfo(addrs): ConnectInfo<ConnectionAddrs>,
    headers: HeaderMap,
    ws: WebSocketUpgrade,
) -> Response {
    let peer = addrs.remote;
    if state.shutdown.is_cancelled() {
        return refuse(peer, "Daemon Shutting Down.");
    }
    let admission = if bearer_token(&headers).is_some_and(|token| state.token.matches(token)) {
        // Already authenticated: straight to a connection slot, with no
        // handshake permit that idle sockets could have used up.
        match Arc::clone(&state.connections).try_acquire_owned() {
            Ok(slot) => Admission::Authenticated(slot),
            Err(_) => return refuse(peer, "Too Many Connections."),
        }
    } else if state.connections.available_permits() == 0 {
        // An early answer while the daemon is full; the authoritative
        // reservation happens once `hello` authenticates.
        return refuse(peer, "Too Many Connections.");
    } else {
        let Ok(from_peer) = state.peer_handshakes.try_acquire(peer.ip()) else {
            return refuse(peer, "Too Many Pending Connections From This Address.");
        };
        let Ok(pooled) = Arc::clone(&state.handshakes).try_acquire_owned() else {
            return refuse(peer, "Too Many Pending Connections.");
        };
        Admission::Pending(pooled, from_peer)
    };

    let limit = state.limits.max_message_bytes;
    let tracked = state.tasks.token();
    ws.max_message_size(limit)
        .max_frame_size(limit)
        .on_failed_upgrade(move |error| {
            tracing::debug!(%peer, %error, "WebSocket upgrade failed");
        })
        .on_upgrade(move |socket| async move {
            let _tracked = tracked;
            connection(socket, state, peer, admission).await;
        })
}

fn refuse(peer: SocketAddr, reason: &'static str) -> Response {
    tracing::warn!(%peer, reason, "WebSocket upgrade refused");
    (StatusCode::SERVICE_UNAVAILABLE, reason).into_response()
}

/// The token from an `Authorization: Bearer <token>` header (the scheme is
/// case-insensitive).
fn bearer_token(headers: &HeaderMap) -> Option<&str> {
    let (scheme, token) = headers
        .get(header::AUTHORIZATION)?
        .to_str()
        .ok()?
        .split_once(' ')?;
    scheme.eq_ignore_ascii_case("bearer").then(|| token.trim())
}

/// What [`upgrade`] reserved for a connection.
enum Admission {
    /// A valid Bearer header: the connection slot itself.
    Authenticated(OwnedSemaphorePermit),
    /// Not yet authenticated: a permit from the daemon-wide handshake pool
    /// and, for a remote peer, one from its address's share, both released
    /// once the handshake ends, successfully or not.
    Pending(OwnedSemaphorePermit, Option<PeerPermit>),
}

/// Handshakes in flight per remote client address, capped at
/// [`Limits::max_pending_handshakes_per_peer`] so one remote host cannot take
/// the whole handshake pool (see the module doc for why loopback is exempt).
pub(crate) struct PeerHandshakes {
    limit: usize,
    counts: Mutex<HashMap<IpAddr, usize>>,
}

/// The address a peer's handshakes are counted under, or `None` for a
/// loopback peer, which has no per-address share. An IPv4 client of a
/// dual-stack listener shows up v4-mapped and counts as its IPv4 address;
/// an IPv6 client counts as its `/64`, since one host usually holds the
/// whole block and could otherwise pick a fresh address per socket.
fn peer_key(ip: IpAddr) -> Option<IpAddr> {
    match ip.to_canonical() {
        ip if ip.is_loopback() => None,
        IpAddr::V6(v6) => Some(IpAddr::V6((v6.to_bits() & !u128::from(u64::MAX)).into())),
        v4 @ IpAddr::V4(_) => Some(v4),
    }
}

impl PeerHandshakes {
    pub(crate) fn new(limit: usize) -> Arc<Self> {
        Arc::new(Self {
            limit,
            counts: Mutex::default(),
        })
    }

    /// Takes one of `ip`'s handshake permits: `Ok(None)` for a loopback
    /// peer, which needs none, and `Err(ShareUsedUp)` when its share is gone.
    fn try_acquire(self: &Arc<Self>, ip: IpAddr) -> Result<Option<PeerPermit>, ShareUsedUp> {
        let Some(ip) = peer_key(ip) else {
            return Ok(None);
        };
        let mut counts = self.counts.lock();
        let count = counts.entry(ip).or_default();
        if *count >= self.limit {
            return Err(ShareUsedUp);
        }
        *count += 1;
        Ok(Some(PeerPermit {
            peers: Arc::clone(self),
            ip,
        }))
    }
}

/// A remote address already holds its whole share of handshake permits.
#[derive(Debug)]
struct ShareUsedUp;

/// One of a remote address's handshake permits; returned on drop.
struct PeerPermit {
    peers: Arc<PeerHandshakes>,
    ip: IpAddr,
}

impl Drop for PeerPermit {
    fn drop(&mut self) {
        let mut counts = self.peers.counts.lock();
        if let Entry::Occupied(mut count) = counts.entry(self.ip) {
            *count.get_mut() -= 1;
            if *count.get() == 0 {
                count.remove();
            }
        }
    }
}

/// Why a connection's writer or feeder task ended.
enum Ended {
    Writer(Result<(), axum::Error>),
    Feeder(FeedEnd),
}

/// Why [`feed`] stopped.
#[derive(Debug, thiserror::Error)]
enum FeedEnd {
    #[error("the connection's writer stopped")]
    Disconnected,
    #[error("the event engine stopped")]
    EngineStopped,
    #[error("event replay failed: {0}")]
    Replay(String),
}

/// One client connection, from the handshake to the close.
async fn connection(socket: WebSocket, state: AppState, peer: SocketAddr, admission: Admission) {
    let (mut sink, mut stream) = socket.split();

    let deadline = state.limits.handshake_deadline;
    let hello = tokio::select! {
        () = state.shutdown.cancelled() => {
            close_now(&mut sink, close_code::AWAY, "Daemon Shutting Down.").await;
            return;
        }
        hello = tokio::time::timeout(deadline, read_hello(&mut stream)) => hello,
    };
    let (last_seq, token) = match hello {
        Ok(Ok(hello)) => hello,
        Ok(Err(HelloError::Invalid(what))) => {
            tracing::warn!(%peer, what, "WebSocket closed: the first message was not a valid `hello`");
            close_now(&mut sink, close_code::POLICY, "Expected A `hello` Frame.").await;
            return;
        }
        Ok(Err(HelloError::Gone)) => {
            tracing::debug!(%peer, "WebSocket client left before sending `hello`");
            return;
        }
        Err(_elapsed) => {
            tracing::warn!(%peer, "WebSocket closed: no `hello` within the handshake deadline");
            close_now(
                &mut sink,
                close_code::POLICY,
                "Expected `hello` Within The Handshake Deadline.",
            )
            .await;
            return;
        }
    };

    let slot = match admission {
        Admission::Authenticated(slot) => Some(slot),
        Admission::Pending(pooled, from_peer) => {
            // The handshake is over, whatever its outcome.
            drop((pooled, from_peer));
            None
        }
    };
    let authenticated = slot.is_some()
        || token
            .as_deref()
            .is_some_and(|token| state.token.matches(token));
    if !authenticated {
        tracing::warn!(%peer, "WebSocket closed: invalid or missing token");
        close_now(&mut sink, CLOSE_UNAUTHORIZED, "Unauthorized.").await;
        return;
    }
    let _slot = match slot {
        Some(slot) => slot,
        None => match Arc::clone(&state.connections).try_acquire_owned() {
            Ok(slot) => slot,
            Err(_) => {
                tracing::warn!(%peer, "WebSocket closed: connection limit reached");
                close_now(&mut sink, close_code::AGAIN, "Too Many Connections.").await;
                return;
            }
        },
    };

    // Subscribe BEFORE reading the head (see the module doc).
    let live = state.ctx.engine.subscribe();
    let server_seq = state.ctx.engine.head_seq();
    let log_path = state.ctx.engine.db_path().map(Path::to_path_buf);
    tracing::info!(%peer, last_seq, server_seq, "WebSocket client connected");

    let (events_tx, events_rx) = mpsc::channel(EVENT_LANE_CAPACITY);
    let (control_tx, control_rx) = mpsc::channel(CONTROL_LANE_CAPACITY);
    let ready = frame(&ServerFrame::Ready {
        server_seq,
        version: PROTOCOL_VERSION,
        caps: state.limits.caps(),
    });
    // Cannot fail: the lane is empty and its receiver is alive.
    let _ = events_tx.try_send(ready);

    let mut tasks = JoinSet::new();
    tasks.spawn(async move { Ended::Writer(write_frames(sink, events_rx, control_rx).await) });
    tasks.spawn(async move {
        Ended::Feeder(
            feed(
                live,
                log_path,
                last_seq,
                server_seq,
                events_tx,
                REPLAY_PAGE_SIZE,
            )
            .await,
        )
    });

    let rpc_slots = Arc::new(Semaphore::new(MAX_CONCURRENT_RPC_PER_CONNECTION));
    let close_with = loop {
        tokio::select! {
            () = state.shutdown.cancelled() => {
                break Some((close_code::AWAY, "Daemon Shutting Down."));
            }
            Some(ended) = tasks.join_next() => break match ended {
                Ok(Ended::Feeder(FeedEnd::Replay(error))) => {
                    tracing::error!(%peer, %error, "closing the WebSocket: event replay failed");
                    Some((close_code::ERROR, "Event Replay Failed."))
                }
                Ok(Ended::Feeder(FeedEnd::EngineStopped)) => {
                    Some((close_code::AWAY, "Daemon Shutting Down."))
                }
                Ok(Ended::Feeder(FeedEnd::Disconnected) | Ended::Writer(Ok(()))) => None,
                Ok(Ended::Writer(Err(error))) => {
                    tracing::debug!(%peer, %error, "WebSocket write failed");
                    None
                }
                Err(error) => {
                    tracing::error!(%peer, %error, "WebSocket connection task failed");
                    None
                }
            },
            message = stream.next() => match message {
                Some(Ok(Message::Text(text))) => on_text(&state, &text, &control_tx, &rpc_slots),
                Some(Ok(Message::Close(_))) | None => break None,
                // Pings are answered by the protocol layer; binary frames
                // are not part of the protocol.
                Some(Ok(Message::Ping(_) | Message::Pong(_) | Message::Binary(_))) => {}
                Some(Err(error)) => {
                    tracing::debug!(%peer, %error, "WebSocket receive failed");
                    break None;
                }
            },
        }
    };

    if let Some((code, reason)) = close_with {
        let closed = tokio::time::timeout(CLOSE_GRACE, async {
            if control_tx.send(close_message(code, reason)).await.is_ok() {
                while let Some(ended) = tasks.join_next().await {
                    if matches!(ended, Ok(Ended::Writer(_))) {
                        break;
                    }
                }
            }
        })
        .await;
        if closed.is_err() {
            tracing::debug!(%peer, code, "close frame not written within the grace period");
        }
    }
    tracing::info!(%peer, "WebSocket client disconnected");
    // Dropping `tasks` aborts the writer and feeder if they are still running.
}

/// Why a handshake produced no `hello`.
enum HelloError {
    /// The first data message was something else; names what.
    Invalid(&'static str),
    /// The client closed the connection, or it failed.
    Gone,
}

/// Reads messages until the first data message, which must be `hello`, and
/// returns its (`lastSeq`, `token`). Pings and pongs are skipped.
async fn read_hello(
    stream: &mut SplitStream<WebSocket>,
) -> Result<(Option<u64>, Option<String>), HelloError> {
    loop {
        match stream.next().await {
            Some(Ok(Message::Text(text))) => {
                return match serde_json::from_str(&text) {
                    Ok(ClientFrame::Hello { last_seq, token }) => Ok((last_seq, token)),
                    Ok(_) => Err(HelloError::Invalid("a frame other than `hello`")),
                    Err(_) => Err(HelloError::Invalid("a malformed frame")),
                };
            }
            Some(Ok(Message::Binary(_))) => return Err(HelloError::Invalid("a binary message")),
            Some(Ok(Message::Ping(_) | Message::Pong(_))) => {}
            Some(Ok(Message::Close(_)) | Err(_)) | None => return Err(HelloError::Gone),
        }
    }
}

/// Handles one text frame from an authenticated client.
fn on_text(
    state: &AppState,
    text: &str,
    control: &mpsc::Sender<Message>,
    rpc_slots: &Arc<Semaphore>,
) {
    match serde_json::from_str::<ClientFrame>(text) {
        Ok(ClientFrame::Rpc { id, cmd, args }) => match Arc::clone(rpc_slots).try_acquire_owned() {
            Ok(permit) => {
                let state = state.clone();
                let control = control.clone();
                state.tasks.clone().spawn(async move {
                    let _permit = permit;
                    let result = state
                        .registry
                        .dispatch_remote(&cmd, state.ctx.clone(), args)
                        .await;
                    // A closed lane means the client is gone; nobody is
                    // left to answer.
                    let _ = control.send(rpc_result(id, result)).await;
                });
            }
            Err(_) => reply_now(
                control,
                id,
                Err(Value::from(
                    "Too Many Concurrent RPC Calls On This Connection.",
                )),
            ),
        },
        Ok(ClientFrame::Hello { .. }) => {
            tracing::warn!("ignoring a second `hello` on an established WebSocket connection");
        }
        Err(error) => match rpc_id(text) {
            Some(id) => reply_now(
                control,
                id,
                Err(Value::String(format!("Malformed RPC Frame: {error}"))),
            ),
            None => tracing::warn!(%error, "ignoring a malformed client frame"),
        },
    }
}

/// The `id` of a frame that claims to be an `rpc`, even when the rest of it
/// does not parse.
fn rpc_id(text: &str) -> Option<String> {
    #[derive(Deserialize)]
    struct RpcHeader {
        frame: String,
        id: String,
    }
    serde_json::from_str::<RpcHeader>(text)
        .ok()
        .filter(|header| header.frame == "rpc")
        .map(|header| header.id)
}

/// Queues an immediate reply without waiting: a client that has filled the
/// control lane is flooding, and the reader must not block on it.
fn reply_now(control: &mpsc::Sender<Message>, id: String, result: Result<Value, Value>) {
    if control.try_send(rpc_result(id, result)).is_err() {
        tracing::debug!("control lane full; dropped an immediate rpcResult");
    }
}

fn rpc_result(id: String, result: Result<Value, Value>) -> Message {
    let frame = match result {
        Ok(value) => ServerFrame::RpcResult {
            id,
            ok: true,
            result: Some(value),
            error: None,
        },
        Err(value) => ServerFrame::RpcResult {
            id,
            ok: false,
            result: None,
            error: Some(value),
        },
    };
    Message::Text(self::frame(&frame))
}

fn frame(frame: &ServerFrame) -> Utf8Bytes {
    serde_json::to_string(frame)
        .expect("a ServerFrame always serializes to JSON")
        .into()
}

fn close_message(code: u16, reason: &'static str) -> Message {
    Message::Close(Some(CloseFrame {
        code,
        reason: Utf8Bytes::from_static(reason),
    }))
}

/// Sends a close frame directly; used before the writer task exists.
async fn close_now(sink: &mut SplitSink<WebSocket, Message>, code: u16, reason: &'static str) {
    let _ = sink.send(close_message(code, reason)).await;
}

/// Drains both lanes into the socket, control first, coalescing whatever is
/// already queued into one flush. Returns after writing a close frame, or
/// once both lanes are closed and empty.
async fn write_frames<S: Sink<Message> + Unpin>(
    mut sink: S,
    mut events: mpsc::Receiver<Utf8Bytes>,
    mut control: mpsc::Receiver<Message>,
) -> Result<(), S::Error> {
    loop {
        let first = tokio::select! {
            biased;
            Some(message) = control.recv() => message,
            Some(text) = events.recv() => Message::Text(text),
            else => return Ok(()),
        };
        let mut closing = matches!(first, Message::Close(_));
        sink.feed(first).await?;
        let mut batched = 1;
        while !closing && batched < WRITE_BATCH {
            let next = match control.try_recv() {
                Ok(message) => message,
                Err(_) => match events.try_recv() {
                    Ok(text) => Message::Text(text),
                    Err(_) => break,
                },
            };
            closing = matches!(next, Message::Close(_));
            sink.feed(next).await?;
            batched += 1;
        }
        sink.flush().await?;
        if closing {
            return Ok(());
        }
    }
}

/// Runs blocking SQLite work on the blocking pool.
async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, AppError> + Send + 'static,
) -> Result<T, FeedEnd> {
    tokio::task::spawn_blocking(work)
        .await
        .map_err(|error| FeedEnd::Replay(error.to_string()))?
        .map_err(|error| FeedEnd::Replay(error.to_string()))
}

/// Feeds the event lane for one connection: the replay for a warm `hello`,
/// `replayEnd`, then live events (healing lag by replay) until the
/// connection or the engine goes away.
async fn feed(
    live: broadcast::Receiver<Arc<DomainEvent>>,
    log_path: Option<PathBuf>,
    last_seq: Option<u64>,
    server_seq: u64,
    events: mpsc::Sender<Utf8Bytes>,
    page_size: u32,
) -> FeedEnd {
    stream_events(
        live,
        log_path.as_deref(),
        last_seq,
        server_seq,
        &events,
        page_size,
    )
    .await
    .into_err()
}

async fn stream_events(
    mut live: broadcast::Receiver<Arc<DomainEvent>>,
    log_path: Option<&Path>,
    last_seq: Option<u64>,
    server_seq: u64,
    events: &mpsc::Sender<Utf8Bytes>,
    page_size: u32,
) -> Result<!, FeedEnd> {
    let mut cursor = match last_seq {
        Some(last_seq) => replay(log_path, last_seq, events, page_size).await?,
        None => server_seq,
    };
    events
        .send(frame(&ServerFrame::ReplayEnd { seq: cursor }))
        .await
        .map_err(|_| FeedEnd::Disconnected)?;

    loop {
        match live.recv().await {
            Ok(event) if event.seq > cursor => {
                forward(&event, events).await?;
                cursor = event.seq;
            }
            // Already delivered by a replay.
            Ok(_) => {}
            Err(RecvError::Lagged(skipped)) => {
                tracing::warn!(
                    skipped,
                    cursor,
                    "WebSocket client lagged the event fanout; healing by replay"
                );
                cursor = replay(log_path, cursor, events, page_size).await?;
            }
            Err(RecvError::Closed) => return Err(FeedEnd::EngineStopped),
        }
    }
}

/// Enqueues one live event on the lane its persistence class calls for.
async fn forward(event: &DomainEvent, events: &mpsc::Sender<Utf8Bytes>) -> Result<(), FeedEnd> {
    let text = match serde_json::to_string(event) {
        Ok(text) => Utf8Bytes::from(text),
        Err(error) => {
            tracing::error!(seq = event.seq, %error, "failed to serialize a live event; skipping it");
            return Ok(());
        }
    };
    if is_persistent(&event.event) {
        events.send(text).await.map_err(|_| FeedEnd::Disconnected)
    } else {
        if events.max_capacity() - events.capacity() < EPHEMERAL_WATERMARK {
            // Full or closed: dropped, like any ephemeral event under load.
            let _ = events.try_send(text);
        }
        Ok(())
    }
}

/// Sends every persisted event after `cursor`, page by page, and returns the
/// last seq sent (`cursor` itself when there was nothing to send).
async fn replay(
    log_path: Option<&Path>,
    mut cursor: u64,
    events: &mpsc::Sender<Utf8Bytes>,
    page_size: u32,
) -> Result<u64, FeedEnd> {
    let Some(path) = log_path.map(Path::to_path_buf) else {
        // An in-memory log has nothing to replay from.
        return Ok(cursor);
    };
    let mut log = blocking(move || EventLog::open_readonly(&path)).await?;
    loop {
        let (reader, page) =
            blocking(move || log.events_since(cursor, page_size).map(|page| (log, page))).await?;
        log = reader;
        let last_page = page.len() < page_size as usize;
        for stored in page {
            let seq = stored.seq;
            let text = stored_event_to_json(stored).to_string();
            events
                .send(text.into())
                .await
                .map_err(|_| FeedEnd::Disconnected)?;
            cursor = seq;
        }
        if last_page {
            return Ok(cursor);
        }
    }
}

#[cfg(test)]
mod tests {
    use axum::http::HeaderValue;
    use swarm_core::events::{FileWrittenPayload, Provenance, SwarmEvent, SystemLogPayload};

    use super::*;

    fn persisted(seq: u64) -> DomainEvent {
        DomainEvent {
            seq,
            ts: 0,
            origin_worker: None,
            cause_seq: None,
            event: SwarmEvent::FileWritten(FileWrittenPayload {
                path: format!("/tmp/{seq}"),
                bytes: 1,
            }),
        }
    }

    fn ephemeral(seq: u64) -> DomainEvent {
        DomainEvent {
            seq,
            ts: 0,
            origin_worker: None,
            cause_seq: None,
            event: SwarmEvent::SystemLog(SystemLogPayload {
                level: "info".to_owned(),
                message: format!("tick {seq}"),
                target: "test".to_owned(),
                timestamp: 0,
            }),
        }
    }

    /// A file-backed log holding `seqs` as persisted events.
    fn log_with(dir: &Path, seqs: impl IntoIterator<Item = u64>) -> PathBuf {
        let path = dir.join("events.db");
        let mut log = EventLog::open(&path).unwrap();
        for seq in seqs {
            let event = persisted(seq);
            let tagged = serde_json::to_value(&event.event).unwrap();
            log.append(
                seq,
                0,
                tagged["type"].as_str().unwrap(),
                &tagged["payload"].to_string(),
                &Provenance::default(),
            )
            .unwrap();
        }
        path
    }

    /// Everything the feeder put on the lane so far, as (`seq` or `None` for
    /// control frames, `frame` tag).
    fn drain(rx: &mut mpsc::Receiver<Utf8Bytes>) -> Vec<(Option<u64>, Option<String>)> {
        std::iter::from_fn(|| rx.try_recv().ok())
            .map(|text| {
                let value: Value = serde_json::from_str(&text).unwrap();
                (
                    value["seq"].as_u64(),
                    value["frame"].as_str().map(str::to_owned),
                )
            })
            .collect()
    }

    fn seqs(frames: &[(Option<u64>, Option<String>)]) -> Vec<u64> {
        frames
            .iter()
            .filter(|(_, frame)| frame.is_none())
            .filter_map(|(seq, _)| *seq)
            .collect()
    }

    /// The text of every message a writer produced, in wire order.
    fn texts(written: &[Message]) -> Vec<&str> {
        written
            .iter()
            .map(|message| match message {
                Message::Text(text) => text.as_str(),
                Message::Close(_) => "<close>",
                other => panic!("unexpected message {other:?}"),
            })
            .collect()
    }

    /// An `rpcResult` queued behind a flood of events is written first, and
    /// the events keep their order after it. The writer used to serve the
    /// event lane first, so the result waited for the whole flood to drain.
    #[tokio::test]
    async fn test_writer_serves_rpc_results_before_a_queued_event_flood() {
        const FLOOD: usize = 1000;
        let (events_tx, events_rx) = mpsc::channel(EVENT_LANE_CAPACITY);
        let (control_tx, control_rx) = mpsc::channel(CONTROL_LANE_CAPACITY);
        for seq in 0..FLOOD {
            events_tx
                .try_send(Utf8Bytes::from(format!("event {seq}")))
                .unwrap();
        }
        control_tx
            .try_send(Message::Text("rpcResult".into()))
            .unwrap();
        drop((events_tx, control_tx));

        let mut written = Vec::new();
        write_frames(&mut written, events_rx, control_rx)
            .await
            .unwrap();
        let written = texts(&written);
        assert_eq!(written.len(), FLOOD + 1);
        assert_eq!(written[0], "rpcResult", "the control lane goes first");
        let events: Vec<_> = (0..FLOOD).map(|seq| format!("event {seq}")).collect();
        assert_eq!(written[1..], events, "events keep their FIFO order");
    }

    /// A close frame on the control lane ends the writer at once, without
    /// first draining the queued events.
    #[tokio::test]
    async fn test_writer_stops_after_a_close_frame() {
        let (events_tx, events_rx) = mpsc::channel(EVENT_LANE_CAPACITY);
        let (control_tx, control_rx) = mpsc::channel(CONTROL_LANE_CAPACITY);
        for seq in 0..10 {
            events_tx
                .try_send(Utf8Bytes::from(seq.to_string()))
                .unwrap();
        }
        control_tx
            .try_send(close_message(close_code::AWAY, "Bye."))
            .unwrap();

        let mut written = Vec::new();
        write_frames(&mut written, events_rx, control_rx)
            .await
            .unwrap();
        assert_eq!(texts(&written), ["<close>"]);
    }

    fn ip(text: &str) -> IpAddr {
        text.parse().unwrap()
    }

    /// Each remote address gets its own share of handshake permits,
    /// v4-mapped spellings count as the IPv4 address, and dropped permits
    /// come back without leaving empty entries behind.
    #[test]
    fn test_peer_handshake_permits_are_capped_per_address() {
        let peers = PeerHandshakes::new(2);
        let a = ip("192.0.2.1");
        let first = peers.try_acquire(a).unwrap();
        let second = peers.try_acquire(a).unwrap();
        assert!(
            peers.try_acquire(a).is_err(),
            "the address's share is used up"
        );
        assert!(
            peers.try_acquire(ip("::ffff:192.0.2.1")).is_err(),
            "a v4-mapped spelling shares the IPv4 address's share"
        );
        assert!(
            peers.try_acquire(ip("192.0.2.2")).unwrap().is_some(),
            "other addresses are unaffected"
        );
        drop(first);
        let third = peers.try_acquire(a).expect("a dropped permit is returned");
        drop((second, third));
        assert!(peers.counts.lock().is_empty());
    }

    /// All addresses in an IPv6 `/64` share one share: a host cannot
    /// sidestep the cap by picking a fresh address per socket.
    #[test]
    fn test_ipv6_peers_are_counted_by_their_64() {
        let peers = PeerHandshakes::new(2);
        let _a = peers.try_acquire(ip("2001:db8:1:2::1")).unwrap();
        let _b = peers.try_acquire(ip("2001:db8:1:2:ffff::9")).unwrap();
        assert!(peers.try_acquire(ip("2001:db8:1:2:abcd::1")).is_err());
        assert!(
            peers.try_acquire(ip("2001:db8:1:3::1")).unwrap().is_some(),
            "the next /64 is another host"
        );
    }

    /// Loopback peers (every client of a local reverse proxy or `ssh -L`
    /// tunnel) take no per-address permit; only the pool bounds them. The
    /// cap used to put all of them in one bucket of
    /// `max_pending_handshakes_per_peer`.
    #[test]
    fn test_loopback_peers_have_no_per_address_share() {
        let peers = PeerHandshakes::new(1);
        for text in ["127.0.0.1", "127.0.0.2", "::1", "::ffff:127.0.0.1"] {
            for _ in 0..3 {
                assert!(peers.try_acquire(ip(text)).unwrap().is_none(), "{text}");
            }
        }
        assert!(peers.counts.lock().is_empty());
    }

    #[test]
    fn test_bearer_token_parsing() {
        let headers = |value: &'static str| {
            let mut headers = HeaderMap::new();
            headers.insert(header::AUTHORIZATION, HeaderValue::from_static(value));
            headers
        };
        assert_eq!(bearer_token(&headers("Bearer abc")), Some("abc"));
        assert_eq!(bearer_token(&headers("bearer abc")), Some("abc"));
        assert_eq!(bearer_token(&headers("Basic abc")), None);
        assert_eq!(bearer_token(&headers("Bearer")), None);
        assert_eq!(bearer_token(&HeaderMap::new()), None);
    }

    #[test]
    fn test_rpc_id_is_read_from_frames_that_otherwise_fail_to_parse() {
        assert_eq!(
            rpc_id(r#"{"frame":"rpc","id":"r1","cmd":7}"#),
            Some("r1".to_owned())
        );
        assert_eq!(rpc_id(r#"{"frame":"hello","id":"r1"}"#), None);
        assert_eq!(rpc_id(r#"{"frame":"rpc"}"#), None);
        assert_eq!(rpc_id("not json"), None);
    }

    /// A warm attach replays exactly the persisted events after `lastSeq`,
    /// then drops live events the replay already covered.
    #[tokio::test]
    async fn test_warm_attach_replays_then_deduplicates_live_events() {
        let dir = tempfile::tempdir().unwrap();
        let path = log_with(dir.path(), 1..=5);
        let (live_tx, live_rx) = broadcast::channel(16);
        for seq in 4..=6 {
            live_tx.send(Arc::new(persisted(seq))).unwrap();
        }
        let (tx, mut rx) = mpsc::channel(64);
        let feeder = tokio::spawn(feed(live_rx, Some(path), Some(2), 5, tx, 2));
        tokio::task::yield_now().await;
        drop(live_tx);
        assert!(matches!(feeder.await.unwrap(), FeedEnd::EngineStopped));

        let frames = drain(&mut rx);
        assert_eq!(seqs(&frames), [3, 4, 5, 6]);
        let replay_end = frames
            .iter()
            .position(|(_, frame)| frame.as_deref() == Some("replayEnd"))
            .unwrap();
        assert_eq!(
            replay_end, 3,
            "replayEnd follows the replayed events: {frames:?}"
        );
        assert_eq!(frames[replay_end].0, Some(5));
    }

    /// A receiver that lagged the fanout is healed from the log, with no gap
    /// and no duplicate.
    #[tokio::test]
    async fn test_lagged_receiver_heals_by_replay() {
        let dir = tempfile::tempdir().unwrap();
        let path = log_with(dir.path(), 1..=10);
        let (live_tx, live_rx) = broadcast::channel(2);
        for seq in 1..=10 {
            live_tx.send(Arc::new(persisted(seq))).unwrap();
        }
        let (tx, mut rx) = mpsc::channel(64);
        let feeder = tokio::spawn(feed(live_rx, Some(path), None, 0, tx, 3));
        tokio::task::yield_now().await;
        drop(live_tx);
        assert!(matches!(feeder.await.unwrap(), FeedEnd::EngineStopped));
        assert_eq!(seqs(&drain(&mut rx)), (1..=10).collect::<Vec<_>>());
    }

    /// A replay that cannot read the log is a failure, never a silent
    /// "caught up".
    #[tokio::test]
    async fn test_unreadable_log_fails_the_replay() {
        let dir = tempfile::tempdir().unwrap();
        let missing = dir.path().join("missing").join("events.db");
        let (_live_tx, live_rx) = broadcast::channel(2);
        let (tx, mut rx) = mpsc::channel(8);
        let end = feed(live_rx, Some(missing), Some(0), 0, tx, 10).await;
        assert!(matches!(end, FeedEnd::Replay(_)), "{end:?}");
        assert!(
            drain(&mut rx).is_empty(),
            "no replayEnd after a failed replay"
        );
    }

    #[tokio::test]
    async fn test_ephemeral_events_are_dropped_above_the_watermark() {
        let (tx, mut rx) = mpsc::channel(EPHEMERAL_WATERMARK * 2);
        for seq in 0..EPHEMERAL_WATERMARK as u64 + 10 {
            forward(&ephemeral(seq), &tx).await.unwrap();
        }
        forward(&persisted(9999), &tx).await.unwrap();
        let frames = drain(&mut rx);
        assert_eq!(frames.len(), EPHEMERAL_WATERMARK + 1);
        assert_eq!(
            frames.last().unwrap().0,
            Some(9999),
            "persistent events are never dropped"
        );
    }

    /// Terminal keystroke echoes are ephemeral: on a full lane they are
    /// dropped instead of blocking the feeder, while machine-issued input
    /// is persistent and waits for room.
    #[tokio::test]
    async fn test_terminal_worker_input_rides_the_ephemeral_lane() {
        use swarm_core::events::{InputSource, WorkerInputPayload};
        let input = |seq, source| DomainEvent {
            event: SwarmEvent::WorkerInput(WorkerInputPayload {
                worker_id: uuid::Uuid::nil(),
                bytes: 1,
                source,
                preview: None,
            }),
            ..persisted(seq)
        };
        let (tx, _rx) = mpsc::channel(EPHEMERAL_WATERMARK);
        for seq in 0..EPHEMERAL_WATERMARK as u64 {
            tx.try_send(Utf8Bytes::from(seq.to_string())).unwrap();
        }
        let wait = Duration::from_millis(100);
        let terminal =
            tokio::time::timeout(wait, forward(&input(1, InputSource::Terminal), &tx)).await;
        assert!(
            matches!(terminal, Ok(Ok(()))),
            "terminal input must not block"
        );
        let tool = tokio::time::timeout(wait, forward(&input(2, InputSource::Tool), &tx)).await;
        assert!(
            tool.is_err(),
            "machine-issued input waits for room on the lane"
        );
    }
}
