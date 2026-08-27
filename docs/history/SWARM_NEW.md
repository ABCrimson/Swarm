# SWARM Orchestrator v2 — Claude Code Build Specification

> **PURPOSE**: This is the complete, authoritative build specification for Claude Code to construct SWARM Orchestrator from scratch. Read every section in full before writing any code. Every version, pattern, architecture decision, and constraint is encoded here. Nothing is optional.

---

## ⚠️ PRIME DIRECTIVES — THESE GOVERN EVERY LINE OF CODE

```
1.  ALL versions pinned exactly. Zero ^ zero ~ zero ranges. Ever. Period.
2.  EVERY line uses the newest API surface of its pinned version — no deprecated paths.
3.  EVERY async operation uses the fastest concurrency primitive available.
4.  EVERY visual element derives from OKLCH color — never hex, rgb(), or hsl().
5.  EVERY GPU-bound operation goes through WebGPU compute/render pipelines.
6.  NO forwardRef — React 19 ref-as-prop directly.
7.  NO manual useMemo/useCallback — React Compiler auto-memoizes.
8.  NO tailwind.config.js — Tailwind 4 configured entirely via CSS @theme.
9.  NO ESLint. NO Prettier. Biome 2.4.6 is the single linting + formatting tool.
10. NO CommonJS anywhere — ESM only across the entire project.
11. NO blocking calls on Tokio async threads — spawn_blocking for CPU work.
12. NO std::sync::Mutex — parking_lot::Mutex everywhere in Rust.
```

---

## 📦 COMPLETE PINNED DEPENDENCY MANIFEST

### Node / TypeScript / Toolchain

| Package | Exact Version | Classification | Role |
|---------|--------------|----------------|------|
| `node` | `25.8.1` | stable | Runtime — native TS type-stripping, built-in WebSocket, fetch |
| `typescript` | `6.0.0-dev.20260313` | dev build | Last JS compiler. Bridge to TS7 Go rewrite. strict/esnext/esnext defaults |
| `vite` | `8.0.0` | **stable** | Rolldown-powered build. Oxc parser/minifier. 10–30× faster than Rollup |
| `@tauri-apps/cli` | `2.10.1` | stable | Desktop shell CLI |
| `@biomejs/biome` | `2.4.6` | stable | Linter + Formatter. Replaces ESLint + Prettier entirely |

> **Vite 8.0.0 is now stable** — not beta. Rolldown is the production bundler.

### Frontend Framework

| Package | Exact Version | Classification | Role |
|---------|--------------|----------------|------|
| `react` | `19.3.0-canary-5e9eedb5-20260312` | canary | use(), ref-as-prop, React Compiler, concurrent |
| `react-dom` | `19.3.0-canary-5e9eedb5-20260312` | canary | Must match React exactly |
| `tailwindcss` | `4.2.1` | stable | CSS-first: @theme, @utility, @variant, @function |
| `framer-motion` | `12.36.0` | stable | Component animation, layout, scroll-driven |
| `gsap` | `3.14.2` | stable | Timelines, SplitText, ScrollTrigger sequences |
| `@webgpu/types` | `0.1.69` | stable | TypeScript types for WebGPU API |

### State Management

| Package | Exact Version | Classification | Role |
|---------|--------------|----------------|------|
| `zustand` | `5.0.11` | stable | Global — worker registry, sessions, AI queue |
| `immer` | `11.1.4` | stable | Structural sharing for all Zustand mutations |
| `jotai` | `2.18.1` | stable | Atom-based local UI state per component |

### Data / Validation / AI

| Package | Exact Version | Classification | Role |
|---------|--------------|----------------|------|
| `zod` | `4.4.0-canary.20260125T215152` | canary | Import from `"zod/v4"`. z.interface(), toJSONSchema() |
| `@anthropic-ai/sdk` | `0.78.0` | stable | Claude API — streaming, tool use, message batches |
| `recharts` | `3.8.0` | stable | Metrics dashboards — ResponsiveContainer, animated |
| `date-fns` | `4.1.0` | stable | Date utilities — ESM-only, Temporal-compatible |

### UI Primitives

| Package | Exact Version | Classification | Role |
|---------|--------------|----------------|------|
| `modern-cmdk` | `1.1.5` | stable | Command palette — headless, shouldFilter=false, frecency |
| `sonner` | `2.0.7` | stable | Toast notifications — OKLCH themed, stacked |
| `vaul` | `1.1.2` | stable | Drawer primitive — snap points, nested |
| `@crimson_dev/use-resize-observer` | `1.0.0` | stable | **First-party** ResizeObserver hook — React 19, zero deps |

> **`@crimson_dev/use-resize-observer`** is Albert's own published package — the React 19 remaster. It is the ground truth for ResizeObserver usage in SWARM. Any edge case found in SWARM is a bug report for the library.

> **`modern-cmdk`** is the first-party cmdk rewrite. Headless architecture, React 19 native, no legacy peer dep assumptions. Use its exported API exclusively — do not reference upstream `cmdk`.

### Graph + Terminal

| Package | Exact Version | Classification | Role |
|---------|--------------|----------------|------|
| `@xyflow/react` | `12.10.1` | stable | Worker topology DAG |
| `elkjs` | `0.11.1` | stable | ELK auto-layout — always runs in Web Worker |
| `@xterm/xterm` | `6.1.0-beta.193` | beta | Terminal emulator — WebGL2 renderer mandatory |
| `@xterm/addon-fit` | `0.12.0-beta.168` | beta | Fit addon — beta channel, triggered via @crimson_dev/use-resize-observer |

### Tauri Plugins

| Package | Exact Version | Role |
|---------|--------------|------|
| `@tauri-apps/plugin-fs` | `2.4.5` | File system — BaseDirectory scoped |
| `@tauri-apps/plugin-dialog` | `2.6.0` | Native open/save/message dialogs |
| `@tauri-apps/plugin-shell` | `2.3.5` | Shell spawning — event-stream output |
| `@tauri-apps/plugin-store` | `2.4.2` | Persistent KV — user prefs, session state |

### Rust Crates

| Crate | Exact Version | Features |
|-------|--------------|---------|
| `tokio` | `1.50.0` | `features = ["full"]` |
| `tokio-stream` | `0.1.18` | `features = ["net"]` |
| `rayon` | `1.11.0` | CPU-parallel work |
| `portable-pty` | `0.9.0` | Cross-platform PTY |
| `reqwest` | `0.13.2` | `features = ["json","stream","rustls"], default-features = false` |
| `serde` | `1.0.228` | `features = ["derive"]` |
| `serde_json` | `1.0.149` | JSON serialization |
| `anyhow` | `1.0.102` | Application error handling |
| `thiserror` | `2.0.18` | Library boundary error types |
| `tracing` | `0.1.44` | Structured async-aware logging |
| `dashmap` | `7.0.0-rc2` | Concurrent HashMap — worker registry |
| `parking_lot` | `0.12.5` | Fast Mutex/RwLock/Condvar |

**Rust Toolchain**: `1.95.0-beta` · **Edition**: `2024`

---

## 📋 CHANGE DELTA FROM PREVIOUS SPEC

These changed — update every reference in code, configs, and docs:

| What | Old | New | Impact |
|------|-----|-----|--------|
| `node` | 25.8.0 | **25.8.1** | patch — update engines field |
| `vite` | 8.0.0-beta.16 | **8.0.0** | **stable** — remove all "beta" references |
| `react` + `react-dom` | 19.3.0-canary-3bc2d414-20260304 | **19.3.0-canary-5e9eedb5-20260312** | newer canary — update both |
| `typescript` | 6.0.0-dev.20260304 | **6.0.0-dev.20260313** | newer dev build |
| `@xterm/xterm` | 6.1.0-beta.168 | **6.1.0-beta.193** | newer beta — API audit required |
| `framer-motion` | 12.35.0 | **12.36.0** | minor bump — check changelog |
| `jotai` | 2.18.0 | **2.18.1** | patch |
| `recharts` | 3.7.0 | **3.8.0** | minor — new chart APIs possible |
| `cmdk@1.1.1` | upstream cmdk | **modern-cmdk@1.1.5** | **package swap** — import paths change |
| `use-resize-observer@9.1.0` | upstream npm | **@crimson_dev/use-resize-observer@1.0.0** | **first-party** — full API ownership |
| `@biomejs/biome` | 2.4.5 | **2.4.6** | patch — update schema URL |


---

## 🗂️ COMPLETE PROJECT STRUCTURE

