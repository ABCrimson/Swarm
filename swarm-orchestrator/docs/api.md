# API Reference

> Tauri IPC command documentation for the SWARM Orchestrator backend.

All commands are invoked from the React frontend via `@tauri-apps/api`:

```typescript
import { invoke } from "@tauri-apps/api/core";
const result = await invoke("command_name", { arg1: value1 });
```

Events are received via:

```typescript
import { listen } from "@tauri-apps/api/event";
const unlisten = await listen("event:channel", (event) => { /* ... */ });
```

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

**Emits:** `worker:spawned` event with `{ workerId, name, pid }`.

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

**Emits:** `worker:state` event with `{ workerId, state: "paused" }`.

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

**Emits:** `worker:state` event with `{ workerId, state: "running" }`.

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

**Emits:** `worker:killed` event with `{ workerId }`.

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

**Emits:** `session:created` event with `{ sessionId, name }`.

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

**Emits:** `session:deleted` event with `{ sessionId }`.

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

The request is placed into a priority queue and processed when a concurrency slot is available (default: 3 concurrent requests). Response chunks are delivered as `ai:stream_delta` events.

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
const requestId = crypto.randomUUID();

// Listen for stream deltas
const unlisten = await listen("ai:stream_delta", (event) => {
  const { requestId: id, delta, done } = event.payload;
  if (id === requestId) {
    if (done) {
      console.log("Stream complete");
      unlisten();
    } else {
      console.log(delta);
    }
  }
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
```

**Emits:** Multiple `ai:stream_delta` events:

| Field       | Type      | Description                              |
|-------------|-----------|------------------------------------------|
| `requestId` | `string`  | Correlation ID matching the request      |
| `delta`     | `string`  | Text chunk (empty string on final event) |
| `done`      | `boolean` | `true` on the final event                |

**Guaranteed termination:** A `done: true` event is always emitted for a given `requestId`, even when the stream fails (network error, malformed SSE, provider error) or ends without a `message_stop` event. Frontend consumers can rely on `done: true` as the definitive signal to stop listening -- there is no scenario where a request is enqueued and the frontend never receives a terminal event.

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

**Note:** This is the pull-based complement to the push-based `system:metrics` event (emitted every 500ms). Both `get_metrics` and the background loop read from the same `SharedSystem` (managed state wrapping one `sysinfo::System` behind a `parking_lot::Mutex`), so CPU usage deltas are computed from a single source of truth instead of two independently-refreshing `System` instances.

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

Subscribes to a topic and streams matching messages to the frontend as `swarm://bus-message` events.

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
await invoke("bus_subscribe", { topic: "task:result" });

const unlisten = await listen("swarm://bus-message", (event) => {
  const { messageId, fromWorker, toWorker, topic, payload } = event.payload;
  console.log(`[${topic}] ${fromWorker} -> ${toWorker ?? "*"}:`, payload);
});
```

**Emits:** `swarm://bus-message` event with `{ messageId, fromWorker, toWorker, topic, payload }` for every message received on the subscribed topic, for the lifetime of the subscription task.

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

### Unified Bus Event Contract

`swarm://bus-message` is delivered through exactly one path: the background task spawned by [`bus_subscribe`](#bus_subscribe). `bus_send` never emits directly. This guarantees each message reaches the frontend **at most once**, in one consistent shape, regardless of how many (if any) `bus_subscribe` calls are active for a topic -- there is no double-delivery and no risk of the emit-on-send and emit-on-subscribe paths drifting out of sync.

### Event Channel Reference

All events use colon-separated channel names (`swarm://bus-message` uses the Tauri URL-style channel form). Payload fields are `camelCase`.

| Channel               | Payload Type             | Frequency        |
|------------------------|--------------------------|------------------|
| `worker:spawned`       | `WorkerSpawnedPayload`   | On spawn         |
| `worker:killed`        | `WorkerKilledPayload`    | On kill          |
| `worker:output`        | `WorkerOutputPayload`    | Continuous       |
| `worker:state`         | `WorkerStatePayload`     | On state change  |
| `session:created`      | `SessionCreatedPayload`  | On create        |
| `session:deleted`      | `SessionDeletedPayload`  | On delete        |
| `system:metrics`       | `SystemMetricsPayload`   | Every 500ms      |
| `ai:stream_delta`      | `AiStreamDeltaPayload`   | Per AI chunk (always terminates with `done: true`) |
| `system:log`           | `SystemLogPayload`       | On log emit      |
| `swarm://bus-message`  | `BusMessagePayload`      | Per bus message, only while a matching `bus_subscribe` task is active |

### Listening to Events

```typescript
import { listen } from "@tauri-apps/api/event";

// Worker output (high frequency -- PTY data)
const unlisten = await listen("worker:output", (event) => {
  const { workerId, data } = event.payload;
  // data is a number[] of raw bytes
  const text = new TextDecoder().decode(new Uint8Array(data));
  terminal.write(text);
});

// System metrics (every 500ms)
await listen("system:metrics", (event) => {
  const { cpuPercent, memoryMb, workerCount, timestamp } = event.payload;
  updateMetricsChart({ cpuPercent, memoryMb, workerCount, timestamp });
});

// Bus messages (requires an active bus_subscribe call for the topic)
await invoke("bus_subscribe", { topic: "task:result" });
await listen("swarm://bus-message", (event) => {
  const { messageId, fromWorker, toWorker, topic, payload } = event.payload;
  console.log(`[${topic}]`, payload);
});

// Cleanup on unmount
unlisten();
```
