//! Integration tests: a real `swarmd` server driven by real clients.
//!
//! The first group runs the `swarmd` library in-process ([`swarmd::serve`]
//! on an ephemeral loopback port, exactly as `main` runs it) against
//! `tokio-tungstenite` WebSocket clients and a minimal HTTP/1.1 client. The
//! second group spawns the compiled binary, for what only `main` does:
//! argument handling, the non-loopback gate, the bound address, the lock's
//! exit status and signal-driven shutdown.

use std::io::{BufRead, BufReader, Read};
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::mpsc as std_mpsc;
use std::time::{Duration, Instant};

use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::task::JoinHandle;
use tokio_tungstenite::MaybeTlsStream;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::handshake::client::Request;
use tokio_tungstenite::tungstenite::protocol::frame::Frame;
use tokio_tungstenite::tungstenite::protocol::frame::coding::{Data, OpCode};
use tokio_tungstenite::tungstenite::{self, Message as WsMessage};
use tokio_util::sync::DropGuard;

use swarm_core::Paths;
use swarm_core::events::{SwarmEvent, SystemLogPayload, WorkerKilledPayload};
use swarm_core::lock::LockError;
use swarm_core::protocol::{ClientFrame, PROTOCOL_VERSION, ServerFrame};
use swarm_core::runtime::{Runtime, RuntimeConfig, RuntimeStartError};
use swarmd::auth::{AllowedHost, DaemonToken, HostPolicy};
use swarmd::{AppState, Limits};

type WsStream = tokio_tungstenite::WebSocketStream<MaybeTlsStream<TcpStream>>;

const WAIT: Duration = Duration::from_secs(10);

// ── In-process server ───────────────────────────────────────────────────

/// A server over its own data directory. Dropping it cancels the server;
/// [`TestServer::stop`] shuts it down completely and releases the lock.
struct TestServer {
    addr: SocketAddr,
    token: String,
    state: AppState,
    runtime: Runtime,
    server: JoinHandle<std::io::Result<()>>,
    data_dir: PathBuf,
    _cancel_on_drop: DropGuard,
    /// Declared last so it is removed after the runtime closes its files.
    temp_dir: Option<tempfile::TempDir>,
}

#[derive(Default)]
struct Options {
    limits: Limits,
    allow_hosts: Vec<&'static str>,
    serve_ui: Option<PathBuf>,
}

impl TestServer {
    async fn start() -> Self {
        Self::start_with(Options::default()).await
    }

    async fn start_with(options: Options) -> Self {
        let dir = tempfile::tempdir().unwrap();
        let data_dir = dir.path().to_path_buf();
        Self::start_in(data_dir, Some(dir), options).await
    }

    async fn start_in(data_dir: PathBuf, dir: Option<tempfile::TempDir>, options: Options) -> Self {
        let token = DaemonToken::load_or_create(&data_dir).unwrap().token;
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let runtime = start_runtime(&data_dir, addr).await;
        let hosts = HostPolicy::new(
            options
                .allow_hosts
                .iter()
                .map(|host| host.parse::<AllowedHost>().unwrap()),
        );
        let state = AppState::new(&runtime, token.clone(), hosts, options.limits);
        let server = tokio::spawn({
            let state = state.clone();
            async move { swarmd::serve(listener, state, options.serve_ui.as_deref()).await }
        });
        Self {
            addr,
            token: token.as_str().to_owned(),
            _cancel_on_drop: state.shutdown_token().drop_guard(),
            state,
            runtime,
            server,
            data_dir,
            temp_dir: dir,
        }
    }

    fn ws_url(&self) -> String {
        format!("ws://{}/ws", self.addr)
    }

    /// Shuts the server down the way `main` does and releases the lock.
    async fn stop(self) -> Option<tempfile::TempDir> {
        let Self {
            state,
            runtime,
            server,
            mut temp_dir,
            ..
        } = self;
        state.shutdown_token().cancel();
        server.await.unwrap().unwrap();
        runtime.metrics_cancel.cancel();
        drop(runtime);
        temp_dir.take()
    }
}

/// How long [`start_runtime`] keeps retrying a lock that is still held.
const LOCK_RETRY_DEADLINE: Duration = Duration::from_secs(5);

