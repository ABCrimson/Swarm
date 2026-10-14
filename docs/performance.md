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
| `tokio::sync::Semaphore` | tokio 1.53.3 | Agent-turn concurrency limit (`AgentScheduler`, default 3, resizable at runtime) |
| `tokio::sync::mpsc` | tokio 1.53.3 | The scheduler's intake and the piped-process output channel (4096 capacity) |
| `tokio::sync::broadcast` | tokio 1.53.3 | The orchestration engine's secondary fan-out of ordered events to subscribers (`OrchestrationEngine::subscribe`) |

`parking_lot` replaces `std::sync::Mutex`/`RwLock` everywhere (`clippy.toml` bans the std types): no poisoning and better behavior under contention. Worker metrics aggregate sequentially inside `spawn_blocking`; with a default registry cap of 64 workers, parallel dispatch would cost more than it saves.

### Event Log Persistence

The ordered-event writer commits each persistent event as its own autocommit `INSERT` (`OrchestrationEngine::persist` -> `EventLog::append`) plus one seq-block reservation per 1024 seqs, all on the single `swarm-event-writer` thread. The log runs `synchronous=EXTRA` with `fullfsync=1` in WAL mode ([ADR-0039](adr/0039-event-log-flushes-every-commit.md)); in WAL mode EXTRA is FULL, so every commit waits for a sync of the `-wal` file (on macOS an `F_FULLFSYNC`). That wait, not SQLite's CPU work, bounds the writer's persistent-event rate and sets the latency of a persistent event. Ephemeral events are not stored, but they share the writer's FIFO, so a terminal-output or delta event queued behind a persistent one waits for that event's flush (about 2 ms on the measured disk; a burst of N persistent events delays them about N x 2 ms, more when a commit triggers a WAL checkpoint).

The first three row groups were measured 2026-10-13 with `measure_append_throughput_by_synchronous_level` (3000 appends of a 392-byte `agent_tool_call` payload, one per transaction, reservations every 1024 seqs; `agent_tool_result` content is unbounded, so larger events cost more; `open` sets EXTRA, and the test lowers or raises the level on the connection only for the comparison). Three runs per row (EXTRA: two, within run-to-run noise of FULL); events/s is the per-run rate, latencies are per-append p50 / p99. The macOS, Windows and Linux rows are one run each on 2026-10-14, the ignored test run on GitHub-hosted runners (test profile, the command under Reproduce, `TMPDIR` left at the runner default), with all three levels measured in that run.