```
swarm-orchestrator/
├── CLAUDE.md                          ← This file — single source of truth
├── README.md
├── CHANGELOG.md                       ← Keep a Changelog 1.0 + Conventional Commits
├── LICENSE
├── .gitignore
├── .npmrc                             ← save-exact=true, engine-strict=true
├── package.json                       ← All exact versions, no ranges
├── biome.json                         ← Biome 2.4.6 — lint + format config
├── tsconfig.json                      ← TS 6.0: strict, esnext, es2026, bundler
├── vite.config.ts                     ← Vite 8.0.0 stable — Rolldown + Oxc
├── rust-toolchain.toml               ← Pins 1.95.0-beta
│
├── src/
│   ├── main.tsx                       ← createRoot() — only valid entry point
│   ├── App.tsx                        ← Root layout + Suspense boundaries
│   │
│   ├── styles/
│   │   ├── global.css                 ← @import chain root
│   │   ├── layers.css                 ← @layer declarations (6 named layers)
│   │   ├── tokens.css                 ← @theme OKLCH tokens + @function + @property
│   │   ├── animations.css             ← @keyframes + @property typed props
│   │   └── components.css             ← @layer components styles
│   │
│   ├── components/
│   │   ├── layout/
│   │   │   ├── AppShell.tsx
│   │   │   ├── Sidebar.tsx
│   │   │   ├── TopBar.tsx
│   │   │   ├── StatusBar.tsx
│   │   │   └── SplitPane.tsx          ← @crimson_dev/use-resize-observer driven
│   │   │
│   │   ├── worker/
│   │   │   ├── WorkerCard.tsx
│   │   │   ├── WorkerDetail.tsx
│   │   │   ├── WorkerGrid.tsx
│   │   │   ├── WorkerTerminal.tsx     ← xterm 6.1.0-beta.193 + WebGL2
│   │   │   ├── WorkerControls.tsx
│   │   │   └── WorkerMetrics.tsx
│   │   │
│   │   ├── graph/
│   │   │   ├── TopologyGraph.tsx
│   │   │   ├── WorkerNode.tsx
│   │   │   ├── DependencyEdge.tsx
│   │   │   └── GraphControls.tsx
│   │   │
│   │   ├── ai/
│   │   │   ├── AIQueue.tsx
│   │   │   ├── AIMessageStream.tsx
│   │   │   ├── ToolCallDisplay.tsx
│   │   │   └── ModelSelector.tsx
│   │   │
│   │   ├── command/
│   │   │   ├── CommandPalette.tsx     ← modern-cmdk 1.1.5
│   │   │   ├── CommandGroups.tsx
│   │   │   └── CommandItem.tsx
│   │   │
│   │   ├── session/
│   │   │   ├── SessionList.tsx
│   │   │   ├── SessionItem.tsx
│   │   │   └── SessionDetail.tsx
│   │   │
│   │   ├── metrics/
│   │   │   ├── SystemDashboard.tsx
│   │   │   ├── CPUChart.tsx
│   │   │   ├── MemoryChart.tsx
│   │   │   └── ThroughputChart.tsx    ← recharts 3.8.0
│   │   │
│   │   └── ui/
│   │       ├── Button.tsx
│   │       ├── Badge.tsx
│   │       ├── Tooltip.tsx
│   │       ├── Dialog.tsx
│   │       ├── Drawer.tsx             ← vaul 1.1.2
│   │       ├── Toast.tsx              ← sonner 2.0.7
│   │       ├── Spinner.tsx
│   │       ├── ProgressBar.tsx
│   │       └── ScrollArea.tsx
│   │
│   ├── hooks/
│   │   ├── useWorker.ts
│   │   ├── useSession.ts
│   │   ├── useStream.ts               ← Anthropic SDK 0.78.0 streaming
│   │   ├── useCommand.ts              ← modern-cmdk frecency + Zustand
│   │   ├── useWebGPU.ts               ← Device init, context loss recovery
│   │   ├── useElkLayout.ts            ← ELK via Web Worker
│   │   ├── useTauri.ts                ← invoke + listen typed wrappers
│   │   ├── useTerminal.ts             ← xterm lifecycle + @crimson_dev/use-resize-observer
│   │   └── useTheme.ts
│   │
│   ├── store/
│   │   ├── workers.ts                 ← Zustand 5.0.11 + immer + subscribeWithSelector
│   │   ├── sessions.ts
│   │   ├── ai.ts
│   │   ├── system.ts
│   │   ├── ui.ts                      ← Jotai 2.18.1 atoms
│   │   └── types.ts                   ← All Zod v4 schemas (import from "zod/v4")
│   │
│   ├── workers/
│   │   ├── elk.worker.ts              ← ELK layout — always off main thread
│   │   ├── metrics.worker.ts
│   │   └── ai.worker.ts
│   │
│   ├── lib/
│   │   ├── anthropic.ts               ← SDK client + async generator streaming
│   │   ├── tauri.ts                   ← Type-safe invoke/listen wrappers
│   │   ├── webgpu.ts                  ← Device factory + pipeline helpers
│   │   ├── particles.ts               ← WGSL compute shader + render loop
│   │   ├── postprocess.ts             ← Bloom + CA + vignette passes
│   │   ├── theme.ts                   ← OKLCH color utilities
│   │   └── format.ts                  ← date-fns 4.1.0 + Temporal
│   │
│   └── pages/
│       ├── Dashboard.tsx
│       ├── Workers.tsx
│       ├── Sessions.tsx
│       ├── Metrics.tsx
│       └── Settings.tsx
│
├── src-tauri/
│   ├── Cargo.toml
│   ├── tauri.conf.json
│   ├── capabilities/default.json
│   └── src/
│       ├── main.rs                    ← #[tokio::main] multi-thread runtime
│       ├── lib.rs                     ← tauri::Builder + all plugin setup
│       ├── error.rs                   ← thiserror 2.0.18 AppError
│       ├── commands/
│       │   ├── mod.rs
│       │   ├── worker.rs
│       │   ├── session.rs
│       │   ├── ai.rs
│       │   ├── fs.rs
│       │   └── metrics.rs
│       ├── worker/
│       │   ├── mod.rs
│       │   ├── registry.rs            ← DashMap 7.0.0-rc2
│       │   ├── handle.rs
│       │   ├── pty.rs                 ← portable-pty 0.9.0
│       │   └── lifecycle.rs
│       ├── ai/
│       │   ├── mod.rs
│       │   ├── client.rs              ← reqwest 0.13.2
│       │   ├── stream.rs              ← SSE → tokio-stream 0.1.18
│       │   └── queue.rs
│       ├── session/
│       │   ├── mod.rs
│       │   ├── manager.rs
│       │   └── store.rs
│       └── events/
│           ├── mod.rs
│           └── emitter.rs
│
├── .github/
│   ├── workflows/
│   │   ├── ci.yml
│   │   ├── release.yml
│   │   └── deps.yml
│   └── ISSUE_TEMPLATE/
│       ├── bug_report.md
│       └── feature_request.md
│
└── docs/
    ├── architecture.md
    ├── api.md
    ├── contributing.md
    └── performance.md
```


---

## 🗺️ VERSION ROADMAP

> Build in strict order. Every version is a deployable, tested, passing milestone.  
> Never skip ahead. Never leave TODOs behind.  
> `0.0.x` = scaffolding · `0.1–0.4x` = core systems · `0.5–0.8x` = features · `0.9x` = polish · `1.0.0` = release

---

### 0.0.x — Project Foundation

#### `0.0.1` — Repository Skeleton
- `npm create tauri-app@latest swarm-orchestrator -- --template react-ts --manager npm`
- `rust-toolchain.toml`: `channel = "beta"`, all targets, components
- `package.json`: all exact versions, `"type": "module"`, `"engines": { "node": "25.8.1" }`
- `.npmrc`: `save-exact=true` + `engine-strict=true`
- `biome.json`: Biome 2.4.6, `$schema` pointing to `2.4.6/schema.json`
- `tsconfig.json`: `strict`, `module: esnext`, `target: esnext`, `moduleResolution: bundler`, `verbatimModuleSyntax: true`, `isolatedDeclarations: true`
- `vite.config.ts`: Vite 8.0.0 stable, `minify: "rolldown"`, `target: "es2026"`, `worker: { format: "es" }`
- ✅ `npm run tauri dev` opens blank window with zero console errors

#### `0.0.2` — TypeScript 6.0 Alignment
- Subpath imports in `package.json`: `#components/*`, `#store/*`, `#lib/*`, `#workers/*`, `#hooks/*`, `#pages/*`
- Vite aliases matching all subpaths
- `@tailwindcss/vite` plugin added — zero PostCSS config, no `tailwind.config.js` now or ever
- Biome check: zero warnings, zero errors
- TypeScript: `tsc --noEmit` clean

#### `0.0.3` — CSS Architecture
- `src/styles/global.css`: `@import "tailwindcss"` + import chain
- `src/styles/layers.css`: `@layer reset, base, tokens, layout, components, overrides`
- `src/styles/tokens.css`: full `@theme` OKLCH token set (all colors, fonts, spacing, easing)
- All `@property` typed custom props: `--glow-intensity`, `--pulse-scale`, `--scan-alpha`, `--worker-hue`
- CSS `@function --worker-color(--idx: integer) -> color` and `--worker-glow(--idx: integer) -> color`
- `@utility` blocks: `plasma-glow`, `glass-panel`, `surface-raised`, `surface-sunken`
- `@variant` blocks: `worker-active`, `worker-error`, `worker-paused`
- Variable fonts loaded: JetBrains Mono Variable, Syne Variable, DM Sans Variable — `font-display: optional`
- Biome CSS lint passes clean

#### `0.0.4` — Cargo.toml & Rust Workspace
- `edition = "2024"` in Cargo.toml
- All 12 crates pinned exactly as listed
- Release profile: `opt-level=3`, `lto="fat"`, `codegen-units=1`, `panic="abort"`, `strip="symbols"`
- Dev profile: `opt-level=1` (faster incremental builds)
- `src/error.rs`: `AppError` enum, `thiserror 2.0.18`
- `cargo clippy -- -D warnings` clean

#### `0.0.5` — Entry Points
- `src/main.tsx`: `createRoot()` only — zero `ReactDOM.render`
- Wrapped: `<StrictMode>` → `<Suspense fallback={<AppLoader />}>` → `<App />`
- `src-tauri/src/main.rs`: `#[tokio::main]`, `Builder::new_multi_thread().worker_threads(num_cpus::get()).enable_all()`
- `src-tauri/src/lib.rs`: `tauri::Builder` with all plugins registered
- App boots, blank render, zero errors

#### `0.0.6` — Tauri Plugin Registration
- All 4 plugins registered and functional
- `capabilities/default.json`: minimum required permissions (principle of least privilege)
- `tauri.conf.json`: frameless on macOS, CSP configured, product name/identifier
- `src/lib/tauri.ts`: typed `invoke<T>()` and `listen<T>()` wrappers

#### `0.0.7` — Zustand + Jotai Stores
- `src/store/types.ts`: all Zod v4 schemas — `import * as z from "zod/v4"` everywhere
- `src/store/workers.ts`: Zustand 5 + immer + subscribeWithSelector
- `src/store/sessions.ts`, `system.ts`
- `src/store/ui.ts`: Jotai 2.18.1 atoms — panel state, focus, toggles
- TypeScript clean, Biome clean

#### `0.0.8` — Rust Module Skeleton
- All module `mod.rs` files created
- `WorkerRegistry`: `Arc<DashMap<WorkerId, WorkerHandle>>` + `Arc<RwLock<SystemConfig>>`
- Empty Tauri commands (return `Ok(())`) — all registered in `lib.rs`
- `cargo check` clean

#### `0.0.9` — CI/CD
- `.github/workflows/ci.yml`: Biome lint, `tsc --noEmit`, `cargo clippy -- -D warnings`, `cargo test`
- `.github/workflows/release.yml`: `npm run tauri build` for Win/Mac targets
- `.github/workflows/deps.yml`: `cargo audit` + `npm audit`
- README badges for all CI workflows
- CI green on first push

---

### 0.1.x — Core Layout & Navigation

#### `0.1.0` — AppShell
- CSS Grid: sidebar 220px fixed + main 1fr
- GSAP 3.14.2 startup sequence: sidebar slides in (x: -20, 0.4s power3.out) → topbar fades in (y: -12, 0.3s, <0.1s overlap) → main fades (0.4s, <0.15s overlap)
- Framer Motion 12.36.0 `<AnimatePresence mode="popLayout">` on page content
- Glass-panel utility on sidebar. All surfaces OKLCH.
- `@crimson_dev/use-resize-observer` on AppShell container — drives initial layout

#### `0.1.1` — SplitPane
- Horizontal/vertical resizable panes
- `@crimson_dev/use-resize-observer 1.0.0` — `onResize` callback drives recalc
- Jotai atoms store sizes, persisted to `plugin-store 2.4.2`
- Drag handle: 4px, `oklch(0.78 0.18 205 / 0.3)`, glows on hover via CSS `@variant`

#### `0.1.2` — Routing
- Jotai atom for current page (no React Router)
- Framer Motion page transitions: `motion.div` initial/animate/exit
- All 5 pages: Dashboard, Workers, Sessions, Metrics, Settings (skeletons)
- Active nav link: `data-active="true"` + OKLCH accent left border

#### `0.1.3` — Theme System
- `src/lib/theme.ts`: `workerColor(idx)`, `withAlpha(color, alpha)`, OKLCH utilities
- Dark-only: no light mode — SWARM is for power users in dark environments
- `prefers-reduced-motion`: detected in `useTheme.ts` → Jotai atom → all consumers respect