/// Starts the runtime on `data_dir`, retrying while the single-instance lock
/// is still held.
///
/// A restart ([`TestServer::stop`], then [`TestServer::start_in`] on the same
/// directory) can find the previous runtime's `daemon.lock` still locked
/// even though that runtime is dropped: the lock belongs to the open file
/// description, and a process that another test in this binary is spawning
/// at that moment holds a copy of the descriptor from fork until exec closes
/// it (it is close-on-exec). That window is short, so a bounded retry makes
/// the restart deterministic without hiding a real leak: a lock held for
/// the whole deadline still fails the test.
async fn start_runtime(data_dir: &Path, addr: SocketAddr) -> Runtime {
    let deadline = Instant::now() + LOCK_RETRY_DEADLINE;
    loop {
        let config = RuntimeConfig {
            paths: Paths {
                data_dir: data_dir.to_path_buf(),
            },
            shell_name: "swarmd",
            bind: Some(addr.to_string()),
        };
        match Runtime::start(config, |_| {}) {
            Ok(runtime) => return runtime,
            Err(RuntimeStartError::Lock(LockError::AlreadyRunning(_)))
                if Instant::now() < deadline =>
            {
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
            Err(error) => panic!("runtime should start on a free data dir: {error}"),
        }
    }
}

async fn connect(server: &TestServer) -> WsStream {
    connect_request(server.ws_url().into_client_request().unwrap()).await
}

async fn connect_request(request: Request) -> WsStream {
    tokio_tungstenite::connect_async(request)
        .await
        .expect("WS connect should succeed")
        .0
}

async fn send_frame(ws: &mut WsStream, frame: &ClientFrame) {
    ws.send(WsMessage::Text(
        serde_json::to_string(frame).unwrap().into(),
    ))
    .await
    .unwrap();
}

async fn hello(ws: &mut WsStream, last_seq: Option<u64>, token: Option<&str>) {
    send_frame(
        ws,
        &ClientFrame::Hello {
            last_seq,
            token: token.map(str::to_owned),
        },
    )
    .await;
}

/// Connects, authenticates cold, and consumes `ready` and `replayEnd`.
async fn attach(server: &TestServer) -> WsStream {
    let mut ws = connect(server).await;
    hello(&mut ws, None, Some(&server.token)).await;
    assert!(matches!(
        next_frame(&mut ws).await,
        Inbound::Control(ServerFrame::Ready { .. })
    ));
    assert!(matches!(
        next_frame(&mut ws).await,
        Inbound::Control(ServerFrame::ReplayEnd { .. })
    ));
    ws
}

/// The next text message, skipping ping/pong.
async fn recv_text(ws: &mut WsStream) -> String {
    loop {
        match tokio::time::timeout(WAIT, ws.next())
            .await
            .expect("timed out waiting for a WS message")
            .expect("stream ended unexpectedly")
            .expect("WS transport error")
        {
            WsMessage::Text(text) => return text.to_string(),
            WsMessage::Ping(_) | WsMessage::Pong(_) => {}
            other => panic!("unexpected non-text message: {other:?}"),
        }
    }
}

/// The close code the server ends the connection with, skipping any text
/// frames before it. `None` if the connection ended without a close frame.
async fn close_code(ws: &mut WsStream) -> Option<u16> {
    loop {
        match tokio::time::timeout(WAIT, ws.next())
            .await
            .expect("timed out waiting for the server to close")
        {
            Some(Ok(WsMessage::Close(frame))) => return frame.map(|frame| u16::from(frame.code)),
            Some(Ok(_)) => {}
            Some(Err(_)) | None => return None,
        }
    }
}

/// A server frame: control frames carry a `"frame"` tag; `event` frames are
/// the bare `DomainEvent` JSON (the same demux `wsTransport` performs).
enum Inbound {
    Control(ServerFrame),
    Event(Value),
}

fn classify(raw: &str) -> Inbound {
    let value: Value = serde_json::from_str(raw).unwrap();
    if value.get("frame").is_some() {
        Inbound::Control(serde_json::from_value(value).unwrap())
    } else {
        Inbound::Event(value)
    }
}

async fn next_frame(ws: &mut WsStream) -> Inbound {
    classify(&recv_text(ws).await)
}

/// Sends one `rpc` and returns its `(ok, result, error)`, skipping events.
async fn rpc(
    ws: &mut WsStream,
    id: &str,
    cmd: &str,
    args: Value,
) -> (bool, Option<Value>, Option<Value>) {
    send_frame(
        ws,
        &ClientFrame::Rpc {
            id: id.to_owned(),
            cmd: cmd.to_owned(),
            args,
        },
    )
    .await;
    rpc_reply(ws, id).await
}

async fn rpc_reply(ws: &mut WsStream, id: &str) -> (bool, Option<Value>, Option<Value>) {
    loop {
        if let Inbound::Control(ServerFrame::RpcResult {
            id: reply,
            ok,
            result,
            error,
        }) = next_frame(ws).await
            && reply == id
        {
            return (ok, result, error);
        }
    }
}

fn event_type(event: &Value) -> Option<&str> {
    event["type"].as_str()
}

/// Minimal HTTP/1.1 GET: `(status, lowercase headers, body)`.
async fn http_get(
    addr: SocketAddr,
    path: &str,
    host: &str,
) -> (u16, Vec<(String, String)>, String) {
    let mut stream = TcpStream::connect(addr).await.unwrap();
    let request = format!("GET {path} HTTP/1.1\r\nHost: {host}\r\nConnection: close\r\n\r\n");
    stream.write_all(request.as_bytes()).await.unwrap();
    let mut raw = Vec::new();
    tokio::time::timeout(WAIT, stream.read_to_end(&mut raw))
        .await
        .unwrap()
        .unwrap();
    let raw = String::from_utf8_lossy(&raw).into_owned();
    let (head, body) = raw.split_once("\r\n\r\n").unwrap();
    let mut lines = head.lines();
    let status = lines
        .next()
        .unwrap()
        .split(' ')
        .nth(1)
        .unwrap()
        .parse()
        .unwrap();
    let headers = lines
        .filter_map(|line| line.split_once(':'))
        .map(|(name, value)| (name.trim().to_ascii_lowercase(), value.trim().to_owned()))
        .collect();
    (status, headers, body.to_owned())
}

fn header<'a>(headers: &'a [(String, String)], name: &str) -> Option<&'a str> {
    headers
        .iter()
        .find(|(key, _)| key == name)
        .map(|(_, value)| value.as_str())
}

// ── Handshake and authentication ───────────────────────────────────────

/// Cold attach: `ready` at the log head, then `replayEnd` with no events
/// between them.
#[tokio::test]
async fn test_cold_attach_yields_ready_then_replay_end() {
    let server = TestServer::start().await;
    let mut ws = connect(&server).await;
    hello(&mut ws, None, Some(&server.token)).await;

    match next_frame(&mut ws).await {
        Inbound::Control(ServerFrame::Ready {
            server_seq,
            version,
            caps,
        }) => {
            assert_eq!(server_seq, 0, "a fresh data dir has no persisted events");
            assert_eq!(version, PROTOCOL_VERSION);
            assert_eq!(caps.max_frame_bytes, Limits::default().max_message_bytes);
            assert_eq!(caps.max_connections, Limits::default().max_connections);
        }
        _ => panic!("expected ready first"),
    }
    match next_frame(&mut ws).await {
        Inbound::Control(ServerFrame::ReplayEnd { seq }) => assert_eq!(seq, 0),
        _ => panic!("expected replayEnd second"),
    }
}

