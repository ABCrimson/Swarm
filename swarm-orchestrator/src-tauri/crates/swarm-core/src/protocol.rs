//! Wire protocol for the `swarmd` WebSocket transport (headless-daemon
//! plan, Phase 2/3). Serde-only — no networking code lives here;
//! `swarmd`'s `ws` module owns the actual axum WebSocket handler, and
//! `src/lib/transport.ts`'s `wsTransport` (Phase 3) is the client.
//!
//! ## Framing
//!
//! Every frame on the socket is one JSON text message. Six kinds, five
//! wrapped in a `{"frame": "<kind>", ...}` envelope and one deliberately
//! bare:
//!
//! | Frame        | Direction         | Wrapped?                    |
//! |--------------|--------------------|-----------------------------|
//! | `hello`      | client -> server   | `{"frame":"hello", ...}`    |
//! | `ready`      | server -> client   | `{"frame":"ready", ...}`    |
//! | `event`      | server -> client   | bare `DomainEvent` JSON — **no** `frame` key |
//! | `replayEnd`  | server -> client   | `{"frame":"replayEnd", ...}`|
//! | `rpc`        | client -> server   | `{"frame":"rpc", ...}`      |
//! | `rpcResult`  | server -> client   | `{"frame":"rpcResult", ...}`|
//!
//! `event` frames are UNWRAPPED on purpose: they must be byte-identical
//! to what the desktop shell's `app.emit(EVENT_CHANNEL, &envelope)`
//! already sends over Tauri IPC (see
//! [`crate::orchestration::DomainEvent`]), so the frontend's existing
//! `DomainEventSchema` (`src/lib/event-bus.ts`) parses them with zero
//! changes. A receiver distinguishes an `event` frame from every other
//! frame by the ABSENCE of a `"frame"` key — every control frame below
//! has one; a `DomainEvent` never does.

use serde::{Deserialize, Serialize};

/// Client -> server frames.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "frame", rename_all = "camelCase")]
pub enum ClientFrame {
    /// Sent once immediately after the socket opens, and again on every
    /// reconnect. `lastSeq: None` means a cold attach: the server sends
    /// no replay (just `ready` then `replayEnd` at the current head),
    /// and the client hydrates via the existing snapshot `list_*`
    /// commands instead of replaying the whole log from seq 1 — see the
    /// plan's "Cold attach: null lastSeq = snapshot hydration" decision.
    Hello {
        #[serde(rename = "lastSeq")]
        last_seq: Option<u64>,
        /// The daemon token. Required within the handshake deadline
        /// unless the connection already authenticated via an
        /// `Authorization: Bearer` header at HTTP-upgrade time (see
        /// `swarmd::auth`) — either path is accepted, `hello` is not the
        /// only way in.
        #[serde(default)]
        token: Option<String>,
    },
    /// A command invocation, routed through
    /// [`crate::commands::Registry`] — the same dispatch table the
    /// Tauri IPC wrappers call, so a command that works locally cannot
    /// silently be missing remotely (see the registry's own doc for the
    /// drift-proof contract test).
    Rpc {
        /// Client-generated correlation id, echoed back on
        /// [`ServerFrame::RpcResult`].
        id: String,
        /// Command name — identical to the Tauri IPC command name
        /// (`"spawn_worker"`, `"events_since"`, ...).
        cmd: String,
        #[serde(default)]
        args: serde_json::Value,
    },
}

/// Server -> client control frames (everything except `event`, which is
/// unwrapped — see the module doc).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "frame", rename_all = "camelCase")]
pub enum ServerFrame {
    /// Handshake ack: the server's current head `seq` (the client
    /// hydrates from here on a cold `hello`), the protocol version, and
    /// advertised caps.
    Ready {
        #[serde(rename = "serverSeq")]
        server_seq: u64,
        version: u32,
        caps: ServerCaps,
    },
    /// Marks the end of one replay burst — whether that burst was empty
    /// (the client was already caught up) or paged through history. The
    /// client is only authoritative that it is "live" after seeing this
    /// for the CURRENT `hello`'s replay, not merely after receiving
    /// some events.
    ReplayEnd { seq: u64 },
    /// Response to a client [`ClientFrame::Rpc`], correlated by `id`.
    /// Exactly one of `result`/`error` is present, mirroring
    /// `Result<Value, Value>` on the wire (never both, never neither).
    RpcResult {
        id: String,
        ok: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        result: Option<serde_json::Value>,
        #[serde(skip_serializing_if = "Option::is_none")]
        error: Option<serde_json::Value>,
    },
}

