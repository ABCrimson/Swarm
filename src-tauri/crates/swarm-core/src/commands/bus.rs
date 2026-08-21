//! Message bus registry handlers — ported verbatim from
//! `swarm-desktop`'s former `commands::bus`, then pruned in the
//! multi-provider plan's Phase 4 ("bus disposition, part 2" — see
//! `crate::bus::router`'s module doc). `bus_subscribe`/
//! `bus_create_pipeline`/`bus_list_pipelines` are DELETED: `bus_send`
//! now emits `bus_message` directly (via [`crate::bus::router::Router`]),
//! so a second subscription primitive would just recreate the
//! ad-hoc-events problem the ordered spine already eliminated, and the
//! pipeline machinery never awaited a real stage's completion (see the
//! router module doc for the full disposition writeup).

use serde::Deserialize;
use serde_json::Value;

use super::{Ctx, ok_value, parse_args, parse_uuid};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BusSendArgs {
    from_worker_id: String,
    #[serde(default)]
    to_worker_id: Option<String>,
    topic: String,
    payload: Value,
    /// The `seq` of the event that caused this send (e.g. an
    /// `agent_turn_started`/`agent_tool_call` an adapter is handing off
    /// from) — threaded straight onto the emitted `bus_message`'s
    /// envelope-level `causeSeq`. `None` for a human-initiated send with
    /// no single causing event.
    #[serde(default)]
    cause_seq: Option<u64>,
}

pub async fn bus_send(ctx: Ctx, args: Value) -> Result<Value, Value> {
    let BusSendArgs {
        from_worker_id,
        to_worker_id,
        topic,
        payload,
        cause_seq,
    } = parse_args(args)?;
    let from = parse_uuid(&from_worker_id)?;
    let to = to_worker_id.map(|s| parse_uuid(&s)).transpose()?;

    let count = if let Some(to) = to {
        ctx.router.send_direct(from, to, &topic, payload, cause_seq)
    } else {
        ctx.router.send_broadcast(from, &topic, payload, cause_seq)
    }
    .map_err(Value::String)?;

    ok_value(&count)
}

pub async fn bus_list_channels(ctx: Ctx, _args: Value) -> Result<Value, Value> {
    ok_value(&ctx.message_bus.list_channels())
}