/// A valid `Authorization: Bearer` header authenticates the connection;
/// `hello` then needs no token.
#[tokio::test]
async fn test_bearer_header_authenticates_without_a_hello_token() {
    let server = TestServer::start().await;
    let mut request = server.ws_url().into_client_request().unwrap();
    request.headers_mut().insert(
        "Authorization",
        format!("Bearer {}", server.token).parse().unwrap(),
    );
    let mut ws = connect_request(request).await;
    hello(&mut ws, None, None).await;
    assert!(matches!(
        next_frame(&mut ws).await,
        Inbound::Control(ServerFrame::Ready { .. })
    ));
}

/// A wrong token is refused with close code 4401 and no `ready`.
#[tokio::test]
async fn test_wrong_token_is_closed_with_4401() {
    let server = TestServer::start().await;
    let mut ws = connect(&server).await;
    hello(&mut ws, None, Some("definitely-not-the-real-token")).await;
    assert_eq!(
        close_code(&mut ws).await,
        Some(swarmd::ws::CLOSE_UNAUTHORIZED)
    );

    // A wrong Bearer header is no better.
    let mut request = server.ws_url().into_client_request().unwrap();
    request
        .headers_mut()
        .insert("Authorization", "Bearer wrong".parse().unwrap());
    let mut ws = connect_request(request).await;
    hello(&mut ws, None, None).await;
    assert_eq!(
        close_code(&mut ws).await,
        Some(swarmd::ws::CLOSE_UNAUTHORIZED)
    );
}

/// A connection that never sends `hello` is closed with 1008 once the
/// handshake deadline passes, Bearer-authenticated or not.
#[tokio::test]
async fn test_missing_hello_is_closed_with_1008() {
    let server = TestServer::start_with(Options {
        limits: Limits {
            handshake_deadline: Duration::from_millis(200),
            ..Limits::default()
        },
        ..Options::default()
    })
    .await;
    let mut ws = connect(&server).await;
    assert_eq!(close_code(&mut ws).await, Some(1008));

    let mut request = server.ws_url().into_client_request().unwrap();
    request.headers_mut().insert(
        "Authorization",
        format!("Bearer {}", server.token).parse().unwrap(),
    );
    let mut ws = connect_request(request).await;
    assert_eq!(close_code(&mut ws).await, Some(1008));
}

// ── Host / Origin ───────────────────────────────────────────────────────

fn upgrade_status(result: Result<impl std::fmt::Debug, tungstenite::Error>) -> u16 {
    match result {
        Err(tungstenite::Error::Http(response)) => response.status().as_u16(),
        other => panic!("expected an HTTP rejection, got: {other:?}"),
    }
}

/// A cross-origin browser page is refused before the upgrade.
#[tokio::test]
async fn test_cross_origin_upgrade_is_refused_with_403() {
    let server = TestServer::start().await;
    let mut request = server.ws_url().into_client_request().unwrap();
    request
        .headers_mut()
        .insert("Origin", "https://attacker.example.com".parse().unwrap());
    assert_eq!(
        upgrade_status(tokio_tungstenite::connect_async(request).await),
        403
    );
}

/// DNS rebinding: a foreign `Host` is refused even on a loopback socket.
#[tokio::test]
async fn test_foreign_host_header_is_refused_with_403() {
    let server = TestServer::start().await;
    let mut request = server.ws_url().into_client_request().unwrap();
    request.headers_mut().insert(
        "Host",
        format!("evil.example.com:{}", server.addr.port())
            .parse()
            .unwrap(),
    );
    assert_eq!(
        upgrade_status(tokio_tungstenite::connect_async(request).await),
        403
    );
}

/// Loopback aliases of the bound address and `--allow-host` names (a
/// reverse proxy's public origin) are accepted.
#[tokio::test]
async fn test_loopback_aliases_and_allowed_hosts_are_accepted() {
    let server = TestServer::start_with(Options {
        allow_hosts: vec!["swarm.example.com"],
        ..Options::default()
    })
    .await;
    for (host, origin) in [
        (format!("localhost:{}", server.addr.port()), None),
        (
            server.addr.to_string(),
            Some(format!("http://localhost:{}", server.addr.port())),
        ),
        (
            "swarm.example.com".to_owned(),
            Some("https://swarm.example.com".to_owned()),
        ),
    ] {
        let mut request = server.ws_url().into_client_request().unwrap();
        request.headers_mut().insert("Host", host.parse().unwrap());
        if let Some(origin) = &origin {
            request
                .headers_mut()
                .insert("Origin", origin.parse().unwrap());
        }
        let mut ws = connect_request(request).await;
        hello(&mut ws, None, Some(&server.token)).await;
        assert!(
            matches!(
                next_frame(&mut ws).await,
                Inbound::Control(ServerFrame::Ready { .. })
            ),
            "{host} / {origin:?}"
        );
    }
}

// ── Limits ──────────────────────────────────────────────────────────────

/// Authenticated connections beyond the cap get 503; sockets that never
/// authenticate do not use up a slot.
#[tokio::test]
async fn test_connection_limit_counts_only_authenticated_clients() {
    let server = TestServer::start_with(Options {
        limits: Limits {
            max_connections: 1,
            ..Limits::default()
        },
        ..Options::default()
    })
    .await;

    // Unauthenticated sockets idling in their handshake.
    let mut idle = Vec::new();
    for _ in 0..3 {
        idle.push(connect(&server).await);
    }
    let _first = attach(&server).await;

    let refused = tokio_tungstenite::connect_async(server.ws_url()).await;
    assert_eq!(upgrade_status(refused), 503);
}

/// Pending handshakes have their own, smaller pool.
#[tokio::test]
async fn test_pending_handshakes_are_capped() {
    let server = TestServer::start_with(Options {
        limits: Limits {
            max_pending_handshakes: 2,
            ..Limits::default()
        },
        ..Options::default()
    })
    .await;
    let _a = connect(&server).await;
    let _b = connect(&server).await;
    let refused = tokio_tungstenite::connect_async(server.ws_url()).await;
    assert_eq!(upgrade_status(refused), 503);
}

