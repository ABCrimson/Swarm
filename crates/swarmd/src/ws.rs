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
//! (in [`forward_one`]) discards whatever the replay already covered,
//! rather than the replay needing to somehow know the exact live
//! cutoff in advance.
//!
//! # ONE ordered lane for ready/replayEnd/events (security-review FIX-3)
//!
//! `ready`, `replayEnd`, and every `event` frame (replayed or live) ride
//! the SAME bounded, FIFO `mpsc` channel (`event_tx`/`event_rx`) — this
//! is the only way to guarantee wire order matches seq order. An
//! earlier three-channel design (separate control/persistent/ephemeral
//! lanes, `select!`-merged in the writer task) let wire order diverge
//! from seq order even for events that both landed on the "persistent"
//! lane, whenever a live event and a lag-heal replay page raced across
//! the `select!` — a client backfilling a gap, seeing the OUT-of-order
//! seq, would advance `lastSeq` past a later-arriving-but-lower-seq
//! frame and silently treat it as already-seen, discarding real PTY
//! output. The fix collapses persistent + replay/control-that-carries-a-seq
//! onto ONE lane; only `rpcResult` (which carries no seq and has no
//! ordering relationship to the event stream) keeps a separate lane.
//!
//! Backpressure still has two behaviors, now expressed as two ENQUEUE
//! functions over the ONE lane rather than two lanes: persistent frames
//! (replay, and any live event whose type isn't in [`lane_for`]'s
//! ephemeral set) always enqueue — blocking the CONNECTION, never the
//! engine, if the lane is full. Ephemeral frames
//! (`worker_output`/`system_metrics`/`system_log`/`agent_turn_delta`/
//! terminal `worker_input`) are dropped newest-first once the lane's
//! OCCUPIED length reaches [`EPHEMERAL_WATERMARK`] (below the lane's
//! full [`EVENT_LANE_CAPACITY`], reserving headroom so an ephemeral
//! flood can never fully starve a persistent frame's `send().await` of
//! room) — but anything that DOES get enqueued keeps its FIFO position,
//! so wire order among enqueued frames is always seq order.

use std::mem::DropGuard;
use std::net::SocketAddr;
use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::time::Duration;

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{ConnectInfo, State};
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{IntoResponse, Response};
use futures_util::{SinkExt, StreamExt};
use tokio::sync::{Semaphore, broadcast, mpsc};

use swarm_core::commands::Ctx;
use swarm_core::orchestration::DomainEvent;
use swarm_core::protocol::{ClientFrame, PROTOCOL_VERSION, ServerCaps, ServerFrame};

use crate::AppState;
use crate::auth;

/// Total capacity of the single ordered event lane (`ready`/`replayEnd`/
/// `event`). This is a queue of frames awaiting write to the socket,
/// not a data store — sized generously so a real replay burst never
/// spuriously blocks, while still bounding memory under a genuinely
/// wedged connection.
const EVENT_LANE_CAPACITY: usize = 4096;

/// Once the event lane's OCCUPIED length reaches this, new ephemeral
/// frames are dropped (newest-first) instead of enqueued — see the
/// module doc. Deliberately well below [`EVENT_LANE_CAPACITY`] so a
/// burst of ephemeral traffic can never consume the headroom a
/// persistent frame's blocking `send().await` needs.
const EPHEMERAL_WATERMARK: usize = 512;

/// Bound on the separate `rpcResult` lane (security-review FIX-4 — the
/// prior unbounded channel let an unbounded number of in-flight RPC
/// tasks queue results with nothing to slow them down).
const CONTROL_LANE_CAPACITY: usize = 256;

/// Cap on concurrently in-flight `rpc` tasks per connection
/// (security-review FIX-4). Above this, a NEW `rpc` frame is answered
/// immediately with a typed busy `rpcResult` rather than spawning an
/// unbounded number of tasks per malicious/misbehaving client.
const MAX_CONCURRENT_RPC_PER_CONNECTION: usize = 8;

/// Replay page size, matching [`swarm_core::commands::orchestration::PAGE_LIMIT`].
const REPLAY_PAGE_SIZE: u32 = 5000;

