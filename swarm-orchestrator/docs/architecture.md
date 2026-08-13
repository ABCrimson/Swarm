# Architecture

> System architecture reference for the SWARM Orchestrator desktop application.

---

## Table of Contents

- [System Overview](#system-overview)
- [Backend Architecture](#backend-architecture)
- [Frontend Architecture](#frontend-architecture)
- [WebGPU Pipeline](#webgpu-pipeline)
- [Data Flow](#data-flow)
- [State Management](#state-management)
- [Event System](#event-system)
- [Built, Not Wired](#built-not-wired)
- [Error Handling](#error-handling)

---

## System Overview

SWARM Orchestrator is a Tauri 2.11 desktop application with a clear separation between a Rust backend and a React 19 frontend. Communication between the two layers happens exclusively through Tauri's IPC mechanism: **invoke** (request/response) and **listen** (event stream).

```text
 ┌──────────────────────────────────────────────────────┐
 │                   React 19 Frontend                  │
 │  Components  │  Hooks  │  Stores  │  WebGPU Canvas  │
 ├──────────────────────────────────────────────────────┤
 │              Tauri IPC Bridge                        │
 │         invoke() ↕ listen() / emit()                │
 ├──────────────────────────────────────────────────────┤
 │                   Rust Backend                       │
 │  Commands  │  Worker Registry  │  AI Queue  │  Store│
 │                                                      │
 │            Tokio Multi-Thread Runtime                │
 └──────────────────────────────────────────────────────┘
```

**Design principles:**

1. The Rust backend owns all mutable state (workers, sessions, AI queue, message bus)
2. The frontend receives state updates via Tauri events, not polling
3. CPU-bound and blocking work (sysinfo refresh, worker metrics aggregation, session persistence) runs on `spawn_blocking` threads, never on the async executor
4. All IPC payloads use `camelCase` fields; all event type tags use `snake_case`
5. Worker state transitions are TOCTOU-safe: `WorkerRegistry::update_state_if` performs a compare-and-set under the registry's per-entry lock rather than a separate read-then-write

---

## Backend Architecture

The backend is organized into five domain modules under `src-tauri/src/`:

### Module Map

```text
src-tauri/src/
├── ai/              AI integration
│   ├── client.rs    Anthropic API client (reqwest + SSE streaming; always emits a terminal `done: true`)
│   ├── queue.rs     Priority queue with semaphore concurrency control
│   └── stream.rs    SSE event parser (content_block_delta, message_stop)
├── bus/             Inter-agent message bus
│   ├── channel.rs   MessageBus -- per-topic tokio::sync::broadcast channels
│   └── router.rs    Router -- direct/broadcast send + pipeline orchestration
├── commands/        Tauri IPC command handlers
│   ├── worker.rs        spawn, pause, resume, kill, list, input
│   ├── session.rs       create, delete, list, get, session_add_worker
│   ├── ai.rs            ai_request
│   ├── bus.rs           bus_send, bus_subscribe, bus_create_pipeline, bus_list_channels, bus_list_pipelines
│   ├── metrics.rs       get_metrics (incl. perWorker) + background collection loop
│   ├── updater.rs       check_for_updates
│   ├── notification.rs  send_notification
│   └── fs.rs            Delegates to tauri-plugin-fs
├── events/          Event emission system
│   └── emitter.rs   SwarmEvent enum + emit_event() dispatcher (routes into OrchestrationEngine)
├── orchestration/   Ordered event core -- see "Ordered Event Core" below
│   ├── engine.rs    OrchestrationEngine (single writer thread) + DomainEvent envelope
│   └── log.rs       EventLog -- SQLite (WAL) append-only event log
├── session/         Session management
│   ├── manager.rs   DashMap-backed CRUD
│   └── store.rs     Persistence via tauri-plugin-store
├── worker/          Worker management
│   ├── handle.rs    WorkerHandle, WorkerState, WorkerConfig, WorkerInfo
│   ├── lifecycle.rs Spawn, pause, resume, kill, input operations
│   ├── pty.rs       PTY spawning (portable-pty) + Tokio I/O bridge
│   └── registry.rs  DashMap registry, TOCTOU-safe update_state_if, aggregate metrics
├── error.rs         AppError enum (thiserror + Serialize for IPC)
├── lib.rs           Tauri app builder and setup
└── main.rs          Binary entry point (Tokio runtime)
```

### Tokio Runtime

The application creates an explicit Tokio multi-threaded runtime with one worker thread per logical CPU core:

```rust
let runtime = tokio::runtime::Builder::new_multi_thread()
    .worker_threads(std::thread::available_parallelism().map(|n| n.get()).unwrap_or(1))
    .enable_all()
    .build()
    .expect("failed to build Tokio runtime");
```

### Worker Registry

The `WorkerRegistry` is the central data structure for worker management:

- **Storage:** `DashMap<Uuid, WorkerHandle>` -- lock-free concurrent reads, per-shard write locks
- **Configuration:** `parking_lot::RwLock<SystemConfig>` -- max workers (64) and default shell
- **Metrics:** Sequential iteration over worker states for aggregate counts, run inside `tokio::task::spawn_blocking` so the async executor is never blocked. (The 64-worker cap makes sequential aggregation cheaper than `rayon`-style parallel dispatch overhead, so `rayon` was removed from the dependency tree.)
- **Capacity:** Enforces `max_workers` limit, returns `AppError::RegistryFull` on overflow
- **State transitions:** `update_state_if(id, expected, new)` performs an atomic compare-and-set against the current state under the entry's lock, eliminating the read-then-write TOCTOU window that a separate `get` + `insert` would have

### PTY Management

Workers spawn real processes via `portable-pty` 0.9.0:

```text
spawn_pty()
    │
    ├── native_pty_system().openpty()     Create PTY pair
    ├── slave.spawn_command(shell)        Spawn shell in slave PTY
    ├── master.take_writer()              Get writer for input
    ├── master.try_clone_reader()         Get reader for output
    │
    ├── spawn_blocking(reader loop)       4KB buffer, blocking reads
    │       │
    │       └── mpsc::channel(4096)        Bridge to async world (bounded)
    │               │
    └── tokio::spawn(event emitter)       Forward as worker_output events (ephemeral)
```

The PTY writer and child process are wrapped in `parking_lot::Mutex` to satisfy `Sync` requirements for `DashMap` storage.

### AI Queue (Built, Not Wired)

**Nothing in `src/` calls `ai_request` today** -- see [Built, Not Wired](#built-not-wired) for the full picture. The diagram below documents what this Rust-side apparatus does when invoked (it is fully implemented and unit-tested, not a stub); it is not what happens when a user sends a chat message in the shipped app today -- for that, see [AI Streaming](#ai-streaming) under Data Flow.

```text
ai_request command   (no shipped caller -- documented for the next consumer)
                         │
                    mpsc::channel(256)          Bounded queue
                         │
                    process_loop (long-lived task)
                         │
                    BinaryHeap<PrioritizedRequest>
                    (Higher priority first, FIFO within same level)
                         │
                    Semaphore::acquire_owned() [concurrent_limit = 3]
                         │
                    tokio::spawn(client.stream_message())
                         │
                    SSE parser → emit_event(AiStreamDelta) events, terminated by emit_event(AiStreamSettled)
```

Priority levels: `Low (0) < Normal (1) < High (2) < Critical (3)`

On stream failure (network error, malformed SSE, provider error) or a stream that ends without a `message_stop` event, the client still emits a final `ai_stream_delta` with `done: true`, followed by `ai_stream_settled` -- were this path in use, the frontend would be guaranteed a terminal receipt for every enqueued `requestId`.

### Session Persistence

Sessions are stored in `DashMap<Uuid, Session>` and persisted to disk:

- **Storage file:** `sessions.json` in Tauri's app data directory
- **Backend:** `tauri-plugin-store` 2.4.3
- **Auto-save:** After every create/delete/`session_add_worker` operation, offloaded to `spawn_blocking`
- **Restore:** Loaded once during app setup, before any commands are processed

### Message Bus

The `bus` module provides inter-agent communication independent of the AI queue:

- **`MessageBus`** (`bus/channel.rs`): creates and holds one `tokio::sync::broadcast` channel per topic string, in a `DashMap<String, Sender<BusMessage>>`
- **`Router`** (`bus/router.rs`): sends direct messages (`send_direct`, tagged with a `to_worker`) and broadcasts (`send_broadcast`), and owns a `DashMap<Uuid, Pipeline>` of registered multi-stage pipelines
- **Pipelines:** an ordered list of `PipelineStage { worker_id, transform }`; `execute_pipeline` forwards a payload from stage to stage, applying an optional dot-notation field-selector transform (e.g. `.result`, `.data.items`) between stages
- **Frontend delivery contract:** `bus_send` only publishes to the internal bus and never emits an event itself. `bus_subscribe` spawns the sole background task that forwards messages on a topic to the frontend as `bus_message` envelopes on `swarm://events`. This keeps delivery to exactly one event per message, in one payload shape (`BusMessagePayload`), regardless of how many (if any) subscribers are attached -- see [docs/api.md](api.md#unified-bus-event-contract)

### Ordered Event Core

The `orchestration` module owns the single ordered event pipeline that every `emit_event` call (`src-tauri/src/events/emitter.rs`) is routed through:

```text
Any backend call ──emit_event()──> OrchestrationEngine::record()   (mpsc::Sender, any thread)
                                              │
                                    swarm-event-writer thread        (the only writer)
                                              │
                                    seq += 1; ts = now_millis()
                                              │
                                    is_persistent(event)? ──yes──> EventLog::append()   SQLite (WAL)
                                              │                        <app-data>/swarm-events.db
                                              ▼
                                    AppHandle::emit("swarm://events", DomainEvent)
```

- **Single writer, one thread:** `OrchestrationEngine::start` spawns one dedicated `swarm-event-writer` OS thread owning an `mpsc::Receiver<SwarmEvent>` and the `EventLog` connection. `record()` is a non-blocking `Sender::send` callable from any thread/task; the writer loop is the *only* place that assigns `seq`, so wire order is totally ordered by construction -- there is no window where two threads could race to claim the same sequence number.
- **SQLite WAL log:** `EventLog` (`orchestration/log.rs`) opens a SQLite database at `<app-data>/swarm-events.db` in WAL journal mode (`synchronous = NORMAL`), with a single `events(seq INTEGER PRIMARY KEY, ts, type, payload) STRICT` table. `seq` is the primary key, so a duplicate-seq append is a hard error -- an invariant the writer thread's exclusive ownership of `seq` assignment guarantees never fires in practice. On startup, the engine resumes numbering from `EventLog::max_seq()`, so sequence numbers stay monotonic across restarts, not just within one process lifetime.
- **Persistence policy:** every event consumes a `seq`, but only some are written to the log. `is_persistent()` (`orchestration/engine.rs`) excludes `WorkerOutput`, `SystemMetrics`, and `SystemLog` -- high-frequency telemetry that flows live but is not history. Everything else (`worker_spawned`, `worker_killed`, `worker_state`, `session_created`, `session_deleted`, `ai_stream_delta`, `ai_stream_settled`, `bus_message`) persists before being emitted.
- **Emission:** after the persistence step, the writer wraps the event in a `DomainEvent { seq, ts, ..flattened SwarmEvent }` and emits it on the single `swarm://events` Tauri channel. See [docs/api.md#events](api.md#events) for the wire shape and full type-tag list.
- **The receipt pattern:** rather than overload a stream event's payload with a completion flag, terminal outcomes get their own event type -- e.g. `ai_stream_settled`, emitted exactly once per AI request after the final `ai_stream_delta`, on both success and failure. Frontend code awaits the receipt (`waitFor()` in `src/lib/event-bus.ts`) instead of inferring completion from stream contents.
- **Replay foundation:** `commands/orchestration.rs::events_since(after_seq)` returns persisted rows with `seq > after_seq`, ascending, capped at 5000 per call (see [docs/api.md#events_since](api.md#events_since)). This is the data-layer foundation for gap backfill -- already wired into `src/lib/event-bus.ts`'s `connectEventBus` -- and for future replay; a replay *UI* is out of scope for this phase.

### Updates and Notifications

- **`commands/updater.rs`**: `check_for_updates` wraps `tauri-plugin-updater`'s `UpdaterExt::check()`, returning an `available`/`version`/`body`/`date` JSON summary. Updates are signed with an Ed25519 keypair (see [`src-tauri/UPDATER_KEYS.md`](../src-tauri/UPDATER_KEYS.md)); the public key is embedded in `tauri.conf.json` under `plugins.updater.pubkey`
- **`commands/notification.rs`**: `send_notification` wraps `tauri-plugin-notification`'s builder API for native OS notifications (title, body, optional icon)

---

## Frontend Architecture

### React 19 + Compiler

The frontend uses React 19 canary with the React Compiler (`babel-plugin-react-compiler`), enabling automatic memoization and eliminating the need for manual `useMemo`/`useCallback`.

### Module Resolution

The project uses Node.js hash imports for clean module paths:

```json
{
  "#components/*": "./src/components/*.tsx",
  "#store/*":      "./src/store/*.ts",
  "#lib/*":        "./src/lib/*.ts",
  "#workers/*":    "./src/workers/*.ts",
  "#hooks/*":      "./src/hooks/*.ts",
  "#pages/*":      "./src/pages/*.tsx",
  "#styles/*":     "./src/styles/*.css"
}
```

### Component Architecture

```text
AppShell (CSS Grid + GSAP startup animation)
├── Sidebar (navigation, command palette trigger)
├── Topbar (status indicators, session selector)
├── Main Content Area
│   ├── Dashboard (overview metrics)
│   ├── Workers Page
│   │   ├── TopologyGraph (XYFlow + ELK)
│   │   │   ├── WorkerNode (custom node)
│   │   │   └── SpawnOrderEdge (custom edge, labeled "Spawn Order" in the graph's legend -- not a real dependency graph)
│   │   ├── WorkerTerminal (xterm.js + WebGL2)
│   │   └── WorkerAIPanel (terminal + AI chat split)
│   ├── Sessions Page
│   │   ├── SessionList
│   │   └── SessionCard
│   ├── Metrics Page
│   │   ├── CPUChart, MemoryChart
│   │   ├── ThroughputChart, AIMetricsChart
│   │   └── MetricCard
│   └── Settings Page
├── StatusBar (AI cost, worker count, system status)
├── CommandPalette (modern-cmdk, frecency-ranked)
├── WebGPU Canvas (particles + post-processing)
└── Toast (Sonner)
```

---

## WebGPU Pipeline

The WebGPU particle system runs in a three-stage pipeline:

### Stage 1: Compute

A WGSL compute shader updates particle positions and velocities. Dispatched with 64-workgroup granularity.

```text
Particle Buffer ──> Compute Shader ──> Updated Particle Buffer
                    (position, velocity, lifetime, color)
```

### Stage 2: Render

An instanced billboard render pipeline draws particles as camera-facing quads with additive blending.

```text
Particle Buffer ──> Vertex Shader ──> Fragment Shader ──> Framebuffer
                    (billboard quad)   (OKLCH color)       (offscreen)
```

### Stage 3: Post-Processing

Ping-pong framebuffers apply effects in sequence:

```text
Framebuffer A ──> Bloom ──> Framebuffer B
Framebuffer B ──> Chromatic Aberration ──> Framebuffer A
Framebuffer A ──> Vignette ──> Screen
```

### WebGPU Lifecycle

- Device initialization with adapter selection and capability detection
- `isWebGPUSupported()` gate with solid OKLCH fallback background
- Context loss recovery with automatic re-initialization
- `prefers-reduced-motion` integration: particles disabled when reduced motion is preferred

---

## Data Flow

### Worker Lifecycle

```text
User clicks "Spawn Worker"
        │
        ▼
Frontend: invoke("spawn_worker", { name, shell, cwd })
        │
        ▼
Backend: commands::worker::spawn_worker()
        │
        ▼
Backend: lifecycle::do_spawn_worker()
        ├── pty::spawn_pty()          Spawn PTY process
        ├── WorkerRegistry.spawn()    Register in DashMap
        └── emit_event(WorkerSpawned) Hand off to OrchestrationEngine
        │
        ▼
OrchestrationEngine writer thread: seq++, persist, emit
        │  DomainEvent{ seq, ts, type: "worker_spawned", payload } on swarm://events
        ▼
Frontend: onEvent("worker_spawned", ...)   (src/lib/event-bus.ts)
        │
        ▼
Zustand worker store updates → React re-renders
```

### AI Streaming

This is the flow that actually runs when a user sends a chat message today. It never leaves the webview except for one config read -- no Rust IPC carries the request or the response, no `swarm://events` envelope is involved, and nothing is persisted. Contrast with [AI Queue](#ai-queue-built-not-wired) above, which documents Rust machinery this flow does not use; see [Built, Not Wired](#built-not-wired) for why both exist.

```text
User sends message
        │
        ▼
Frontend: src/lib/anthropic.ts getClient()
        ├── invoke("read_config", { key: "anthropic_api_key" })   The one Rust round-trip in this flow
        ▼
new Anthropic({ apiKey, dangerouslyAllowBrowser: true })   @anthropic-ai/sdk client, held in the webview
        │
        ▼
client.messages.stream(requestParams, { signal })   Direct HTTPS request, webview → api.anthropic.com
        │
        ▼
SSE Stream, parsed by the Anthropic SDK itself (not src-tauri's ai/stream.rs)
        │
        ▼
Frontend: streamMessage() (src/lib/anthropic.ts) yields StreamDelta objects
        │
        ▼
Frontend: useAiStream (src/hooks/useAiStream.ts) -- Zustand AI store accumulates deltas → React re-renders message
        │
        ▼
Stream ends (or is aborted) -- useAiStream resolves/rejects its promise directly; no separate terminal event exists for this path
```

Most tool calls the model requests (e.g. `spawn_worker`) still run as ordinary `invoke()` IPC through the ordered event core, exactly like any other command -- only the AI request/response leg itself bypasses Rust. `read_file`/`write_file` are the exception: they run over `tauri-plugin-fs` directly (see `#lib/fs`), not through the ordered event core (no `seq`, no `swarm://events` envelope).

### Metrics Collection

```text
Background task (500ms interval)
        │
        ▼
spawn_blocking(registry.aggregate_metrics())    Sequential (spawn_blocking-offloaded)
        │
        ▼
emit_event(SystemMetrics{ cpuPercent, memoryMb, workerCount, ... })
        │  OrchestrationEngine: seq++, NOT persisted (ephemeral), emit as swarm://events
        ▼
Frontend: onEvent("system_metrics", ...)
        │
        ▼
Zustand metrics store → Recharts re-renders
```

---

## State Management

The application uses a three-tier state management strategy:

### Tier 1: Domain State (Zustand 5)

Zustand stores manage domain entities with `subscribeWithSelector` for minimal re-renders and `immer` (11.1.11, with `enableMapSet()` enabled in production) for immutable updates:

| Store            | Purpose                        | Persistence         |
|------------------|--------------------------------|----------------------|
| `workerStore`    | Worker list, states, metadata  | In-memory            |
| `sessionStore`   | Session list and active session| `tauri-plugin-store` |
| `aiQueueStore`   | AI request queue and history   | In-memory            |
| `metricsStore`   | System metrics time series     | In-memory            |

`enableMapSet()` is called once at store-module load in production, not gated behind a dev-only path, so any store that models domain data as a `Map`/`Set` under Immer's `produce` works correctly in a production build, not just in dev/test where Immer's dev warnings previously masked the missing plugin registration.

### Tier 2: UI State (Jotai)

Jotai atoms manage ephemeral UI state that does not belong in domain stores:

- Theme preferences (particles enabled, reduced motion)
- Frecency scores for command palette
- Pane sizes and layout state
- Selected worker/session IDs

### Tier 3: Persistent State (tauri-plugin-store)

Long-lived state that must survive restarts:

- Session data (`sessions.json`)
- Theme preferences
- Layout preferences (pane sizes)

---

## Event System

### Backend to Frontend (Push)

The backend emits typed events via the `SwarmEvent` enum, but not directly: every emission is routed through `emit_event()` into the `OrchestrationEngine` (see [Ordered Event Core](#ordered-event-core) above), which is the sole source of the single `swarm://events` channel. There is one channel, not one channel per event type -- the type tag lives in the envelope's `type` field:

| Type                 | Payload                                                        | Trigger                    | Persisted |
|-----------------------|-----------------------------------------------------------------|-----------------------------|-----------|
| `worker_spawned`     | `{ workerId, name, pid }`                                       | Worker registered           | Yes |
| `worker_killed`      | `{ workerId }`                                                   | Worker terminated           | Yes |
| `worker_output`      | `{ workerId, data }`                                             | PTY output available        | No |
| `worker_state`       | `{ workerId, state }`                                            | State transition            | Yes |
| `session_created`    | `{ sessionId, name }`                                            | Session created              | Yes |
| `session_deleted`    | `{ sessionId }`                                                  | Session removed              | Yes |
| `system_metrics`     | `{ cpuPercent, memoryMb, workerCount, aiReqPerSec, timestamp }`  | 500ms metrics tick           | No |
| `ai_stream_delta`    | `{ requestId, delta, done }`                                     | AI response chunk            | Yes |
| `ai_stream_settled`  | `{ requestId, status, error }`                                   | Terminal receipt, once per AI request | Yes |
| `system_log`         | `{ level, message, target, timestamp }`                          | Backend log message          | No |
| `bus_message`        | `{ messageId, fromWorker, toWorker, topic, payload }`            | Bus message, forwarded by an active `bus_subscribe` task | Yes |

See [docs/api.md#events](api.md#events) for the full envelope contract (`{ seq, ts, type, payload }`), the persistence policy, the receipt pattern, and `events_since` paging.

### Frontend to Backend (Pull)

The frontend invokes Tauri commands via `invoke()`:

| Command               | Response                          |
|------------------------|-----------------------------------|
| `spawn_worker`         | Worker UUID string                |
| `pause_worker`         | `()`                               |
| `resume_worker`        | `()`                               |
| `kill_worker`          | `()`                               |
| `list_workers`         | `WorkerInfo[]`                     |
| `worker_input`         | `()`                               |
| `create_session`       | `Session`                          |
| `delete_session`       | `()`                               |
| `list_sessions`        | `Session[]`                        |
| `get_session`          | `Session`                          |
| `session_add_worker`   | `()`                               |
| `ai_request`           | Request ID string (no shipped caller -- see [Built, Not Wired](#built-not-wired)) |
| `get_metrics`          | Metrics JSON, incl. `perWorker`    |
| `bus_send`             | Receiver count (`number`) (no shipped caller -- see [Built, Not Wired](#built-not-wired)) |
| `bus_subscribe`        | `()` (no shipped caller -- see [Built, Not Wired](#built-not-wired)) |
| `bus_create_pipeline`  | Pipeline UUID string (no shipped caller -- see [Built, Not Wired](#built-not-wired)) |
| `bus_list_channels`    | `string[]` (no shipped caller -- see [Built, Not Wired](#built-not-wired)) |
| `bus_list_pipelines`   | `PipelineInfo[]` (no shipped caller -- see [Built, Not Wired](#built-not-wired)) |
| `events_since`          | Persisted `DomainEvent[]`, `seq > afterSeq`, capped at 5000 |
| `check_for_updates`    | Update-availability JSON            |
| `send_notification`    | `()`                                |

---

## Built, Not Wired

Three pieces of the shipped Rust backend are fully implemented and tested but have zero frontend callers today. They are not stubs or dead code -- they are the backend half of features that have not been wired up yet, built ahead of the multi-provider (ACP) rework that is expected to route AI traffic (and possibly agent-to-agent bus traffic) through Rust instead of the webview.

| Piece | Where | Why it isn't live today |
|-------|-------|---------------------------|
| The AI request path: [`ai_request`](api.md#ai_request), `AiQueue`, the SSE parser (`ai/stream.rs`) | `src-tauri/src/ai/`, `src-tauri/src/commands/ai.rs` | The shipped AI flow runs `@anthropic-ai/sdk` directly in the webview (`src/lib/anthropic.ts`, `dangerouslyAllowBrowser: true`) and streams straight to `api.anthropic.com` -- see [AI Streaming](#ai-streaming). Scheduled to become the real transport once the multi-provider (ACP) rework lands. |
| The five `bus_*` commands: [`bus_send`](api.md#bus_send), [`bus_subscribe`](api.md#bus_subscribe), [`bus_create_pipeline`](api.md#bus_create_pipeline), [`bus_list_channels`](api.md#bus_list_channels), [`bus_list_pipelines`](api.md#bus_list_pipelines) | `src-tauri/src/bus/`, `src-tauri/src/commands/bus.rs` | No UI surface invokes any of them -- inter-agent messaging is implemented but not exposed to a user today. Scheduled alongside the ACP rework, which introduces the agent-to-agent flows that would need it. |
| The `ai_stream_settled` receipt | `src-tauri/src/events/emitter.rs`, emitted from `AiQueue`'s process loop | Downstream of `ai_request` above -- since nothing calls `ai_request`, nothing ever triggers this event. Documents the intended terminal-receipt contract for whichever consumer eventually calls `ai_request`. |

Read the [AI Queue](#ai-queue-built-not-wired) diagram and the `ai_request`/`bus_*` entries in [docs/api.md](api.md) as a description of what the Rust side does *if* called -- not as a description of what happens when a user sends a chat message or a worker talks to another worker in the app today.

---

## Error Handling

### Backend Errors

All backend errors flow through the `AppError` enum (11 variants), which implements:

- `thiserror::Error` for `Display` and `From` impls
- Custom `Serialize` that serializes as a plain string for IPC

```text
AppError
├── WorkerNotFound { id }        Worker ID missing from registry
├── PtySpawn(String)             PTY creation failed
├── Ipc(String)                  IPC write/flush/parse failure
├── Ai(String)                   AI API error
├── Io(io::Error)                Standard I/O error
├── PermissionDenied(String)     Access denied
├── RegistryFull { max }         Worker limit exceeded
├── Serialization(serde_json)    JSON error
├── SessionNotFound { id }       Session ID missing
├── ChannelClosed(String)        Channel dropped
└── QueueFull { capacity }       AI queue backpressure
```

### Error Propagation

```text
Domain function (returns AppError)
        │
        ▼
Command handler (maps to String via .to_string())
        │
        ▼
Tauri IPC (sends error string to frontend)
        │
        ▼
Frontend (displays in Toast via Sonner)
```

The `AppError -> String` mapping at the command boundary is intentional: Tauri commands return `Result<T, String>`, so we serialize errors as human-readable messages.