/// Asserts the server ends the connection without sending any frame (no
/// `ready`).
async fn assert_closed_without_ready(ws: &mut WsStream) {
    loop {
        match tokio::time::timeout(WAIT, ws.next())
            .await
            .expect("timed out waiting for the server to close")
        {
            Some(Ok(WsMessage::Text(text))) => panic!("expected no frame, got {text}"),
            Some(Ok(WsMessage::Close(_)) | Err(_)) | None => return,
            Some(Ok(_)) => {}
        }
    }
}

/// A message over the cap is refused before authentication, whether it
/// arrives as one frame or fragmented into frames that are each under the
/// cap. The payload is a VALID `hello` padded past the cap: accepting it
/// would authenticate the connection and answer `ready`.
#[tokio::test]
async fn test_oversized_messages_are_refused_before_authentication() {
    let server = TestServer::start_with(Options {
        limits: Limits {
            max_message_bytes: 64 * 1024,
            ..Limits::default()
        },
        ..Options::default()
    })
    .await;
    let padded_hello = json!({
        "frame": "hello",
        "lastSeq": null,
        "token": server.token,
        "padding": "x".repeat(80 * 1024),
    })
    .to_string();

    let mut ws = connect(&server).await;
    let _ = ws.send(WsMessage::Text(padded_hello.clone().into())).await;
    assert_closed_without_ready(&mut ws).await;

    let (head, tail) = padded_hello.split_at(padded_hello.len() / 2);
    let mut ws = connect(&server).await;
    for (part, opcode, last) in [(head, Data::Text, false), (tail, Data::Continue, true)] {
        let frame = Frame::message(part.as_bytes().to_vec(), OpCode::Data(opcode), last);
        let _ = ws.send(WsMessage::Frame(frame)).await;
    }
    assert_closed_without_ready(&mut ws).await;
}

// ── Replay and ordering ─────────────────────────────────────────────────

/// Replay exact: a client that disconnects mid-stream and reconnects with
/// `lastSeq` ends up with exactly the sequence an always-connected client
/// saw, no duplicates and no gaps.
///
/// Both collectors count only `session_created`, the one event type this
/// test produces: the metrics loop's ephemeral `system_metrics` ticks
/// interleave at timing-dependent points and are never replayed, so
/// counting every event would make the comparison depend on the runner's
/// speed.
#[tokio::test]
async fn test_reconnect_with_last_seq_replays_exactly_the_missed_events() {
    let server = TestServer::start().await;
    let mut client_b = attach(&server).await;
    let mut client_a = attach(&server).await;
    let mut driver = attach(&server).await;

    // One at a time: the per-connection RPC cap would reject a burst.
    for i in 0..30 {
        let (ok, _, error) = rpc(
            &mut driver,
            &format!("r{i}"),
            "create_session",
            json!({"name": format!("s{i}"), "config": {}}),
        )
        .await;
        assert!(ok, "create_session #{i} failed: {error:?}");
    }

    let mut b_seqs = Vec::new();
    while b_seqs.len() < 30 {
        if let Inbound::Event(event) = next_frame(&mut client_b).await
            && event_type(&event) == Some("session_created")
        {
            b_seqs.push(event["seq"].as_u64().unwrap());
        }
    }
    let mut a_seqs = Vec::new();
    while a_seqs.len() < 15 {
        if let Inbound::Event(event) = next_frame(&mut client_a).await
            && event_type(&event) == Some("session_created")
        {
            a_seqs.push(event["seq"].as_u64().unwrap());
        }
    }
    let last_seen = *a_seqs.last().unwrap();
    drop(client_a);

    let mut client_a = connect(&server).await;
    hello(&mut client_a, Some(last_seen), Some(&server.token)).await;
    assert!(matches!(
        next_frame(&mut client_a).await,
        Inbound::Control(ServerFrame::Ready { .. })
    ));
    loop {
        match next_frame(&mut client_a).await {
            Inbound::Event(event) if event_type(&event) == Some("session_created") => {
                a_seqs.push(event["seq"].as_u64().unwrap());
            }
            Inbound::Control(ServerFrame::ReplayEnd { .. }) => break,
            _ => {}
        }
    }
    assert_eq!(
        a_seqs, b_seqs,
        "live prefix + replayed tail must equal the always-connected sequence"
    );
}

/// Persistent and ephemeral events emitted interleaved arrive in strictly
/// increasing seq order, and no persistent event is dropped.
#[tokio::test]
async fn test_interleaved_persistent_and_ephemeral_events_arrive_in_seq_order() {
    let server = TestServer::start().await;
    let mut ws = attach(&server).await;

    const N: usize = 200;
    for i in 0..N {
        let event = if i % 2 == 0 {
            SwarmEvent::SystemLog(SystemLogPayload {
                level: "info".to_owned(),
                message: format!("tick {i}"),
                target: "test".to_owned(),
                timestamp: 0,
            })
        } else {
            SwarmEvent::WorkerKilled(WorkerKilledPayload {
                worker_id: uuid::Uuid::new_v4(),
            })
        };
        server.runtime.sink.emit(event);
    }

    let mut persistent = 0;
    let mut seqs = Vec::new();
    while persistent < N / 2 {
        if let Inbound::Event(event) = next_frame(&mut ws).await {
            seqs.push(event["seq"].as_u64().unwrap());
            if event_type(&event) == Some("worker_killed") {
                persistent += 1;
            }
        }
    }
    assert!(
        seqs.is_sorted_by(|a, b| a < b),
        "out-of-order seqs: {seqs:?}"
    );
}

