//! The WebSocket transport: one connection per client, `hello` ->
//! `ready` -> (optional replay) -> `replayEnd` -> live, with `rpc`
//! request/response interleaved throughout. Headless-daemon plan Phase
//! 2 items 3-9.
//!
//! # `stream_from` — one routine, every caller
//!
//! [`stream_from`] is called exactly once per connection (after
//! `hello`) and again, inline, every time the live broadcast receiver
//! reports [`broadcast::error::RecvError::Lagged`] — "the same routine
//! heals broadcast Lagged" per the plan. It always:
//!
//! 1. Pages `events_since(cursor, PAGE_SIZE)` from SQLite (skipped
//!    entirely for a cold `hello` — `lastSeq: None` — see the plan's
//!    "null lastSeq = snapshot hydration" decision).
//! 2. Advances `cursor` to the last seq actually sent.
//!
//! The caller subscribes to the broadcast channel BEFORE calling this
//! (never after) — so there is no hole between "read the snapshot" and
//! "start receiving live events": anything published while the SQLite
//! pages are being read is already buffered in the subscriber's
//! channel, and the live-forwarding loop's own `seq > cursor` filter
//! (in [`forward_live`]) discards whatever the replay already covered,
//! rather than the replay needing to somehow know the exact live
//! cutoff in advance.
//!
//! # Two-lane backpressure
//!
//! Every outgoing frame is classified [`Lane::Persistent`] or
//! [`Lane::Ephemeral`] by [`crate::ws::lane_for`]. The persistent lane
//! is an effectively-unbounded queue (blocks the CONNECTION on
//! backpressure, never the engine — the feeder task awaits `send`).
//! The ephemeral lane is bounded and uses `try_send`: above the
//! watermark, the NEWEST arrival is dropped (the channel is full, so
//! the item that can't fit is always the one just produced) —
//! `worker_output`/`system_metrics`/`system_log`/`agent_turn_delta`/
//! terminal `worker_input` never back up the writer, they degrade to
//! choppy/sparse instead.

use std::net::SocketAddr;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{ConnectInfo, State};
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{IntoResponse, Response};
use futures_util::{SinkExt, StreamExt};
use tokio::sync::{broadcast, mpsc};

use swarm_core::commands::Ctx;
use swarm_core::orchestration::DomainEvent;
use swarm_core::protocol::{ClientFrame, PROTOCOL_VERSION, ServerCaps, ServerFrame};

use crate::AppState;
use crate::auth;

/// Bound on the ephemeral lane — small on purpose: this is a queue of
/// frames waiting to be WRITTEN to a socket, not a data store. Above
/// this, newest-arrival drop kicks in.
const EPHEMERAL_LANE_CAPACITY: usize = 256;

/// Replay page size, matching [`swarm_core::commands::orchestration::PAGE_LIMIT`].
const REPLAY_PAGE_SIZE: u32 = 5000;

/// How long a connection has to send `hello` (with a valid token, if
/// not already Bearer-authenticated at upgrade time) before the socket
/// is closed.
const HANDSHAKE_DEADLINE: Duration = Duration::from_secs(5);

#[derive(Clone, Copy, PartialEq, Eq)]
enum Lane {
    Persistent,
    Ephemeral,
}

/// Classifies a domain event's wire lane by its `type` tag — mirrors
/// [`swarm_core::orchestration::is_persistent`]'s own ephemeral set,
/// plus terminal (human-keystroke) `worker_input`, which the log itself
/// never persists either (see that function's doc) so it is a natural
/// fit for the same "may be dropped" lane.
fn lane_for(event_type: &str) -> Lane {
    match event_type {
        "worker_output" | "system_metrics" | "system_log" | "agent_turn_delta" => Lane::Ephemeral,
        _ => Lane::Persistent,
    }
}

