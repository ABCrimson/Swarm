//! Wire protocol for the `swarmd` WebSocket transport. Serde only: the
//! socket handler is `swarmd`'s `ws` module and the client is
//! `WsTransport` in `src/lib/transport.ts`.
//!
//! ## Framing
//!
//! Every frame on the socket is one JSON text message. Six kinds, five
//! wrapped in a `{"frame": "<kind>", ...}` envelope and one deliberately
//! bare:
//!
//! | Frame        | Direction          | Wrapped?                    |
//! |--------------|--------------------|-----------------------------|
//! | `hello`      | client -> server   | `{"frame":"hello", ...}`    |
//! | `ready`      | server -> client   | `{"frame":"ready", ...}`    |
//! | `event`      | server -> client   | bare `DomainEvent` JSON — **no** `frame` key |
//! | `replayEnd`  | server -> client   | `{"frame":"replayEnd", ...}`|
//! | `rpc`        | client -> server   | `{"frame":"rpc", ...}`      |
//! | `rpcResult`  | server -> client   | `{"frame":"rpcResult", ...}`|
//!
//! `event` frames are unwrapped on purpose: they are byte-identical to
//! what the desktop shell emits over Tauri IPC (see
//! [`crate::orchestration::DomainEvent`]), so the frontend's
//! `DomainEventSchema` (`src/lib/event-bus.ts`) parses both unchanged. A
//! receiver tells an `event` frame from every other frame by the
//! absence of a `"frame"` key: every control frame has one, a
//! `DomainEvent` never does.

use serde::{Deserialize, Serialize};

/// Client -> server frames.
///
/// `Debug` is written by hand so a logged frame never shows the daemon
/// token or a command's arguments (a `write_config` value, say).
#[derive(Clone, Serialize, Deserialize)]
#[serde(tag = "frame", rename_all = "camelCase")]
pub enum ClientFrame {
    /// Sent once immediately after the socket opens, and again on every
    /// reconnect.
    Hello {
        /// The last `seq` the client has seen: the server replays every
        /// persisted event after it. `None` is a cold attach: no replay
        /// (`ready`, then `replayEnd` at the current head) and the
        /// client hydrates from the snapshot `list_*` commands instead
        /// of replaying the whole log.
        #[serde(rename = "lastSeq")]
        last_seq: Option<u64>,
        /// The daemon token. Required within the handshake deadline
        /// unless the connection already authenticated with an
        /// `Authorization: Bearer` header at HTTP-upgrade time.
        #[serde(default)]
        token: Option<String>,
    },
    /// A command invocation, dispatched through
    /// [`crate::commands::Registry::dispatch_remote`]: the same table
    /// the Tauri IPC wrappers call, plus each command's remote policy.
    Rpc {
        /// Client-generated correlation id, echoed back on
        /// [`ServerFrame::RpcResult`].
        id: String,
        /// Command name — identical to the Tauri IPC command name
        /// (`"spawn_worker"`, `"events_since"`, ...).
        cmd: String,
        /// The command's arguments: a JSON object, or omitted/`null`
        /// for none.
        #[serde(default)]
        args: serde_json::Value,
    },
}

impl std::fmt::Debug for ClientFrame {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Hello { last_seq, token } => f
                .debug_struct("Hello")
                .field("last_seq", last_seq)
                .field("token", &token.as_ref().map(|_| "<redacted>"))
                .finish(),
            Self::Rpc { id, cmd, .. } => f
                .debug_struct("Rpc")
                .field("id", id)
                .field("cmd", cmd)
                .finish_non_exhaustive(),
        }
    }
}

/// Server -> client control frames (everything except `event`, which is
/// unwrapped — see the module doc).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "frame", rename_all = "camelCase")]
pub enum ServerFrame {
    /// Handshake ack.
    Ready {
        /// The server's head `seq` when the client attached (a cold
        /// client hydrates from here).
        #[serde(rename = "serverSeq")]
        server_seq: u64,
        /// [`PROTOCOL_VERSION`].
        version: u32,
        /// The server's advertised limits.
        caps: ServerCaps,
    },
    /// Marks the end of one replay burst, empty (the client was caught
    /// up) or paged through history. A client is live only after the
    /// `replayEnd` of its CURRENT `hello`, not merely after receiving
    /// some events.
    ReplayEnd {
        /// The last `seq` the replay covered; live events follow it.
        seq: u64,
    },
    /// Response to a client [`ClientFrame::Rpc`], correlated by `id`.
    /// Exactly one of `result`/`error` is present, mirroring
    /// `Result<Value, Value>` on the wire (never both, never neither).
    RpcResult {
        /// The [`ClientFrame::Rpc`]'s `id`.
        id: String,
        /// Whether the command succeeded (`result`) or failed (`error`).
        ok: bool,
        /// The command's result, when `ok`.
        #[serde(skip_serializing_if = "Option::is_none")]
        result: Option<serde_json::Value>,
        /// The command's error (a string today), when not `ok`.
        #[serde(skip_serializing_if = "Option::is_none")]
        error: Option<serde_json::Value>,
    },
}

/// Wire protocol version — bump on any breaking frame-shape change.
pub const PROTOCOL_VERSION: u32 = 1;

/// The server's limits, sent in `ready` so the client never hardcodes
/// them.
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
    use std::assert_matches;

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
        assert_matches!(
            back,
            ClientFrame::Hello {
                last_seq: Some(42),
                token: Some(ref t),
            } if t == "abc"
        );
    }

    #[test]
    fn test_client_frame_debug_never_shows_the_token_or_args() {
        let hello = ClientFrame::Hello {
            last_seq: None,
            token: Some("s3cret-token".to_owned()),
        };
        let rpc = ClientFrame::Rpc {
            id: "r1".to_owned(),
            cmd: "write_config".to_owned(),
            args: serde_json::json!({"key": "k", "value": "s3cret-value"}),
        };
        for printed in [format!("{hello:?}"), format!("{rpc:?}")] {
            assert!(!printed.contains("s3cret"), "{printed}");
        }
        assert!(format!("{rpc:?}").contains("write_config"));
    }

    #[test]
    fn test_hello_last_seq_null_means_cold_attach() {
        let json = serde_json::json!({"frame": "hello", "lastSeq": null, "token": "t"});
        let frame: ClientFrame = serde_json::from_value(json).unwrap();
        assert_matches!(frame, ClientFrame::Hello { last_seq: None, .. });
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

    /// A `DomainEvent` must never carry a `"frame"` key: its absence is
    /// how every client tells an `event` frame from a control frame.
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