/// Wire protocol version — bump on any breaking frame-shape change.
pub const PROTOCOL_VERSION: u32 = 1;

/// Server-advertised capability/limit caps, echoed in `ready` so the
/// client never has to hardcode them.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerCaps {
    /// Maximum accepted incoming frame size, in bytes.
    pub max_frame_bytes: usize,
    /// Maximum concurrent WebSocket connections the daemon accepts.
    pub max_connections: usize,
    /// Page size used for `events_since` replay paging.
    pub replay_page_size: u32,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_hello_roundtrip_with_last_seq() {
        let frame = ClientFrame::Hello {
            last_seq: Some(42),
            token: Some("abc".to_string()),
        };
        let json = serde_json::to_value(&frame).unwrap();
        assert_eq!(json["frame"], "hello");
        assert_eq!(json["lastSeq"], 42);
        let back: ClientFrame = serde_json::from_value(json).unwrap();
        matches!(
            back,
            ClientFrame::Hello {
                last_seq: Some(42),
                ..
            }
        );
    }

    #[test]
    fn test_hello_last_seq_null_means_cold_attach() {
        let json = serde_json::json!({"frame": "hello", "lastSeq": null, "token": "t"});
        let frame: ClientFrame = serde_json::from_value(json).unwrap();
        match frame {
            ClientFrame::Hello { last_seq, .. } => assert_eq!(last_seq, None),
            _ => panic!("expected Hello"),
        }
    }

    #[test]
    fn test_rpc_roundtrip() {
        let frame = ClientFrame::Rpc {
            id: "r1".to_string(),
            cmd: "list_workers".to_string(),
            args: serde_json::json!({}),
        };
        let json = serde_json::to_value(&frame).unwrap();
        assert_eq!(json["frame"], "rpc");
        assert_eq!(json["cmd"], "list_workers");
    }

    #[test]
    fn test_ready_shape() {
        let frame = ServerFrame::Ready {
            server_seq: 7,
            version: PROTOCOL_VERSION,
            caps: ServerCaps {
                max_frame_bytes: 1_000_000,
                max_connections: 32,
                replay_page_size: 5000,
            },
        };
        let json = serde_json::to_value(&frame).unwrap();
        assert_eq!(json["frame"], "ready");
        assert_eq!(json["serverSeq"], 7);
        assert_eq!(json["caps"]["maxFrameBytes"], 1_000_000);
    }

    #[test]
    fn test_rpc_result_omits_absent_result_and_error() {
        let ok = ServerFrame::RpcResult {
            id: "r1".to_string(),
            ok: true,
            result: Some(serde_json::json!({"a": 1})),
            error: None,
        };
        let json = serde_json::to_value(&ok).unwrap();
        assert!(json.get("error").is_none());
        assert_eq!(json["result"]["a"], 1);

        let err = ServerFrame::RpcResult {
            id: "r1".to_string(),
            ok: false,
            result: None,
            error: Some(serde_json::json!("Worker Not Found")),
        };
        let json = serde_json::to_value(&err).unwrap();
        assert!(json.get("result").is_none());
        assert_eq!(json["error"], "Worker Not Found");
    }

    /// DIRECTIVE: a `DomainEvent`'s own JSON shape must never carry a
    /// `"frame"` key — this is the entire disambiguation mechanism the
    /// module doc describes, so a regression here (e.g. `DomainEvent`
    /// someday adding a field literally named `frame`) would silently
    /// break every client's frame demux.
    #[test]
    fn test_domain_event_shape_has_no_frame_key() {
        use crate::events::{Provenance, SwarmEvent, WorkerSpawnedPayload};
        use crate::orchestration::DomainEvent;

        let envelope = DomainEvent {
            seq: 1,
            ts: 0,
            origin_worker: Provenance::default().origin_worker,
            cause_seq: None,
            event: SwarmEvent::WorkerSpawned(WorkerSpawnedPayload {
                worker_id: uuid::Uuid::nil(),
                name: "w".to_string(),
                pid: None,
                isolation: None,
            }),
        };
        let json = serde_json::to_value(&envelope).unwrap();
        assert!(json.get("frame").is_none());
        assert!(json.get("seq").is_some());
    }
}