/// `GET /ws` — the single upgrade endpoint.
pub async fn ws_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    ConnectInfo(_peer): ConnectInfo<SocketAddr>,
    ws: WebSocketUpgrade,
) -> Response {
    let host = headers.get(header::HOST).and_then(|v| v.to_str().ok());
    let origin = headers.get(header::ORIGIN).and_then(|v| v.to_str().ok());
    if let Err(reason) = auth::validate_upgrade_headers(host, origin, &state.bind_host_port) {
        return (StatusCode::FORBIDDEN, reason).into_response();
    }

    if state.active_connections.load(Ordering::SeqCst) >= state.caps.max_connections {
        return (StatusCode::SERVICE_UNAVAILABLE, "Too Many Connections.").into_response();
    }

    // A valid `Authorization: Bearer <token>` header pre-authenticates
    // the connection — `hello` is then only needed for `lastSeq`, not
    // for its `token` field. Any other value (missing, malformed,
    // wrong) leaves authentication to `hello` within the handshake
    // deadline; it is NOT itself a rejection (a client may simply be
    // using the hello-carries-token path instead).
    let bearer_pre_authed = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .map(|candidate| state.token.matches(candidate))
        .unwrap_or(false);

    ws.max_frame_size(state.caps.max_frame_bytes)
        .on_upgrade(move |socket| handle_socket(socket, state, bearer_pre_authed))
}