#### `0.1.4` — Typography
- Variable font weights applied throughout
- `ScrollArea.tsx`: `scrollbar-width: thin`, OKLCH thumb
- `font-display: optional` on all loaded fonts

#### `0.1.5` — Command Palette — `modern-cmdk 1.1.5`
- `CommandPalette.tsx` built on `modern-cmdk 1.1.5`
- `shouldFilter={false}` — all filtering driven by Zustand + frecency ranking
- Frecency: `Map<commandId, { uses: number; lastUsed: Temporal.Instant }>` in Jotai atom
- `⌘K` / `Ctrl+K`: `addEventListener` in `useEffect` — cleaned up on unmount
- Styling: all `[cmdk-*]` data attribute selectors — OKLCH + glass-panel

#### `0.1.6` — Toast + Drawer
- `Toast.tsx` wrapping Sonner 2.0.7 — `<Toaster>` bottom-right, CSS var themed
- `Drawer.tsx` wrapping Vaul 1.1.2 — snap points at 40%, 70%, 95%
- Both: `prefers-reduced-motion` compliant

#### `0.1.7` — UI Primitive Library
- All `src/components/ui/` components fully implemented
- `Button.tsx`: polymorphic `as` prop, variants, loading state with `Spinner`
- `Badge.tsx`: OKLCH worker state colors via CSS `data-state` attribute
- `Spinner.tsx`: CSS `@keyframes`, `will-change: transform` removed after animation — `oklch(var(--color-plasma))`

#### `0.1.8` — Accessibility Pass
- All interactive: keyboard navigable
- All icons: `aria-label` or `aria-hidden="true"`
- All dialogs: `role="dialog"` + `aria-modal="true"` + focus trap
- WCAG AA contrast: all text verified with OKLCH perceptual model
- Live regions: `aria-live="polite"` for async state changes

#### `0.1.9` — Layout Verification
- Test at 1280×800, 1440×900, 2560×1440, 3840×2160
- Split panes work at 10%/90% extremes
- Command palette keyboard nav flawless
- GSAP startup fires exactly once
- Biome 2.4.6 + TypeScript both clean

---

### 0.2.x — Rust Backend Core

#### `0.2.0` — WorkerRegistry
- `WorkerRegistry`: `Arc<DashMap<WorkerId, WorkerHandle>>` + `Arc<parking_lot::RwLock<SystemConfig>>`
- `aggregate_metrics()`: collect DashMap entries → `rayon par_iter()` → fold — CPU-parallel, never on Tokio thread
- Registered via `tauri::Builder::manage()`

#### `0.2.1` — PTY Integration
- `portable-pty 0.9.0`: `PtySystem::default()` → `openpty()` → `spawn_command()`
- PTY reads: `spawn_blocking` → `tokio::mpsc::unbounded_channel` bridge
- Output: `Vec<u8>` chunks → `app.emit("worker:output", payload)`
- Input: `listen("worker:input")` → write to PTY master fd

#### `0.2.2` — Worker Lifecycle Commands
- `spawn_worker`, `pause_worker`, `resume_worker`, `kill_worker`, `list_workers`
- All: `#[tauri::command]` + `#[tracing::instrument(skip(app, registry))]`
- Return: `Result<T, String>` at IPC boundary
- Post-command: emit typed event via `app.emit()`

#### `0.2.3` — Tokio Runtime Architecture
- `Builder::new_multi_thread().worker_threads(num_cpus::get()).enable_all().build()`
- Main event loop: `tokio::select! { biased; shutdown => ..., pty => ..., ai => ... }`
- `JoinSet` for fan-out to N workers
- `watch::channel` for system state → frontend broadcast
- `broadcast::channel` for N-worker fan-out events

#### `0.2.4` — Error Handling Architecture
- `AppError` variants: `WorkerNotFound`, `PtySpawn`, `IpcError`, `AiError`, `IoError`, `PermissionDenied`, `RegistryFull`
- `anyhow::Context` chains on all `?` propagation with descriptive messages
- Tauri boundary: `.map_err(|e| e.to_string())`
- `tracing::error!` with structured fields on every error branch

#### `0.2.5` — Metrics Collection
- `tokio::time::interval(Duration::from_millis(500))` for metric tick
- Collect: CPU%, memory MB, worker count, AI req/s, tokens/s
- `rayon` parallel per-worker aggregation
- Emit: `app.emit("system:metrics", &payload)`

#### `0.2.6` — Session Management
- `Session`: `id: Uuid`, `worker_ids`, `created_at: i64`, `config`
- `plugin-store 2.4.2`: async auto-save
- `serde` with `#[serde(rename_all = "camelCase")]` on all IPC types
- Commands: `create_session`, `delete_session`, `list_sessions`, `get_session`

#### `0.2.7` — Typed Event System
- `SwarmEvent` enum: all frontend events centralized
- Single call site: `emit_event(app, SwarmEvent::WorkerSpawned { id, timestamp })`
- snake_case channels, camelCase JSON payloads

#### `0.2.8` — Tracing Setup
- `tracing-subscriber 0.3` with JSON formatter for production, pretty for dev
- `tracing::instrument` on every public async fn
- Forward `warn+` logs to frontend as `system:log` events

#### `0.2.9` — Rust Tests
- Unit: `WorkerRegistry` CRUD
- Unit: `AppError` display strings match expected
- Integration: spawn → output events → kill
- `cargo test -- --nocapture` passes
- `cargo clippy -- -D warnings` passes

---

### 0.3.x — Frontend ↔ Backend Integration

#### `0.3.0` — Typed IPC Bindings
- `src/lib/tauri.ts`: complete typed wrappers for all Rust commands
- Return types from Zod v4 schemas in `store/types.ts`
- All listeners: cleanup in `useEffect` return

#### `0.3.1` — Worker Store Integration
- Zustand actions → `invoke()` → optimistic update via `useOptimistic`
- `listen("worker:spawned")` → `addWorker()`
- `listen("worker:output")` → ring buffer (max 10k lines per worker)
- `listen("worker:state")` → `updateState()`

#### `0.3.2` — Terminal Integration — xterm 6.1.0-beta.193
- `useTerminal.ts` hook using `@crimson_dev/use-resize-observer 1.0.0`
- `new Terminal({ allowProposedApi: true, ... })` — beta API required for 6.1.x
- Load order: `FitAddon` → `WebglAddon` — WebGL2 renderer mandatory
- `@crimson_dev/use-resize-observer`: `onResize` callback → `fitAddon.fit()`
- OKLCH theme: `background: "oklch(0.06 0.02 220)"`, `cursor: "oklch(0.78 0.18 205)"`
- Input: `term.onData(data => invoke("worker_input", { workerId, data }))`

#### `0.3.3` — Metrics Integration
- `listen("system:metrics")` → `useSystemStore` update
- Recharts 3.8.0: `<ResponsiveContainer>` everywhere, `isAnimationActive={false}`
- OKLCH stroke colors via `workerColor(idx)`

#### `0.3.4` — Session Store Integration
- `useSession.ts` wraps all session commands
- `listen("session:created")` / `listen("session:deleted")` → Zustand
- Restore last session from `plugin-store` on startup

#### `0.3.5` — File System Integration
- `src/lib/tauri.ts` FS utilities via `plugin-fs 2.4.5`
- All paths: `BaseDirectory` scoped
- Atomic write pattern for config files

#### `0.3.6` — AI Client Setup (Frontend)
- `src/lib/anthropic.ts`: Anthropic SDK 0.78.0
- `async function*` generator: `for await (const event of stream)`
- Tool schemas: `ToolSchema.toJSONSchema()` via Zod v4 → `input_schema`
- API key: stored in Rust via `plugin-store` — never in frontend

#### `0.3.7` — AI Client (Rust)
- `reqwest 0.13.2`: `features = ["json","stream","rustls"]`, `default-features = false`
- SSE streaming: `response.bytes_stream()` + `tokio-stream 0.1.18 StreamExt`
- Emit `ai:stream_delta` Tauri events per chunk

#### `0.3.8` — Error Boundaries
- React 19 error boundary every major section
- Typed Tauri errors → Sonner toast
- Retry: exponential backoff (1s/2s/4s, 3 max)

#### `0.3.9` — Integration Test Pass
- 3 workers spawn, all terminals active, kill 1 → registry updates
- Create session → reload → session restored
- AI streaming works end-to-end
- Zero event listener leaks on unmount

---

### 0.4.x — Worker Topology Graph

#### `0.4.0` — XYFlow Foundation
- `@xyflow/react 12.10.1`: `nodeTypes`, `edgeTypes`, Background dots OKLCH
- Custom `<GraphControls>` — no default XYFlow controls

#### `0.4.1` — ELK Layout Worker
- `src/workers/elk.worker.ts` — `type: "module"` ES module worker
- `useElkLayout.ts`: returns `{ layoutedNodes, isLayouting }`
- `elkjs 0.11.1` options: layered algorithm, DOWN direction, 40/60 spacing
- Framer Motion 12.36.0 layout animations on position change

#### `0.4.2` — WorkerNode
- Glass-panel, OKLCH worker color via `--worker-color(idx)` CSS function
- `data-state` attribute drives CSS `@variant worker-active` glow
- Framer Motion: `whileHover={{ scale: 1.02 }}` — CSS transform only

#### `0.4.3` — DependencyEdge
- Animated `stroke-dashoffset` via CSS `@keyframes dash-flow`
- `oklch(0.78 0.18 205 / 0.6)` stroke + `filter: drop-shadow`

#### `0.4.4` — Graph Interactions
- Click → focus worker → `WorkerDetail` opens (Jotai atom)
- Right-click → context menu (pause/resume/kill/inspect)
- Drag → persist position in `plugin-store`
- `<MiniMap nodeColor={(n) => workerColor(n.data.index)} />`

#### `0.4.5` — Graph Performance
- ELK: only re-layout on actual topology change (deep compare)
- `requestAnimationFrame` for position updates post-layout
- 60fps verified with 50+ nodes (Chrome Performance profiler)

#### `0.4.6` — Graph Commands
- Command palette: "Focus Worker X", "Zoom to Fit", "Reset Layout", "Center Running Workers"
- `⌘⇧G` toggle graph / list view

#### `0.4.7` — Graph Polish
- Entry: nodes fade+scale in, staggered delay — Framer Motion
- Remove: shrink+fade before edge disconnects
- Loading overlay with `<Spinner>` while ELK computes
- Empty state: centered illustration

#### `0.4.8` — Graph Tests (Milestone)
- 1, 5, 10, 20, 50 workers — all layouts correct
- ELK confirmed off main thread (DevTools Performance)
- Drag + persist + reload restores positions
- 60fps verified

---

### 0.5.x — AI Integration & Streaming

#### `0.5.0` — Anthropic Streaming — SDK 0.78.0
- `useStream.ts`: `async function*` consumed via React `use()` + Suspense
- Chunks → `AIMessageStream.tsx` renders incrementally
- `AbortController` threaded through — cancel mid-stream works

