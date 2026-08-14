# Architecture

> System architecture reference for the SWARM Orchestrator desktop application.

---

## Table of Contents

- [System Overview](#system-overview)
- [Backend Architecture](#backend-architecture)
  - [Worktree Isolation](#worktree-isolation)
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

The Rust side is a two-crate workspace: domain logic lives in the tauri-free `swarm-core` library crate, the Tauri shell (`swarm-desktop`) wires it to IPC commands and platform paths. CI enforces that `swarm-core` never depends on `tauri`/`tauri-plugin-*` (`cargo tree -p swarm-core -e normal`).

```text
src-tauri/crates/swarm-core/src/   (swarm-core -- tauri-free domain crate)
├── ai/              AI integration
│   ├── client.rs    Anthropic API client (reqwest + SSE streaming; always emits a terminal `done: true`)
│   ├── queue.rs     Priority queue with semaphore concurrency control
│   └── stream.rs    SSE event parser (content_block_delta, message_stop)
├── bus/             Inter-agent message bus
│   ├── channel.rs   MessageBus -- per-topic tokio::sync::broadcast channels
│   └── router.rs    Router -- direct/broadcast send + pipeline orchestration
├── events/          Event emission system
│   └── emitter.rs   SwarmEvent enum + EventSink (routes into OrchestrationEngine)
├── git/             Worktree-per-worker isolation -- see "Worktree Isolation" below
│   ├── cli.rs       git binary discovery + arg-vector Command runner, capability probe
│   ├── repo.rs      Repo toplevel discovery, HEAD sha resolution
│   ├── worktree.rs  add/lock/unlock/remove/list/prune + porcelain parsing
│   └── mod.rs       RepoLocks (per-repo serialization + lock-contention retry), home_dir/slugify/short_hash8
├── orchestration/   Ordered event core -- see "Ordered Event Core" below
│   ├── engine.rs    OrchestrationEngine (single writer thread) + DomainEvent envelope
│   └── log.rs       EventLog -- SQLite (WAL) append-only event log
├── session/         Session management
│   └── manager.rs   DashMap-backed CRUD + SessionStore port
├── worker/          Worker management
│   ├── handle.rs    WorkerHandle, WorkerState, WorkerConfig, WorkerIsolation, WorkerInfo
│   ├── lifecycle.rs Spawn, pause, resume, kill, input operations (worktree create/remove on spawn/kill)
│   ├── pty.rs       PTY spawning (portable-pty) + Tokio I/O bridge
│   └── registry.rs  DashMap registry, TOCTOU-safe update_state_if, aggregate metrics
├── config.rs        Atomic key-value JSON config persistence
├── paths.rs         Paths (data dir), constructed by the shell and passed in
├── error.rs         AppError enum (thiserror + Serialize for IPC)
└── lib.rs           Crate root, module re-exports

src-tauri/src/   (swarm-desktop -- Tauri shell)
├── commands/        Tauri IPC command handlers, thin wrappers over swarm-core
│   ├── worker.rs        spawn, pause, resume, kill, list, input
│   ├── session.rs       create, delete, list, get, session_add_worker
│   ├── ai.rs            ai_request
│   ├── bus.rs           bus_send, bus_subscribe, bus_create_pipeline, bus_list_channels, bus_list_pipelines
│   ├── metrics.rs       get_metrics (incl. perWorker) + background collection loop
│   ├── orchestration.rs events_since
│   ├── config.rs        read_config, write_config
│   ├── git.rs           validate_repo_root
│   ├── updater.rs       check_for_updates
│   ├── notification.rs  send_notification
│   └── fs.rs            Delegates to tauri-plugin-fs
├── session/         Session persistence via tauri-plugin-store
├── lib.rs           Tauri app builder and setup (git capability probe + startup prune live here)
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

### Worktree Isolation

A worker spawned with `WorkerConfig.repoRoot` set (and `isolation` resolving to `"worktree"`, the default) gets its own `git worktree` instead of sharing a cwd with every other worker on the same repo -- the collision unit is the process writing files, and N PTYs in one working tree is exactly the failure this protects against. Everything lives in the tauri-free `git` module (`crates/swarm-core/src/git/`), which shells out to the system `git` binary rather than a Rust git library -- `gix` doesn't yet implement creating/removing worktrees, and `git2`/libgit2 checks out through a different code path than the user's own hooks/LFS/attributes.

```text
do_spawn_worker(config)
    │
    ├── config.repoRoot present, isolation == "worktree"?
    │       │
    │       ├── git::repo::discover_toplevel(repoRoot)   -C <dir> rev-parse --show-toplevel
    │       ├── git::repo::head_sha(toplevel)             -C <root> rev-parse HEAD
    │       ├── path = ~/.swarm/worktrees/<repo>-<hash8>/w-<id8>
    │       ├── branch = swarm/<slug(name)>-<id8>
    │       ├── RepoLocks::run_serialized(root, || git::worktree::add(root, path, branch, sha))
    │       └── RepoLocks::run_serialized(root, || git::worktree::lock(root, path, "swarm worker <uuid>"))
    │               any step fails ──> hard-fail the whole spawn (no worker, no PTY, no fallback cwd)
    │
    ├── spawn_pty(cwd = path, or config.cwd if unisolated)
    ├── WorkerHandle { worktree_path, repo_root, branch, base_commit, .. } inserted into registry
    └── emit worker_spawned { isolation: "worktree" | "none" }, then (if isolated) worktree_created

do_kill_worker(id)
    │
    ├── remove from registry, drop PTY writer, kill + wait the child
    │       (waiting for exit matters on Windows: a live child holding the
    │        worktree dir as its cwd would block removal — see the
    │        surviving-grandchild caveat below)
    │
    ├── handle.worktree_path present?
    │       │
    │       ├── RepoLocks::run_serialized(root, || git::worktree::unlock(root, path))
    │       │       unlock fails ──> disposition "failed" directly; remove is never attempted
    │       ├── RepoLocks::run_serialized(root, || git::worktree::remove(root, path))  -- NEVER --force
    │       ├── disposition == "removed"? ──> compare branch tip to base_commit;
    │       │       tip == base_commit ──> RepoLocks::run_serialized(root, || git::worktree::delete_branch(root, branch))  -- NEVER -D
    │       │       tip != base_commit ──> branch retained (logged, not an event)
    │       └── emit worktree_removed { disposition: "removed" | "preserved_dirty" | "failed" }
    │
    └── emit worker_killed
```

- **Arg-vector only, never a shell string.** Every `git` invocation (`git/cli.rs::run`) is a `std::process::Command` with an explicit argument vector -- injection-proof by construction, unlike a shell command line. `GIT_TERMINAL_PROMPT=0` is set on every call (a missing credential can never block on an interactive prompt); on Windows, `CREATE_NO_WINDOW` (`0x0800_0000`) suppresses the console-window flash a GUI app would otherwise get from spawning a console subprocess. Every invocation carries `-C <dir> -c core.longpaths=true` (per-invocation, never written to the user's own git config) so long checkout paths under `~/.swarm/worktrees/**` survive Windows' legacy `MAX_PATH` limit.
- **Timeouts.** 20s for `worktree add` (a full checkout, can legitimately take longer on a large repo), 5s for everything else (`rev-parse`, `worktree list`/`lock`/`unlock`/`remove`/`branch -d`, `--version`). A timed-out child is killed.
- **Disposition is classified honestly, not optimistically.** `git::worktree::remove` reserves `RemoveOutcome::Preserved` (`disposition: "preserved_dirty"` on the wire) **strictly** for git's specific refusal (`"contains modified or untracked files"`) -- every other non-zero exit (a still-locked worktree, a permission error partway through delete, a missing path, an unrecognized message) is an `Err` that the caller reports as `disposition: "failed"`. An earlier version of this classification treated any non-zero exit other than two hardcoded strings as "preserved", which is a lie for a locked-but-clean worktree and dangerous for a permission error that struck mid-delete (git may have already removed tracked files by then). The narrow classification is pinned down by `git::worktree::tests::test_is_dirty_tree_refusal_*` and an end-to-end `test_remove_returns_err_not_preserved_for_still_locked_worktree`.
- **The preserve-on-dirty guarantee.** `git::worktree::remove` never constructs a `--force`/`-f` argument -- the argv builder is structurally incapable of it (`git::worktree::tests::test_remove_args_never_contains_force`). Without `--force`, git itself refuses to remove a worktree with uncommitted changes or untracked files; that refusal, and *only* that refusal, becomes `disposition: "preserved_dirty"`. SWARM never deletes a worktree's contents itself -- it only ever asks git, and git says no when it would lose something.
- **A surviving grandchild process can produce `disposition: "failed"`.** `portable-pty` 0.9 has no Windows job object and no Unix process-group kill -- `do_kill_worker`'s `child.kill()` only terminates the direct shell, not anything it spawned (e.g. a long build). A surviving grandchild can hold the worktree directory open as its own cwd, which makes `git worktree remove` fail with a permission error -- correctly `"failed"` (never laundered into "preserved"), but the worktree then sits on disk until the process exits and the operation is retried or cleaned up manually. TODO in `worker::lifecycle::do_kill_worker`: the real fix is a job object (Windows) / process-group kill (Unix) at spawn time; out of Phase 1 scope.
- **Branch cleanup.** After a `"removed"` disposition (never any other), `do_kill_worker` resolves the isolation branch's tip (`git::repo::rev_parse`, which works even though the worktree directory is already gone -- branches live in the shared `.git` ref database) and compares it to the `base_commit` recorded at spawn time. Unchanged -> `git branch -d` (never `-D`; `git::worktree::tests::test_branch_delete_args_never_contains_capital_d` proves `-D` isn't constructible, same pattern as the no-`--force` guarantee) deletes it, so `swarm/*` branches don't accumulate forever in the user's real repo. Diverged (the agent committed) -> left in place; a `tracing` log records which happened (not a `SwarmEvent` -- this is bookkeeping, not history), and a failure at either step never fails `do_kill_worker` itself.
- **Per-repo serialization, everywhere.** `RepoLocks` (`git/mod.rs`) holds a `DashMap<PathBuf, Mutex<()>>` keyed by the *canonical* repo toplevel (every call site resolves through `discover_toplevel` first). Every mutating call in the isolation lifecycle -- `worktree add`, `worktree lock`, `worktree unlock`, `worktree remove`, `branch -d`, including the best-effort cleanup path when spawn fails partway through -- runs under its repo's lock, with one retry (200ms backoff) if the failure looks like transient index/ref-lock contention (`index.lock`, "cannot lock ref", "another git process..."). Two different repos' operations run fully in parallel; only operations against the *same* repo queue behind each other.
- **Startup capability probe.** `git::probe_capability()` runs `git --version` and requires >= 2.17 (when `worktree remove` was added). Missing or too-old git is never silently degraded: `swarm-desktop`'s `setup()` logs a warning and emits a `system_log` envelope (consumed by `useSystemLogEvents` into the existing Logs page -- the first live consumer of what was previously a documented-but-unwired event type) reading "Git Unavailable -- Isolated Spawns Will Fail Until Git Is Installed Or Upgraded". It does not claim workers spawn unisolated -- a `repoRoot`-bearing spawn still hard-fails naturally at the `discover_toplevel`/`head_sha` step, since there is no working `git` to run.
- **Startup prune.** `setup()` also runs `git worktree prune` against the persisted `default_repo_root` config key (set via the Workers page's Project Root picker, which validates it as a real repo via `validate_repo_root` before persisting -- see [docs/api.md#validate_repo_root](api.md#validate_repo_root)), logging the pruned count. This is intentionally the Phase 1 scope -- a full multi-repo orphan reconciliation (rebuilding the expected worktree set from the event log and diffing against `git worktree list --porcelain`) is a later phase.
- **Failure policy.** No `repoRoot` -> unconditionally today's unisolated spawn (zero regression, `worker::lifecycle::tests::test_spawn_without_repo_root_is_unisolated_zero_regression`). `repoRoot` present and the pipeline fails at any step -> the whole spawn fails; no silent fallback to a shared cwd (`worker::lifecycle::tests::test_spawn_hard_fails_when_repo_root_is_not_a_git_repo`).

See [docs/api.md#worktree-isolation-lifecycle](api.md#worktree-isolation-lifecycle) for the IPC-level contract (`WorkerConfig` fields, `worktree_created`/`worktree_removed` payload shapes, `validate_repo_root`) and [Events](#event-system) below for where these events sit in the persistence policy.

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
- **Persistence policy:** every event consumes a `seq`, but only some are written to the log. `is_persistent()` (`orchestration/engine.rs`) excludes `WorkerOutput`, `SystemMetrics`, and `SystemLog` -- high-frequency telemetry that flows live but is not history. Everything else (`worker_spawned`, `worker_killed`, `worker_state`, `session_created`, `session_deleted`, `ai_stream_delta`, `ai_stream_settled`, `bus_message`, `worktree_created`, `worktree_removed`) persists before being emitted. `is_persistent()` excludes by name rather than allowlisting, so a new variant is persistent by construction unless explicitly added to the exclusion list -- pinned down for the two worktree events by `orchestration::engine::tests::test_worktree_events_are_persistent`.
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
| `worker_spawned`     | `{ workerId, name, pid, isolation }`                             | Worker registered           | Yes |
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
| `worktree_created`   | `{ workerId, sessionId, repoRoot, worktreePath, branch, baseCommit }` | Worker's git worktree created | Yes |
| `worktree_removed`   | `{ workerId, worktreePath, branch, disposition, headCommit, reason }` | Worker killed; worktree removed/preserved | Yes |

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
