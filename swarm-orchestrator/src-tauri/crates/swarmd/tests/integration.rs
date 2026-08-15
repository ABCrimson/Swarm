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
    data_dir_str: String,
    // Held for the test's duration — dropping releases the
    // single-instance lock and stops the runtime's background tasks
    // from mattering further. Some tests (the FIX-3 ordering test)
    // reach through this to emit engine events directly, bypassing the
    // `rpc`/registry path (and its concurrency cap) entirely.
    runtime: Runtime,
}

async fn start_test_server() -> TestServer {
    let data_dir = std::env::temp_dir().join(format!("swarmd-it-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&data_dir).unwrap();
    let data_dir_str = data_dir.to_string_lossy().into_owned();

    let (token, _, _) = auth::DaemonToken::load_or_create(&data_dir).unwrap();

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
        data_dir_str,
        runtime,
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

    // Paced, not fire-and-forget: awaits each create_session's matching
    // rpcResult before sending the next. Required now that the server
    // caps concurrent in-flight RPCs per connection
    // (`MAX_CONCURRENT_RPC_PER_CONNECTION`, security-review FIX-4) — 30
    // rapid-fire sends with no backpressure awareness would blow past
    // that cap and get most of them busy-rejected (producing FAR fewer
    // than 30 persisted events, which is exactly the failure this test
    // exists to rule out, not exercise). One in flight at a time stays
    // far under the cap and keeps this test deterministic: all 30
    // succeed.
    for i in 0..30 {
        let id = format!("r{i}");
        send_frame(
            &mut driver,
            &ClientFrame::Rpc {
                id: id.clone(),
                cmd: "create_session".to_string(),
                args: json!({"name": format!("s{i}"), "config": {}}),
            },
        )
        .await;
        loop {
            match classify(&recv_text(&mut driver).await) {
                Frame::Control(ServerFrame::RpcResult {
                    id: rid, ok, error, ..
                }) if rid == id => {
                    assert!(ok, "create_session RPC #{i} unexpectedly failed: {error:?}");
                    break;
                }
                _ => {} // a live event frame (or an unrelated control frame) — keep reading
            }
        }
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

/// DIRECTIVE (security-review BLOCK-1, exfiltration vector #1 closed):
/// `read_file` over WS — reproduced live against a running daemon as
/// reading `<data_dir>/daemon-token` verbatim — now returns a typed
/// denial via `Registry::dispatch_remote`'s `RemotePolicy::Denied`,
/// unconditionally, before the handler (and therefore the path
/// argument) is ever touched.
#[tokio::test]
async fn test_read_file_denied_over_ws() {
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

    // The exact reproduced exfiltration target.
    let token_path = format!("{}/daemon-token", server.data_dir_str);
    send_frame(
        &mut ws,
        &ClientFrame::Rpc {
            id: "r1".to_string(),
            cmd: "read_file".to_string(),
            args: json!({"path": token_path}),
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
    assert!(!ok, "read_file must be denied over WS regardless of path");
    assert!(error.is_some());
}

/// DIRECTIVE (security-review BLOCK-1): `write_file` over WS is denied
/// the same way — the poisoning-shaped half of the same vector.
#[tokio::test]
async fn test_write_file_denied_over_ws() {
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
            cmd: "write_file".to_string(),
            args: json!({"path": format!("{}/whatever.txt", server.data_dir_str), "content": "x"}),
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
    assert!(!ok, "write_file must be denied over WS regardless of path");
    assert!(error.is_some());
}

/// DIRECTIVE (security-review FIX-3, closed): a client under a mix of
/// persistent and ephemeral traffic never observes the event lane
/// deliver seq numbers out of order. Reproduced (pre-fix) by a
/// three-channel `select!`-merged design where `replayEnd`/live events
/// on separate lanes could race; the fix collapses them onto one FIFO
/// lane. This test emits persistent (`worker_killed`) and ephemeral
/// (`system_log`) events interleaved directly through the engine (not
/// via `rpc`, so it isn't bounded by the RPC concurrency cap) and
/// asserts: every persistent seq is delivered (never dropped), and the
/// full received seq sequence — whichever ephemeral frames also made it
/// — is strictly increasing.
#[tokio::test]
async fn test_interleaved_persistent_and_ephemeral_events_arrive_in_seq_order() {
    use swarm_core::events::{SwarmEvent, SystemLogPayload, WorkerKilledPayload};

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

    const N: usize = 200;
    for i in 0..N {
        if i % 2 == 0 {
            server
                .runtime
                .sink
                .emit(SwarmEvent::SystemLog(SystemLogPayload {
                    level: "info".to_string(),
                    message: format!("tick {i}"),
                    target: "test".to_string(),
                    timestamp: 0,
                }));
        } else {
            server
                .runtime
                .sink
                .emit(SwarmEvent::WorkerKilled(WorkerKilledPayload {
                    worker_id: uuid::Uuid::new_v4(),
                }));
        }
    }

    let expected_persistent_count = N / 2; // the odd-i WorkerKilled emissions — never dropped
    let mut persistent_seen = 0usize;
    let mut received_seqs = Vec::new();
    while persistent_seen < expected_persistent_count {
        if let Frame::Event(e) = classify(&recv_text(&mut ws).await) {
            received_seqs.push(e["seq"].as_u64().unwrap());
            if e["type"] == "worker_killed" {
                persistent_seen += 1;
            }
        }
    }

    for pair in received_seqs.windows(2) {
        assert!(
            pair[0] < pair[1],
            "received out-of-order seqs {pair:?} in {received_seqs:?} — wire order diverged from seq order"
        );
    }
}

/// DIRECTIVE (security-review FIX-4): firing more `rpc` frames than
/// `MAX_CONCURRENT_RPC_PER_CONNECTION` allows, back-to-back with no
/// pacing, must produce at least one typed busy `rpcResult` rather than
/// spawning an unbounded number of concurrent handler tasks.
#[tokio::test]
async fn test_concurrent_rpc_cap_returns_a_typed_busy_result_above_the_limit() {
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

    const N: usize = 20; // comfortably above the 8-per-connection cap
    for i in 0..N {
        send_frame(
            &mut ws,
            &ClientFrame::Rpc {
                id: format!("c{i}"),
                cmd: "list_workers".to_string(),
                args: json!({}),
            },
        )
        .await;
    }

    let mut saw_busy = false;
    let mut results = 0usize;
    while results < N {
        if let Frame::Control(ServerFrame::RpcResult { ok, error, .. }) =
            classify(&recv_text(&mut ws).await)
        {
            results += 1;
            if !ok
                && error
                    .as_ref()
                    .and_then(|e| e.as_str())
                    .is_some_and(|s| s.contains("Too Many Concurrent"))
            {
                saw_busy = true;
            }
        }
    }
    assert!(
        saw_busy,
        "expected at least one busy-rejected rpcResult firing {N} RPCs against an \
         8-concurrent-per-connection cap with no pacing"
    );
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

// ── Process-spawning tests: drive the REAL `swarmd` binary ──────────
//
// Everything above uses the `swarmd` LIBRARY target in-process. These
// two tests spawn the actual compiled `[[bin]] swarmd` via
// `std::process::Command` (`CARGO_BIN_EXE_swarmd`, set by cargo for
// integration tests in a package with a matching bin target) — the
// bugs they guard against (BLOCK-2's mint-before-gate ordering,
// cross-process single-instance lock collision) are only reproducible
// through `main()`'s actual argv/exit-code/stderr surface, not the
// library functions it calls.

mod bin {
    use std::io::{BufRead, BufReader};
    use std::path::PathBuf;
    use std::process::{Child, Command, Stdio};
    use std::time::{Duration, Instant};

    pub fn swarmd_path() -> PathBuf {
        PathBuf::from(env!("CARGO_BIN_EXE_swarmd"))
    }

    pub fn fresh_data_dir() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("swarmd-bin-it-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// Runs `swarmd` to completion (it must exit on its own — used for
    /// the refused/gate-rejected paths, which exit immediately without
    /// ever binding) and returns `(exit_success, stderr)`.
    pub fn run_to_completion(args: &[&str]) -> (bool, String) {
        let output = Command::new(swarmd_path())
            .args(args)
            .output()
            .expect("failed to spawn the swarmd binary");
        (
            output.status.success(),
            String::from_utf8_lossy(&output.stderr).into_owned(),
        )
    }

    /// Spawns `swarmd` in the background and blocks (up to 5s) until it
    /// prints its "Listening" line, proving it acquired the
    /// single-instance lock and successfully bound. Kills the child on
    /// `Drop` so a panicking assertion never leaks a background daemon.
    pub struct BackgroundDaemon {
        child: Child,
    }

    impl BackgroundDaemon {
        pub fn spawn_and_wait_until_listening(args: &[&str]) -> Self {
            let mut child = Command::new(swarmd_path())
                .args(args)
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .spawn()
                .expect("failed to spawn the swarmd binary");

            let stdout = child.stdout.take().expect("child stdout was not piped");
            let mut reader = BufReader::new(stdout);
            let deadline = Instant::now() + Duration::from_secs(5);
            let mut line = String::new();
            loop {
                line.clear();
                if Instant::now() > deadline {
                    let _ = child.kill();
                    panic!("swarmd did not print its Listening line within 5s");
                }
                match reader.read_line(&mut line) {
                    Ok(0) => {
                        let _ = child.kill();
                        panic!("swarmd exited before printing its Listening line");
                    }
                    Ok(_) => {
                        if line.contains("Listening") {
                            break;
                        }
                    }
                    Err(_) => continue,
                }
            }
            Self { child }
        }
    }

    impl Drop for BackgroundDaemon {
        fn drop(&mut self) {
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
    }
}

/// DIRECTIVE (security-review BLOCK-2, closed): a fresh data directory
/// combined with a non-loopback `--bind` is refused — AND, critically,
/// refused AGAIN on a second identical invocation. Before the fix, the
/// first (refused) run still minted `daemon-token` as a side effect of
/// the old mint-before-gate ordering, so the second run found a
/// "pre-existing" token and slipped through the gate it had just
/// failed.
#[test]
fn test_fresh_dir_non_loopback_bind_is_refused_twice_in_a_row() {
    let data_dir = bin::fresh_data_dir();
    let data_dir_str = data_dir.to_string_lossy().into_owned();

    let (ok1, stderr1) =
        bin::run_to_completion(&["--bind", "0.0.0.0:0", "--data-dir", &data_dir_str]);
    assert!(!ok1, "first run against a fresh dir must be refused");
    assert!(
        stderr1.contains("Refusing To Bind A Non-Loopback Address"),
        "unexpected stderr: {stderr1}"
    );
    assert!(
        !data_dir.join("daemon-token").exists(),
        "a refused run must NOT mint a token file — BLOCK-2 regression"
    );

    // The second, identical invocation — the actual bypass this test
    // guards against.
    let (ok2, stderr2) =
        bin::run_to_completion(&["--bind", "0.0.0.0:0", "--data-dir", &data_dir_str]);
    assert!(
        !ok2,
        "second run against the SAME fresh dir must ALSO be refused"
    );
    assert!(
        stderr2.contains("Refusing To Bind A Non-Loopback Address"),
        "unexpected stderr on the second run: {stderr2}"
    );

    let _ = std::fs::remove_dir_all(&data_dir);
}

/// A loopback bind on a fresh dir is never subject to the non-loopback
/// gate — sanity check alongside the refusal test above so the two
/// don't silently drift into both-refused.
#[test]
fn test_fresh_dir_loopback_bind_mints_a_token_and_is_not_refused() {
    let data_dir = bin::fresh_data_dir();
    let daemon = bin::BackgroundDaemon::spawn_and_wait_until_listening(&[
        "--bind",
        "127.0.0.1:0",
        "--data-dir",
        &data_dir.to_string_lossy(),
    ]);
    assert!(data_dir.join("daemon-token").exists());
    drop(daemon);
    let _ = std::fs::remove_dir_all(&data_dir);
}

/// DIRECTIVE (security-review FIX-5): the single-instance lock's
/// cross-process collision, driven for real — two ACTUAL `swarmd`
/// processes against the same data directory, not a same-process
/// `Runtime::start` double-call (which only proves the in-process lock
/// primitive works, not that the OS-level advisory lock actually
/// survives being held by a genuinely different process).
#[test]
fn test_second_daemon_on_the_same_data_dir_is_refused_by_the_single_instance_lock() {
    let data_dir = bin::fresh_data_dir();
    let data_dir_str = data_dir.to_string_lossy().into_owned();

    let first = bin::BackgroundDaemon::spawn_and_wait_until_listening(&[
        "--bind",
        "127.0.0.1:0",
        "--data-dir",
        &data_dir_str,
    ]);

    let (ok2, stderr2) =
        bin::run_to_completion(&["--bind", "127.0.0.1:0", "--data-dir", &data_dir_str]);
    assert!(!ok2, "a second daemon on the same data dir must be refused");
    assert!(
        stderr2.contains("SWARM Is Already Running"),
        "expected the lock-collision message, got: {stderr2}"
    );
    // FIX-7's companion: the message names which shell holds the lock.
    assert!(
        stderr2.contains("swarmd"),
        "expected the lock message to name the holding shell, got: {stderr2}"
    );

    drop(first);
    let _ = std::fs::remove_dir_all(&data_dir);
}