async fn handle_socket(socket: WebSocket, state: AppState, bearer_pre_authed: bool) {
    state.active_connections.fetch_add(1, Ordering::SeqCst);
    let _decrement_on_drop = ConnectionGuard(state.active_connections.clone());

    let (mut sender, mut receiver) = socket.split();

    // ── Handshake: hello -> auth -> ready ───────────────────────────
    let hello = match tokio::time::timeout(HANDSHAKE_DEADLINE, receiver.next()).await {
        Ok(Some(Ok(Message::Text(text)))) => serde_json::from_str::<ClientFrame>(&text).ok(),
        _ => None,
    };

    let ClientFrame::Hello { last_seq, token } = hello.unwrap_or(ClientFrame::Hello {
        last_seq: None,
        token: None,
    }) else {
        let _ = sender
            .send(Message::Close(Some(axum::extract::ws::CloseFrame {
                code: 1008,
                reason: "Expected `hello` As The First Frame.".into(),
            })))
            .await;
        return;
    };

    let authed = bearer_pre_authed || token.as_deref().is_some_and(|t| state.token.matches(t));
    if !authed {
        let _ = sender
            .send(Message::Close(Some(axum::extract::ws::CloseFrame {
                code: 4401,
                reason: "Unauthorized.".into(),
            })))
            .await;
        return;
    }

    // Subscribe BEFORE reading SQLite — no hole between snapshot and
    // live cutover (see module doc).
    let mut broadcast_rx = state.ctx.engine.subscribe();
    let server_seq = current_max_seq(&state.ctx);

    let (persistent_tx, mut persistent_rx) = mpsc::channel::<String>(4096);
    let (ephemeral_tx, mut ephemeral_rx) = mpsc::channel::<String>(EPHEMERAL_LANE_CAPACITY);
    let (control_tx, mut control_rx) = mpsc::unbounded_channel::<String>();

    // `ready` goes on the PERSISTENT lane, not the separate `control_tx`
    // channel — see the `feeder` task below for why: `replayEnd` and
    // every replayed `event` frame must arrive in that exact relative
    // order, which is only guaranteed by putting them on the SAME
    // ordered channel. `ready` itself has no such constraint (it is
    // always first), but sharing the lane keeps one mental model for
    // "everything that must preserve wire order relative to events."
    let ready = ServerFrame::Ready {
        server_seq,
        version: PROTOCOL_VERSION,
        caps: state.caps.clone(),
    };
    if persistent_tx
        .send(serde_json::to_string(&ready).unwrap())
        .await
        .is_err()
    {
        return;
    }

    // ── Writer task: drains all three lanes onto the socket ────────
    let writer = tokio::spawn(async move {
        loop {
            tokio::select! {
                biased;
                Some(frame) = control_rx.recv() => {
                    if sender.send(Message::Text(frame.into())).await.is_err() { break; }
                }
                Some(frame) = persistent_rx.recv() => {
                    if sender.send(Message::Text(frame.into())).await.is_err() { break; }
                }
                Some(frame) = ephemeral_rx.recv() => {
                    if sender.send(Message::Text(frame.into())).await.is_err() { break; }
                }
                else => break,
            }
        }
    });

    // ── Feeder task: replay (if warm) + live forwarding with Lagged healing ──
    let feed_ctx = state.ctx.clone();
    let feed_persistent = persistent_tx.clone();
    let feed_ephemeral = ephemeral_tx.clone();
    let feeder = tokio::spawn(async move {
        let mut cursor = if last_seq.is_some() {
            last_seq.unwrap_or(0)
        } else {
            server_seq
        };
        if last_seq.is_some() {
            cursor = replay_from(&feed_ctx, cursor, &feed_persistent).await;
        }
        // `replayEnd` MUST be sent on the SAME persistent lane the
        // replayed events themselves used — not the separate unbounded
        // `control_tx` channel. Two independent mpsc channels give no
        // ordering guarantee relative to each other once both have
        // pending items (a `biased` `select!` in the writer task always
        // drains `control_rx` first when both are ready, which — since
        // `replayEnd` is enqueued only microseconds after the last
        // replayed event — could otherwise deliver `replayEnd` to the
        // client BEFORE some of the events it claims to conclude,
        // corrupting the client's gap/backfill bookkeeping). Reproduced
        // by this crate's `test_reconnect_with_last_seq_replays_exactly_the_missed_events`
        // integration test before this fix.
        let _ = feed_persistent
            .send(serde_json::to_string(&ServerFrame::ReplayEnd { seq: cursor }).unwrap())
            .await;

        loop {
            match broadcast_rx.recv().await {
                Ok(envelope) => {
                    cursor =
                        forward_one(&envelope, cursor, &feed_persistent, &feed_ephemeral).await;
                }
                Err(broadcast::error::RecvError::Lagged(n)) => {
                    tracing::warn!(
                        skipped = n,
                        cursor,
                        "WS connection lagged the broadcast fanout — healing via replay"
                    );
                    cursor = replay_from(&feed_ctx, cursor, &feed_persistent).await;
                }
                Err(broadcast::error::RecvError::Closed) => break,
            }
        }
    });

    // ── Reader loop: this task's own life IS the connection's life —
    // rpc frames dispatched inline, exits on socket close ───────────
    let rpc_ctx = state.ctx.clone();
    let rpc_registry = state.registry.clone();
    let rpc_control = control_tx.clone();
    loop {
        match receiver.next().await {
            Some(Ok(Message::Text(text))) => match serde_json::from_str::<ClientFrame>(&text) {
                Ok(ClientFrame::Rpc { id, cmd, args }) => {
                    let ctx = rpc_ctx.clone();
                    let registry = rpc_registry.clone();
                    let control = rpc_control.clone();
                    let secret_denied = cmd == "read_config" && is_secret_read(&args);
                    tokio::spawn(async move {
                        let result = if secret_denied {
                            Err(serde_json::json!(
                                "Remote Read Of Secret Config Keys Is Denied."
                            ))
                        } else {
                            registry.dispatch(&cmd, ctx, args).await
                        };
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
                        let _ = control.send(serde_json::to_string(&frame).unwrap());
                    });
                }
                Ok(ClientFrame::Hello { .. }) => {
                    // Only the first frame may be `hello` — a second one
                    // on the same live socket is a protocol error the
                    // client should never send (reconnect = new socket).
                    tracing::warn!(
                        "received a second `hello` on an already-live connection; ignoring"
                    );
                }
                Err(e) => tracing::warn!(error = %e, "malformed client frame"),
            },
            Some(Ok(Message::Close(_))) | None => break,
            Some(Ok(_)) => {} // ping/pong/binary — ignored
            Some(Err(e)) => {
                tracing::debug!(error = %e, "WS receive error, closing connection");
                break;
            }
        }
    }

    writer.abort();
    feeder.abort();
}

