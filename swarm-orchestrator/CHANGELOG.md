# Changelog

All notable changes to SWARM Orchestrator will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Conventional Commits](https://www.conventionalcommits.org/).

---

## [0.9.9] - 2026-03-16

### Changed
- Final integration verification pass across all 100+ files
- Pinned all Cargo.toml dependency versions exactly
- Removed CSP `unsafe-inline` from style-src
- Narrowed Tauri capability permissions
- Added Biome domain rules for React and test files
- Version bump to release candidate

### Fixed
- Fixed AbortSignal propagation through provider abstraction layer
- Fixed remaining floating promises and unstable useEffect dependencies

---

## [0.9.8] - 2026-03-16

### Security Audit
- Removed all manual `useMemo`/`useCallback` (112 instances) for React Compiler compliance
- Replaced `std::sync::Mutex` with `parking_lot::Mutex` throughout Rust backend
- Pinned all dependency versions exactly (zero ranges)
- Redacted API key from Debug/Serialize derives
- Added reqwest timeout configuration (120s request, 10s connect)
- Wrapped all blocking lifecycle functions in `spawn_blocking`
- Added `CancellationToken` with `tokio::select!` for metrics loop shutdown
- Added `JoinSet` for AI queue task lifecycle management
- Converted unbounded channels to bounded (PTY: 4096, AI queue: 256)
- Added `AbortSignal` propagation through streaming pipeline
- Removed all light mode CSS (dark-only mandate)
- Added virtualization to SessionList and FileTree
- Added search debouncing to LogFilter
- Replaced `globalThis.confirm` with Tauri native dialog
- Migrated `atomWithStorage` to Tauri plugin-store backend
- Created LICENSE (MIT) and SECURITY.md
- Fixed CHANGELOG formatting and milestone alignment
- Added frontend test step to CI workflow
- Barrel distortion chromatic aberration in WebGPU post-processing
- Async WebGPU pipeline creation

---

## [0.9.7] - 2026-03-14

### Added

- Comprehensive `///` doc comments on every public function, struct, enum, trait, and module across all 23 Rust source files
- Module-level `//!` documentation with architecture diagrams and data flow descriptions
- `# Arguments`, `# Returns`, `# Errors`, and `# Examples` sections following Rust doc conventions
- README.md complete rewrite with architecture diagram, tech stack table, project structure, and milestone status
- CHANGELOG.md documenting all milestones from 0.0.1 through 0.9.7
- `docs/architecture.md` -- system architecture deep dive
- `docs/api.md` -- Tauri IPC command reference with parameters, return types, errors, and examples
- `docs/contributing.md` -- development setup, code standards, commit conventions, and PR process

---

## [0.9.6] - 2026-03-14

### Added

- Cross-platform build verification (Windows, macOS ARM64, macOS x86_64)
- Platform-specific PTY shell defaults (PowerShell on Windows, bash on Unix)
- Target triples in `rust-toolchain.toml` (`x86_64-pc-windows-msvc`, `aarch64-apple-darwin`, `x86_64-apple-darwin`)

---

## [0.9.5] - 2026-03-14

### Changed

- Comprehensive error boundary coverage across all page shells
- Graceful degradation for WebGPU context loss with automatic recovery
- Retry logic hardening for AI streaming failures with exponential backoff
- PTY spawn error recovery with user-facing diagnostic messages

---

## [0.9.4] - 2026-03-14

### Added

- ARIA attributes for all interactive components
- `aria-hidden` on decorative WebGPU canvas
- Keyboard navigation support for command palette, graph controls, and context menus
- `prefers-reduced-motion` media query integration across all animations

---

## [0.9.3] - 2026-03-14

### Changed

- Memory optimization: eliminated unnecessary clones in worker registry iteration
- Reduced allocation pressure in PTY output bridge (4KB buffer with zero-copy forwarding)
- Session manager uses `DashMap::get()` with clone instead of full iteration where possible

---

## [0.9.2] - 2026-03-14

### Changed

- Startup time optimization: deferred AI client initialization to `setup` closure
- Lazy-loaded WebGPU device initialization with fallback detection
- Session restore runs synchronously in setup to avoid race conditions

---

## [0.9.1] - 2026-03-14

### Changed

- Vite 8 bundle optimization with Rolldown bundler
- Tree-shaking analysis via `VITE_BUNDLE_ANALYZE=true`
- Release profile: `lto = "fat"`, `codegen-units = 1`, `panic = "abort"`, `strip = "symbols"`

---

## [0.9.0] - 2026-03-14

### Changed

- Performance audit and optimization pass across frontend and backend
- Zustand `subscribeWithSelector` for minimal re-renders
- Jotai atoms with `atomWithStorage` for persistent UI state
- React 19 Compiler integration via `babel-plugin-react-compiler`
- Hash imports (`#components/*`, `#store/*`, `#lib/*`, etc.) for clean module resolution
- Recharts `isAnimationActive={false}` globally for render performance
- `tokio::task::spawn_blocking` for all rayon-based computations

---

## [0.8.x] - 2026-03-14

### Added

- Real-time metrics dashboard with CPU, memory, throughput, and AI queue charts
- MetricCard component with sparkline trend indicators
- CPUChart, MemoryChart, ThroughputChart, AIMetricsChart, AIQueueChart components using Recharts
- AlertRule system with configurable thresholds and notification channels
- PerformanceOverlay dev tool: React render count, Zustand selector count, GPU frame time (Ctrl+Shift+P toggle)
- Background metrics collection loop (500ms interval) with `spawn_blocking` for rayon
- `get_metrics` Tauri command for on-demand metrics snapshot
- System metrics event (`system:metrics`) with cpu, memory, worker count, and AI request rate

---

## [0.7.x] - 2026-03-14

### Added

- Session management system with DashMap-backed CRUD operations
- Persistent session storage via `tauri-plugin-store` (`sessions.json`)
- Auto-save on session create/delete with crash recovery on startup
- Session components: SessionList, SessionCard, SessionActions (export/import)
- HistorySearch component for filtering session history
- TemplateSelector for creating sessions from predefined templates
- Snapshot/restore functionality for workspace state
- Session export/import via JSON files with `tauri-plugin-dialog`

---

## [0.6.7] - 2026-03-14

### Added

- ParticleBackground conditional wrapper with WebGPU support detection
- `isWebGPUSupported()` gate, `themeAtom.particlesEnabled` toggle, and `reducedMotionAtom` respect
- Solid OKLCH background fallback (`oklch(0.06 0.02 220)`) when particles are disabled

---

## [0.6.x] - 2026-03-14

### Added

- WebGPU device initialization with adapter selection, context loss recovery, and graceful fallback (`lib/webgpu.ts`)
- GPU-driven particle compute pipeline: 64-workgroup WGSL compute shader for position/velocity update (`lib/particles.ts`)
- Instanced billboard render pipeline: WGSL vertex/fragment shaders with additive blending
- Post-processing pipeline: bloom, chromatic aberration, vignette via ping-pong framebuffers (`lib/postprocess.ts`)
- `useWebGPU` hook: device lifecycle, canvas resize handling, context loss recovery, reduced-motion integration
- `useParticleSync` hook: maps worker states to particle simulation parameters (delta hue, spawn rate, turbulence)
- ParticleCanvas component: fixed `z-index: 0` WebGPU canvas, `pointer-events: none`, `aria-hidden`
- All WGSL shaders use OKLCH-derived color calculations

---

## [0.5.x] - 2026-03-14

### Added

- AIChat component: full chat interface with message input, scroll-to-bottom, per-worker conversations
- AIMessageStream component: streaming AI response renderer with markdown code blocks, OKLCH syntax highlighting, cursor animation
- AIQueue component: visual queue display with position indicators, priority badges, estimated wait times, cancel functionality
- ModelSelector component: Claude opus/sonnet/haiku selector with context window, cost estimate, capability badges
- ToolCallDisplay component: animated accordion for tool name, input, and result with Framer Motion expand/collapse
- MessageHistory component: per-worker conversation history with virtualized list and IntersectionObserver
- WorkerAIPanel component: combined terminal + AI chat split view with tool execution routed through worker PTY
- AI error classification system with retry logic and rate-limit handling (`lib/ai-error.ts`)
- Swarm tool framework: Zod v4 schema-driven tool definitions with Anthropic API conversion (`lib/tools.ts`)
- Message history Zustand store with per-worker conversation persistence (`store/message-history.ts`)

---

## [0.4.x] - 2026-03-14

### Added

- WorkerGraph component: full interactive DAG topology with XYFlow ReactFlow, minimap, and background grid
- WorkerNode custom node: status-colored borders, sparkline badges, selection ring with OKLCH glow
- DependencyEdge custom edge: animated dash-flow SVG markers with OKLCH stroke
- GraphControls component: zoom/fit/reset controls with Framer Motion button animations
- GraphContextMenu component: right-click context menu for worker actions (restart, kill, inspect, detach)
- WorkerDetail panel: expanded worker info with uptime, message count, tool calls, error metrics
- WorkerCard component: per-worker stats card with inline Recharts sparklines
- WorkerAnalytics component: detailed per-worker analytics (messages/time, tool calls, error timeline) using Recharts
- WorkerTerminal component: xterm.js terminal with WebGL2 renderer per worker
- StatusBar component: fixed bottom bar with AI cost estimate, worker count, system status
- Shared Recharts OKLCH theme: axis props, grid props, tooltip styles, legend styles (`lib/chart-theme.ts`)
- Dedicated metrics chart components: CPUChart, MemoryChart, ThroughputChart, AIMetricsChart, AIQueueChart, MetricCard
- PerformanceOverlay dev tool: React render count, Zustand selector count, GPU frame time (Ctrl+Shift+P toggle)
- Session components: SessionList, SessionCard, SessionActions (export/import), HistorySearch, TemplateSelector
- All Recharts components use `isAnimationActive={false}` for performance

---

## [0.3.9] - 2026-03-14

### Added

- Command Palette component (`modern-cmdk`) with frecency-ranked sorting
- Graph components: WorkerNode, DependencyEdge, GraphControls (XYFlow + ELK)
- SplitPane resizable layout with persistent pane sizes via Jotai + `plugin-store`
- Drawer component wrapping vaul with snap points and OKLCH styling
- MetricsChart real-time dashboard using Recharts with OKLCH stroke colors
- AI streaming integration: `useAiStream` hook, Anthropic SDK async generator, Zod v4 tool schema conversion
- Worker lifecycle hooks: `useWorker` with React 19 `useOptimistic`, `useSpawnWorker`
- Session CRUD hooks: `useSession`, `useSessionActions` with IPC-backed operations
- ELK layout Web Worker with topology fingerprinting for diff-based re-layout
- JSON syntax highlighter with full OKLCH token palette

---

## [0.2.x] - 2026-03-14

### Added

- Tauri event system: typed `SwarmEvent` enum with `snake_case` type tags and `camelCase` payload fields
- Worker PTY bridge: `portable-pty` 0.9.0 spawn with Tokio mpsc output streaming
- Worker registry: `DashMap`-backed concurrent store with rayon aggregate metrics
- Worker lifecycle operations: spawn, pause, resume, kill with event emission
- Session manager: `DashMap`-backed CRUD with persistent store via `tauri-plugin-store`
- AI client: `reqwest`-based Anthropic Messages API with SSE streaming
- AI priority queue: `BinaryHeap` with `Semaphore`-based concurrency limiting (default: 3 concurrent)
- Metrics collection loop: 500ms interval with `spawn_blocking` for rayon
- Structured tracing: JSON output in release, pretty output in debug, `RUST_LOG` env override
- Error system: `thiserror` 2.0.18 with custom `Serialize` impl for IPC transport (10 error variants)
- Application entry point: Tokio multi-thread runtime scaled to CPU cores

---

## [0.1.x] - 2026-03-13

### Added

- OKLCH design token system with `@theme`, `@utility`, `@variant` blocks
- CSS `@property` typed custom properties for GPU-accelerated animations
- Reduced motion media query with universal animation/transition override
- Component CSS: buttons, inputs, badges, scroll areas, command palette
- Animation keyframes: pulse-ring, glow-breathe, dash-flow, scan-line, shimmer, spinner
- Zustand 5 stores: workers, sessions, AI queue, system metrics (all with `subscribeWithSelector` + immer)
- Jotai atoms: UI state, frecency scoring, theme persistence
- Zod v4 schemas: Worker, Session, MetricPoint, SystemMetrics, AiMessage, AiQueueItem
- `useTauri` hooks: `useInvoke`, `useListen` with proper cleanup
- `useTheme` hook: `prefers-reduced-motion` media query sync
- `useTerminal` hook: xterm.js with WebGL2 renderer, FitAddon, resize observer integration
- Tauri IPC wrapper: typed `invoke`/`listen` functions for all backend commands
- File system utilities: atomic write pattern, scoped read/write, JSON helpers
- Test utilities: mock invoke/listen, mock event emitter, mock worker store
- UI components: Button (ref as prop), Badge, Input, ScrollArea, Spinner, Toast (Sonner), ErrorBoundary
- Layout components: AppShell (CSS Grid + GSAP startup), Sidebar, Topbar
- Page shells: Dashboard, Workers, Sessions, Metrics, Settings

---

## [0.0.1] - 2026-03-13

### Added

- Initial project scaffold with Tauri 2.10, React 19 canary, TypeScript 6.0-dev
- Complete dependency manifest with exact pinned versions
- Vite 8.0.0 stable build configuration with Rolldown bundler
- Biome 2.4.6 linting and formatting configuration
- Rust 1.95.0-beta workspace with all crate dependencies
- OKLCH-based CSS architecture with Tailwind CSS 4.2.1
- Zustand 5, Jotai 2.18.1, and Zod v4 state management setup
- Rust module skeleton with DashMap worker registry
- CI/CD workflows for lint, build, release, and dependency auditing
- Cosmic Nexus application icon at multiple resolutions