| Directory (filesystem) | `synchronous` | events/s (3 runs) | p50 | p99 |
|------------------------|---------------|-------------------|-----|-----|
| `/root/swarm-bench` (ext4 on a WSL2 VHD) | NORMAL | 27578, 31606, 23219 | 6.6-7.2 µs | 48-69 µs |
| `/root/swarm-bench` (ext4 on a WSL2 VHD) | FULL | 499, 469, 514 | 1.97-2.19 ms | 4.8-6.3 ms |
| `/root/swarm-bench` (ext4 on a WSL2 VHD) | EXTRA (parity check, 2 runs) | 463, 492 | 2.2-2.4 ms | 5.4-5.6 ms |
| `C:\` through WSL2 9p (`/mnt/c`) | NORMAL | 247, 174, 381 | 2.3-3.1 ms | 6.2-48.5 ms |
| `C:\` through WSL2 9p (`/mnt/c`) | FULL | 230, 229, 260 | 3.4-4.1 ms | 9.0-13.8 ms |
| `TMPDIR` under `/var/folders` (APFS, GitHub-hosted `macos-26`, macOS 26.6.2) | NORMAL | 39657 | 11.75 µs | 50.3 µs |
| `TMPDIR` under `/var/folders` (APFS, GitHub-hosted `macos-26`, macOS 26.6.2) | FULL | 933 | 816 µs | 8.17 ms |
| `TMPDIR` under `/var/folders` (APFS, GitHub-hosted `macos-26`, macOS 26.6.2) | EXTRA | 1217 | 749 µs | 2.61 ms |
| `C:\Users\RUNNER~1\AppData\Local\Temp` (NTFS, GitHub-hosted `windows-2025`, Windows 10.0.26100.33438) | NORMAL | 2823 | 19.5 µs | 122 µs |
| `C:\Users\RUNNER~1\AppData\Local\Temp` (NTFS, GitHub-hosted `windows-2025`, Windows 10.0.26100.33438) | FULL | 251 | 3.45 ms | 12.1 ms |
| `C:\Users\RUNNER~1\AppData\Local\Temp` (NTFS, GitHub-hosted `windows-2025`, Windows 10.0.26100.33438) | EXTRA | 259 | 3.37 ms | 10.0 ms |
| `/tmp` (GitHub-hosted `ubuntu-26.04`, Ubuntu 26.04.1 LTS; control) | NORMAL / FULL / EXTRA | 91143 / 91067 / 91443 | 9.0 / 9.2 / 9.2 µs | 24.2 / 22.2 / 22.3 µs |

The slowest single append (`max`) was 8-72 ms on ext4 and up to 976 ms through 9p, so a flush occasionally stalls the writer far beyond the median. On the runners it was 13.7-38.2 ms on APFS and 25.1-35.8 ms on NTFS at FULL and EXTRA.

Reading the numbers: on the ext4 VHD, FULL (EXTRA measured the same, as SQLite documents for WAL) costs about 2 ms per persistent event (a ceiling near 500 events/s, roughly 60x below NORMAL). Through 9p the per-operation cost already dominates, so FULL adds about 1 ms at p50 and the rates overlap. A `tmpfs` control (`/tmp`) showed no difference (about 150-178k events/s for both), so a sync-level comparison needs a real disk. WSL numbers are a proxy for the shipped app, which runs on native Windows NTFS and macOS. The runner rows measure those filesystems: at the shipped `EXTRA` the p50 per commit is 0.75 ms on APFS (`F_FULLFSYNC`) and 3.37 ms on NTFS, both under the 5 ms gate of [ADR-0039](adr/0039-event-log-flushes-every-commit.md). Read them as upper bounds on the platform's caching behavior, not as guarantees for a given machine: they are GitHub-hosted virtual machines, and the Linux control's flat 9 µs at every level shows that runner's virtual disk does not honor fsync as a physical disk does. On macOS EXTRA measured faster than FULL, which is run-to-run noise. A burst of N persistent events delays queued ephemeral events by about N x 3.4 ms on NTFS.

The WSL2 rows ran on this machine: Intel Core Ultra 9 290HX Plus, 24 CPUs, 70 GiB RAM visible to WSL (`free -g`), WSL2 kernel `6.18.54.1-microsoft-standard-WSL2`, Ubuntu-26.04, bundled SQLite from `libsqlite3-sys` 0.38.2 (`rusqlite` 0.40.2).

Reproduce (the test prints, it asserts nothing; point `TMPDIR` at the filesystem under test; the runner rows used the runner's default temp directory):

```bash
TMPDIR=/path/on/the/disk/under/test \
  cargo test -p swarm-core measure_append_throughput_by_synchronous_level -- --ignored --nocapture
```

### Memory

- **Log store:** Bounded at 10,000 entries (`MAX_ENTRIES` in `src/store/logs.ts`), oldest entries evicted on overflow
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
| `charts` | `recharts`, `d3-*` |

`@anthropic-ai/sdk` has no vendor group. Only `src/lib/anthropic.ts` imports it, and every runtime importer of that module loads on demand: the lazily loaded Workers, Settings and Tools pages, and the `import("#lib/ai-chat")` in `useWorkerEvents`. Rolldown therefore places the SDK in chunks those pages load, off the startup path.

> [!NOTE]
> `framer-motion` was renamed upstream to `motion` -- this project depends on `motion` 14.2.0, not `framer-motion`.

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