/// `true` when `args` names a secret-shaped `read_config` key — see
/// [`swarm_core::commands::config::is_secret_key`]'s doc for why this
/// gate lives here (the network boundary) rather than in the shared
/// registry handler.
fn is_secret_read(args: &serde_json::Value) -> bool {
    args.get("key")
        .and_then(|v| v.as_str())
        .is_some_and(swarm_core::commands::config::is_secret_key)
}

fn current_max_seq(ctx: &Ctx) -> u64 {
    match ctx.engine.db_path() {
        Some(path) => swarm_core::orchestration::EventLog::open_readonly(path)
            .and_then(|l| l.max_seq())
            .unwrap_or(0),
        None => 0,
    }
}

/// Pages `events_since(cursor, REPLAY_PAGE_SIZE)` until a short page
/// arrives, sending each row (always on the persistent lane — replay
/// must never drop) and returning the new cursor (the highest seq
/// actually sent, or the original `cursor` if there was nothing to
/// replay).
async fn replay_from(ctx: &Ctx, mut cursor: u64, persistent_tx: &mpsc::Sender<String>) -> u64 {
    loop {
        let ctx2 = ctx.clone();
        let page = tokio::task::spawn_blocking(move || {
            let Some(path) = ctx2.engine.db_path().map(std::path::Path::to_path_buf) else {
                return Vec::new();
            };
            match swarm_core::orchestration::EventLog::open_readonly(&path)
                .and_then(|l| l.events_since(cursor, REPLAY_PAGE_SIZE))
            {
                Ok(rows) => rows,
                Err(e) => {
                    tracing::error!(error = %e, cursor, "replay page read failed");
                    Vec::new()
                }
            }
        })
        .await
        .unwrap_or_default();

        let page_len = page.len();
        for stored in page {
            let seq = stored.seq;
            let json = swarm_core::commands::orchestration::stored_event_to_json(stored);
            if persistent_tx
                .send(serde_json::to_string(&json).unwrap())
                .await
                .is_err()
            {
                return cursor;
            }
            cursor = seq;
        }

        if (page_len as u32) < REPLAY_PAGE_SIZE {
            break;
        }
    }
    cursor
}

/// Forwards one live [`DomainEvent`] if it is newer than `cursor`
/// (dedupe against whatever replay/a prior lag-heal already sent),
/// routing it to the correct lane. Returns the new cursor.
async fn forward_one(
    envelope: &Arc<DomainEvent>,
    cursor: u64,
    persistent_tx: &mpsc::Sender<String>,
    ephemeral_tx: &mpsc::Sender<String>,
) -> u64 {
    if envelope.seq <= cursor {
        return cursor;
    }
    let json = serde_json::to_string(envelope.as_ref()).unwrap();
    let event_type = envelope_type(envelope);
    match lane_for(&event_type) {
        Lane::Persistent => {
            // Blocks the CONNECTION (never the engine) — exactly the
            // plan's backpressure contract.
            let _ = persistent_tx.send(json).await;
        }
        Lane::Ephemeral => {
            // Newest-first drop above the watermark.
            let _ = ephemeral_tx.try_send(json);
        }
    }
    envelope.seq
}

fn envelope_type(envelope: &DomainEvent) -> String {
    serde_json::to_value(&envelope.event)
        .ok()
        .and_then(|v| v.get("type").and_then(|t| t.as_str()).map(str::to_string))
        .unwrap_or_default()
}

struct ConnectionGuard(Arc<AtomicUsize>);
impl Drop for ConnectionGuard {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::SeqCst);
    }
}

pub(crate) fn default_caps() -> ServerCaps {
    ServerCaps {
        max_frame_bytes: 2 * 1024 * 1024,
        max_connections: 32,
        replay_page_size: REPLAY_PAGE_SIZE,
    }
}
