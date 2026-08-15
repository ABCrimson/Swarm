//! Integration test: drives a REAL `swarmd` axum server (in-process, on
//! an ephemeral loopback port) through a REAL `tokio-tungstenite` WS
//! client — hello -> ready -> replay -> replayEnd -> live -> rpc ->
//! rpcResult. Headless-daemon plan verification #2 ("Replay exact") and
//! #4 ("Auth matrix"), and the plan's explicit Phase 3 ask: "Rust:
//! integration test driving a real swarmd instance on an ephemeral port
//! through hello/replay/rpc round-trip."
//!
//! Uses the `swarmd` LIBRARY target (`src/lib.rs`) directly — no
//! subprocess spawn, so this runs at unit-test speed under `cargo test
//! -p swarmd` / CI.

use std::net::SocketAddr;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde_json::json;
use tokio::net::TcpListener;
use tokio_tungstenite::MaybeTlsStream;
use tokio_tungstenite::tungstenite::Message as WsMessage;

use swarm_core::Paths;
use swarm_core::protocol::{ClientFrame, ServerFrame};
use swarm_core::runtime::{Runtime, RuntimeConfig};
use swarmd::auth;

type WsStream = tokio_tungstenite::WebSocketStream<MaybeTlsStream<tokio::net::TcpStream>>;

struct TestServer {
    addr: SocketAddr,
    token: String,
    // Held for the test's duration — dropping releases the
    // single-instance lock and stops the runtime's background tasks
    // from mattering further.
    _runtime: Runtime,
}

async fn start_test_server() -> TestServer {
    let data_dir = std::env::temp_dir().join(format!("swarmd-it-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&data_dir).unwrap();

    let (token, _) = auth::DaemonToken::load_or_create(&data_dir).unwrap();

    let runtime = Runtime::start(
        RuntimeConfig {
            paths: Paths { data_dir },
            shell_name: "swarmd",
            bind: Some("127.0.0.1:0".to_string()),
        },
        |_| {},
    )
    .expect("runtime should start on a fresh temp data dir");

    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();

    let state = swarmd::build_state(
        &runtime,
        addr.to_string(),
        token.clone(),
        swarmd::default_caps(),
    );
    let app = swarmd::build_router(state, None).into_make_service_with_connect_info::<SocketAddr>();

    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });

    // Give the accept loop a beat to be ready (bind already succeeded
    // above, so this is generous, not load-bearing).
    tokio::time::sleep(Duration::from_millis(20)).await;

    TestServer {
        addr,
        token: token.as_str().to_string(),
        _runtime: runtime,
    }
}

async fn connect(server: &TestServer) -> WsStream {
    let url = format!("ws://{}/ws", server.addr);
    let (stream, _resp) = tokio_tungstenite::connect_async(url)
        .await
        .expect("WS connect should succeed");
    stream
}

async fn send_frame(ws: &mut WsStream, frame: &ClientFrame) {
    ws.send(WsMessage::Text(
        serde_json::to_string(frame).unwrap().into(),
    ))
    .await
    .unwrap();
}

/// Reads the next text message and returns it, retrying past
/// ping/pong control frames a real WS stack may interleave.
async fn recv_text(ws: &mut WsStream) -> String {
    loop {
        match tokio::time::timeout(Duration::from_secs(5), ws.next())
            .await
            .expect("timed out waiting for a WS message")
            .expect("stream ended unexpectedly")
            .expect("WS transport error")
        {
            WsMessage::Text(t) => return t.to_string(),
            WsMessage::Ping(_) | WsMessage::Pong(_) => continue,
            other => panic!("unexpected non-text message: {other:?}"),
        }
    }
}

/// `event` frames are bare `DomainEvent` JSON (no `"frame"` key —
/// see `swarm_core::protocol`'s doc); control frames always have one.
/// This is exactly the demux `src/lib/transport.ts`'s `wsTransport`
/// performs client-side.
enum Frame {
    Control(ServerFrame),
    Event(serde_json::Value),
}

fn classify(raw: &str) -> Frame {
    let value: serde_json::Value = serde_json::from_str(raw).unwrap();
    if value.get("frame").is_some() {
        Frame::Control(serde_json::from_str(raw).unwrap())
    } else {
        Frame::Event(value)
    }
}

/// DIRECTIVE: full hello -> ready -> replayEnd -> live handshake against
/// a REAL server, cold attach (`lastSeq: null`).
#[tokio::test]
async fn test_cold_attach_handshake_yields_ready_then_replay_end_with_no_events() {
    let server = start_test_server().await;
    let mut ws = connect(&server).await;

    send_frame(
        &mut ws,
        &ClientFrame::Hello {
            last_seq: None,
            token: Some(server.token.clone()),
        },
    )
    .await;

    match classify(&recv_text(&mut ws).await) {
        Frame::Control(ServerFrame::Ready {
            server_seq,
            version,
            ..
        }) => {
            assert_eq!(server_seq, 0, "fresh data dir has no events yet");
            assert_eq!(version, swarm_core::protocol::PROTOCOL_VERSION);
        }
        _ => panic!("expected Ready first"),
    }
    match classify(&recv_text(&mut ws).await) {
        Frame::Control(ServerFrame::ReplayEnd { seq }) => assert_eq!(seq, 0),
        _ => panic!("expected ReplayEnd second (cold attach: no events in between)"),
    }
}

