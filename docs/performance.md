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
| JS frame budget | < 5ms | React Compiler auto-memoization, virtualized lists |
| GPU frame time | < 4ms | Adaptive particle count, efficient WGSL shaders |
| Cold start | < 1.5s | Lazy page loading, deferred WebGPU initialization |
| Memory (idle) | < 150 MB | Bounded log store (10k entries), ring-buffer metrics |
| IPC latency | < 2ms | Typed Tauri commands, minimal serialization |

---

## Frontend Performance

### React 19 + Compiler

- The React Compiler (the Oxc port, `oxc-transform-react`) auto-memoizes all components and hooks
- No manual `useMemo`/`useCallback` -- the compiler handles dependency tracking
- `useDeferredValue` for non-urgent streaming content updates (`AIMessageStream`)
- `startTransition` for background state updates (`useStream`, `AIChat`)
- Lazy page loading via `React.lazy()` + `Suspense` -- all 8 pages are code-split (`App.tsx`)
- `requestIdleCallback` for deferred startup tasks (auto-snapshot, store integrity validation)

### Virtualization

All long lists use scroll-window virtualization with absolute positioning:

| Component | ROW_HEIGHT | OVERSCAN | Notes |
|-----------|-----------|----------|-------|
| `SessionList` | 80px | 5 | Chronologically sorted, resize-observed container |
| `FileTree` | 28px | 10 | Flattened tree structure for O(1) index lookup |
| `LogViewer` | 28px | 10 | Auto-scroll with pause-on-scroll-up detection |

Each component uses `@crimson_dev/use-resize-observer` to track container dimensions and computes visible index ranges from `scrollTop`.

### Debouncing

| Input | Delay | Location |
|-------|-------|----------|
| Log filter search | 300ms | `LogFilter.tsx` |
| Workspace file watcher | 300ms | `useWorkspaceWatcher.ts` |

---

## Backend Performance

### Tokio Runtime

The application creates an explicit Tokio multi-threaded runtime scaled to available parallelism:

```rust
let runtime = tokio::runtime::Builder::new_multi_thread()
    .worker_threads(std::thread::available_parallelism().map(|n| n.get()).unwrap_or(1))
    .enable_all()
    .build()
    .expect("failed to build Tokio runtime");
```

- `spawn_blocking` for all blocking I/O: PTY reads (`pty.rs`), sysinfo refresh (`metrics.rs`), worker metrics aggregation (`metrics.rs`), session persistence (`session.rs`)
- `CancellationToken::run_until_cancelled` races the 500ms metrics interval tick against shutdown, replacing an earlier two-armed `tokio::select! { biased; }` with a more direct single-future expression
- `JoinSet` for tracking spawned agent-turn tasks with clean drain on shutdown
- A single `SharedSystem` (one `sysinfo::System` behind a `parking_lot::Mutex`, managed as Tauri state) is shared between the background metrics loop and the on-demand `get_metrics` command, so CPU-usage deltas come from one tracker instead of two independently-refreshing `System` instances

### Concurrency

| Primitive | Version / Crate | Usage |
|-----------|----------------|-------|
| `DashMap` | 6.2.1 | Lock-free worker registry (`WorkerRegistry`), session manager, bus channels |
| `parking_lot::Mutex` | 0.12.5 | PTY writer/child wrapping, shared sysinfo `System` (`SharedSystem`), agent turn queue heap |
| `parking_lot::RwLock` | 0.12.5 | System configuration (max workers, default shell) |
| `tokio::sync::Semaphore` | tokio 1.53.1 | agent-turn concurrency limiting (`AgentScheduler`, default: 3 concurrent turns) |
| `tokio::sync::mpsc` | tokio 1.53.1 | PTY output channel (4096 capacity), agent turn queue (256 capacity) |
| `tokio::sync::broadcast` | tokio 1.53.1 | Per-topic message bus channels (`bus::channel::MessageBus`) |

