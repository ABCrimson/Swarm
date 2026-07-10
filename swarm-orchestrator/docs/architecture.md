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
│   └── emitter.rs   SwarmEvent enum + emit_event() dispatcher
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
    └── tokio::spawn(event emitter)       Forward as worker:output events
```

The PTY writer and child process are wrapped in `parking_lot::Mutex` to satisfy `Sync` requirements for `DashMap` storage.

### AI Queue

AI requests flow through a priority queue with concurrency control:

```text
Frontend ──invoke──> ai_request command
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
                    SSE parser → emit ai:stream_delta events
```

Priority levels: `Low (0) < Normal (1) < High (2) < Critical (3)`

On stream failure (network error, malformed SSE, provider error) or a stream that ends without a `message_stop` event, the client still emits a final `ai:stream_delta` with `done: true` -- the frontend is guaranteed a terminal event for every enqueued `requestId`.

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
- **Frontend delivery contract:** `bus_send` only publishes to the internal bus and never emits an event itself. `bus_subscribe` spawns the sole background task that forwards messages on a topic to the frontend as `swarm://bus-message` events. This keeps delivery to exactly one event per message, in one payload shape (`BusMessagePayload`), regardless of how many (if any) subscribers are attached -- see [docs/api.md](api.md#unified-bus-event-contract)

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
│   │   │   └── DependencyEdge (custom edge)
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
        └── emit(worker:spawned)      Notify frontend
        │
        ▼
Frontend: listen("worker:spawned")
        │
        ▼
Zustand worker store updates → React re-renders
```

### AI Streaming

```text
User sends message
        │
        ▼
Frontend: invoke("ai_request", { requestId, messages, priority })
        │
        ▼
Backend: AiQueue.enqueue()           Add to priority queue
        │
        ▼
Backend: AiQueue.process_loop()      Pop from BinaryHeap
        │
        ▼
Backend: AiClient.stream_message()   POST to Anthropic API
        │
        ▼
SSE Stream: data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hi"}}
        │
        ▼
Backend: emit(ai:stream_delta, { requestId, delta: "Hi", done: false })
        │
        ▼
Frontend: listen("ai:stream_delta")
        │
        ▼
Zustand AI store accumulates deltas → React re-renders message
        │
        ▼
Backend: emit(ai:stream_delta, { requestId, delta: "", done: true })
```

### Metrics Collection

```text
Background task (500ms interval)
        │
        ▼
spawn_blocking(registry.aggregate_metrics())    Sequential (spawn_blocking-offloaded)
        │
        ▼
emit(system:metrics, { cpuPercent, memoryMb, workerCount, ... })
        │
        ▼
Frontend: listen("system:metrics")
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

The backend emits typed events via `SwarmEvent` enum:

| Channel                | Payload                                         | Trigger                    |
|------------------------|--------------------------------------------------|----------------------------|
| `worker:spawned`       | `{ workerId, name, pid }`                        | Worker registered          |
| `worker:killed`        | `{ workerId }`                                   | Worker terminated          |
| `worker:output`        | `{ workerId, data }`                             | PTY output available       |
| `worker:state`         | `{ workerId, state }`                            | State transition           |
| `session:created`      | `{ sessionId, name }`                            | Session created            |
| `session:deleted`      | `{ sessionId }`                                  | Session removed            |
| `system:metrics`       | `{ cpuPercent, ... }`                            | 500ms metrics tick         |
| `ai:stream_delta`      | `{ requestId, delta, done }`                     | AI response chunk (always terminates with `done: true`) |
| `system:log`           | `{ level, message }`                             | Backend log message        |
| `swarm://bus-message`  | `{ messageId, fromWorker, toWorker, topic, payload }` | Bus message, forwarded by an active `bus_subscribe` task |

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
| `ai_request`           | Request ID string                  |
| `get_metrics`          | Metrics JSON, incl. `perWorker`    |
| `bus_send`             | Receiver count (`number`)          |
| `bus_subscribe`        | `()`                               |
| `bus_create_pipeline`  | Pipeline UUID string                |
| `bus_list_channels`    | `string[]`                          |
| `bus_list_pipelines`   | `PipelineInfo[]`                    |
| `check_for_updates`    | Update-availability JSON            |
| `send_notification`    | `()`                                |

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