/// DIRECTIVE: wrong/missing token is refused — the server closes the
/// socket rather than proceeding to `ready`.
#[tokio::test]
async fn test_wrong_token_closes_the_connection_without_a_ready_frame() {
    let server = start_test_server().await;
    let mut ws = connect(&server).await;

    send_frame(
        &mut ws,
        &ClientFrame::Hello {
            last_seq: None,
            token: Some("definitely-not-the-real-token".to_string()),
        },
    )
    .await;

    let next = tokio::time::timeout(Duration::from_secs(5), ws.next())
        .await
        .expect("server should respond (with a close) promptly");
    match next {
        Some(Ok(WsMessage::Close(_))) | None => {} // expected
        Some(Ok(other)) => panic!("expected a close frame, got: {other:?}"),
        Some(Err(_)) => {} // an abrupt close surfacing as a transport error is also acceptable
    }
}

/// DIRECTIVE: replay exact. Produce N real persisted events via `rpc`
/// (`create_session`), disconnect, reconnect with `lastSeq` set to a
/// midpoint, and assert the replayed tail plus the events already seen
/// pre-disconnect reconstructs the exact same seq sequence a
/// continuously-connected client would see — no dupes, no gaps.
#[tokio::test]
async fn test_reconnect_with_last_seq_replays_exactly_the_missed_events() {
    let server = start_test_server().await;

    // Client B: connects once, stays live for the whole test, is the
    // "ground truth" — collects every seq it sees, live, start to
    // finish.
    let mut client_b = connect(&server).await;
    send_frame(
        &mut client_b,
        &ClientFrame::Hello {
            last_seq: None,
            token: Some(server.token.clone()),
        },
    )
    .await;
    let _ready = recv_text(&mut client_b).await;
    let _replay_end = recv_text(&mut client_b).await;

    // Client A: connects, gets the first batch live, then disconnects.
    let mut client_a = connect(&server).await;
    send_frame(
        &mut client_a,
        &ClientFrame::Hello {
            last_seq: None,
            token: Some(server.token.clone()),
        },
    )
    .await;
    let _ready = recv_text(&mut client_a).await;
    let _replay_end = recv_text(&mut client_a).await;

    // Produce 30 persisted events via a THIRD connection's rpc calls
    // (any connection can drive rpc — using a dedicated one keeps the
    // event-producing traffic separate from the two observers' own
    // frames).
    let mut driver = connect(&server).await;
    send_frame(
        &mut driver,
        &ClientFrame::Hello {
            last_seq: None,
            token: Some(server.token.clone()),
        },
    )
    .await;
    let _ = recv_text(&mut driver).await; // ready
    let _ = recv_text(&mut driver).await; // replayEnd

    for i in 0..30 {
        send_frame(
            &mut driver,
            &ClientFrame::Rpc {
                id: format!("r{i}"),
                cmd: "create_session".to_string(),
                args: json!({"name": format!("s{i}"), "config": {}}),
            },
        )
        .await;
    }

    // Client B collects every live seq (30 events).
    let mut b_seqs = Vec::new();
    while b_seqs.len() < 30 {
        if let Frame::Event(e) = classify(&recv_text(&mut client_b).await) {
            b_seqs.push(e["seq"].as_u64().unwrap());
        }
    }

    // Client A collects the first 15 live, then disconnects.
    let mut a_seqs = Vec::new();
    while a_seqs.len() < 15 {
        if let Frame::Event(e) = classify(&recv_text(&mut client_a).await) {
            a_seqs.push(e["seq"].as_u64().unwrap());
        }
    }
    let last_seen = *a_seqs.last().unwrap();
    drop(client_a); // disconnect mid-stream

    // Reconnect with lastSeq = the last one actually seen — replay must
    // deliver exactly the remaining 15, then go live with nothing left
    // to produce.
    let mut client_a2 = connect(&server).await;
    send_frame(
        &mut client_a2,
        &ClientFrame::Hello {
            last_seq: Some(last_seen),
            token: Some(server.token.clone()),
        },
    )
    .await;
    let _ready = recv_text(&mut client_a2).await;

    let mut replayed = Vec::new();
    loop {
        match classify(&recv_text(&mut client_a2).await) {
            Frame::Event(e) => replayed.push(e["seq"].as_u64().unwrap()),
            Frame::Control(ServerFrame::ReplayEnd { .. }) => break,
            Frame::Control(_) => {}
        }
    }

    let mut reconstructed = a_seqs.clone();
    reconstructed.extend(replayed);

    assert_eq!(
        reconstructed, b_seqs,
        "client A's reconstructed sequence (live prefix + replayed tail) must exactly match \
         client B's always-connected sequence — no dupes, no gaps"
    );
}

