# ADR-0023: `swarmd` delivers events on one ordered lane

- **Status:** Accepted (supersedes the three-lane writer)
- **Date:** 2026-08-15

## Context

The desktop shell delivers events through a synchronous `emit` closure on the engine's writer thread,
lossless by construction. A WebSocket client has no such path, so each connection rides the engine's
secondary `broadcast` fanout, which is lossy under lag, and heals gaps by replaying from the SQLite
log. The first connection writer used three channels (control, persistent, ephemeral) merged with a
`biased select!`. A live event and a replay or lag-heal page could race across that `select!`, letting
wire order diverge from seq order: a client backfilling a gap could see an out-of-order seq, advance
its cursor past a later-but-lower-seq frame, and silently discard real PTY output it never saw.

## Decision

`ready`, `replayEnd` and every `event` frame (replayed or live) share **one** bounded (4096), FIFO
channel per connection, so wire order is seq order by construction. Persistent frames always enqueue
onto it, blocking the connection (never the engine) if it is momentarily full. Ephemeral frames
(`worker_output`, `system_metrics`, `system_log`, `agent_turn_delta`, terminal-source `worker_input`,
classified by the engine's own `is_persistent`) are dropped newest-first once the lane's occupied
length reaches a watermark (512), reserving headroom so an ephemeral flood can never starve a
persistent frame's blocking send; anything enqueued keeps its position. `rpcResult` frames carry no seq
and ride a separate bounded (256) control lane, which is served first.

Each connection subscribes to the broadcast channel **before** reading the log head, so nothing
published between snapshot and live cutover is missed, pages `events_since` for replay (page size 5000),
and re-runs the same paging whenever it observes `RecvError::Lagged`. A cold `hello` (`lastSeq: null`)
replays nothing and starts at the head, because the client hydrates from the snapshot `list_*`
commands. Concurrently in-flight `rpc` tasks are capped at 8 per connection; beyond that a new `rpc`
frame gets an immediate typed busy `rpcResult`. A replay failure closes the socket with `1011` rather
than claiming it caught up.

## Consequences

- The client's own gap detection in `event-bus.ts` stays as defence in depth, not the only safety net.
- A persistent frame can stall one slow connection, never the engine or other connections.