#### `0.5.1` — Tool Use System
- SWARM tools as Zod v4 schemas → `.toJSONSchema()` → Anthropic format
- Tools: `spawn_worker`, `kill_worker`, `run_command`, `read_file`, `write_file`, `get_metrics`
- `ToolCallDisplay.tsx`: animated accordion, tool name + input + result
- Tool results: JSON with OKLCH syntax highlighting

#### `0.5.2` — AI Queue
- Zustand priority queue: `critical > high > normal > low`
- Concurrent limit: configurable (default 3 simultaneous streams)
- `AIQueue.tsx`: position indicators, estimated wait

#### `0.5.3` — Model Selection
- Claude opus/sonnet/haiku options
- Per-model: context window, cost estimate, capability badges
- Stored in `plugin-store`

#### `0.5.4` — Message History
- Per-worker conversation history
- `plugin-store` persistence: LRU, last 100 messages
- Virtualized list — never DOM overflow with thousands of messages

#### `0.5.5` — Streaming Performance
- Time-to-first-token < 500ms
- Chunk render < 16ms each — React 19 `startTransition` + `useDeferredValue`
- 60fps maintained during active 8k token stream

#### `0.5.6` — AI Error Handling
- Rate limit: exponential backoff, visual countdown in Sonner
- Context overflow: auto-truncate oldest, notify user
- Network timeout: 30s hard limit + retry option

#### `0.5.7` — Worker-AI Bridge
- AI tool execution in worker's PTY — bidirectional
- `inject_instruction` command: mid-conversation injection via `tokio::mpsc`

#### `0.5.8` — AI Metrics
- tokens/min, req/min, avg latency, tool calls/session
- Recharts 3.8.0 `<AreaChart>` — 30s rolling window, OKLCH fills

---

### 0.6.x — WebGPU Visual System

#### `0.6.0` — Device Initialization
- `requestAdapter({ powerPreference: "high-performance" })`
- `requestDevice({ requiredFeatures: ["timestamp-query"], requiredLimits: {...} })`
- `device.lost.then(...)` → auto-reinitialize without app crash
- Graceful fallback: `isSupported` boolean → solid OKLCH background

#### `0.6.1` — Particle Compute Shader (WGSL)
- `@compute @workgroup_size(64)` particle update kernel
- Particle struct: `pos: vec2f, vel: vec2f, life: f32, color: vec4f`
- SimParams uniform: `dt: f32, workerCount: u32, time: f32, deltaHue: f32`
- Worker count → particle density + hue rotation
- `createComputePipelineAsync` — non-blocking, never blocks render

#### `0.6.2` — Particle Render Pass
- Instanced quads: `draw(4, particleCount)` — billboard expansion in vertex shader
- Fragment: soft circle falloff, OKLCH-derived color
- Blend: additive — particles accumulate glow
- GPU timestamp queries for frame time measurement

#### `0.6.3` — Post-Processing Pipeline
- Ping-pong framebuffers
- Pass 1: Bloom — threshold → dual-kawase blur
- Pass 2: Chromatic aberration — RGB channel offset ±2px
- Pass 3: Vignette — `oklch(0 0 0 / 0.4)` edges
- All passes in single `GPURenderPassEncoder` chain

#### `0.6.4` — Worker State → Visual Coupling
- Running: particles flow toward node positions
- Error: hue shifts to rose OKLCH
- Paused: particles slow, desaturate
- Kill: burst emitter at node → dissolve
- Zustand subscription → WebGPU uniform buffer update

#### `0.6.5` — GPU Performance
- Target: < 4ms per frame (particles + post-process combined)
- GPU timestamp queries → `StatusBar.tsx` display (toggleable)
- Adaptive particle count: reduce if GPU > 8ms frame time

#### `0.6.6` — WebGL2 + WebGPU Coexistence
- Separate `<canvas>` elements — no shared contexts
- WebGPU: `z-index: 0`. xterm canvases: `z-index: 1`
- No WebGPU operations on xterm canvases

#### `0.6.7` — Accessibility
- All effects disabled on `prefers-reduced-motion: reduce`
- `<canvas aria-hidden="true">` — purely decorative
- App fully functional with WebGPU disabled

---

### 0.7.x — Sessions & Persistence

#### `0.7.0` — Session Model
- Complete Zod v4 `SessionSchema` — all fields
- `plugin-store 2.4.2` async auto-save on change
- `SessionList.tsx`: sorted by last activity, grouped by day (date-fns 4.1.0)

#### `0.7.1` — Session Lifecycle
- Create/delete/restore/export (JSON via `plugin-dialog 2.6.0`)
- Restore on startup: load all sessions → hydrate Zustand

#### `0.7.2` — Snapshots
- Auto-snapshot every 5 minutes (`tokio::time::interval`)
- Manual: command palette → "Snapshot Session"
- Diff: `serde_json::Value` comparison

#### `0.7.3` — Templates
- Built-in: "Single Agent", "Multi-Agent Parallel", "Supervisor + Workers", "Pipeline"
- User templates: create from active session, save to `plugin-store`

#### `0.7.4` — History Search
- Full-text: `invoke("search_history")` → Rust-side scan
- Date range: date-fns 4.1.0 + Temporal
- Highlights: OKLCH amber background

#### `0.7.5` — Data Export
- Session as Markdown, JSON, metrics as CSV
- All via `plugin-dialog 2.6.0` + `plugin-fs 2.4.5`

#### `0.7.6` — Workspace Watching
- `plugin-fs 2.4.5` `watch()` on project directory
- Debounce 300ms, ignore `.git`, `node_modules`, `target`
- Changes → `inject_instruction` to active workers

#### `0.7.7` — Store Integrity
- Startup validation: all stored data against Zod v4 schemas
- Corrupt data: warn + reset to defaults + toast
- Store keys: namespaced `swarm:sessions`, `swarm:config`, `swarm:ui`

---

### 0.8.x — Metrics & Analytics

#### `0.8.0` — SystemDashboard
- Recharts 3.8.0: `<ResponsiveContainer>` everywhere
- All charts: `isAnimationActive={false}` — 60fps maintained
- Real-time from `listen("system:metrics")` at 500ms

#### `0.8.1` — CPU + Memory Charts
- `CPUChart.tsx`: 60s rolling window, one line per core
- `MemoryChart.tsx`: stacked area (used/cached/available)
- OKLCH line colors, tooltips with OKLCH backgrounds

#### `0.8.2` — AI Throughput
- `ThroughputChart.tsx`: tokens/sec per model, 30s window
- `AIQueueChart.tsx`: pending by priority
- Rolling 24h cost in `StatusBar.tsx`

#### `0.8.3` — Worker Analytics
- Per-worker: uptime, messages, tool calls, error count
- Sparklines in `WorkerCard.tsx` (Recharts)

#### `0.8.4` — Performance Overlay (Dev)
- React render count, Zustand selector eval count
- GPU frame time from WebGPU timestamps
- Toggle: `⌘⇧P`

#### `0.8.5` — Alerts
- Thresholds: CPU > 80%, memory > 90%, error rate > 10%
- Sonner severity toasts
- Rust: `tokio::time::interval` 1s evaluation

#### `0.8.6` — Recharts 3.8.0 Theming
- `<CartesianGrid stroke="oklch(0.3 0.05 220 / 0.3)">`
- Tooltip: `contentStyle={{ background: "oklch(0.1 0.02 220)", border: "..." }}`
- All axes: `tick={{ fill: "oklch(0.6 0.05 220)", fontSize: 11 }}`

#### `0.8.7` — Data Aggregation
- Rust: ring buffer per metric (3600 samples = 30 min at 500ms)
- Downsampled for display: 60 points max per chart
- `rayon par_iter()` for multi-worker aggregation

---

### 0.9.x — Polish & Release Preparation

#### `0.9.0` — Performance Audit
- Chrome DevTools: 30s heavy usage recording
- Targets: < 5ms JS, < 4ms GPU, < 11ms total
- Zero tasks > 50ms on main thread
- React Compiler: verify zero unnecessary re-renders

#### `0.9.1` — Bundle Analysis
- Vite 8.0.0 bundle report: initial chunk < 200KB gzipped
- Lazy-loaded: recharts, xyflow, gsap, xterm — never in initial bundle

#### `0.9.2` — Startup Performance
- Cold start to interactive: < 1.5s
- Tauri: minimize IPC round trips on startup
- GSAP timeline: only after DOMContentLoaded + WebGPU ready

#### `0.9.3` — Memory Leak Audit
- All `listen()` calls: cleaned up in `useEffect` return
- All xterm instances: `dispose()` on unmount
- All WebGPU resources: `destroy()` on context loss
- Rust: zero Arc cycles, zero channel receiver panics

#### `0.9.4` — Accessibility Final Pass
- Full keyboard navigation test: every feature without mouse
- Screen reader: NVDA (Win), VoiceOver (Mac)
- WCAG AA: every text element
- `prefers-reduced-motion`: all animations off, fully functional

#### `0.9.5` — Error Hardening
- Kill Rust mid-op → frontend recovers
- Invalid API key → clear re-auth flow
- Disk full → no data corruption
- Window at 400×300 → no layout breaks

#### `0.9.6` — Platform Polish
- Windows 11 24H2: Mica material on title bar
- macOS 26: translucent sidebar (NSVisualEffectView vibrancy)
- JetBrains Mono: crisp on all DPI
- D3D12 (Win) + Metal (Mac) WebGPU paths both verified

#### `0.9.7` — Documentation Pass
- All public Rust: `///` with `# Examples`, `# Errors`
- All TypeScript: JSDoc on all hooks, stores, lib utils
- README.md: complete per docs standards section
- CHANGELOG.md: all 0.0.1–0.9.6 documented
- `docs/architecture.md`, `docs/api.md`, `docs/contributing.md`
- GitHub Wiki: 6+ pages (see GitHub docs section)

#### `0.9.8` — Security Audit
- `cargo audit`: zero known vulnerabilities
- `npm audit`: zero high/critical
- Tauri capabilities: least privilege review
- API key: never logged, never in frontend, never in errors
- CSP: strict, no unsafe-inline, no unsafe-eval

#### `0.9.9` — Release Candidate
- `npm run tauri build` produces signed installers Win + Mac
- All milestones 0.0.1–0.9.8 verified
- Biome 2.4.6: zero warnings
- TypeScript: zero errors
- Clippy: zero warnings
- Final human QA pass across all platforms

---

### `1.0.0` — Production Release 🚀
- All milestone criteria met
- Documentation complete and accurate
- Performance targets: < 5ms JS, < 4ms GPU, < 1.5s cold start
- Security audit clean
- Installers built and code-signed for Win 11 + macOS 26
- GitHub Release: binaries + CHANGELOG entry
- `package.json`, `Cargo.toml`, `tauri.conf.json` all at `1.0.0`
- `git tag v1.0.0 && git push origin v1.0.0`


---

## ⚙️ EXACT CONFIGURATION FILES

### `.npmrc`
```
save-exact=true
engine-strict=true
```