/// DIRECTIVE: rpc round-trip against the real registry — `list_workers`
/// on a fresh runtime returns an empty array via a real `rpc`/`rpcResult`
/// exchange.
#[tokio::test]
async fn test_rpc_round_trip_list_workers() {
    let server = start_test_server().await;
    let mut ws = connect(&server).await;
    send_frame(
        &mut ws,
        &ClientFrame::Hello {
            last_seq: None,
            token: Some(server.token.clone()),
        },
    )
    .await;
    let _ready = recv_text(&mut ws).await;
    let _replay_end = recv_text(&mut ws).await;

    send_frame(
        &mut ws,
        &ClientFrame::Rpc {
            id: "abc".to_string(),
            cmd: "list_workers".to_string(),
            args: json!({}),
        },
    )
    .await;

    let frame = loop {
        if let Frame::Control(ServerFrame::RpcResult {
            id,
            ok,
            result,
            error,
        }) = classify(&recv_text(&mut ws).await)
        {
            break (id, ok, result, error);
        }
    };
    let (id, ok, result, error) = frame;
    assert_eq!(id, "abc");
    assert!(
        ok,
        "list_workers must succeed on a fresh runtime, error: {error:?}"
    );
    assert_eq!(result, Some(json!([])));
}

/// DIRECTIVE: `read_config("anthropic_api_key")` is denied over the WS
/// `rpc` path WITHOUT ever reaching the registry (the denial short-circuits
/// in `ws.rs` before `Registry::dispatch`) — verifies the actual network
/// boundary, not just the pure predicate (that's `src/auth.rs`'s and
/// `src/commands/config.rs`'s own unit tests).
#[tokio::test]
async fn test_read_config_secret_key_denied_over_ws() {
    let server = start_test_server().await;
    let mut ws = connect(&server).await;
    send_frame(
        &mut ws,
        &ClientFrame::Hello {
            last_seq: None,
            token: Some(server.token.clone()),
        },
    )
    .await;
    let _ready = recv_text(&mut ws).await;
    let _replay_end = recv_text(&mut ws).await;

    send_frame(
        &mut ws,
        &ClientFrame::Rpc {
            id: "r1".to_string(),
            cmd: "read_config".to_string(),
            args: json!({"key": "anthropic_api_key"}),
        },
    )
    .await;

    let (ok, error) = loop {
        if let Frame::Control(ServerFrame::RpcResult { ok, error, .. }) =
            classify(&recv_text(&mut ws).await)
        {
            break (ok, error);
        }
    };
    assert!(!ok, "anthropic_api_key must be denied over WS");
    assert!(error.is_some());
}

/// DIRECTIVE: an ordinary (non-secret) config key still round-trips
/// successfully over WS — the denial gate is narrow, not a blanket
/// `read_config` ban.
#[tokio::test]
async fn test_read_config_ordinary_key_allowed_over_ws() {
    let server = start_test_server().await;
    let mut ws = connect(&server).await;
    send_frame(
        &mut ws,
        &ClientFrame::Hello {
            last_seq: None,
            token: Some(server.token.clone()),
        },
    )
    .await;
    let _ready = recv_text(&mut ws).await;
    let _replay_end = recv_text(&mut ws).await;

    send_frame(
        &mut ws,
        &ClientFrame::Rpc {
            id: "r1".to_string(),
            cmd: "read_config".to_string(),
            args: json!({"key": "max_workers"}),
        },
    )
    .await;

    let ok = loop {
        if let Frame::Control(ServerFrame::RpcResult { ok, .. }) =
            classify(&recv_text(&mut ws).await)
        {
            break ok;
        }
    };
    assert!(ok, "an ordinary config key must not be denied");
}

/// DIRECTIVE (Origin/Host — network-layer half of the auth matrix): a
/// cross-origin browser-style upgrade is refused with HTTP 403 before
/// the WS handshake even begins.
#[tokio::test]
async fn test_cross_origin_upgrade_is_refused_with_403() {
    let server = start_test_server().await;

    let mut request = format!("ws://{}/ws", server.addr)
        .into_client_request()
        .unwrap();
    request
        .headers_mut()
        .insert("Origin", "https://attacker.example.com".parse().unwrap());

    let result = tokio_tungstenite::connect_async(request).await;
    match result {
        Err(tokio_tungstenite::tungstenite::Error::Http(resp)) => {
            assert_eq!(resp.status(), 403);
        }
        other => panic!("expected an HTTP 403 rejection, got: {other:?}"),
    }
}

use tokio_tungstenite::tungstenite::client::IntoClientRequest;