/// Persisted history survives a daemon restart: a client reattaching to the
/// restarted daemon with its `lastSeq` receives exactly the events recorded
/// after it, even though they were recorded by another process lifetime.
#[tokio::test]
async fn test_reattach_after_restart_replays_events_recorded_by_the_new_daemon() {
    let first = TestServer::start().await;
    let data_dir = first.data_dir.clone();
    let token = first.token.clone();
    let mut client = attach(&first).await;
    let mut driver = attach(&first).await;
    for i in 0..3 {
        let (ok, _, error) = rpc(
            &mut driver,
            &format!("a{i}"),
            "create_session",
            json!({"name": format!("a{i}"), "config": {}}),
        )
        .await;
        assert!(ok, "{error:?}");
    }
    let mut seen = Vec::new();
    while seen.len() < 3 {
        if let Inbound::Event(event) = next_frame(&mut client).await
            && event_type(&event) == Some("session_created")
        {
            seen.push(event["seq"].as_u64().unwrap());
        }
    }
    let last_seen = *seen.last().unwrap();
    drop((driver, client));
    let dir = first.stop().await;

    let second = TestServer::start_in(data_dir, dir, Options::default()).await;
    assert_eq!(second.token, token, "the token survives the restart");
    let mut driver = attach(&second).await;
    for i in 0..2 {
        let (ok, _, error) = rpc(
            &mut driver,
            &format!("b{i}"),
            "create_session",
            json!({"name": format!("b{i}"), "config": {}}),
        )
        .await;
        assert!(ok, "{error:?}");
    }

    let mut ws = connect(&second).await;
    hello(&mut ws, Some(last_seen), Some(&token)).await;
    assert!(matches!(
        next_frame(&mut ws).await,
        Inbound::Control(ServerFrame::Ready { .. })
    ));
    let mut names = Vec::new();
    loop {
        match next_frame(&mut ws).await {
            Inbound::Event(event) => {
                assert!(
                    event["seq"].as_u64().unwrap() > last_seen,
                    "replayed an old event: {event}"
                );
                if event_type(&event) == Some("session_created") {
                    names.push(event["payload"]["name"].as_str().unwrap().to_owned());
                }
            }
            Inbound::Control(ServerFrame::ReplayEnd { .. }) => break,
            Inbound::Control(_) => {}
        }
    }
    assert_eq!(names, ["b0", "b1"]);
}

/// The browser client's `lastSeq` also counts ephemeral events, which
/// consume seqs but are never persisted. After a restart, events the new
/// daemon records must still sort after everything the client saw.
#[tokio::test]
#[ignore = "needs swarm-core's restart-monotonic seqs (engine reserves seqs in the log); un-ignore when that lands"]
async fn test_reattach_after_restart_with_an_ephemeral_tail_keeps_new_events() {
    let first = TestServer::start().await;
    let data_dir = first.data_dir.clone();
    let token = first.token.clone();
    let mut ws = attach(&first).await;
    let (ok, _, _) = rpc(
        &mut ws,
        "a",
        "create_session",
        json!({"name": "a", "config": {}}),
    )
    .await;
    assert!(ok);
    for i in 0..5 {
        first
            .runtime
            .sink
            .emit(SwarmEvent::SystemLog(SystemLogPayload {
                level: "info".to_owned(),
                message: format!("tail {i}"),
                target: "test".to_owned(),
                timestamp: 0,
            }));
    }
    let mut last_seen = 0;
    let mut tail = 0;
    while tail < 5 {
        if let Inbound::Event(event) = next_frame(&mut ws).await {
            last_seen = last_seen.max(event["seq"].as_u64().unwrap());
            if event_type(&event) == Some("system_log") && event["payload"]["target"] == "test" {
                tail += 1;
            }
        }
    }
    drop(ws);
    let dir = first.stop().await;

    let second = TestServer::start_in(data_dir, dir, Options::default()).await;
    let mut driver = attach(&second).await;
    let (ok, _, _) = rpc(
        &mut driver,
        "b",
        "create_session",
        json!({"name": "b", "config": {}}),
    )
    .await;
    assert!(ok);

    let mut ws = connect(&second).await;
    hello(&mut ws, Some(last_seen), Some(&token)).await;
    let mut names = Vec::new();
    loop {
        match next_frame(&mut ws).await {
            Inbound::Event(event) if event_type(&event) == Some("session_created") => {
                names.push(event["payload"]["name"].as_str().unwrap().to_owned());
            }
            Inbound::Control(ServerFrame::ReplayEnd { .. }) => break,
            _ => {}
        }
    }
    assert_eq!(
        names,
        ["b"],
        "the event recorded after the restart must be replayed"
    );
}

// ── RPC ─────────────────────────────────────────────────────────────────

#[tokio::test]
async fn test_rpc_round_trip_list_workers() {
    let server = TestServer::start().await;
    let mut ws = attach(&server).await;
    let (ok, result, error) = rpc(&mut ws, "abc", "list_workers", json!({})).await;
    assert!(ok, "list_workers failed: {error:?}");
    assert_eq!(result, Some(json!([])));
}

/// The remote policy is enforced at the network boundary: secret config
/// keys are denied by `Registry::dispatch_remote`'s `SecretFiltered` gate
/// (the predicate is `swarm_core::commands::config::is_secret_key`) before
/// the handler runs, for reads and writes alike.
#[tokio::test]
async fn test_secret_config_keys_are_denied_over_ws() {
    let server = TestServer::start().await;
    let mut ws = attach(&server).await;
    let (ok, _, error) = rpc(
        &mut ws,
        "r",
        "read_config",
        json!({"key": "anthropic_api_key"}),
    )
    .await;
    assert!(
        !ok && error.is_some(),
        "reading anthropic_api_key must be denied"
    );
    let (ok, _, error) = rpc(
        &mut ws,
        "w",
        "write_config",
        json!({"key": "anthropic_api_key", "value": "sk-ant-planted"}),
    )
    .await;
    assert!(
        !ok && error.is_some(),
        "writing anthropic_api_key must be denied"
    );
    let config =
        std::fs::read_to_string(server.data_dir.join("swarm-config.json")).unwrap_or_default();
    assert!(
        !config.contains("sk-ant-planted"),
        "the denied write must not persist"
    );
}