### `package.json`
```json
{
  "name": "swarm-orchestrator",
  "version": "0.0.1",
  "type": "module",
  "engines": { "node": "25.8.1" },
  "scripts": {
    "dev":         "vite",
    "build":       "tsc --noEmit && vite build",
    "check":       "biome check --write .",
    "lint":        "biome lint .",
    "format":      "biome format --write .",
    "tauri":       "tauri",
    "tauri:dev":   "tauri dev",
    "tauri:build": "tauri build"
  },
  "dependencies": {
    "react":                              "19.3.0-canary-5e9eedb5-20260312",
    "react-dom":                          "19.3.0-canary-5e9eedb5-20260312",
    "tailwindcss":                        "4.2.1",
    "framer-motion":                      "12.36.0",
    "gsap":                               "3.14.2",
    "@xyflow/react":                      "12.10.1",
    "elkjs":                              "0.11.1",
    "zustand":                            "5.0.11",
    "immer":                              "11.1.4",
    "jotai":                              "2.18.1",
    "recharts":                           "3.8.0",
    "@anthropic-ai/sdk":                  "0.78.0",
    "zod":                                "4.4.0-canary.20260125T215152",
    "modern-cmdk":                        "1.1.5",
    "sonner":                             "2.0.7",
    "vaul":                               "1.1.2",
    "date-fns":                           "4.1.0",
    "@crimson_dev/use-resize-observer":   "1.0.0",
    "@xterm/xterm":                       "6.1.0-beta.193",
    "@xterm/addon-fit":                   "0.12.0-beta.168",
    "@tauri-apps/plugin-fs":              "2.4.5",
    "@tauri-apps/plugin-dialog":          "2.6.0",
    "@tauri-apps/plugin-shell":           "2.3.5",
    "@tauri-apps/plugin-store":           "2.4.2"
  },
  "devDependencies": {
    "typescript":      "6.0.0-dev.20260313",
    "vite":            "8.0.0",
    "@biomejs/biome":  "2.4.6",
    "@tauri-apps/cli": "2.10.1",
    "@webgpu/types":   "0.1.69"
  },
  "imports": {
    "#components/*": "./src/components/*.tsx",
    "#store/*":      "./src/store/*.ts",
    "#lib/*":        "./src/lib/*.ts",
    "#workers/*":    "./src/workers/*.ts",
    "#hooks/*":      "./src/hooks/*.ts",
    "#pages/*":      "./src/pages/*.tsx",
    "#styles/*":     "./src/styles/*.css"
  }
}
```

### `rust-toolchain.toml`
```toml
[toolchain]
channel    = "beta"
components = ["rustfmt", "clippy", "rust-src", "rust-analyzer"]
targets    = [
  "x86_64-pc-windows-msvc",
  "aarch64-apple-darwin",
  "x86_64-apple-darwin"
]
```

### `src-tauri/Cargo.toml`
```toml
[package]
name    = "swarm-core"
version = "0.0.1"
edition = "2024"

[dependencies]
tauri               = { version = "2.10",    features = ["devtools"] }
tokio               = { version = "1.50.0",  features = ["full"] }
tokio-stream        = { version = "0.1.18",  features = ["net"] }
rayon               = "1.11.0"
portable-pty        = "0.9.0"
reqwest             = { version = "0.13.2",  features = ["json","stream","rustls"], default-features = false }
serde               = { version = "1.0.228", features = ["derive"] }
serde_json          = "1.0.149"
anyhow              = "1.0.102"
thiserror           = "2.0.18"
tracing             = "0.1.44"
dashmap             = "7.0.0-rc2"
parking_lot         = "0.12.5"
tauri-plugin-fs     = "2.4.5"
tauri-plugin-dialog = "2.6.0"
tauri-plugin-shell  = "2.3.5"
tauri-plugin-store  = "2.4.2"

[profile.release]
opt-level     = 3
lto           = "fat"
codegen-units = 1
panic         = "abort"
strip         = "symbols"

[profile.dev]
opt-level = 1
```

### `tsconfig.json`
```json
{
  "compilerOptions": {
    "strict":                          true,
    "module":                          "esnext",
    "target":                          "esnext",
    "moduleResolution":                "bundler",
    "lib":                             ["esnext", "DOM", "DOM.Iterable"],
    "noUncheckedSideEffectImports":    true,
    "isolatedModules":                 true,
    "declaration":                     true,
    "isolatedDeclarations":            true,
    "verbatimModuleSyntax":            true,
    "jsx":                             "react-jsx",
    "jsxImportSource":                 "react",
    "noEmit":                          true,
    "skipLibCheck":                    false,
    "forceConsistentCasingInFileNames": true,
    "paths":                           {}
  },
  "include": ["src"],
  "exclude": ["node_modules", "src-tauri"]
}
```

### `vite.config.ts`
```typescript
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { resolve } from "node:path";

export default defineConfig({
  plugins: [
    react({
      babel: { plugins: ["babel-plugin-react-compiler"] },
    }),
    tailwindcss(),
  ],

  resolve: {
    alias: {
      "#components": resolve(__dirname, "src/components"),
      "#store":      resolve(__dirname, "src/store"),
      "#lib":        resolve(__dirname, "src/lib"),
      "#workers":    resolve(__dirname, "src/workers"),
      "#hooks":      resolve(__dirname, "src/hooks"),
      "#pages":      resolve(__dirname, "src/pages"),
    },
  },

  build: {
    // Vite 8.0.0 stable — Rolldown is the bundler
    minify:        "rolldown",
    sourcemap:     true,
    target:        "es2026",
    modulePreload: { polyfill: false },  // Chromium 146+ native
    rollupOptions: {
      output: {
        manualChunks: {
          "react-vendor": ["react", "react-dom"],
          "motion":       ["framer-motion", "gsap"],
          "graph":        ["@xyflow/react", "elkjs"],
          "terminal":     ["@xterm/xterm", "@xterm/addon-fit"],
          "state":        ["zustand", "immer", "jotai"],
          "ai":           ["@anthropic-ai/sdk"],
          "charts":       ["recharts"],
        },
      },
    },
  },

  optimizeDeps: {
    // Rolldown handles pre-bundling — explicit includes for any CJS compat
    include: ["gsap", "elkjs"],
  },

  worker: {
    format: "es",  // ES module workers — Chromium 146+ native
  },

  server: {
    port:       1420,
    strictPort: true,
    watch:      { ignored: ["**/src-tauri/**"] },
  },
});
```

### `biome.json`
```json
{
  "$schema": "https://biomejs.dev/schemas/2.4.6/schema.json",
  "vcs": { "enabled": true, "clientKind": "git", "useIgnoreFile": true },
  "files": {
    "ignore": ["src-tauri/target/**", "dist/**", "node_modules/**"]
  },
  "formatter": {
    "enabled":     true,
    "indentStyle": "space",
    "indentWidth": 2,
    "lineWidth":   100,
    "lineEnding":  "auto"
  },
  "linter": {
    "enabled": true,
    "rules": {
      "recommended": true,
      "correctness": {
        "noFloatingPromises": "error",
        "noUnusedImports":    "error",
        "noUnusedVariables":  "error"
      },
      "style": {
        "noNonNullAssertion": "warn",
        "useConst":           "error"
      },
      "suspicious": {
        "noExplicitAny": "error"
      }
    }
  },
  "domains": {
    "react": "recommended",
    "test":  "recommended"
  },
  "organizeImports": { "enabled": true },
  "javascript": {
    "formatter": {
      "quoteStyle":       "double",
      "semicolons":       "always",
      "trailingCommas":   "all",
      "arrowParentheses": "always"
    }
  }
}
```

### `src/styles/tokens.css`
```css
@layer reset {
  *, *::before, *::after {
    box-sizing: border-box;
    margin: 0;
    padding: 0;
  }
  html {
    -webkit-font-smoothing: antialiased;
    text-rendering: optimizeLegibility;
    color-scheme: dark;
  }
}

@theme {
  /* ── OKLCH Color System ────────────────────── */
  --color-plasma:        oklch(0.78 0.18 205);
  --color-plasma-dim:    oklch(0.55 0.12 205);
  --color-plasma-glow:   oklch(0.78 0.18 205 / 0.25);
  --color-amber:         oklch(0.82 0.19 70);
  --color-amber-dim:     oklch(0.55 0.12 70);
  --color-rose:          oklch(0.72 0.20 10);
  --color-rose-dim:      oklch(0.50 0.14 10);
  --color-lime:          oklch(0.82 0.18 140);
  --color-lime-dim:      oklch(0.55 0.12 140);
  --color-violet:        oklch(0.72 0.20 290);
  --color-cyan:          oklch(0.80 0.14 195);
  --color-void:          oklch(0.06 0.02 220);
  --color-surface-0:     oklch(0.08 0.02 220);
  --color-surface-1:     oklch(0.11 0.03 220);
  --color-surface-2:     oklch(0.14 0.03 220);
  --color-surface-3:     oklch(0.17 0.04 220);
  --color-border:        oklch(0.22 0.04 220);
  --color-border-2:      oklch(0.28 0.05 220);
  --color-text:          oklch(0.82 0.04 220);
  --color-text-dim:      oklch(0.55 0.04 220);
  --color-text-bright:   oklch(0.95 0.02 220);

  /* ── Typography ──────────────────────────────── */
  --font-mono:    "JetBrains Mono Variable", ui-monospace, monospace;
  --font-display: "Syne Variable", sans-serif;
  --font-body:    "DM Sans Variable", system-ui, sans-serif;

  /* ── Spacing (4px base) ──────────────────────── */
  --spacing-1: 4px;
  --spacing-2: 8px;
  --spacing-3: 12px;
  --spacing-4: 16px;
  --spacing-5: 20px;
  --spacing-6: 24px;
  --spacing-8: 32px;
  --spacing-10: 40px;
  --spacing-12: 48px;

  /* ── Border Radius ───────────────────────────── */
  --radius-sm: 4px;
  --radius-md: 8px;
  --radius-lg: 12px;
  --radius-xl: 16px;

  /* ── Easing ──────────────────────────────────── */
  --ease-spring:  cubic-bezier(0.34, 1.56, 0.64, 1.0);
  --ease-out:     cubic-bezier(0.0,  0.0,  0.2,  1.0);
  --ease-in-out:  cubic-bezier(0.4,  0.0,  0.2,  1.0);
  --ease-bounce:  cubic-bezier(0.34, 1.75, 0.64, 1.0);
}

/* ── CSS @function — dynamic OKLCH worker colors ── */
@function --worker-color(--idx: integer) -> color {
  result: oklch(
    from var(--color-plasma)
    calc(l - (--idx * 0.04))
    c
    calc(h + (--idx * 36))
  );
}

@function --worker-glow(--idx: integer) -> color {
  result: oklch(
    from var(--color-plasma)
    calc(l - (--idx * 0.04))
    c
    calc(h + (--idx * 36))
    / 0.3
  );
}

/* ── @utility blocks ─────────────────────────────── */
@utility plasma-glow {
  box-shadow:
    0 0 0 1px oklch(0.78 0.18 205 / 0.4),
    0 0 20px oklch(0.78 0.18 205 / 0.2),
    0 0 40px oklch(0.78 0.18 205 / 0.1);
}

@utility glass-panel {
  background:      oklch(0.12 0.03 220 / 0.7);
  backdrop-filter: blur(12px) saturate(1.5);
  border:          1px solid oklch(0.28 0.05 220);
}

@utility surface-raised {
  background: oklch(0.14 0.03 220);
  border:     1px solid oklch(0.22 0.04 220);
}

/* ── @variant blocks ─────────────────────────────── */
@variant worker-active  ("&[data-state='running']");
@variant worker-error   ("&[data-state='error']");
@variant worker-paused  ("&[data-state='paused']");
```

