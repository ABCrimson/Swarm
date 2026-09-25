//! Inter-agent bus handlers: `bus_send` records a `bus_message` event
//! (see [`crate::bus`]), `bus_list_channels` lists the topics in use.

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
    /// The `seq` of the event that caused this send (an
    /// `agent_turn_started`/`agent_tool_call` an adapter is handing off
    /// from, say), stamped as the `bus_message` envelope's `causeSeq`.
    /// `None` for a human-initiated send.
    #[serde(default)]
    cause_seq: Option<u64>,
}

/// Records a `bus_message` from `fromWorkerId` on `topic`, to
/// `toWorkerId` or, when it is omitted, to every listener.
///
/// Resolves to `0`: the result used to count bus-level receivers, and
/// there are none since delivery moved onto the event stream. The number
/// is kept so the command's result type stays stable.
pub async fn bus_send(ctx: Ctx, args: Value) -> Result<Value, Value> {
    let BusSendArgs {
        from_worker_id,
        to_worker_id,
        topic,
        payload,
        cause_seq,
    } = parse_args(args)?;
    let from = parse_uuid(&from_worker_id)?;
    let to = to_worker_id.as_deref().map(parse_uuid).transpose()?;

    ctx.router
        .send(from, to, topic, payload, cause_seq)
        .map_err(Value::String)?;
    ok_value(&0_usize)
}

/// Every bus topic in use, sorted.
pub async fn bus_list_channels(ctx: Ctx, _args: Value) -> Result<Value, Value> {
    ok_value(&ctx.message_bus.list_channels())
}
