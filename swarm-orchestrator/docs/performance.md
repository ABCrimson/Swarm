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

- `babel-plugin-react-compiler` 1.0.0 auto-memoizes all components and hooks
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

The application creates an explicit Tokio multi-threaded runtime scaled to CPU count (`num_cpus::get()`):

```rust
let runtime = tokio::runtime::Builder::new_multi_thread()
    .worker_threads(num_cpus::get())
    .enable_all()
    .build()
    .expect("failed to build Tokio runtime");
```

- `spawn_blocking` for all blocking I/O: PTY reads (`pty.rs`), sysinfo refresh (`metrics.rs`), worker metrics aggregation (`metrics.rs`), session persistence (`session.rs`)
- `CancellationToken` + `tokio::select! { biased; }` for graceful metrics loop shutdown
- `JoinSet` for tracking spawned AI streaming tasks with clean drain on shutdown

### Concurrency

| Primitive | Version / Crate | Usage |
|-----------|----------------|-------|
| `DashMap` | 7.0.0-rc2 | Lock-free worker registry (`WorkerRegistry`) |
| `parking_lot::Mutex` | 0.12.5 | PTY writer/child wrapping, shared sysinfo `System`, AI queue heap |
| `parking_lot::RwLock` | 0.12.5 | System configuration (max workers, default shell) |
| `tokio::sync::Semaphore` | tokio 1.50.0 | AI concurrency limiting (default: 3 concurrent requests) |
| `tokio::sync::mpsc` | tokio 1.50.0 | PTY output channel (4096 capacity), AI queue (256 capacity) |
| `rayon` | 1.11.0 | Available for CPU-parallel aggregation (currently sequential -- 64 worker cap makes parallel dispatch overhead unnecessary) |

`parking_lot::Mutex` is used instead of `std::sync::Mutex` throughout the codebase -- no poisoning overhead and better performance under contention.

### Memory

- **Log store:** Bounded at 10,000 entries (`MAX_ENTRIES` in `log-store.ts`), oldest entries evicted on overflow
- **Metrics loop:** 500ms interval with a shared `sysinfo::System` instance (reused across ticks for accurate CPU deltas, not re-allocated)
- **AI queue:** Bounded mpsc channel (256 capacity) with `BinaryHeap` priority ordering and `try_send` for non-blocking backpressure
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

### Vite 8.0 + Rolldown

The frontend builds with Vite 8.0.0 using the Rolldown bundler:

```ts
build: {
  minify: "rolldown",           // Native Rolldown minification
  sourcemap: true,
  target: "es2026",             // No polyfills for modern APIs
  modulePreload: { polyfill: false },  // Chromium 146+ native
}
```

### Manual Chunk Splitting

Vendor code is split into dedicated chunks to maximize caching:

| Chunk | Contents |
|-------|----------|
| `react-vendor` | `react`, `react-dom` |
| `motion` | `framer-motion`, `gsap` |
| `graph` | `@xyflow/react`, `elkjs` |
| `terminal` | `@xterm/xterm`, `@xterm/addon-fit`, `@xterm/addon-webgl` |
| `state` | `zustand`, `immer`, `jotai` |
| `ai` | `@anthropic-ai/sdk` |
| `charts` | `recharts` |

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