### `src/styles/animations.css`
```css
/* ── Typed custom properties ─────────────────────── */
@property --glow-intensity {
  syntax: "<number>";
  initial-value: 0;
  inherits: false;
}

@property --pulse-scale {
  syntax: "<number>";
  initial-value: 1;
  inherits: false;
}

@property --scan-alpha {
  syntax: "<number>";
  initial-value: 0;
  inherits: false;
}

@property --worker-hue {
  syntax: "<angle>";
  initial-value: 205deg;
  inherits: false;
}

/* ── @keyframes ──────────────────────────────────── */
@keyframes pulse-ring {
  0%   { transform: scale(1);   opacity: 0.8; }
  100% { transform: scale(2.5); opacity: 0; }
}

@keyframes glow-breathe {
  0%, 100% { --glow-intensity: 0.3; }
  50%       { --glow-intensity: 0.8; }
}

@keyframes dash-flow {
  0%   { stroke-dashoffset: 24; }
  100% { stroke-dashoffset: 0; }
}

@keyframes scan-line {
  0%   { --scan-alpha: 0; transform: translateY(-100%); }
  10%  { --scan-alpha: 0.4; }
  90%  { --scan-alpha: 0.4; }
  100% { --scan-alpha: 0; transform: translateY(100vh); }
}

@keyframes shimmer {
  0%   { background-position: -200% center; }
  100% { background-position:  200% center; }
}

/* ── Reduced motion ──────────────────────────────── */
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration:       0.001ms !important;
    animation-iteration-count: 1      !important;
    transition-duration:      0.001ms !important;
  }
}
```


---

## 💻 MANDATORY CODE PATTERNS

### React 19 Canary — Every Component

```typescript
// ✅ ref as prop — React 19, no forwardRef ever
function TerminalPane({
  ref,
  workerId,
}: {
  ref?: React.Ref<HTMLDivElement>;
  workerId: string;
}) {
  return <div ref={ref} data-worker={workerId} />;
}

// ✅ use() for async data — replaces useEffect data fetching
function WorkerDetail({ promise }: { promise: Promise<Worker> }) {
  const worker = use(promise); // suspends automatically
  return <div>{worker.id}</div>;
}

// ✅ useOptimistic for instant feedback
function WorkerControls({ worker }: { worker: Worker }) {
  const [state, setOptimistic] = useOptimistic(worker.state);
  const [, startTransition] = useTransition();

  const handlePause = () => {
    setOptimistic("pausing");
    startTransition(async () => {
      await invoke("pause_worker", { id: worker.id });
    });
  };

  return (
    <button onClick={handlePause}>
      {state === "pausing" ? "Pausing…" : "Pause"}
    </button>
  );
}

// ✅ createRoot — only valid entry point
import { createRoot } from "react-dom/client";
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Suspense fallback={<AppLoader />}>
      <App />
    </Suspense>
  </StrictMode>,
);
```

### TypeScript 6.0 — Every File

```typescript
// ✅ verbatimModuleSyntax: explicit type imports
import type { Worker, Session } from "#store/types";
import { useWorkerStore } from "#store/workers";

// ✅ isolatedDeclarations: all exports inferrable without analysis
export function getWorkerColor(idx: number): string {
  return `oklch(${0.78 - idx * 0.04} 0.18 ${205 + idx * 36})`;
}

// ✅ Zod v4 — always import from "zod/v4"
import * as z from "zod/v4";

const WorkerSchema = z.interface({
  id:         z.string().uuid(),
  state:      z.enum(["idle", "running", "paused", "error"]),
  "pid?":     z.number().int(),          // key optional
  output:     z.string().optional(),     // value optional, key present
  startedAt:  z.string().datetime(),
});
export type Worker = z.infer<typeof WorkerSchema>;

// ✅ Temporal API — typed under es2026 in TS 6.0
const now = Temporal.Now.instant();
const uptime = now.since(Temporal.Instant.from(worker.startedAt));

// ✅ Subpath imports — never relative paths for cross-module
import { Button } from "#components/ui/Button";
import { useWorker } from "#hooks/useWorker";
```

### `modern-cmdk 1.1.5` — Command Palette Pattern

```typescript
// ✅ modern-cmdk — import from "modern-cmdk"
import { Command } from "modern-cmdk";
import { useWorkerStore } from "#store/workers";
import { atom, useAtom } from "jotai";
import * as z from "zod/v4";

// Frecency entry schema
const FrecencySchema = z.interface({
  uses:     z.number().int(),
  lastUsed: z.string().datetime(), // Temporal.Instant serialized
});
type FrecencyEntry = z.infer<typeof FrecencySchema>;

// Jotai atom — frecency map persisted to plugin-store
const frecencyAtom = atom<Map<string, FrecencyEntry>>(new Map());

function CommandPalette() {
  const [open, setOpen] = useAtom(commandPaletteOpenAtom);
  const [frecency, setFrecency] = useAtom(frecencyAtom);
  const workers = useWorkerStore((s) => Array.from(s.workers.values()));

  // All filtering is done here — shouldFilter={false} on Command
  const [query, setQuery] = useState("");
  const filtered = useMemo(() => {
    return rankByFrecency(
      workers.filter((w) => w.id.includes(query) || w.name?.includes(query)),
      frecency,
    );
  }, [workers, query, frecency]);

  const handleSelect = (commandId: string) => {
    setFrecency((prev) => {
      const existing = prev.get(commandId) ?? { uses: 0, lastUsed: "" };
      return new Map(prev).set(commandId, {
        uses: existing.uses + 1,
        lastUsed: Temporal.Now.instant().toString(),
      });
    });
    setOpen(false);
  };

  return (
    <Command shouldFilter={false} className="command-root">
      <Command.Input
        value={query}
        onValueChange={setQuery}
        placeholder="Search workers, sessions, actions…"
      />
      <Command.List>
        <Command.Group heading="Workers">
          {filtered.map((worker) => (
            <Command.Item
              key={worker.id}
              value={worker.id}
              onSelect={() => handleSelect(worker.id)}
            >
              {worker.id}
            </Command.Item>
          ))}
        </Command.Group>
      </Command.List>
    </Command>
  );
}
```

### `@crimson_dev/use-resize-observer 1.0.0` — Hook Usage

```typescript
// ✅ First-party hook — full React 19 native
import { useResizeObserver } from "@crimson_dev/use-resize-observer";

// ✅ Terminal pane — xterm fit driven by observer
function WorkerTerminal({ workerId }: { workerId: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef      = useRef<Terminal | null>(null);
  const fitRef       = useRef<FitAddon | null>(null);

  // @crimson_dev/use-resize-observer 1.0.0
  useResizeObserver({
    ref: containerRef,
    onResize: () => {
      fitRef.current?.fit();
    },
  });

  useEffect(() => {
    const term  = new Terminal({ allowProposedApi: true });
    const fit   = new FitAddon();
    const webgl = new WebglAddon();

    term.loadAddon(fit);
    term.loadAddon(webgl);
    term.open(containerRef.current!);
    fit.fit();

    termRef.current = term;
    fitRef.current  = fit;

    return () => { term.dispose(); };
  }, [workerId]);

  return <div ref={containerRef} className="h-full w-full" />;
}

// ✅ SplitPane — pane size tracking
function SplitPane({ children }: { children: React.ReactNode }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [, setSizes] = useAtom(paneSizesAtom);

  useResizeObserver({
    ref: containerRef,
    onResize: ({ width, height }) => {
      setSizes({ width: width ?? 0, height: height ?? 0 });
    },
  });

  return <div ref={containerRef}>{children}</div>;
}
```

### xterm.js `6.1.0-beta.193` — Full Terminal Setup

```typescript
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";

// ✅ allowProposedApi: true — required for 6.1.x beta APIs
const term = new Terminal({
  allowProposedApi: true,   // mandatory for beta.193
  theme: {
    background:          "oklch(0.06 0.02 220)",
    foreground:          "oklch(0.82 0.04 220)",
    cursor:              "oklch(0.78 0.18 205)",
    cursorAccent:        "oklch(0.06 0.02 220)",
    selectionBackground: "oklch(0.78 0.18 205 / 0.25)",
    black:               "oklch(0.20 0.02 220)",
    brightBlack:         "oklch(0.40 0.02 220)",
    red:                 "oklch(0.72 0.20 10)",
    brightRed:           "oklch(0.78 0.20 10)",
    green:               "oklch(0.82 0.18 140)",
    brightGreen:         "oklch(0.88 0.18 140)",
    yellow:              "oklch(0.82 0.19 70)",
    brightYellow:        "oklch(0.88 0.19 70)",
    blue:                "oklch(0.72 0.18 250)",
    brightBlue:          "oklch(0.78 0.18 250)",
    magenta:             "oklch(0.72 0.20 290)",
    brightMagenta:       "oklch(0.78 0.20 290)",
    cyan:                "oklch(0.80 0.14 195)",
    brightCyan:          "oklch(0.86 0.14 195)",
    white:               "oklch(0.82 0.04 220)",
    brightWhite:         "oklch(0.95 0.02 220)",
  },
  fontFamily:  "'JetBrains Mono Variable', monospace",
  fontSize:    13,
  lineHeight:  1.5,
  cursorBlink: true,
  cursorStyle: "bar",
  scrollback:  10000,
});

// ✅ Load order: fit before webgl
const fit   = new FitAddon();
const webgl = new WebglAddon();
term.loadAddon(fit);
term.loadAddon(webgl);
term.open(containerElement);
fit.fit();
```

### Zustand 5.0.11 — Every Store

```typescript
import { create } from "zustand";
import { subscribeWithSelector } from "zustand/middleware";
import { immer } from "zustand/middleware/immer";
import type { Worker } from "#store/types";

interface WorkerState { workers: Map<string, Worker>; selectedId: string | null; }
interface WorkerActions {
  addWorker(worker: Worker): void;
  updateState(id: string, state: Worker["state"]): void;
  removeWorker(id: string): void;
  selectWorker(id: string | null): void;
}

export const useWorkerStore = create<WorkerState & WorkerActions>()(
  subscribeWithSelector(
    immer((set) => ({
      workers: new Map(),
      selectedId: null,
      addWorker(worker)        { set((s) => { s.workers.set(worker.id, worker); }); },
      updateState(id, state)   { set((s) => { const w = s.workers.get(id); if (w) w.state = state; }); },
      removeWorker(id)         { set((s) => { s.workers.delete(id); }); },
      selectWorker(id)         { set((s) => { s.selectedId = id; }); },
    }))
  )
);

// ✅ Slice subscription — components subscribe to minimal surface
const runningCount = useWorkerStore(
  (s) => Array.from(s.workers.values()).filter((w) => w.state === "running").length,
);
```

