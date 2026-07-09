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
- [AI Commands](#ai-commands)
  - [ai_request](#ai_request)
- [Metrics Commands](#metrics-commands)
  - [get_metrics](#get_metrics)
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

---

## Metrics Commands

### `get_metrics`

Returns a snapshot of the current aggregate worker metrics.

**Parameters:** None

**Returns:** `AggregateMetrics` (JSON)

| Field          | Type     | Description                    |
|----------------|----------|--------------------------------|
| `totalWorkers` | `number` | Total registered workers       |
| `running`      | `number` | Workers in `running` state     |
| `paused`       | `number` | Workers in `paused` state      |
| `idle`         | `number` | Workers in `idle` state        |
| `errored`      | `number` | Workers in `error` state       |

**Example:**

```typescript
const metrics = await invoke("get_metrics");
console.log(`${metrics.running}/${metrics.totalWorkers} workers running`);
```

**Note:** This is the pull-based complement to the push-based `system:metrics` event (emitted every 500ms).

---

## Events

### Event Channel Reference

All events use colon-separated channel names. Payload fields are `camelCase`.

| Channel           | Payload Type             | Frequency        |
|-------------------|--------------------------|------------------|
| `worker:spawned`  | `WorkerSpawnedPayload`   | On spawn         |
| `worker:killed`   | `WorkerKilledPayload`    | On kill          |
| `worker:output`   | `WorkerOutputPayload`    | Continuous       |
| `worker:state`    | `WorkerStatePayload`     | On state change  |
| `session:created` | `SessionCreatedPayload`  | On create        |
| `session:deleted` | `SessionDeletedPayload`  | On delete        |
| `system:metrics`  | `SystemMetricsPayload`   | Every 500ms      |
| `ai:stream_delta` | `AiStreamDeltaPayload`   | Per AI chunk     |
| `system:log`      | `SystemLogPayload`       | On log emit      |

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

// Cleanup on unmount
unlisten();
```
