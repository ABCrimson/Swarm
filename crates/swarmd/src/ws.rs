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

mod admission;
mod feed;
mod writer;

use std::net::SocketAddr;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use axum::extract::ws::{CloseFrame, Message, Utf8Bytes, WebSocket, WebSocketUpgrade, close_code};
use axum::extract::{ConnectInfo, State};
use axum::http::HeaderMap;
use axum::response::Response;
use futures_util::stream::{SplitSink, SplitStream};
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use serde_json::Value;
use tokio::sync::{Semaphore, mpsc};
use tokio::task::JoinSet;

use swarm_core::commands::orchestration::PAGE_LIMIT;
#[cfg(doc)]
use swarm_core::orchestration::is_persistent;
use swarm_core::protocol::{ClientFrame, PROTOCOL_VERSION, ServerFrame};

pub(crate) use self::admission::PeerHandshakes;
use self::admission::{Admission, bearer_token, refuse};
use self::feed::{FeedEnd, feed};
use self::writer::write_frames;
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

/// Capacity of the control lane (`rpcResult` and close frames).
const CONTROL_LANE_CAPACITY: usize = 256;

/// In-flight `rpc` tasks allowed per connection.
const MAX_CONCURRENT_RPC_PER_CONNECTION: usize = 8;

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

/// Why a connection's writer or feeder task ended.
enum Ended {
    Writer(Result<(), axum::Error>),
    Feeder(FeedEnd),
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
        Ok(Err(HelloError::Failed(error))) => {
            tracing::debug!(%peer, %error, "WebSocket receive failed before `hello`");
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
    /// The client closed the connection.
    Gone,
    /// Receiving failed (an oversized message, a protocol violation, a reset).
    Failed(axum::Error),
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
            Some(Ok(Message::Close(_))) | None => return Err(HelloError::Gone),
            Some(Err(error)) => return Err(HelloError::Failed(error)),
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

#[cfg(test)]
mod tests {
    use super::*;

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
}