### Jotai 2.18.1 — Local UI State

```typescript
import { atom, useAtom, useAtomValue, useSetAtom } from "jotai";
import { atomWithStorage } from "jotai/utils";

// Panel state — local, ephemeral
export const commandPaletteOpenAtom = atom(false);
export const selectedWorkerIdAtom   = atom<string | null>(null);
export const sidebarCollapsedAtom   = atom(false);

// Persisted via plugin-store integration
export const paneSizesAtom = atomWithStorage<{ main: number; detail: number }>(
  "swarm:ui:paneSizes",
  { main: 60, detail: 40 },
);

// Derived atom
export const selectedWorkerAtom = atom((get) => {
  const id = get(selectedWorkerIdAtom);
  if (!id) return null;
  // Derived from Zustand store via atom bridge
  return id;
});
```

### Rust — Every Module

```rust
// ✅ Edition 2024, async fn in trait (Rust 1.95 stable)
pub trait WorkerBackend: Send + Sync {
    async fn spawn(&self, config: WorkerConfig) -> anyhow::Result<WorkerId>;
    async fn pause(&self, id: WorkerId) -> anyhow::Result<()>;
    async fn resume(&self, id: WorkerId) -> anyhow::Result<()>;
}

// ✅ thiserror 2.0.18 — library boundary errors
#[derive(Debug, thiserror::Error)]
pub enum WorkerError {
    #[error("Worker {id} not found")]
    NotFound { id: String },
    #[error("PTY spawn failed: {0}")]
    PtySpawn(#[from] portable_pty::Error),
    #[error("Registry at capacity ({max})")]
    RegistryFull { max: usize },
}

// ✅ parking_lot::RwLock — never std::sync
use parking_lot::RwLock;
use dashmap::DashMap;
use std::sync::Arc;

#[derive(Clone)]
pub struct WorkerRegistry {
    workers: Arc<DashMap<WorkerId, WorkerHandle>>,
    config:  Arc<RwLock<SystemConfig>>,
}

// ✅ rayon for CPU-parallel aggregation — never on Tokio thread
pub fn aggregate_metrics(&self) -> SystemMetrics {
    self.workers
        .iter()
        .collect::<Vec<_>>()
        .par_iter()                          // rayon parallel
        .map(|entry| entry.value().metrics())
        .reduce(SystemMetrics::default, |a, b| a.merge(b))
}

// ✅ JoinSet for fan-out
pub async fn broadcast(&self, msg: AgentMessage) -> anyhow::Result<()> {
    let mut set = tokio::task::JoinSet::new();
    for entry in self.workers.iter() {
        let handle = entry.value().clone();
        let msg    = msg.clone();
        set.spawn(async move { handle.send(msg).await });
    }
    while let Some(r) = set.join_next().await { r??; }
    Ok(())
}

// ✅ Tauri command — tracing::instrument, anyhow, Result<T,String>
#[tauri::command]
#[tracing::instrument(skip(app, registry))]
pub async fn spawn_worker(
    app:      tauri::AppHandle,
    registry: tauri::State<'_, WorkerRegistry>,
    config:   WorkerConfig,
) -> Result<String, String> {
    let id = registry
        .spawn(config)
        .await
        .context("registry spawn failed")
        .map_err(|e| e.to_string())?;

    app.emit("worker:spawned", &id).map_err(|e| e.to_string())?;
    tracing::info!(worker_id = %id, "worker spawned");
    Ok(id)
}
```

### Anthropic SDK 0.78.0 — Streaming

```typescript
import Anthropic from "@anthropic-ai/sdk";
import type { Tool } from "@anthropic-ai/sdk/resources/messages";
import * as z from "zod/v4";

// ✅ async generator — consumed by React use() + Suspense
export async function* streamAgentResponse(
  messages: Anthropic.MessageParam[],
  tools: Tool[],
  signal?: AbortSignal,
): AsyncGenerator<string, void, undefined> {
  const client = new Anthropic();
  const stream = client.messages.stream({
    model:      "claude-opus-4-5",
    max_tokens: 8192,
    tools,
    messages,
  });

  for await (const event of stream) {
    if (signal?.aborted) break;
    if (
      event.type === "content_block_delta" &&
      event.delta.type === "text_delta"
    ) {
      yield event.delta.text;
    }
  }
}

// ✅ Zod v4 toJSONSchema() for tool input_schema
const RunCommandSchema = z.object({
  command: z.string(),
  args:    z.array(z.string()).default([]),
  cwd:     z.string().optional(),
});

export const SWARM_TOOLS: Tool[] = [
  {
    name:         "run_command",
    description:  "Run a shell command in the worker PTY",
    input_schema: RunCommandSchema.toJSONSchema() as Tool["input_schema"],
  },
];
```

### Recharts 3.8.0 — Every Chart

```typescript
// ✅ isAnimationActive={false} — 60fps during live updates
// ✅ ResponsiveContainer — always wraps charts
// ✅ OKLCH colors everywhere
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from "recharts";

function CPUChart({ data }: { data: MetricPoint[] }) {
  return (
    <ResponsiveContainer width="100%" height={200}>
      <LineChart data={data}>
        <CartesianGrid
          strokeDasharray="3 3"
          stroke="oklch(0.3 0.05 220 / 0.3)"
          vertical={false}
        />
        <XAxis
          dataKey="time"
          tick={{ fill: "oklch(0.55 0.04 220)", fontSize: 11, fontFamily: "JetBrains Mono Variable" }}
          axisLine={{ stroke: "oklch(0.22 0.04 220)" }}
          tickLine={false}
        />
        <YAxis
          domain={[0, 100]}
          tick={{ fill: "oklch(0.55 0.04 220)", fontSize: 11, fontFamily: "JetBrains Mono Variable" }}
          axisLine={false}
          tickLine={false}
        />
        <Tooltip
          contentStyle={{
            background: "oklch(0.11 0.03 220)",
            border:     "1px solid oklch(0.28 0.05 220)",
            borderRadius: "6px",
            fontFamily:   "JetBrains Mono Variable",
            fontSize:     11,
          }}
          cursor={{ stroke: "oklch(0.78 0.18 205 / 0.3)" }}
        />
        <Line
          type="monotone"
          dataKey="cpu"
          stroke="oklch(0.78 0.18 205)"
          strokeWidth={1.5}
          dot={false}
          isAnimationActive={false}  // REQUIRED for 60fps live updates
        />
      </LineChart>
    </ResponsiveContainer>
  );
}
```

### WebGPU — Device + Pipeline

```typescript
// ✅ createComputePipelineAsync — non-blocking
export async function initWebGPU(): Promise<GPUDevice | null> {
  if (!navigator.gpu) return null;
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
  if (!adapter) return null;

  const device = await adapter.requestDevice({
    requiredFeatures: ["timestamp-query"],
    requiredLimits: {
      maxComputeWorkgroupSizeX:       256,
      maxStorageBufferBindingSize:    adapter.limits.maxStorageBufferBindingSize,
    },
  });

  // Auto-recover on context loss — never crash the app
  device.lost.then((info) => {
    console.error("WebGPU lost:", info.reason, info.message);
    // Trigger re-initialization via Jotai atom
  });

  return device;
}

// ✅ Pipeline async — Chromium parallelizes shader compilation
export async function createComputePipeline(
  device: GPUDevice,
  wgsl: string,
): Promise<GPUComputePipeline> {
  const module = device.createShaderModule({ code: wgsl });
  return await device.createComputePipelineAsync({
    layout:  "auto",
    compute: { module, entryPoint: "main" },
  });
}
```

---

## 🎨 AESTHETIC STANDARDS

### The OKLCH Mandate
Every color in SWARM is OKLCH. This is non-negotiable:
- ✅ `oklch(0.78 0.18 205)` — correct
- ❌ `#00aaff` — banned
- ❌ `rgb(0, 170, 255)` — banned
- ❌ `hsl(204, 100%, 50%)` — banned

OKLCH is perceptually uniform — same chroma at different lightness values looks visually balanced. This matters for worker color generation where multiple workers need visually distinct but equally saturated colors.

### Surface Hierarchy
```
oklch(0.06 0.02 220)  — void (WebGPU canvas background)
oklch(0.08 0.02 220)  — app background
oklch(0.11 0.03 220)  — sidebar, secondary panels
oklch(0.14 0.03 220)  — cards, dropdowns, raised surfaces
oklch(0.17 0.04 220)  — dialogs, modals, overlays
oklch(0.12 0.03 220 / 0.7) + backdrop-filter — glass panels
```

### Worker Color Generation
Workers 0–N each get a unique OKLCH hue rotation:
```
Worker 0: oklch(0.78 0.18 205)   — plasma blue
Worker 1: oklch(0.74 0.18 241)   — indigo
Worker 2: oklch(0.70 0.18 277)   — violet
Worker 3: oklch(0.66 0.18 313)   — rose-violet
Worker 4: oklch(0.62 0.18 349)   — rose
...
```
Generated via CSS `--worker-color(idx)` function or TypeScript `workerColor(idx)`.

### Typography Hierarchy
```
Display:   Syne Variable 700–800, letter-spacing: -0.02em
Heading:   Syne Variable 600–700
Body:      DM Sans Variable 400
Label:     DM Sans Variable 500
Mono/Code: JetBrains Mono Variable 400
Data:      JetBrains Mono Variable 300
```

### Animation Principles
1. Spring physics for UI state (Framer Motion: stiffness 400, damping 30)
2. Power easing for GSAP sequences (power3.out for entries, power2.in for exits)
3. CSS @keyframes for infinite loops (pulse, scan, dash)
4. WebGPU for particles/post-processing — zero canvas2D particle loops
5. Zero animation on `prefers-reduced-motion: reduce`

### State Visual Language
| State | Color | Visual Effect |
|-------|-------|--------------|
| running | `oklch(0.78 0.18 205)` | Plasma glow + breathing pulse ring |
| paused | `oklch(0.82 0.19 70)` | Amber, static, no animation |
| error | `oklch(0.72 0.20 10)` | Rose, strobe glow (2× duty cycle) |
| idle | `oklch(0.55 0.04 220)` | Dim, no glow, no animation |
| loading | plasma 30% opacity | Shimmer sweep |

---

## 📊 PERFORMANCE REQUIREMENTS

### Frame Budget (Hard Targets)
| Metric | Target | Hard Max |
|--------|--------|---------|
| JS main thread per frame | < 5ms | 8ms |
| GPU (particles + post-process) | < 4ms | 6ms |
| Total frame time | < 11ms | 14ms |
| Dropped frames | 0 | < 1/min |
| Long tasks (> 50ms) | 0 | 0 |

