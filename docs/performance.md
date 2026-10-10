# Performance Architecture

> Performance targets, budgets, and implementation details for the SWARM Orchestrator.

---

## Table of Contents

- [Targets](#targets)
- [Frontend Performance](#frontend-performance)
- [Backend Performance](#backend-performance)
- [GPU Performance](#gpu-performance)
- [Build Optimization](#build-optimization)

---

## Targets

| Metric | Target | Implementation |
|--------|--------|---------------|
| JS frame budget | < 5ms | React Compiler auto-memoization, `content-visibility` and windowed lists |
| GPU frame latency | 2-8 ms | The adaptive particle count (min 2,000, max 10,000 = `PARTICLE_CAPACITY`) shrinks above 8 ms and grows below 2 ms, measured by `ParticleBackground` |
| Cold start | < 1.5s | Lazy page loading, deferred WebGPU initialization, polyfills fetched only where the engine lacks them |
| Memory (idle) | < 150 MB | Bounded log store (10k entries), bounded event and turn queues |
| IPC latency | < 2ms | One shared command registry, JSON arguments, no per-command wrapper |

---

## Frontend Performance

### React 19 + Compiler

- The React Compiler (the Oxc port, `oxc-transform-react`) auto-memoizes all components and hooks
- No manual `useMemo`/`useCallback` -- the compiler handles dependency tracking; `pnpm check:compiler` fails the build when a key component ships uncompiled
- `useDeferredValue` for non-urgent content: streamed AI text (`AIMessageStream`), the log search (`LogViewer`) and the history search (`HistorySearch`) -- typing stays responsive without a debounce timer
- `startTransition` for navigation (`useNavigate`) and worker actions (`useWorker`)
- Lazy page loading via `React.lazy()` + `Suspense` -- all 8 pages are code-split (`PageHost.tsx`). Visited pages stay mounted inside `<Activity>` (hidden, effects unmounted, state kept), so returning to a page is instant
- `onIdle` (`#lib/idle`) defers startup tasks: `requestIdleCallback` where the webview has it, a macrotask on WebKit

### Boot

`index.html` loads `src/boot.ts`, which awaits `ensureTemporal()` and only then imports `main.tsx`. WebView2 (Chromium) has `Temporal`, so it never fetches the polyfill chunk; WKWebView and WebKitGTK load `temporal-polyfill` before the first app module evaluates.

### Long Lists

| Component | Technique | Notes |
|-----------|-----------|-------|
| `LogViewer` | Scroll-window virtualization, 28px rows, overscan 10 | Auto-scroll with pause-on-scroll-up detection |
| `FileTree` | Scroll-window virtualization, 28px rows, overscan 10 | Flattened tree for O(1) index lookup |
| `SessionList` | `content-visibility: auto` with `contain-intrinsic-size` | Plain flow layout, so wrapped tag rows can never overlap; the browser skips off-screen cards |

The virtualized lists track container size with `@crimson_dev/use-resize-observer` and compute the visible range from `scrollTop`.

---

## Backend Performance

### Tokio Runtime

The desktop process builds one multi-threaded Tokio runtime (`install_async_runtime`, threads named `swarm-tokio`, default worker count) and hands it to Tauri, so IPC commands, plugin work and swarm-core's background loops share a single pool. `swarmd` runs the same core on its own runtime.

- PTY workers use dedicated OS threads (`pty-<id>` for output, `pty-exit-<id>` for exit detection), not Tokio threads
- `spawn_blocking` carries the remaining blocking work: child `wait`/kill-and-wait, the sysinfo refresh in `metrics.rs`, and similar
- `CancellationToken::run_until_cancelled` races the 500ms metrics tick against shutdown
- `JoinSet` tracks the agent scheduler's running turns and drains them on shutdown
- A single `SharedSystem` (one `sysinfo::System` behind a `parking_lot::Mutex`) serves both the background metrics loop and the on-demand `get_metrics` command, so CPU-usage deltas come from one tracker instead of two independently-refreshing instances

### Concurrency

| Primitive | Version / Crate | Usage |
|-----------|----------------|-------|
| `DashMap` | 7.0.0-rc2 | Sharded concurrent map: worker registry, session manager, agent session registry, per-repository git locks |
| `parking_lot::Mutex` | 0.12.5 | PTY child wrapping, the shared sysinfo `System`, the config file lock |
| `parking_lot::RwLock` | 0.12.5 | System configuration (max workers, default shell), the message bus topic registry (bounded at 1024 topics) |
| `tokio::sync::Semaphore` | tokio 1.53.2 | Agent-turn concurrency limit (`AgentScheduler`, default 3, resizable at runtime) |
| `tokio::sync::mpsc` | tokio 1.53.2 | The scheduler's intake and the piped-process output channel (4096 capacity) |
| `tokio::sync::broadcast` | tokio 1.53.2 | The orchestration engine's secondary fan-out of ordered events to subscribers (`OrchestrationEngine::subscribe`) |

`parking_lot` replaces `std::sync::Mutex`/`RwLock` everywhere (`clippy.toml` bans the std types): no poisoning and better behavior under contention. Worker metrics aggregate sequentially inside `spawn_blocking`; with a default registry cap of 64 workers, parallel dispatch would cost more than it saves.

### Memory

- **Log store:** Bounded at 10,000 entries (`MAX_ENTRIES` in `log-store.ts`), oldest entries evicted on overflow
- **Metrics loop:** 500ms interval, missed ticks delayed rather than caught up, one shared `sysinfo::System` reused across ticks for accurate CPU deltas
- **Agent turn queue:** At most 256 turns wait for dispatch (`AGENT_TURN_QUEUE_CAPACITY`); `enqueue` beyond that fails with `QueueFull` instead of growing. Dispatch order is priority, then FIFO, and a follow-up for a busy worker waits without holding a permit
- **Worker output:** PTY output is read in 8 KiB chunks and emitted straight onto the ordered event stream; piped workers read 4 KiB chunks through a 4096-slot channel that applies backpressure

---

## GPU Performance

### WebGPU Pipeline

The particle system runs a three-stage GPU pipeline:

1. **Compute:** WGSL compute shader with `@workgroup_size(64)`, dispatch = `ceil(particleCount / 64)`. PCG hash RNG, gravity-well attractors from active workers, velocity damping.
2. **Render:** Instanced billboard quads with additive blending (`src-alpha + one`). Triangle-strip topology, 4 vertices per particle.
3. **Post-process:** Ping-pong framebuffer chain:
   - Dual-Kawase bloom (4-level mip chain: threshold, downsample, upsample, composite)
   - Barrel-distortion chromatic aberration (per-channel UV offset)
   - Vignette (smoothstep edge darkening)

Pipeline compilation uses `createComputePipelineAsync` / `createRenderPipelineAsync` for non-blocking initialization.

### Adaptive Particle Count

The renderer measures real GPU latency -- submit to `queue.onSubmittedWorkDone()` -- and averages it over a 30-sample window:

| Condition | Action | Clamped Range |
|-----------|--------|---------------|
| avg latency > 8ms | Reduce the drawn count by 20% | min 2,000 |
| avg latency < 2ms | Increase the drawn count by 10% | max 10,000 (the buffer capacity) |

The count starts at the 10,000 capacity. The averaged latency is exposed via `gpuFrameTimeAtom` for the performance overlay and the status bar. Simulation runs in fixed steps (at most 3 per frame), so a slow frame never inflates a step.

### Fallback

- **WebGPU unavailable:** solid background (`bg-void`), with the reason logged once
- **`prefers-reduced-motion`:** particle rendering disabled, solid background
- **`particlesEnabled` off:** user toggle in theme preferences, solid background
- **Device loss:** `useWebGPU` re-initializes after 1 second, up to 3 times in a row

---

## Build Optimization

### Vite 8.3 + Rolldown

The frontend builds with Vite 8.3.4 using the Rolldown bundler. The React Compiler runs inside `@vitejs/plugin-react` (`react({ compiler: true })`) as the Oxc port, `oxc-transform-react`: its native binding, or its WASI binding where the native one cannot load (Windows Smart App Control). No Babel is involved:

```ts
build: {
  sourcemap: true,
  target: "esnext",
  modulePreload: { polyfill: false },
  rolldownOptions: {
    output: {
      codeSplitting: { groups: [ /* ... */ ] },  // manualChunks is gone in Vite 8/Rolldown
    },
  },
}
```

`esnext` is safe because WebView2 is Chromium and WKWebView/WebKitGTK are current WebKit; the one engine gap, Temporal, is polyfilled at boot (`src/boot.ts`). The code also calls iterator helpers, `Error.isError` and `RegExp.escape` unguarded, so the WebKit floor is Safari 18.4: `bundle.macOS.minimumSystemVersion` is `15.4`, the oldest macOS that guarantees it (`vite.config.ts` states the reasoning).

Minification is Vite's default (Oxc). `pnpm build` writes `dist/` for the desktop bundle; `pnpm build:web` writes `dist-web/` for `swarmd --serve-ui`.

### Chunk Splitting (`codeSplitting`)

`manualChunks` was removed in Vite 8/Rolldown; vendor code is split into dedicated chunks via `rolldownOptions.output.codeSplitting.groups` to maximize caching:

| Chunk | Contents |
|-------|----------|
| `react-vendor` | `react`, `react-dom`, `scheduler` |
| `motion` | `motion` |
| `graph` | `@xyflow/react`, `elkjs` |
| `terminal` | `@xterm/xterm`, `@xterm/addon-fit`, `@xterm/addon-webgl` |
| `state` | `zustand`, `immer`, `jotai` |
| `ai` | `@anthropic-ai/sdk` |
| `charts` | `recharts`, `d3-*` |

> [!NOTE]
> `framer-motion` was renamed upstream to `motion` -- this project depends on `motion` 14.1.0, not `framer-motion`.

### Rust Release Profile

```toml
[profile.release]
opt-level     = 3
lto           = "fat"        # Full link-time optimization
codegen-units = 1            # Maximum optimization, single codegen unit
strip         = "symbols"    # Strip symbols from the binary
trim-paths    = "all"        # Remap build-machine paths out of the binary
```

`panic` stays at its default, `unwind`: a panic ends only the task or thread it happens on, so one panicking agent turn or WebSocket connection leaves every other worker running. `abort` would save roughly 16% of the desktop binary's stripped size and 9% of `swarmd`'s (measured 2026-09-23) at the cost of killing every agent and terminal on any panic.

### Workers

ELK layout computation runs in a dedicated ES module web worker (`elk.worker.ts`) to keep graph layout off the main thread.