`rayon` was removed from `Cargo.toml` -- it was an unused dependency. Worker metrics aggregation runs as sequential iteration inside `tokio::task::spawn_blocking`; the 64-worker registry cap makes `rayon`-style parallel dispatch overhead not worth paying for.

`parking_lot::Mutex` is used instead of `std::sync::Mutex` throughout the codebase -- no poisoning overhead and better performance under contention.

### Memory

- **Log store:** Bounded at 10,000 entries (`MAX_ENTRIES` in `log-store.ts`), oldest entries evicted on overflow
- **Metrics loop:** 500ms interval with a shared `sysinfo::System` instance (reused across ticks for accurate CPU deltas, not re-allocated)
- **Agent turn queue:** Bounded mpsc channel (256 capacity) with `BinaryHeap` priority ordering and `try_send` for non-blocking backpressure
- **PTY buffers:** 4 KB read buffer per worker, bounded mpsc channel (4096 capacity) bridges blocking reads to async world with backpressure

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

The renderer monitors CPU-side frame time over a rolling 30-sample window:

| Condition | Action | Clamped Range |
|-----------|--------|---------------|
| avg frame time > 8ms | Reduce particle count by 20% | min 2,000 |
| avg frame time < 2ms | Increase particle count by 10% | max 50,000 |

Initial particle count: 10,000. The GPU frame time (when timestamp queries are supported) is exposed via `gpuFrameTimeAtom` for the performance overlay.

### Timestamp Queries

When the `timestamp-query` device feature is available, the compute pass records begin/end timestamps. These are resolved, copied to a readback buffer, and mapped asynchronously to compute GPU frame time in milliseconds.

### Fallback

- **WebGPU unavailable:** Solid OKLCH background (`oklch(0.06 0.02 220)`)
- **`prefers-reduced-motion`:** Particle rendering disabled, solid background
- **`particlesEnabled` off:** User toggle in theme preferences, solid background
- **Device loss:** `device.lost` callback triggers re-initialization

---

## Build Optimization

### Vite 8.2 + Rolldown

The frontend builds with Vite 8.2.2 using the Rolldown bundler. The React Compiler runs inside `@vitejs/plugin-react` (`react({ compiler: true })`) as the Oxc port, `oxc-transform-react`: its native binding, or its WASI binding where the native one cannot load (Windows Smart App Control). No Babel is involved:

```ts
build: {
  minify: "oxc",                        // Native oxc minification (Rolldown's minifier)
  sourcemap: true,
  target: "esnext",                     // Tauri renders in Chromium 146+ (WebView2/WKWebView) — no downleveling needed
  modulePreload: { polyfill: false },
  rolldownOptions: {
    output: {
      codeSplitting: { groups: [ /* ... */ ] },  // manualChunks is gone in Vite 8/Rolldown
    },
  },
}
```

### Chunk Splitting (`codeSplitting`)

`manualChunks` was removed in Vite 8/Rolldown; vendor code is split into dedicated chunks via `rolldownOptions.output.codeSplitting.groups` to maximize caching:

| Chunk | Contents |
|-------|----------|
| `react-vendor` | `react`, `react-dom`, `scheduler` |
| `motion` | `motion`, `gsap` |
| `graph` | `@xyflow/react`, `elkjs` |
| `terminal` | `@xterm/xterm`, `@xterm/addon-fit`, `@xterm/addon-webgl` |
| `state` | `zustand`, `immer`, `jotai` |
| `ai` | `@anthropic-ai/sdk` |
| `charts` | `recharts`, `d3-*` |

> [!NOTE]
> `framer-motion` was renamed upstream to `motion` -- this project depends on `motion` 13.1.1, not `framer-motion`.

### Rust Release Profile

```toml
[profile.release]
opt-level     = 3
lto           = "fat"        # Full link-time optimization
codegen-units = 1            # Maximum optimization, single codegen unit
panic         = "abort"      # No unwind tables
strip         = "symbols"    # Strip debug symbols from binary
```

### Workers

ELK layout computation runs in a dedicated ES module web worker (`elk.worker.ts`) to keep graph layout off the main thread.
