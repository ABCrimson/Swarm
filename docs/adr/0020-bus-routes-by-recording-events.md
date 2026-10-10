# ADR-0020: The bus routes by recording events

- **Status:** Accepted
- **Date:** 2026-08-15 (bounded topic registry 2026-09-23)

## Context

The inter-agent bus began as per-topic tokio broadcast channels, plus a "pipeline" API. Delivery to
the frontend depended on an active `bus_subscribe` forwarder task, which nothing in the shipped app
ever started, so a sent message had nowhere to go. The pipeline (`create_pipeline`, `execute_pipeline`,
`PipelineStage`, `apply_transform`) never awaited any stage's completion and only narrowed the initial
payload, never a worker's output: a synchronous fan-out wearing a pipeline's name. `bus_subscribe` was
a second subscription primitive recreating the ad-hoc-events problem the ordered stream had already
solved.

## Decision

A bus send **is** a `bus_message` event on the ordered stream, recorded by `Router::send(from, to?,
topic, payload, cause_seq?)` with `originWorker` set to the sender and `causeSeq` to the cited cause.
Every frontend and remote client therefore sees it live and a replay sees it again, with no
subscriber needed. A multi-stage hand-off is a chain of `causeSeq` links, which the log already gives
for free.

`bus_subscribe`, `bus_create_pipeline` and `bus_list_pipelines` and the pipeline types are deleted.
`bus_send` and `bus_list_channels` remain. Because topic names are chosen by callers (remote clients
included) and previously accumulated without bound, the `MessageBus` is now only a bounded set of topic
names (`MAX_TOPICS` = 1024); a send on a new topic past the cap is refused and records nothing. The
per-topic broadcast channels are gone (nothing subscribed to them).

## Consequences

- `bus_send` still resolves to the number `0`, kept so its result type did not change.
- No UI surface calls `bus_send` yet; the agent-to-agent hand-off flows an adapter-side caller would
  need are future work.
- Real multi-stage workflows must be built from `causeSeq` chains, not a stage-registration API.

See [Message Bus](../architecture.md#message-bus).