/// How long a connection has to send `hello` (with a valid token, if
/// not already Bearer-authenticated at upgrade time) before the socket
/// is closed. Enforced for BOTH auth paths (security-review FIX-5) — a
/// Bearer-pre-authed connection that never sends a `hello` at all would
/// otherwise hang forever with no `ready`/replay ever delivered.
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
/// fit for the same "may be dropped" class.
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
    let _decrement_on_drop = DropGuard::new(Arc::clone(&state.active_connections), |count| {
        count.fetch_sub(1, Ordering::SeqCst);
    });

    let (mut sender, mut receiver) = socket.split();

    // ── Handshake: hello -> auth -> ready, bounded for EVERY caller,
    // Bearer-pre-authed included (security-review FIX-5: a
    // pre-authed-but-hello-less connection used to hang forever). ────
    let hello = match tokio::time::timeout(HANDSHAKE_DEADLINE, receiver.next()).await {
        Ok(Some(Ok(Message::Text(text)))) => serde_json::from_str::<ClientFrame>(&text).ok(),
        _ => None,
    };

    let Some(ClientFrame::Hello { last_seq, token }) = hello else {
        let _ = sender
            .send(Message::Close(Some(axum::extract::ws::CloseFrame {
                code: 1008,
                reason: "Expected `hello` Within The Handshake Deadline.".into(),
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

    let (event_tx, mut event_rx) = mpsc::channel::<String>(EVENT_LANE_CAPACITY);
    let (control_tx, mut control_rx) = mpsc::channel::<String>(CONTROL_LANE_CAPACITY);

    // `ready` goes on the SAME ordered event lane as everything that
    // follows it (replay, then live) — see the module doc's FIX-3 note.
    let ready = ServerFrame::Ready {
        server_seq,
        version: PROTOCOL_VERSION,
        caps: state.caps.clone(),
    };
    if !enqueue_persistent(&event_tx, serde_json::to_string(&ready).unwrap()).await {
        return;
    }

    // ── Writer task: drains the event lane and the control lane ────
    let writer = tokio::spawn(async move {
        loop {
            tokio::select! {
                biased;
                Some(frame) = event_rx.recv() => {
                    if sender.send(Message::Text(frame.into())).await.is_err() { break; }
                }
                Some(frame) = control_rx.recv() => {
                    if sender.send(Message::Text(frame.into())).await.is_err() { break; }
                }
                else => break,
            }
        }
    });

    // ── Feeder task: replay (if warm) + live forwarding with Lagged healing ──
    let feed_ctx = state.ctx.clone();
    let feed_event_tx = event_tx.clone();
    let feeder = tokio::spawn(async move {
        let mut cursor = if last_seq.is_some() {
            last_seq.unwrap_or(0)
        } else {
            server_seq
        };
        if last_seq.is_some() {
            cursor = replay_from(&feed_ctx, cursor, &feed_event_tx).await;
        }
        // `replayEnd` shares the event lane with the replayed events it
        // concludes — FIFO on one channel is what makes this ordering
        // guarantee unconditional (see the module doc's FIX-3 note).
        let _ = enqueue_persistent(
            &feed_event_tx,
            serde_json::to_string(&ServerFrame::ReplayEnd { seq: cursor }).unwrap(),
        )
        .await;

        loop {
            match broadcast_rx.recv().await {
                Ok(envelope) => {
                    cursor = forward_one(&envelope, cursor, &feed_event_tx).await;
                }
                Err(broadcast::error::RecvError::Lagged(n)) => {
                    tracing::warn!(
                        skipped = n,
                        cursor,
                        "WS connection lagged the broadcast fanout — healing via replay"
                    );
                    cursor = replay_from(&feed_ctx, cursor, &feed_event_tx).await;
                }
                Err(broadcast::error::RecvError::Closed) => break,
            }
        }
    });

    // ── Reader loop: this task's own life IS the connection's life —
    // rpc frames dispatched inline (capped concurrency), exits on
    // socket close ───────────────────────────────────────────────────
    let rpc_ctx = state.ctx.clone();
    let rpc_registry = state.registry.clone();
    let rpc_control = control_tx.clone();
    let rpc_semaphore = Arc::new(Semaphore::new(MAX_CONCURRENT_RPC_PER_CONNECTION));
    loop {
        match receiver.next().await {
            Some(Ok(Message::Text(text))) => match serde_json::from_str::<ClientFrame>(&text) {
                Ok(ClientFrame::Rpc { id, cmd, args }) => {
                    let control = rpc_control.clone();
                    match Arc::clone(&rpc_semaphore).try_acquire_owned() {
                        Ok(permit) => {
                            let ctx = rpc_ctx.clone();
                            let registry = rpc_registry.clone();
                            tokio::spawn(async move {
                                let _permit = permit; // held until this task ends
                                // BLOCK-1 fix: dispatch_remote, never
                                // dispatch — the registry's declared
                                // RemotePolicy is consulted for every
                                // command, never a `cmd == "..."` string
                                // check at this call site.
                                let result = registry.dispatch_remote(&cmd, ctx, args).await;
                                send_rpc_result(&control, id, result).await;
                            });
                        }
                        Err(_) => {
                            send_rpc_result(
                                &control,
                                id,
                                Err(serde_json::json!(
                                    "Too Many Concurrent RPC Calls On This Connection."
                                )),
                            )
                            .await;
                        }
                    }
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

async fn send_rpc_result(
    control: &mpsc::Sender<String>,
    id: String,
    result: Result<serde_json::Value, serde_json::Value>,
) {
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
    // Bounded, blocking send: a congested control lane slows this RPC
    // task down rather than silently dropping the client's correlated
    // response (which the client has no other way to recover — see
    // `wsTransport`'s pending-map, which would otherwise wait out its
    // own 30s timeout for nothing).
    let _ = control.send(serde_json::to_string(&frame).unwrap()).await;
}

fn current_max_seq(ctx: &Ctx) -> u64 {
    match ctx.engine.db_path() {
        Some(path) => swarm_core::orchestration::EventLog::open_readonly(path)
            .and_then(|l| l.max_seq())
            .unwrap_or(0),
        None => 0,
    }
}

/// Enqueues `frame` onto the event lane, ALWAYS — blocking the
/// connection (never dropping) if the lane is momentarily full. Used
/// for `ready`, `replayEnd`, every replayed event, and every live event
/// NOT classified [`Lane::Ephemeral`]. Returns `false` if the lane's
/// receiver is gone (connection torn down).
async fn enqueue_persistent(event_tx: &mpsc::Sender<String>, frame: String) -> bool {
    event_tx.send(frame).await.is_ok()
}

/// Enqueues `frame` onto the event lane UNLESS the lane's occupied
/// length has already reached [`EPHEMERAL_WATERMARK`], in which case
/// this arrival is dropped (newest-first — it is, by construction, the
/// newest thing anyone tried to enqueue). Never blocks.
fn enqueue_ephemeral(event_tx: &mpsc::Sender<String>, frame: String) {
    let occupied = EVENT_LANE_CAPACITY.saturating_sub(event_tx.capacity());
    if occupied >= EPHEMERAL_WATERMARK {
        return; // dropped
    }
    let _ = event_tx.try_send(frame);
}

/// Pages `events_since(cursor, REPLAY_PAGE_SIZE)` until a short page
/// arrives, sending each row (always via [`enqueue_persistent`] — replay
/// must never drop) and returning the new cursor (the highest seq
/// actually sent, or the original `cursor` if there was nothing to
/// replay).
async fn replay_from(ctx: &Ctx, mut cursor: u64, event_tx: &mpsc::Sender<String>) -> u64 {
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
            if !enqueue_persistent(event_tx, serde_json::to_string(&json).unwrap()).await {
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
/// routing it onto the event lane via the enqueue function matching its
/// lane classification. Returns the new cursor.
async fn forward_one(
    envelope: &Arc<DomainEvent>,
    cursor: u64,
    event_tx: &mpsc::Sender<String>,
) -> u64 {
    if envelope.seq <= cursor {
        return cursor;
    }
    let json = serde_json::to_string(envelope.as_ref()).unwrap();
    let event_type = envelope_type(envelope);
    match lane_for(&event_type) {
        Lane::Persistent => {
            let _ = enqueue_persistent(event_tx, json).await;
        }
        Lane::Ephemeral => {
            enqueue_ephemeral(event_tx, json);
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

pub(crate) fn default_caps() -> ServerCaps {
    ServerCaps {
        max_frame_bytes: 2 * 1024 * 1024,
        max_connections: 32,
        replay_page_size: REPLAY_PAGE_SIZE,
    }
}
