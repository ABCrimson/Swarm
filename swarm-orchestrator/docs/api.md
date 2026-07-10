# API Reference

> Tauri IPC command documentation for the SWARM Orchestrator backend.

All commands are invoked from the React frontend via `@tauri-apps/api`:

```typescript
import { invoke } from "@tauri-apps/api/core";
const result = await invoke("command_name", { arg1: value1 });
```

Events are received on a single ordered channel, `swarm://events` -- see [Events](#events) below for the envelope contract. The frontend does not call `listen()` directly outside of `src/lib/event-bus.ts`; application code subscribes via `onEvent()`/`waitFor()`.

---

## Table of Contents

- [Worker Commands](#worker-commands)
  - [spawn_worker](#spawn_worker)
  - [pause_worker](#pause_worker)
  - [resume_worker](#resume_worker)
  - [kill_worker](#kill_worker)
  - [list_workers](#list_workers)
  - [worker_input](#worker_input)
- [Session Commands](#session-commands)
  - [create_session](#create_session)
  - [delete_session](#delete_session)
  - [list_sessions](#list_sessions)
  - [get_session](#get_session)
  - [session_add_worker](#session_add_worker)
- [AI Commands](#ai-commands)
  - [ai_request](#ai_request)
- [Metrics Commands](#metrics-commands)
  - [get_metrics](#get_metrics)
- [Bus Commands](#bus-commands)
  - [bus_send](#bus_send)
  - [bus_subscribe](#bus_subscribe)
  - [bus_create_pipeline](#bus_create_pipeline)
  - [bus_list_channels](#bus_list_channels)
  - [bus_list_pipelines](#bus_list_pipelines)
- [Updater Commands](#updater-commands)
  - [check_for_updates](#check_for_updates)
- [Notification Commands](#notification-commands)
  - [send_notification](#send_notification)
- [Events](#events)

---

## Worker Commands

### `spawn_worker`

Creates a new worker process with a PTY and registers it in the worker registry.

**Parameters:**

| Name     | Type           | Required | Description                                    |
|----------|----------------|----------|------------------------------------------------|
| `config` | `WorkerConfig` | Yes      | Worker spawn configuration                     |

**`WorkerConfig` object:**

| Field   | Type                  | Default            | Description                          |
|---------|-----------------------|--------------------|--------------------------------------|
| `name`  | `string`              | `"Worker"`         | Human-readable display name          |
| `shell` | `string`              | System default     | Shell executable path                |
| `cwd`   | `string`              | `""`               | Initial working directory            |
| `env`   | `Record<string, string>` | `{}`            | Additional environment variables     |
| `rows`  | `number`              | `24`               | PTY terminal rows                    |
| `cols`  | `number`              | `80`               | PTY terminal columns                 |

**Returns:** `string` -- UUID of the newly spawned worker.

**Errors:**

| Error               | Condition                                |
|---------------------|------------------------------------------|
| PTY spawn failed    | Shell executable not found or PTY error  |
| Registry at capacity| Worker count exceeds max_workers (64)    |

**Example:**

```typescript
const workerId = await invoke("spawn_worker", {
  config: {
    name: "Research Agent",
    shell: "powershell.exe",
    cwd: "C:/Projects",
    env: { TERM: "xterm-256color" },
    rows: 30,
    cols: 120,
  },
});
console.log("Spawned worker:", workerId);
```

**Emits:** `worker_spawned` envelope on `swarm://events` with payload `{ workerId, name, pid }`.

---

### `pause_worker`

Pauses a running worker by transitioning its state to `paused`.

**Parameters:**

| Name | Type     | Required | Description              |
|------|----------|----------|--------------------------|
| `id` | `string` | Yes      | UUID of the worker       |

**Returns:** `void`

**Errors:**

| Error            | Condition                       |
|------------------|---------------------------------|
| Invalid UUID     | `id` is not a valid UUID string |
| Worker not found | No worker with the given ID     |

**Example:**

```typescript
await invoke("pause_worker", { id: "550e8400-e29b-41d4-a716-446655440000" });
```

**Emits:** `worker_state` envelope on `swarm://events` with payload `{ workerId, state: "paused" }`.

**Note:** On Windows, this only updates the internal state. Process-level suspension via `SIGSTOP` is not supported.

---

### `resume_worker`

Resumes a paused worker by transitioning its state back to `running`.

**Parameters:**

| Name | Type     | Required | Description              |
|------|----------|----------|--------------------------|
| `id` | `string` | Yes      | UUID of the worker       |

**Returns:** `void`

**Errors:**

| Error            | Condition                       |
|------------------|---------------------------------|
| Invalid UUID     | `id` is not a valid UUID string |
| Worker not found | No worker with the given ID     |

**Example:**

```typescript
await invoke("resume_worker", { id: "550e8400-e29b-41d4-a716-446655440000" });
```

**Emits:** `worker_state` envelope on `swarm://events` with payload `{ workerId, state: "running" }`.

---

### `kill_worker`

Terminates a worker process and removes it from the registry.

Drops the PTY writer (closes master fd), kills the child process, waits for exit to prevent zombie processes, and emits a killed event.

**Parameters:**

| Name | Type     | Required | Description              |
|------|----------|----------|--------------------------|
| `id` | `string` | Yes      | UUID of the worker       |

**Returns:** `void`

**Errors:**

| Error            | Condition                       |
|------------------|---------------------------------|
| Invalid UUID     | `id` is not a valid UUID string |
| Worker not found | No worker with the given ID     |

**Example:**

```typescript
await invoke("kill_worker", { id: "550e8400-e29b-41d4-a716-446655440000" });
```

**Emits:** `worker_killed` envelope on `swarm://events` with payload `{ workerId }`.

---

### `list_workers`

Returns a list of all active workers as serializable info snapshots.

**Parameters:** None

**Returns:** `WorkerInfo[]`

**`WorkerInfo` object:**

| Field       | Type             | Description                        |
|-------------|------------------|------------------------------------|
| `id`        | `string` (UUID)  | Unique worker identifier           |
| `state`     | `string`         | `"idle"`, `"running"`, `"paused"`, or `"error"` |
| `name`      | `string`         | Human-readable display name        |
| `pid`       | `number \| null` | OS process ID, if available        |
| `startedAt` | `number`         | Unix timestamp (seconds)           |

**Example:**

```typescript
const workers = await invoke("list_workers");
// [{ id: "...", state: "running", name: "Agent 1", pid: 1234, startedAt: 1700000000 }]
```

---

### `worker_input`

Sends raw input bytes to a worker's PTY stdin.

**Parameters:**

| Name   | Type       | Required | Description                     |
|--------|------------|----------|---------------------------------|
| `id`   | `string`   | Yes      | UUID of the target worker       |
| `data` | `number[]` | Yes      | Raw bytes to write to the PTY   |

**Returns:** `void`

**Errors:**

| Error            | Condition                          |
|------------------|------------------------------------|
| Invalid UUID     | `id` is not a valid UUID string    |
| Worker not found | No worker with the given ID        |
| IPC error        | Worker has no PTY writer or write failed |

**Example:**

```typescript
// Send "ls\n" to the worker's terminal
const encoder = new TextEncoder();
const data = Array.from(encoder.encode("ls\n"));
await invoke("worker_input", { id: workerId, data });
```

---

## Session Commands

### `create_session`

Creates a new session with the given name and configuration.

**Parameters:**

| Name     | Type   | Required | Description                        |
|----------|--------|----------|------------------------------------|
| `name`   | `string` | Yes    | Human-readable session name        |
| `config` | `object` | Yes    | Arbitrary JSON configuration       |

**Returns:** `Session`

**`Session` object:**

| Field       | Type            | Description                        |
|-------------|------------------|------------------------------------|
| `id`        | `string` (UUID) | Unique session identifier          |
| `name`      | `string`        | Session name                       |
| `workerIds` | `string[]`      | UUIDs of workers in this session   |
| `createdAt` | `number`        | Unix timestamp (seconds)           |
| `config`    | `object`        | Arbitrary JSON configuration       |

**Example:**

```typescript
const session = await invoke("create_session", {
  name: "Research Session",
  config: { model: "claude-sonnet-4-20250514", maxTokens: 4096 },
});
console.log("Created session:", session.id);
```

**Emits:** `session_created` envelope on `swarm://events` with payload `{ sessionId, name }`.

**Side effect:** Auto-saves all sessions to `sessions.json`.

---

### `delete_session`

Deletes a session by ID.

**Parameters:**

| Name | Type     | Required | Description              |
|------|----------|----------|--------------------------|
| `id` | `string` | Yes      | UUID of the session      |

**Returns:** `void`

**Errors:**

| Error             | Condition                        |
|-------------------|----------------------------------|
| Invalid UUID      | `id` is not a valid UUID string  |
| Session not found | No session with the given ID     |

**Example:**

```typescript
await invoke("delete_session", { id: session.id });
```

**Emits:** `session_deleted` envelope on `swarm://events` with payload `{ sessionId }`.

**Side effect:** Auto-saves remaining sessions to `sessions.json`.

---

### `list_sessions`

Returns a list of all active sessions.

**Parameters:** None

**Returns:** `Session[]`

**Example:**

```typescript
const sessions = await invoke("list_sessions");
```

---

### `get_session`

Gets a single session by ID.

**Parameters:**

| Name | Type     | Required | Description              |
|------|----------|----------|--------------------------|
| `id` | `string` | Yes      | UUID of the session      |

**Returns:** `Session`

**Errors:**

| Error             | Condition                        |
|-------------------|----------------------------------|
| Invalid UUID      | `id` is not a valid UUID string  |
| Session not found | No session with the given ID     |

**Example:**

```typescript
const session = await invoke("get_session", { id: "550e8400-..." });
```

---

### `session_add_worker`

Registers a worker against a session's `workerIds` list.

**Parameters:**

| Name         | Type     | Required | Description                        |
|--------------|----------|----------|-------------------------------------|
| `sessionId`  | `string` | Yes      | UUID of the target session          |
| `workerId`   | `string` | Yes      | UUID of the worker to add           |

**Returns:** `void`

**Errors:**

| Error             | Condition                                |
|-------------------|-------------------------------------------|
| Invalid UUID      | `sessionId` or `workerId` is not a valid UUID |
| Session not found | No session with the given ID exists       |

**Example:**

```typescript
await invoke("session_add_worker", {
  sessionId: session.id,
  workerId,
});
```

**Side effect:** Auto-saves the updated session list to `sessions.json`.

---

## AI Commands

### `ai_request`

Enqueues an AI request for streaming processing via the Anthropic Messages API.

The request is placed into a priority queue and processed when a concurrency slot is available (default: 3 concurrent requests). Response chunks are delivered as `ai_stream_delta` envelopes on `swarm://events`, followed by exactly one `ai_stream_settled` receipt.

**Parameters:**

| Name      | Type        | Required | Description                          |
|-----------|-------------|----------|--------------------------------------|
| `request` | `AiRequest` | Yes      | The AI request to enqueue            |

**`AiRequest` object:**

| Field       | Type          | Required | Default    | Description                         |
|-------------|---------------|----------|------------|-------------------------------------|
| `requestId` | `string`      | Yes      | --         | Unique ID for correlating stream events |
| `messages`  | `AiMessage[]` | Yes      | --         | Conversation history                |
| `system`    | `string`      | No       | `null`     | Optional system prompt              |
| `priority`  | `string`      | No       | `"normal"` | `"low"`, `"normal"`, `"high"`, `"critical"` |

**`AiMessage` object:**

| Field     | Type     | Description                            |
|-----------|----------|----------------------------------------|
| `role`    | `string` | `"user"` or `"assistant"`              |
| `content` | `string` | Message text content                   |

**Returns:** `string` -- The `requestId` from the request.

**Errors:**

| Error          | Condition                              |
|----------------|----------------------------------------|
| Queue full     | AI request queue at capacity (backpressure) |
| Channel closed | AI queue processing loop has shut down |

**Example:**

```typescript
import { onEvent, waitFor } from "#lib/event-bus";

const requestId = crypto.randomUUID();

// Accumulate deltas as they arrive
const off = onEvent("ai_stream_delta", (e) => {
  const { requestId: id, delta, done } = e.payload as {
    requestId: string;
    delta: string;
    done: boolean;
  };
  if (id === requestId && !done) console.log(delta);
});

// Enqueue the request
await invoke("ai_request", {
  request: {
    requestId,
    messages: [
      { role: "user", content: "Explain quantum computing in one paragraph." },
    ],
    system: "You are a helpful science tutor.",
    priority: "normal",
  },
});

// Await the terminal receipt instead of polling stream state
const settled = await waitFor(
  (e) => e.type === "ai_stream_settled" && (e.payload as { requestId: string }).requestId === requestId,
);
off();
console.log("Stream settled:", settled.payload);
```

**Emits:** Multiple `ai_stream_delta` envelopes, then exactly one `ai_stream_settled` receipt:

| Type                | Field       | Type              | Description                                  |
|---------------------|-------------|-------------------|-----------------------------------------------|
| `ai_stream_delta`   | `requestId` | `string`          | Correlation ID matching the request          |
| `ai_stream_delta`   | `delta`     | `string`          | Text chunk (empty string on the final delta) |
| `ai_stream_delta`   | `done`      | `boolean`         | `true` on the final delta                    |
| `ai_stream_settled` | `requestId` | `string`          | Correlation ID matching the request          |
| `ai_stream_settled` | `status`    | `string`          | `"ok"` or `"error"`                          |
| `ai_stream_settled` | `error`     | `string \| null`  | Error description when `status == "error"`   |

**Guaranteed termination:** `ai_stream_settled` is always emitted exactly once for a given `requestId`, after the final delta, even when the stream fails (network error, malformed SSE, provider error) or ends without a `message_stop` event. Frontend and test consumers should `waitFor` this receipt instead of polling stream state or relying on `delta.done` alone -- there is no scenario where a request is enqueued and the frontend never receives the terminal receipt.

**Note:** As of this writing, no shipped UI consumes `ai_stream_delta`/`ai_stream_settled` -- this documents the receipt contract, not an active consumer.

---

## Metrics Commands

### `get_metrics`

Returns a snapshot of the current aggregate worker metrics.

**Parameters:** None

**Returns:** JSON object combining system, aggregate worker, and per-worker metrics.

| Field          | Type            | Description                              |
|----------------|-----------------|-------------------------------------------|
| `cpuPercent`   | `number`        | Global CPU usage percentage, via `sysinfo` |
| `memoryMb`     | `number`        | Used system memory in megabytes, via `sysinfo` |
| `totalWorkers` | `number`        | Total registered workers                 |
| `running`      | `number`        | Workers in `running` state               |
| `paused`       | `number`        | Workers in `paused` state                |
| `idle`         | `number`        | Workers in `idle` state                  |
| `errored`      | `number`        | Workers in `error` state                 |
| `perWorker`    | `PerWorkerMetric[]` | Per-worker process metrics (see below) |

**`PerWorkerMetric` object:**

| Field         | Type             | Description                                         |
|---------------|------------------|------------------------------------------------------|
| `workerId`    | `string` (UUID)  | UUID of the worker                                  |
| `pid`         | `number \| null` | OS process ID, if the worker has one                |
| `cpuPercent`  | `number`         | Process-level CPU usage percentage (`0` if no PID or process not found) |
| `memoryBytes` | `number`         | Process-level resident memory in bytes (`0` if no PID or process not found) |

**Example:**

```typescript
const metrics = await invoke("get_metrics");
console.log(`${metrics.running}/${metrics.totalWorkers} workers running`);
for (const w of metrics.perWorker) {
  console.log(`${w.workerId}: ${w.cpuPercent.toFixed(1)}% CPU, ${w.memoryBytes} bytes`);
}
```

**Note:** This is the pull-based complement to the push-based `system_metrics` envelope (emitted every 500ms on `swarm://events`; ephemeral -- consumes a seq but is never persisted). Both `get_metrics` and the background loop read from the same `SharedSystem` (managed state wrapping one `sysinfo::System` behind a `parking_lot::Mutex`), so CPU usage deltas are computed from a single source of truth instead of two independently-refreshing `System` instances.

---

## Bus Commands

The message bus enables direct, broadcast, and pipeline-routed communication between workers. It is composed of a `MessageBus` (per-topic `tokio::sync::broadcast` channels) and a `Router` (direct/broadcast send + pipeline orchestration), both held as Tauri managed state.

### `bus_send`

Sends a message from one worker to another (or broadcasts it) on a topic.

**Parameters:**

| Name           | Type                | Required | Description                                          |
|----------------|---------------------|----------|--------------------------------------------------------|
| `fromWorkerId` | `string`            | Yes      | UUID of the sending worker                              |
| `toWorkerId`   | `string \| null`    | No       | UUID of the target worker. Omit/`null` to broadcast     |
| `topic`        | `string`            | Yes      | Topic channel to send on                                |
| `payload`      | `unknown` (JSON)    | Yes      | Arbitrary JSON payload                                  |

**Returns:** `number` -- the count of receivers that received the message. `0` means no [`bus_subscribe`](#bus_subscribe) caller is currently listening on this topic.

**Errors:**

| Error         | Condition                                    |
|---------------|------------------------------------------------|
| Invalid UUID  | `fromWorkerId` or `toWorkerId` is not a valid UUID |

**Example:**

```typescript
const receiverCount = await invoke("bus_send", {
  fromWorkerId: workerA,
  toWorkerId: workerB, // omit for broadcast
  topic: "task:result",
  payload: { status: "done", output: "..." },
});
```

**Important:** `bus_send` only publishes to the internal bus -- it does **not** emit a frontend event itself. Delivery to the frontend happens exclusively via [`bus_subscribe`](#bus_subscribe)'s forwarding task (see [Unified Bus Event Contract](#unified-bus-event-contract) below).

---

### `bus_subscribe`

Subscribes to a topic and streams matching messages to the frontend as `bus_message` envelopes on `swarm://events`.

**Parameters:**

| Name    | Type     | Required | Description         |
|---------|----------|----------|----------------------|
| `topic` | `string` | Yes      | Topic to subscribe to |

**Returns:** `void` -- resolves once the background forwarding task is spawned; messages arrive later as events.

**Errors:**

| Error              | Condition                          |
|--------------------|--------------------------------------|
| Subscription failed | Failed to create/attach to the broadcast channel |

**Example:**

```typescript
import { onEvent } from "#lib/event-bus";

await invoke("bus_subscribe", { topic: "task:result" });

const off = onEvent("bus_message", (e) => {
  const { messageId, fromWorker, toWorker, topic, payload } = e.payload as {
    messageId: string;
    fromWorker: string;
    toWorker: string | null;
    topic: string;
    payload: unknown;
  };
  console.log(`[${topic}] ${fromWorker} -> ${toWorker ?? "*"}:`, payload);
});
```

**Emits:** `bus_message` envelope on `swarm://events` with payload `{ messageId, fromWorker, toWorker, topic, payload }` for every message received on the subscribed topic, for the lifetime of the subscription task.

---

### `bus_create_pipeline`

Creates a new multi-stage message processing pipeline. Each stage names a worker and an optional jq-like dot-notation transform (e.g., `".result"`, `".data.items"`) applied to the payload before it is forwarded to the next stage.

**Parameters:**

| Name     | Type              | Required | Description                              |
|----------|-------------------|----------|--------------------------------------------|
| `stages` | `PipelineStage[]` | Yes      | Ordered list of pipeline stages            |

**`PipelineStage` object:**

| Field       | Type              | Description                                            |
|-------------|-------------------|-----------------------------------------------------------|
| `workerId`  | `string` (UUID)   | Worker that processes this stage                          |
| `transform` | `string \| null`  | Optional dot-notation field selector applied to the payload |

**Returns:** `string` -- UUID of the newly created pipeline.

**Example:**

```typescript
const pipelineId = await invoke("bus_create_pipeline", {
  stages: [
    { workerId: workerA, transform: null },
    { workerId: workerB, transform: ".result" },
  ],
});
```

---

### `bus_list_channels`

Lists all active message bus topic channels.

**Parameters:** None

**Returns:** `string[]`

**Example:**

```typescript
const topics = await invoke("bus_list_channels");
```

---

### `bus_list_pipelines`

Lists all registered pipelines.

**Parameters:** None

**Returns:** `PipelineInfo[]`

**`PipelineInfo` object:**

| Field        | Type             | Description                        |
|--------------|------------------|--------------------------------------|
| `id`         | `string` (UUID)  | Pipeline identifier                  |
| `stageCount` | `number`         | Number of stages in the pipeline     |
| `workerIds`  | `string[]`       | Worker IDs in pipeline order         |

**Example:**

```typescript
const pipelines = await invoke("bus_list_pipelines");
```

---

## Updater Commands

### `check_for_updates`

Checks the configured update endpoint (`tauri-plugin-updater`) for an available application update.

**Parameters:** None (the `AppHandle` is injected automatically)

**Returns:** JSON object:

| Field       | Type                | Description                                  |
|-------------|---------------------|------------------------------------------------|
| `available` | `boolean`           | Whether an update is available                 |
| `version`   | `string` (optional) | Version of the available update, if any        |
| `body`      | `string` (optional) | Release notes, if any                          |
| `date`      | `string` (optional) | Release date, if any                           |

**Errors:**

| Error              | Condition                                    |
|--------------------|-------------------------------------------------|
| Update check failed | The updater plugin could not reach the update endpoint (e.g., network error) |

**Example:**

```typescript
const update = await invoke("check_for_updates");
if (update.available) {
  console.log(`Update ${update.version} available:`, update.body);
}
```

Updates are signed with an Ed25519 keypair; see [`src-tauri/UPDATER_KEYS.md`](../src-tauri/UPDATER_KEYS.md) for key setup and the `plugins.updater.pubkey` value configured in `tauri.conf.json`.

---

## Notification Commands

### `send_notification`

Sends a native OS notification via `tauri-plugin-notification`.

**Parameters:**

| Name    | Type              | Required | Description                        |
|---------|-------------------|----------|--------------------------------------|
| `title` | `string`          | Yes      | Notification title                   |
| `body`  | `string`          | Yes      | Notification body text               |
| `icon`  | `string \| null`  | No       | Optional path to a notification icon |

**Returns:** `void`

**Errors:**

| Error                | Condition                                  |
|----------------------|-----------------------------------------------|
| Notification failed  | The OS notification failed to display          |

**Example:**

```typescript
await invoke("send_notification", {
  title: "Worker finished",
  body: "Research Agent completed its task.",
  icon: null,
});
```

---

## Events

Every backend event -- worker lifecycle, session lifecycle, AI streaming, metrics, logs, bus messages -- travels on a **single** Tauri channel, `swarm://events`, as a seq-ordered envelope. There are no per-domain channels; `listen()` against anything else is not part of the contract.

### The Envelope

```json
{ "seq": 42, "ts": 1752099600123, "type": "worker_spawned", "payload": { "workerId": "...", "name": "...", "pid": 1234 } }
```

| Field     | Type     | Description                                                          |
|-----------|----------|------------------------------------------------------------------------|
| `seq`     | `number` | Monotonic sequence number assigned by the single-writer engine. Wire order == seq order; never reused, never reordered. |
| `ts`      | `number` | Unix timestamp in milliseconds, assigned by the writer thread.        |
| `type`    | `string` | Event type tag, `snake_case` (e.g. `"worker_spawned"`).               |
| `payload` | `object` | The event's data, `camelCase` fields -- shape depends on `type`.       |

`seq` is assigned by one dedicated writer thread (the `OrchestrationEngine`) that every backend call routes through via `emit_event`, so there is a single, total order across every event type -- a `worker_spawned` and a `session_created` racing in the backend still land on the wire (and in the log) in a well-defined, non-interleaved order.

### Type Tags

| Type                 | Payload                                                        | Persisted |
|----------------------|-----------------------------------------------------------------|-----------|
| `worker_spawned`     | `{ workerId, name, pid }`                                       | Yes       |
| `worker_killed`      | `{ workerId }`                                                   | Yes       |
| `worker_output`      | `{ workerId, data }`                                             | No (ephemeral) |
| `worker_state`       | `{ workerId, state }`                                            | Yes       |
| `session_created`    | `{ sessionId, name }`                                            | Yes       |
| `session_deleted`    | `{ sessionId }`                                                  | Yes       |
| `system_metrics`     | `{ cpuPercent, memoryMb, workerCount, aiReqPerSec, timestamp }`  | No (ephemeral) |
| `ai_stream_delta`    | `{ requestId, delta, done }`                                     | Yes       |
| `ai_stream_settled`  | `{ requestId, status, error }` -- terminal receipt, exactly once per request | Yes |
| `system_log`         | `{ level, message, target, timestamp }`                          | No (ephemeral) |
| `bus_message`        | `{ messageId, fromWorker, toWorker, topic, payload }`            | Yes       |

### Unified Bus Event Contract

`bus_message` envelopes are delivered through exactly one path: the background task spawned by [`bus_subscribe`](#bus_subscribe). `bus_send` never emits directly. This guarantees each message reaches the frontend **at most once**, in one consistent shape, regardless of how many (if any) `bus_subscribe` calls are active for a topic -- there is no double-delivery and no risk of the emit-on-send and emit-on-subscribe paths drifting out of sync.

### Persistence Policy

`worker_output`, `system_metrics`, and `system_log` are high-frequency telemetry: they still flow through the ordered stream and each consumes a `seq`, but they are **never written to the log**. They cannot be backfilled after a gap and will not appear in [`events_since`](#events_since) -- treat them as best-effort, live-only.

Every other type persists to the SQLite event log (`<app-data>/swarm-events.db`, WAL mode) before being emitted, so it survives a gap or a restart and can be replayed via `events_since`.

### Receipts

Some request/response flows use a dedicated terminal event (a "receipt") instead of a boolean flag buried in a stream event, so callers have one unambiguous signal to await:

- **`ai_stream_settled`** -- emitted exactly once per AI request, after the final `ai_stream_delta`, on both the success (`status: "ok"`) and failure (`status: "error"`, `error` set) paths. See [`ai_request`](#ai_request) for the contract and an example using `waitFor`. No shipped UI currently consumes this receipt -- it documents the contract for the next consumer, not an existing one.

The frontend's `waitFor(predicate, timeoutMs?)` (in `src/lib/event-bus.ts`) is the general consumption primitive for receipts: it resolves the first envelope matching `predicate`, or rejects on timeout (default 5000ms).

### `events_since`

```typescript
const events = await invoke("events_since", { afterSeq: 100 });
```

Returns **persisted** envelopes with `seq > afterSeq`, ascending, capped at 5000 rows per call. Used by the frontend to backfill after a detected sequence gap (see `src/lib/event-bus.ts`'s gap-detection in `connectEventBus`) and as the foundation for replay. Ephemeral types (`worker_output`, `system_metrics`, `system_log`) never appear in the result, by construction.

Callers page by re-invoking with the last-seen `seq` as the new `afterSeq` while a full (5000-row) page keeps coming back:

```typescript
let cursor = afterSeq;
for (;;) {
  const page = await invoke<DomainEvent[]>("events_since", { afterSeq: cursor });
  for (const e of page) handle(e);
  if (page.length < 5000) break;
  cursor = page[page.length - 1].seq;
}
```

### Subscribing

Application code does not call `listen()` directly -- it goes through `src/lib/event-bus.ts`, which validates every envelope with zod, tracks `lastSeq`, triggers `events_since` backfill on a detected gap (buffering live events that arrive mid-backfill and flushing them seq-sorted afterward), and exposes:

```typescript
import { connectEventBus, onEvent, waitFor } from "#lib/event-bus";

// Once, at app bootstrap:
await connectEventBus();

// Worker output (high frequency -- PTY data)
onEvent("worker_output", (e) => {
  const { workerId, data } = e.payload as { workerId: string; data: string };
  terminal.write(data);
});

// System metrics (every 500ms)
onEvent("system_metrics", (e) => {
  const { cpuPercent, memoryMb, workerCount, timestamp } = e.payload as {
    cpuPercent: number;
    memoryMb: number;
    workerCount: number;
    timestamp: number;
  };
  updateMetricsChart({ cpuPercent, memoryMb, workerCount, timestamp });
});

// Bus messages (requires an active bus_subscribe call for the topic)
await invoke("bus_subscribe", { topic: "task:result" });
onEvent("bus_message", (e) => {
  const { topic, payload } = e.payload as { topic: string; payload: unknown };
  console.log(`[${topic}]`, payload);
});

// A receipt: await a specific ai_stream_settled instead of polling
const settled = await waitFor((e) => e.type === "ai_stream_settled");
```