### Startup
| Metric | Target |
|--------|--------|
| Cold start → interactive | < 1.5s |
| First render | < 400ms |
| WebGPU device ready | < 200ms post-render |
| Sessions loaded from store | < 100ms |

### Build (Vite 8.0.0 stable — Rolldown)
| Metric | Target |
|--------|--------|
| Full production build | < 8s |
| Hot reload | < 80ms |
| TypeScript type check | < 5s |
| Biome check + format | < 400ms |
| Cargo incremental | < 4s |

---

## 📁 GITHUB DOCUMENTATION STANDARDS

### README.md Structure
```markdown
# SWARM Orchestrator

> Multi-agent AI orchestration — Tauri 2.10 · WebGPU · Rust 1.95 beta · React 19 Canary

[![CI](badge)](link) [![Rust](badge)](link) [![Node](badge)](link) [![Biome](badge)](link)

## Overview

[2–3 paragraphs — no bullet lists in first section]

## Quick Start
[3-step install]

## Stack

| Layer | Technology | Version |
[full table]

## Architecture
[ASCII diagram]

## Development
[dev setup]

## Building
[Win + Mac build commands]

## Contributing
[link to docs/contributing.md]

## License
MIT
```

### GitHub Wiki (6 Required Pages)
1. **Home** — overview + navigation to all wiki pages
2. **Architecture** — system diagram, IPC flow, Rust async model, WebGPU pipeline overview
3. **API Reference** — every Tauri command: parameters, return type, emitted events, errors
4. **Development Setup** — step-by-step: Rust beta install, Node 25.8.1, dev server, common errors
5. **Coding Standards** — patterns, anti-patterns, PR checklist (distilled from this CLAUDE.md)
6. **Performance Guide** — frame budget, profiling with Chrome DevTools + GPU inspector, optimization techniques

### Every .md File Rule Set
- H1: one per file, specific and descriptive
- Code blocks: always language-tagged (`typescript`, `rust`, `bash`, `toml`, `wgsl`, `css`)
- Tables: any comparison of 3+ items
- No single-sentence sections — minimum 2 sentences
- All links verified before commit
- ASCII diagrams for architecture, Mermaid for flows

### Rust Doc Comment Template
```rust
/// Brief one-line summary of what this does.
///
/// Extended description covering behavior, concurrency model,
/// and any non-obvious implementation details.
///
/// # Arguments
///
/// * `config` - Worker configuration including shell, dimensions, env
///
/// # Returns
///
/// The stable [`WorkerId`] for all subsequent references to this worker.
///
/// # Errors
///
/// - [`WorkerError::PtySpawn`] if PTY creation fails
/// - [`WorkerError::RegistryFull`] if max worker limit reached
///
/// # Panics
///
/// Does not panic. All error paths return `Err`.
///
/// # Example
///
/// ```rust
/// let id = registry.spawn(config).await?;
/// println!("Spawned: {id}");
/// ```
pub async fn spawn_worker(&self, config: WorkerConfig) -> anyhow::Result<WorkerId> {
```

### TypeScript JSDoc Template
```typescript
/**
 * Hook for managing xterm.js terminal lifecycle tied to a worker.
 *
 * @remarks
 * Initializes with WebGL2 renderer (WebglAddon).
 * Uses {@link useResizeObserver} from @crimson_dev/use-resize-observer
 * to trigger FitAddon on container resize.
 *
 * @param workerId - Stable worker identifier for PTY binding
 * @returns `terminalRef` — attach to container div element
 *
 * @example
 * ```tsx
 * const { terminalRef } = useTerminal(worker.id);
 * return <div ref={terminalRef} className="h-full" />;
 * ```
 */
export function useTerminal(workerId: string): {
  terminalRef: React.RefCallback<HTMLDivElement>;
}
```

---

## 🔍 CODE REVIEW CHECKLIST

Before any commit passes review:

### TypeScript / React
- [ ] Zero `any` types — use `unknown` and narrow properly
- [ ] Zero `forwardRef` — ref as prop directly (React 19)
- [ ] Zero manual `useMemo`/`useCallback` — React Compiler handles
- [ ] Zero class components — hooks only
- [ ] All type-only imports: `import type { X }` separate from value imports
- [ ] All colors in JSX: OKLCH strings if inline — never hex
- [ ] `import * as z from "zod/v4"` — never `from "zod"`
- [ ] All Tauri `listen()` calls cleaned up in `useEffect` return
- [ ] All async functions: explicit error handling (try/catch or .catch())
- [ ] Non-urgent state updates wrapped in `startTransition`
- [ ] Command palette uses `modern-cmdk` — never upstream `cmdk`
- [ ] ResizeObserver usage: `@crimson_dev/use-resize-observer` — never browser API directly

### Rust
- [ ] Zero `std::sync::Mutex` — `parking_lot::Mutex` everywhere
- [ ] Zero `.unwrap()` in non-test code — use `?` operator
- [ ] Zero blocking calls on Tokio async threads
- [ ] All `pub` functions: `///` doc comment
- [ ] All Tauri commands: `#[tracing::instrument(skip(...))]`
- [ ] CPU-parallel work: `rayon` — not `tokio::spawn` for compute
- [ ] Shared data: `Arc<T>` — not `.clone()` on large structs
- [ ] Errors: `anyhow` in app code, `thiserror` at lib boundaries

### CSS
- [ ] Zero hex colors — OKLCH only
- [ ] Zero `tailwind.config.js` (should never exist)
- [ ] Zero `@apply` — use `@layer components` or utility classes
- [ ] All transitions: `prefers-reduced-motion` handled
- [ ] Zero `!important` except `reset` layer
- [ ] All `@keyframes` in `animations.css`
- [ ] All `@property` typed custom properties declared

### Dependencies
- [ ] Zero `^` or `~` in versions — exact pins only
- [ ] `modern-cmdk@1.1.5` — not `cmdk`
- [ ] `@crimson_dev/use-resize-observer@1.0.0` — not `use-resize-observer`
- [ ] `@xterm/xterm@6.1.0-beta.193` — exactly this version

### Documentation
- [ ] CHANGELOG.md entry added (Keep a Changelog format)
- [ ] All new public APIs documented
- [ ] README updated if user-facing behavior changed

---

## ⛔ ABSOLUTELY FORBIDDEN PATTERNS

```
REACT / TYPESCRIPT:
✗ ReactDOM.render()               → createRoot() only
✗ forwardRef()                    → ref as prop (React 19)
✗ useMemo() / useCallback()      → React Compiler handles
✗ class components                → hooks only
✗ import from "cmdk"              → import from "modern-cmdk"
✗ import from "use-resize-observer" → @crimson_dev/use-resize-observer
✗ import from "zod"               → import from "zod/v4"
✗ new ResizeObserver(...)         → @crimson_dev/use-resize-observer hook
✗ #hexcolor / rgb() / hsl()      → oklch() only
✗ tailwind.config.js              → @theme in CSS
✗ require()                       → ESM only
✗ import type X, Y mixed          → separate type/value imports
✗ any type                        → unknown + narrowing
✗ process.env                     → Tauri store/config
✗ localStorage                    → plugin-store

RUST:
✗ std::sync::Mutex                → parking_lot::Mutex
✗ .unwrap() in app code           → ? operator
✗ thread::sleep()                 → tokio::time::sleep()
✗ block_in_place() on async       → spawn_blocking()
✗ large struct .clone()           → Arc<T>
✗ eprintln!() / println!()       → tracing::error! / tracing::info!

CSS:
✗ #hexcolor                       → oklch()
✗ rgb() / hsl()                   → oklch()
✗ !important (non-reset)          → fix specificity
✗ @apply                          → @layer components {}
✗ Arbitrary values (px)           → design token vars

BUILD:
✗ ^ or ~ version ranges           → exact pins
✗ minify: "esbuild"               → minify: "rolldown" (Vite 8)
✗ CommonJS output                 → ESM only
✗ modulePreload polyfill: true    → false (Chromium 146+)
```

---

## ✅ DEFINITION OF DONE

A version milestone is complete when ALL of the following pass:

1. `npm run build` — zero errors, zero warnings
2. `tsc --noEmit` — zero type errors
3. `biome check .` — zero lint errors, zero format warnings
4. `cargo build --release` — compiles clean
5. `cargo clippy -- -D warnings` — zero warnings
6. `cargo test` — all tests pass
7. `npm run tauri dev` — app opens correctly, zero console errors
8. All version-specific feature tests pass manually
9. Performance: frame time, startup, memory all within targets
10. CHANGELOG.md entry added
11. All new code has documentation comments
12. Commit: `feat(v0.X.Y): description` — conventional commits format

---

## 🏗️ SCAFFOLD COMMANDS

Run in order on a clean machine with Rust 1.95-beta and Node 25.8.1:

```bash
# Verify toolchain
rustup show                    # should show beta 1.95.0
node --version                 # v25.8.1
npm --version

# Create project
npm create tauri-app@latest swarm-orchestrator -- --template react-ts --manager npm
cd swarm-orchestrator

# Install all production deps — exact versions
npm install \
  react@19.3.0-canary-5e9eedb5-20260312 \
  react-dom@19.3.0-canary-5e9eedb5-20260312 \
  tailwindcss@4.2.1 \
  framer-motion@12.36.0 \
  gsap@3.14.2 \
  @xyflow/react@12.10.1 \
  elkjs@0.11.1 \
  zustand@5.0.11 \
  immer@11.1.4 \
  jotai@2.18.1 \
  recharts@3.8.0 \
  @anthropic-ai/sdk@0.78.0 \
  "zod@4.4.0-canary.20260125T215152" \
  modern-cmdk@1.1.5 \
  sonner@2.0.7 \
  vaul@1.1.2 \
  date-fns@4.1.0 \
  @crimson_dev/use-resize-observer@1.0.0 \
  @xterm/xterm@6.1.0-beta.193 \
  @xterm/addon-fit@0.12.0-beta.168 \
  @tauri-apps/plugin-fs@2.4.5 \
  @tauri-apps/plugin-dialog@2.6.0 \
  @tauri-apps/plugin-shell@2.3.5 \
  @tauri-apps/plugin-store@2.4.2

# Install dev deps — exact versions
npm install --save-dev \
  typescript@6.0.0-dev.20260313 \
  vite@8.0.0 \
  @biomejs/biome@2.4.6 \
  @tauri-apps/cli@2.10.1 \
  @webgpu/types@0.1.69

# Initialize Biome 2.4.6
./node_modules/.bin/biome init

# Verify
npm run tauri dev
```

---

*SWARM Orchestrator v2 — Claude Code Build Specification*
*Manifest Version: 2.0 | Updated: 2026-03-13*
*Node 25.8.1 · Vite 8.0.0 stable · React 19.3-canary-5e9eedb5 · TS 6.0-dev.20260313*
*modern-cmdk 1.1.5 · @crimson_dev/use-resize-observer 1.0.0 · xterm 6.1.0-beta.193*
*Biome 2.4.6 · Rust 1.95.0-beta · Tokio 1.50.0 · DashMap 7.0.0-rc2*

