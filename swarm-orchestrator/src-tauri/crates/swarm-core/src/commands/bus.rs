//! Message bus registry handlers — ported verbatim from
//! `swarm-desktop`'s former `commands::bus`.

use serde::Deserialize;
use serde_json::Value;

use crate::bus::router::PipelineStage;
use crate::events::{BusMessagePayload, Provenance, SwarmEvent};

use super::{Ctx, ok_value, parse_args, parse_uuid};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BusSendArgs {
    from_worker_id: String,
    #[serde(default)]
    to_worker_id: Option<String>,
    topic: String,
    payload: Value,
}

pub async fn bus_send(ctx: Ctx, args: Value) -> Result<Value, Value> {
    let BusSendArgs {
        from_worker_id,
        to_worker_id,
        topic,
        payload,
    } = parse_args(args)?;
    let from = parse_uuid(&from_worker_id)?;
    let to = to_worker_id.map(|s| parse_uuid(&s)).transpose()?;

    let count = if let Some(to) = to {
        ctx.router.send_direct(from, to, &topic, payload)
    } else {
        ctx.router.send_broadcast(from, &topic, payload)
    }
    .map_err(Value::String)?;

    ok_value(&count)
}

#[derive(Deserialize)]
struct TopicArgs {
    topic: String,
}

pub async fn bus_subscribe(ctx: Ctx, args: Value) -> Result<Value, Value> {
    let TopicArgs { topic } = parse_args(args)?;
    let mut rx = ctx.message_bus.subscribe(&topic).map_err(Value::String)?;
    let sink = ctx.sink.clone();

    tokio::spawn(async move {
        loop {
            match rx.recv().await {
                Ok(msg) => {
                    let from_worker = msg.from_worker;
                    sink.emit_with(
                        SwarmEvent::BusMessage(BusMessagePayload {
                            message_id: msg.id,
                            from_worker: msg.from_worker,
                            to_worker: msg.to_worker,
                            topic: msg.topic,
                            payload: msg.payload,
                        }),
                        Provenance {
                            origin_worker: Some(from_worker),
                            cause_seq: None,
                        },
                    );
                }
                Err(tokio::sync::broadcast::error::RecvError::Lagged(n)) => {
                    tracing::warn!(topic = %topic, skipped = n, "bus subscriber lagged");
                    continue;
                }
                Err(tokio::sync::broadcast::error::RecvError::Closed) => {
                    tracing::debug!(topic = %topic, "bus channel closed, stopping subscriber");
                    break;
                }
            }
        }
    });

    ok_value(&())
}

#[derive(Deserialize)]
struct PipelineArgs {
    stages: Vec<PipelineStage>,
}

pub async fn bus_create_pipeline(ctx: Ctx, args: Value) -> Result<Value, Value> {
    let PipelineArgs { stages } = parse_args(args)?;
    let id = ctx.router.create_pipeline(stages);
    ok_value(&id.to_string())
}

pub async fn bus_list_channels(ctx: Ctx, _args: Value) -> Result<Value, Value> {
    ok_value(&ctx.message_bus.list_channels())
}

pub async fn bus_list_pipelines(ctx: Ctx, _args: Value) -> Result<Value, Value> {
    ok_value(&ctx.router.list_pipelines())
}