/// The gate is narrow: an ordinary key still round-trips.
#[tokio::test]
async fn test_ordinary_config_key_is_allowed_over_ws() {
    let server = TestServer::start().await;
    let mut ws = attach(&server).await;
    let (ok, _, error) = rpc(&mut ws, "r", "read_config", json!({"key": "max_workers"})).await;
    assert!(ok, "an ordinary key must not be denied: {error:?}");
}

/// `read_file`/`write_file` are denied outright over WS (`RemotePolicy::Denied`),
/// whatever the path: the daemon token itself was the reproduced target.
#[tokio::test]
async fn test_file_commands_are_denied_over_ws() {
    let server = TestServer::start().await;
    let mut ws = attach(&server).await;
    let token_path = server.data_dir.join("daemon-token");
    let (ok, _, error) = rpc(&mut ws, "r", "read_file", json!({"path": token_path})).await;
    assert!(!ok && error.is_some(), "read_file must be denied");
    let (ok, _, error) = rpc(
        &mut ws,
        "w",
        "write_file",
        json!({"path": server.data_dir.join("x.txt"), "content": "x"}),
    )
    .await;
    assert!(!ok && error.is_some(), "write_file must be denied");
}

/// Past the per-connection cap, an `rpc` is answered at once with a busy
/// error instead of spawning more handler tasks.
#[tokio::test]
async fn test_concurrent_rpc_cap_returns_a_busy_result() {
    let server = TestServer::start().await;
    let mut ws = attach(&server).await;
    const N: usize = 20;
    for i in 0..N {
        send_frame(
            &mut ws,
            &ClientFrame::Rpc {
                id: format!("c{i}"),
                cmd: "list_workers".to_owned(),
                args: json!({}),
            },
        )
        .await;
    }
    let mut busy = false;
    for _ in 0..N {
        loop {
            if let Inbound::Control(ServerFrame::RpcResult { ok, error, .. }) =
                next_frame(&mut ws).await
            {
                busy |= !ok
                    && error
                        .as_ref()
                        .and_then(Value::as_str)
                        .is_some_and(|e| e.contains("Too Many Concurrent"));
                break;
            }
        }
    }
    assert!(busy, "expected a busy rpcResult for {N} unpaced RPCs");
}

/// An `rpc` frame that does not parse is still answered when its `id` is
/// readable, instead of leaving the client to time out.
#[tokio::test]
async fn test_malformed_rpc_frame_is_answered() {
    let server = TestServer::start().await;
    let mut ws = attach(&server).await;
    ws.send(WsMessage::Text(
        r#"{"frame":"rpc","id":"bad","cmd":42}"#.into(),
    ))
    .await
    .unwrap();
    let (ok, _, error) = rpc_reply(&mut ws, "bad").await;
    assert!(!ok);
    assert!(
        error
            .unwrap()
            .as_str()
            .unwrap()
            .starts_with("Malformed RPC Frame")
    );
}

// ── Shutdown ────────────────────────────────────────────────────────────

/// Cancelling the shutdown token closes every client with 1001 and lets
/// `serve` return.
#[tokio::test]
async fn test_shutdown_closes_clients_with_1001() {
    let server = TestServer::start().await;
    let mut ws = attach(&server).await;
    server.state.shutdown_token().cancel();
    assert_eq!(close_code(&mut ws).await, Some(1001));
    let TestServer { server, .. } = server;
    tokio::time::timeout(WAIT, server)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
}

// ── --serve-ui ──────────────────────────────────────────────────────────

fn web_bundle() -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(
        dir.path().join("index.html"),
        "<!doctype html><title>SWARM</title>",
    )
    .unwrap();
    std::fs::create_dir(dir.path().join("assets")).unwrap();
    std::fs::write(dir.path().join("assets").join("app-1234.js"), "export {};").unwrap();
    std::fs::write(dir.path().join(".env"), "SECRET=1").unwrap();
    dir
}

#[tokio::test]
async fn test_serve_ui_security_headers_caching_and_fallbacks() {
    let bundle = web_bundle();
    let server = TestServer::start_with(Options {
        serve_ui: Some(bundle.path().to_path_buf()),
        ..Options::default()
    })
    .await;
    let host = server.addr.to_string();

    let (status, headers, body) = http_get(server.addr, "/", &host).await;
    assert_eq!(status, 200);
    assert!(body.contains("<title>SWARM</title>"));
    assert_eq!(
        header(&headers, "content-security-policy"),
        Some(swarmd::serve_ui::CSP)
    );
    let csp = swarmd::serve_ui::CSP;
    assert!(csp.contains("frame-ancestors 'none'"));
    assert!(
        csp.contains("connect-src 'self';"),
        "no ws:/wss: wildcard: {csp}"
    );
    assert!(
        csp.contains("script-src 'self';") && !csp.contains("unsafe-eval"),
        "scripts stay strict: {csp}"
    );
    assert!(
        csp.contains("style-src 'self';"),
        "only <style> elements may be inline, not style attributes: {csp}"
    );
    for (name, value) in swarmd::serve_ui::SECURITY_HEADERS {
        assert_eq!(header(&headers, name.as_str()), Some(value), "{name}");
    }
    assert_eq!(header(&headers, "cache-control"), Some("no-cache"));

    // Client-side routes fall back to index.html.
    let (status, _, body) = http_get(server.addr, "/workers/abc", &host).await;
    assert_eq!(status, 200);
    assert!(body.contains("<title>SWARM</title>"));

    // Hashed assets are immutable; a missing one is a real 404.
    let (status, headers, _) = http_get(server.addr, "/assets/app-1234.js", &host).await;
    assert_eq!(status, 200);
    assert_eq!(
        header(&headers, "cache-control"),
        Some("public, max-age=31536000, immutable")
    );
    let (status, _, _) = http_get(server.addr, "/assets/missing.js", &host).await;
    assert_eq!(status, 404);

    // Hidden files are never served.
    for path in ["/.env", "/%2eenv", "/assets/.hidden"] {
        let (status, _, _) = http_get(server.addr, path, &host).await;
        assert_eq!(status, 404, "{path}");
    }

    // The static routes sit behind the same Host allow-list as /ws.
    let (status, _, _) = http_get(server.addr, "/", "evil.example.com").await;
    assert_eq!(status, 403);
}

