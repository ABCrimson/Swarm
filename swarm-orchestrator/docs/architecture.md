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

SWARM Orchestrator is a Tauri 2.10 desktop application with a clear separation between a Rust backend and a React 19 frontend. Communication between the two layers happens exclusively through Tauri's IPC mechanism: **invoke** (request/response) and **listen** (event stream).

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

1. The Rust backend owns all mutable state (workers, sessions, AI queue)
2. The frontend receives state updates via Tauri events, not polling
3. CPU-bound work (rayon metrics) runs on blocking threads, never on the async executor
4. All IPC payloads use `camelCase` fields; all event type tags use `snake_case`

---

## Backend Architecture

The backend is organized into four domain modules under `src-tauri/src/`:

### Module Map

```text
src-tauri/src/
├── ai/              AI integration
│   ├── client.rs    Anthropic API client (reqwest + SSE streaming)
│   ├── queue.rs     Priority queue with semaphore concurrency control
│   └── stream.rs    SSE event parser (content_block_delta, message_stop)
├── commands/        Tauri IPC command handlers
│   ├── worker.rs    spawn, pause, resume, kill, list, input
│   ├── session.rs   create, delete, list, get
│   ├── ai.rs        ai_request
│   ├── metrics.rs   get_metrics + background collection loop
│   └── fs.rs        Delegates to tauri-plugin-fs
├── events/          Event emission system
│   └── emitter.rs   SwarmEvent enum + emit_event() dispatcher
├── session/         Session management
│   ├── manager.rs   DashMap-backed CRUD
│   └── store.rs     Persistence via tauri-plugin-store
├── worker/          Worker management
│   ├── handle.rs    WorkerHandle, WorkerState, WorkerConfig, WorkerInfo
│   ├── lifecycle.rs Spawn, pause, resume, kill, input operations
│   ├── pty.rs       PTY spawning (portable-pty) + Tokio I/O bridge
│   └── registry.rs  DashMap registry + rayon aggregate metrics
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
- **Metrics:** `rayon::par_iter` over worker states for aggregate counts
- **Capacity:** Enforces `max_workers` limit, returns `AppError::RegistryFull` on overflow

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

### Session Persistence

Sessions are stored in `DashMap<Uuid, Session>` and persisted to disk:

- **Storage file:** `sessions.json` in Tauri's app data directory
- **Backend:** `tauri-plugin-store` 2.4.2
- **Auto-save:** After every create/delete operation
- **Restore:** Loaded once during app setup, before any commands are processed

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
spawn_blocking(registry.aggregate_metrics())    Rayon parallel
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

Zustand stores manage domain entities with `subscribeWithSelector` for minimal re-renders and `immer` for immutable updates:

| Store            | Purpose                        | Persistence         |
|------------------|--------------------------------|----------------------|
| `workerStore`    | Worker list, states, metadata  | In-memory            |
| `sessionStore`   | Session list and active session| `tauri-plugin-store` |
| `aiQueueStore`   | AI request queue and history   | In-memory            |
| `metricsStore`   | System metrics time series     | In-memory            |

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

| Channel            | Payload                  | Trigger                    |
|--------------------|--------------------------|----------------------------|
| `worker:spawned`   | `{ workerId, name, pid }`| Worker registered          |
| `worker:killed`    | `{ workerId }`           | Worker terminated          |
| `worker:output`    | `{ workerId, data }`     | PTY output available       |
| `worker:state`     | `{ workerId, state }`    | State transition           |
| `session:created`  | `{ sessionId, name }`    | Session created            |
| `session:deleted`  | `{ sessionId }`          | Session removed            |
| `system:metrics`   | `{ cpuPercent, ... }`    | 500ms metrics tick         |
| `ai:stream_delta`  | `{ requestId, delta }`   | AI response chunk          |
| `system:log`       | `{ level, message }`     | Backend log message        |

### Frontend to Backend (Pull)

The frontend invokes Tauri commands via `invoke()`:

| Command          | Response                   |
|------------------|----------------------------|
| `spawn_worker`   | Worker UUID string         |
| `pause_worker`   | `()`                       |
| `resume_worker`  | `()`                       |
| `kill_worker`    | `()`                       |
| `list_workers`   | `WorkerInfo[]`             |
| `worker_input`   | `()`                       |
| `create_session` | `Session`                  |
| `delete_session` | `()`                       |
| `list_sessions`  | `Session[]`                |
| `get_session`    | `Session`                  |
| `ai_request`     | Request ID string          |
| `get_metrics`    | `AggregateMetrics` (JSON)  |

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