// ── The compiled binary ─────────────────────────────────────────────────

fn swarmd_bin() -> Command {
    Command::new(env!("CARGO_BIN_EXE_swarmd"))
}

/// Runs `swarmd` to completion: `(exit code, stdout, stderr)`.
fn run(args: &[&str]) -> (Option<i32>, String, String) {
    let output = swarmd_bin()
        .args(args)
        .output()
        .expect("failed to run swarmd");
    (
        output.status.code(),
        String::from_utf8_lossy(&output.stdout).into_owned(),
        String::from_utf8_lossy(&output.stderr).into_owned(),
    )
}

/// A background `swarmd` process. Its stdout and stderr are drained on
/// threads (so the child never blocks on a full pipe) and stdout lines are
/// forwarded to a channel. Killed on drop.
struct Daemon {
    child: Child,
    lines: std_mpsc::Receiver<String>,
    stderr: Option<std::thread::JoinHandle<String>>,
}

impl Daemon {
    fn spawn(args: &[&str]) -> Self {
        let mut child = swarmd_bin()
            .args(args)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("failed to spawn swarmd");
        let stdout = child.stdout.take().unwrap();
        let (tx, lines) = std_mpsc::channel();
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                let _ = tx.send(line);
            }
        });
        let mut stderr = child.stderr.take().unwrap();
        let stderr = std::thread::spawn(move || {
            let mut text = String::new();
            let _ = stderr.read_to_string(&mut text);
            text
        });
        Self {
            child,
            lines,
            stderr: Some(stderr),
        }
    }

    /// Waits for the "Listening On" line and returns it.
    fn listening_line(&mut self) -> String {
        let deadline = Instant::now() + WAIT;
        while let Some(left) = deadline.checked_duration_since(Instant::now()) {
            match self.lines.recv_timeout(left) {
                Ok(line) if line.contains("Listening On") => return line,
                Ok(_) => {}
                Err(_) => break,
            }
        }
        let _ = self.child.kill();
        panic!("swarmd did not print its Listening line: {}", self.stderr());
    }

    /// Waits for the process to exit and returns its exit code.
    fn wait(&mut self) -> Option<i32> {
        let deadline = Instant::now() + WAIT;
        while Instant::now() < deadline {
            if let Some(status) = self.child.try_wait().unwrap() {
                return status.code();
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        panic!("swarmd did not exit in time");
    }

    /// Everything the process wrote to stderr (waits for it to exit).
    fn stderr(&mut self) -> String {
        let _ = self.child.kill();
        self.stderr
            .take()
            .map(|handle| handle.join().unwrap())
            .unwrap_or_default()
    }
}

impl Drop for Daemon {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn path_str(path: &Path) -> &str {
    path.to_str().unwrap()
}

/// The non-loopback gate refuses a fresh data directory, and keeps refusing:
/// a refused run must not mint the token that would let a second identical
/// run through.
#[test]
fn test_fresh_dir_non_loopback_bind_is_refused_twice_in_a_row() {
    let dir = tempfile::tempdir().unwrap();
    for attempt in 1..=2 {
        let (code, _, stderr) = run(&["--bind", "0.0.0.0:0", "--data-dir", path_str(dir.path())]);
        assert_eq!(code, Some(1), "attempt {attempt}: {stderr}");
        assert!(
            stderr.contains("Refusing To Bind A Non-Loopback Address"),
            "{stderr}"
        );
        assert!(
            !dir.path().join("daemon-token").exists(),
            "attempt {attempt} minted a token"
        );
    }
}

/// The data directory (it holds the API key, the event log and the token)
/// ends up owner-only: an existing, looser directory is tightened, and a
/// missing nested path is created private at every level swarmd creates.
/// Both happen before the non-loopback gate, so a refused run is enough.
#[cfg(unix)]
#[test]
fn test_data_dir_is_made_owner_only() {
    use std::os::unix::fs::PermissionsExt;
    let mode = |path: &Path| std::fs::metadata(path).unwrap().permissions().mode() & 0o777;

    let root = tempfile::tempdir().unwrap();
    let existing = root.path().join("existing");
    std::fs::create_dir(&existing).unwrap();
    std::fs::set_permissions(&existing, std::fs::Permissions::from_mode(0o755)).unwrap();
    let nested = root.path().join("new").join("data");

    for dir in [&existing, &nested] {
        let (code, _, stderr) = run(&["--bind", "0.0.0.0:0", "--data-dir", path_str(dir)]);
        assert_eq!(code, Some(1), "{stderr}");
        assert!(
            stderr.contains("Refusing To Bind A Non-Loopback Address"),
            "{stderr}"
        );
    }
    assert_eq!(mode(&existing), 0o700, "an existing directory is tightened");
    assert_eq!(mode(&nested), 0o700, "a new directory is private");
    assert_eq!(
        mode(nested.parent().unwrap()),
        0o700,
        "missing parents are created private too"
    );
}

/// A malformed token file does not satisfy the gate and is never
/// overwritten, not even by a loopback run.
#[test]
fn test_malformed_token_file_is_refused_and_kept() {
    let dir = tempfile::tempdir().unwrap();
    let token_file = dir.path().join("daemon-token");
    std::fs::write(&token_file, "x").unwrap();
    let (code, _, stderr) = run(&["--bind", "0.0.0.0:0", "--data-dir", path_str(dir.path())]);
    assert_eq!(code, Some(1));
    assert!(
        stderr.contains("Refusing To Bind A Non-Loopback Address"),
        "{stderr}"
    );
    let (code, _, stderr) = run(&["--bind", "127.0.0.1:0", "--data-dir", path_str(dir.path())]);
    assert_eq!(code, Some(1));
    assert!(
        stderr.contains("Failed To Establish The Daemon Token"),
        "{stderr}"
    );
    assert_eq!(std::fs::read_to_string(&token_file).unwrap(), "x");
}

/// `--bind 127.0.0.1:0` serves on the address it prints, and the printed
/// line carries no token when stdout is not a terminal.
#[tokio::test]
async fn test_port_zero_bind_serves_the_printed_address() {
    let dir = tempfile::tempdir().unwrap();
    let mut daemon = Daemon::spawn(&["--bind", "127.0.0.1:0", "--data-dir", path_str(dir.path())]);
    let line = daemon.listening_line();
    assert!(
        !line.contains("#t="),
        "the token must not reach a non-terminal log: {line}"
    );
    assert!(
        line.contains("swarmd connect-url --bind 127.0.0.1:"),
        "{line}"
    );

    let url = line
        .split_whitespace()
        .find(|word| word.starts_with("http://"))
        .unwrap();
    let addr = url
        .trim_start_matches("http://")
        .trim_end_matches('/')
        .to_owned();
    assert_ne!(addr, "127.0.0.1:0");
    let token = DaemonToken::load(dir.path()).unwrap().unwrap();

    let (mut ws, _) = tokio_tungstenite::connect_async(format!("ws://{addr}/ws"))
        .await
        .expect("the printed address accepts WebSocket upgrades");
    hello(&mut ws, None, Some(token.as_str())).await;
    assert!(matches!(
        next_frame(&mut ws).await,
        Inbound::Control(ServerFrame::Ready { .. })
    ));
}

/// A second daemon on the same data directory exits with status 75 and a
/// message naming the holder. Two real processes, so the OS-level lock is
/// what is tested.
#[test]
fn test_second_daemon_on_the_same_data_dir_exits_75() {
    let dir = tempfile::tempdir().unwrap();
    let mut first = Daemon::spawn(&["--bind", "127.0.0.1:0", "--data-dir", path_str(dir.path())]);
    first.listening_line();

    let (code, _, stderr) = run(&["--bind", "127.0.0.1:0", "--data-dir", path_str(dir.path())]);
    assert_eq!(code, Some(75), "{stderr}");
    assert!(stderr.contains("SWARM Is Already Running"), "{stderr}");
    assert!(
        stderr.contains("swarmd"),
        "the message names the holding shell: {stderr}"
    );
}

/// `--log-file` (what the Windows task uses) creates missing parent
/// directories and receives both the ordinary log and a fatal startup error,
/// without terminal color codes.
#[test]
fn test_log_file_receives_logs_and_fatal_errors() {
    let dir = tempfile::tempdir().unwrap();
    let log = dir.path().join("logs").join("swarmd.log");
    let args = [
        "--bind",
        "127.0.0.1:0",
        "--data-dir",
        path_str(dir.path()),
        "--log-file",
        path_str(&log),
    ];
    let mut first = Daemon::spawn(&args);
    first.listening_line();

    let (code, _, stderr) = run(&args);
    assert_eq!(code, Some(75), "{stderr}");
    let text = std::fs::read_to_string(&log).unwrap();
    assert!(text.contains("swarmd started"), "{text}");
    assert!(text.contains("SWARM Is Already Running"), "{text}");
    assert!(
        !text.contains('\u{1b}'),
        "no ANSI escapes in a log file: {text}"
    );
}

#[test]
fn test_help_version_and_usage_errors() {
    let (code, stdout, _) = run(&["--help"]);
    assert_eq!(code, Some(0));
    assert!(stdout.contains("Usage: swarmd"));
    let (code, stdout, _) = run(&["--version"]);
    assert_eq!(code, Some(0));
    assert_eq!(
        stdout.trim(),
        format!("swarmd {}", env!("CARGO_PKG_VERSION"))
    );
    for args in [&["--bind"][..], &["--nope"], &["--bind", "not-an-address"]] {
        let (code, _, stderr) = run(args);
        assert_eq!(code, Some(2), "{args:?}: {stderr}");
    }
}

/// `swarmd connect-url` prints the tokenized URL without ever minting.
#[test]
fn test_connect_url_prints_the_token_url() {
    let dir = tempfile::tempdir().unwrap();
    let (code, _, stderr) = run(&["connect-url", "--data-dir", path_str(dir.path())]);
    assert_eq!(code, Some(1), "{stderr}");
    assert!(
        !dir.path().join("daemon-token").exists(),
        "connect-url must never mint"
    );

    let token = DaemonToken::load_or_create(dir.path()).unwrap().token;
    let (code, stdout, _) = run(&[
        "connect-url",
        "--data-dir",
        path_str(dir.path()),
        "--bind",
        "0.0.0.0:9000",
    ]);
    assert_eq!(code, Some(0));
    assert_eq!(
        stdout.trim(),
        format!("http://127.0.0.1:9000/#t={}", token.as_str())
    );
}

/// SIGTERM (what systemd and launchd send) shuts down gracefully: exit 0,
/// and the lock is released for the next daemon.
#[cfg(unix)]
#[test]
fn test_sigterm_shuts_down_gracefully_and_releases_the_lock() {
    let dir = tempfile::tempdir().unwrap();
    let args = ["--bind", "127.0.0.1:0", "--data-dir", path_str(dir.path())];
    let mut daemon = Daemon::spawn(&args);
    daemon.listening_line();
    let status = Command::new("kill")
        .args(["-TERM", &daemon.child.id().to_string()])
        .status()
        .unwrap();
    assert!(status.success());
    assert_eq!(daemon.wait(), Some(0));
    let stderr = daemon.stderr();
    assert!(stderr.contains("swarmd stopped"), "{stderr}");

    let mut next = Daemon::spawn(&args);
    next.listening_line();
}
