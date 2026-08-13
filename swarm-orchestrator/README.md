<p align="center">
  <img src="level-101-cosmic-nexus.svg" alt="SWARM Orchestrator" width="120" />
</p>

<h1 align="center">SWARM Orchestrator</h1>

<p align="center">
  <strong>Multi-agent AI orchestration desktop application</strong><br />
  Real-time topology visualization, integrated terminals, streaming AI, and WebGPU effects
</p>

<p align="center">
  <a href="https://github.com/crimson-dev/swarm-orchestrator/actions/workflows/ci.yml"><img src="https://github.com/crimson-dev/swarm-orchestrator/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <img src="https://img.shields.io/badge/version-0.10.0-blue" alt="Version 0.10.0" />
  <img src="https://img.shields.io/badge/rust-1.98.0--beta-orange" alt="Rust 1.98.0-beta" />
  <img src="https://img.shields.io/badge/node-26.5.0-green" alt="Node 26.5.0" />
  <img src="https://img.shields.io/badge/pnpm-11.11.0-orange" alt="pnpm 11.11.0" />
  <img src="https://img.shields.io/badge/biome-2.5.3-blue" alt="Biome 2.5.3" />
  <img src="https://img.shields.io/badge/license-MIT-brightgreen" alt="License MIT" />
</p>

---

## Overview

SWARM Orchestrator is a high-performance desktop application for managing and orchestrating multiple parallel AI worker agents. Built on Tauri 2.11, it pairs a Rust backend with a React 19 frontend to deliver sub-frame latency across every interaction.

**Key capabilities:**

- **Multi-agent orchestration** -- Spawn, pause, resume, and kill worker agents with real-time state tracking across a concurrent registry supporting up to 64 simultaneous workers
- **Interactive topology graph** -- Visualize workers using XYFlow + ELK layout, connected by animated "Spawn Order" edges (the order workers were added, not a dependency graph -- see the graph's own legend), with sparkline badges and context menus
- **Integrated terminal per worker** -- Each worker runs in its own PTY with @xterm/xterm (WebGL2 renderer), bridged to Tokio via non-blocking mpsc channels
- **Streaming AI responses** -- `@anthropic-ai/sdk` streams directly from the webview to the Anthropic Messages API (SSE), gated by a frontend priority queue and concurrency limit (`useAiStore`), with an agentic tool-use loop. (Rust also ships an `ai_request`/`AiQueue`/SSE-parser path with the same shape -- it has no frontend caller yet; see [Built, Not Wired](docs/architecture.md#built-not-wired).)
- **Per-worker AI chat** -- `WorkerAIPanel` mounts a combined terminal + AI chat split view on the Workers page, with tool execution routed through the worker's PTY
- **Inter-agent message bus** -- Direct, broadcast, and pipeline routing between workers with a unified single-delivery event contract
- **Real-time metrics dashboard** -- CPU, memory, throughput, and AI queue metrics displayed via Recharts with 500ms refresh, a `perWorker` process breakdown, and a performance overlay
- **WebGPU particle system** -- GPU-driven compute shaders, instanced billboard rendering, and post-processing (bloom, chromatic aberration, vignette)
- **Persistent sessions** -- Create, restore, and export workspace sessions with crash recovery via `tauri-plugin-store`
- **Auto-updates & native notifications** -- Signed update checks via `tauri-plugin-updater` and OS notifications via `tauri-plugin-notification`
- **OKLCH color system** -- Every visual element derives from the OKLCH perceptual color space for consistent, balanced aesthetics
- **Keyboard-first navigation** -- Frecency-ranked command palette via `modern-cmdk` for power users

---

## Architecture

```text
                        SWARM Orchestrator
 ┌─────────────────────────────────────────────────────────────┐
 │                       Tauri Window                          │
 ├────────────┬────────────────────────────────────────────────┤
 │            │              React 19 + Compiler               │
 │  Sidebar   │  ┌──────────────────────────────────────────┐ │
 │            │  │  TopologyGraph (XYFlow + ELK Layout)     │ │
 │  Nav       │  │  ┌───────┐  ┌───────┐  ┌───────┐       │ │
 │  Items     │  │  │ W-0   │──│ W-1   │──│ W-2   │       │ │
 │            │  │  │running│  │paused │  │idle   │       │ │
 │  Command   │  │  └───────┘  └───────┘  └───────┘       │ │
 │  Palette   │  └──────────────────────────────────────────┘ │
 │  (cmdk)    │  ┌───────────────┬─────────────────────────┐ │
 │            │  │  Terminal     │  AI Message Stream      │ │
 │            │  │  (xterm.js)   │  (Anthropic SSE)        │ │
 │            │  └───────────────┴─────────────────────────┘ │
 ├────────────┴────────────────────────────────────────────────┤
 │                     WebGPU Canvas                           │
 │          Compute Shaders ─> Render ─> Post-Processing       │
 ├─────────────────────────────────────────────────────────────┤
 │                 Tauri IPC (invoke / listen)                  │
 ├─────────────────────────────────────────────────────────────┤
 │                      Rust Backend                           │
 │  ┌──────────────┬───────────┬───────────┬──────────────┐   │
 │  │ WorkerReg    │ PTY       │ AI Client │ Sessions     │   │
 │  │ (DashMap)    │ Bridge    │ (reqwest) │ (Store)      │   │
 │  │ + sysinfo    │ (portable │ + Queue   │ + DashMap    │   │
 │  │   metrics    │  -pty)    │ + Stream  │ + persist    │   │
 │  └──────────────┴───────────┴───────────┴──────────────┘   │
 │                Tokio Multi-Thread Runtime                    │
 │              (CPU-scaled worker threads)                     │
 └─────────────────────────────────────────────────────────────┘
```

> The Rust Backend's "AI Client (reqwest) + Queue + Stream" is real, tested code -- but it is **built, not wired**: no frontend caller invokes it today. The live "AI Message Stream" shown above actually runs `@anthropic-ai/sdk` directly in the webview and streams straight to `api.anthropic.com`, bypassing Rust entirely except for one `read_config` call for the API key. See [docs/architecture.md#ai-streaming](docs/architecture.md#ai-streaming) for the real flow and [docs/architecture.md#built-not-wired](docs/architecture.md#built-not-wired) for what else is in this position.

For detailed architecture documentation, see [docs/architecture.md](docs/architecture.md).

---

## Tech Stack

| Layer              | Technology                  | Version                                        |
|--------------------|-----------------------------|-------------------------------------------------|
| Desktop Shell      | Tauri                       | 2.11.5 (CLI 2.11.4)                             |
| Frontend           | React                       | 19.3.0-canary-5123b063-20260708                 |
| Language (TS)      | TypeScript                  | 7.0.2 (native compiler)                         |
| Styling            | Tailwind CSS                | 4.3.2                                            |
| Build Tool         | Vite (Rolldown)             | 8.1.4 (oxc minify, advancedChunks)              |
| Compiler Pipeline  | @vitejs/plugin-react + @rolldown/plugin-babel | 6.0.3 / 0.2.3 (`reactCompilerPreset`) |
| React Compiler     | babel-plugin-react-compiler | 1.0.0                                            |
| Test Runner        | Vitest                      | 4.1.10                                           |
| Linting/Formatting | Biome                       | 2.5.3                                            |
| Backend            | Rust                        | 1.98.0-beta                                      |
| Async Runtime      | Tokio                       | 1.52.3                                           |
| Concurrency        | DashMap + parking_lot       | 7.0.0-rc2 / 0.12.5                              |
| State (Global)     | Zustand + Immer             | 5.0.14 / 11.1.11                                |
| State (Local)      | Jotai                       | 2.20.1                                           |
| Validation         | Zod v4                      | 4.5.0-canary.20260504T180558                     |
| AI                 | Anthropic SDK + reqwest      | 0.110.0 / 0.13.4                                |
| Graph              | XYFlow + ELK                | 12.11.2 / 0.11.1                                |
| Terminal           | @xterm/xterm                | 6.1.0-beta.288                                   |
| PTY                | portable-pty                | 0.9.0                                            |
| Animation          | motion + GSAP               | 12.42.2 / 3.15.0                                |
| Charts             | Recharts                    | 3.9.2                                            |
| GPU                | WebGPU (WGSL)               | ---                                               |
| Error Handling     | thiserror + anyhow          | 2.0.18 / 1.0.103                                |
| Logging            | tracing + tracing-subscriber| 0.1.44 / 0.3.23                                 |
| Sysinfo            | sysinfo                     | 0.39.6                                           |
| Package Manager    | pnpm                        | 11.11.0                                          |

> `framer-motion` was renamed upstream to `motion` -- there is no `framer-motion` dependency in this project. `rayon` was removed from `Cargo.toml` (it was unused; the 64-worker cap makes sequential aggregation cheaper than parallel dispatch overhead).

---

## Quick Start

### Prerequisites

| Tool      | Version        | Install                                                    |
|-----------|----------------|------------------------------------------------------------|
| Node.js   | 26.5.0         | [nodejs.org](https://nodejs.org)                           |
| pnpm      | 11.11.0        | `corepack enable` or [pnpm.io](https://pnpm.io) (pinned via `packageManager` in `package.json`) |
| Rust      | 1.98.0-beta    | `rustup` (auto-configured via `rust-toolchain.toml`)       |

### Setup

```bash
# Clone the repository
git clone https://github.com/crimson-dev/swarm-orchestrator.git
cd swarm-orchestrator

# Install frontend dependencies
pnpm install

# Start development server (builds Rust + launches Tauri)
pnpm tauri:dev
```

### Build for Production

```bash
# Type-check, bundle, and compile the desktop application
pnpm tauri:build
```

The compiled binary will be in `src-tauri/target/release/`.

Tagged releases (`v*`) build signed installers for Windows, macOS (Intel + Apple Silicon), and Linux (`.deb` + `.AppImage`) via `.github/workflows/release.yml`. **Linux updater caveat:** `tauri-plugin-updater` only supports self-applying updates through the `.AppImage` bundle — a `.deb` install will report an available update via `check_for_updates` but cannot apply it in-place; see `src-tauri/UPDATER_KEYS.md` for details.

---

## Project Structure

```text
swarm-orchestrator/
├── src/                          # React frontend
│   ├── components/               # UI components (Button, Badge, Toast, WorkerAIPanel, etc.)
│   ├── hooks/                    # React hooks (useInvoke, useListen, useTheme, etc.)
│   ├── lib/                      # Utility libraries (ai-error, tools, chart-theme, webgpu, models.ts)
│   ├── pages/                    # Page shells (Dashboard, Workers, Sessions, Metrics)
│   ├── store/                    # Zustand stores (workers, sessions, AI queue, metrics)
│   ├── styles/                   # OKLCH design tokens, CSS animations, component styles
│   ├── workers/                  # Web Workers (ELK layout)
│   ├── App.tsx                   # Root application component
│   └── main.tsx                  # React entry point
├── src-tauri/                    # Rust backend
│   ├── src/
│   │   ├── ai/                   # AI client, priority queue, SSE stream parser
│   │   │   ├── client.rs         # Anthropic API client with streaming
│   │   │   ├── queue.rs          # Priority queue with concurrency limiting
│   │   │   └── stream.rs         # SSE event parser
│   │   ├── bus/                  # Inter-agent message bus
│   │   │   ├── channel.rs        # MessageBus (per-topic broadcast channels)
│   │   │   └── router.rs         # Direct / broadcast / pipeline routing
│   │   ├── commands/             # Tauri IPC command handlers
│   │   │   ├── worker.rs         # spawn, pause, resume, kill, list, input
│   │   │   ├── session.rs        # create, delete, list, get, session_add_worker
│   │   │   ├── ai.rs             # ai_request
│   │   │   ├── bus.rs            # bus_send, bus_subscribe, bus_create_pipeline, bus_list_channels, bus_list_pipelines
│   │   │   ├── metrics.rs        # get_metrics (incl. perWorker) + background loop
│   │   │   ├── updater.rs        # check_for_updates
│   │   │   ├── notification.rs   # send_notification
│   │   │   └── fs.rs             # Filesystem (delegates to plugin)
│   │   ├── events/               # Typed event emission system
│   │   │   └── emitter.rs        # SwarmEvent enum + emit_event()
│   │   ├── session/              # Session management
│   │   │   ├── manager.rs        # DashMap-backed CRUD
│   │   │   └── store.rs          # Persistence via tauri-plugin-store
│   │   ├── worker/               # Worker management
│   │   │   ├── handle.rs         # WorkerHandle, WorkerState, WorkerConfig
│   │   │   ├── lifecycle.rs      # Spawn, pause, resume, kill operations
│   │   │   ├── pty.rs            # PTY spawning and I/O bridge
│   │   │   └── registry.rs       # DashMap registry, TOCTOU-safe update_state_if, aggregate metrics
│   │   ├── error.rs              # AppError enum (thiserror + Serialize)
│   │   ├── lib.rs                # Tauri app builder and setup
│   │   └── main.rs               # Binary entry point (Tokio runtime)
│   ├── icons/                    # Application icons
│   ├── capabilities/             # Tauri capability/permission definitions
│   ├── Cargo.toml                # Rust dependencies
│   ├── UPDATER_KEYS.md           # Update-signing key setup notes
│   └── tauri.conf.json           # Tauri configuration
├── docs/                         # Documentation
│   ├── architecture.md           # System architecture deep dive
│   ├── api.md                    # Tauri IPC command reference
│   ├── performance.md            # Performance targets and budgets
│   └── contributing.md           # Development and contribution guide
├── vite.config.ts                # Vite 8 + Rolldown configuration
├── biome.json                    # Biome linter/formatter config
├── rust-toolchain.toml           # Rust toolchain pinning
├── tsconfig.json                 # TypeScript config (app)
├── tsconfig.worker.json          # TypeScript config (src/workers, checked separately)
├── package.json                  # Frontend dependencies and scripts
├── CHANGELOG.md                  # Release history (all milestones)
└── README.md                     # This file
```

---

## Development

### Available Scripts

| Command                | Description                                      |
|------------------------|--------------------------------------------------|
| `pnpm tauri:dev`       | Start Tauri dev server (hot-reload frontend + Rust) |
| `pnpm tauri:build`     | Build production desktop binary                  |
| `pnpm dev`             | Vite dev server only (no Tauri)                  |
| `pnpm build`           | Type-check both tsconfig projects + Vite production build |
| `pnpm typecheck`       | Type-check both tsconfig projects (app + `tsconfig.worker.json`), no emit |
| `pnpm check`           | Biome lint + format (auto-fix)                   |
| `pnpm lint`            | Biome lint only                                  |
| `pnpm format`          | Biome format only                                |
| `pnpm test`            | Run unit tests via Vitest                        |
| `pnpm test:watch`      | Run tests in watch mode                          |
| `pnpm test:e2e`        | Run end-to-end tests via Playwright              |
| `pnpm test:coverage`   | Run tests with coverage report                   |
| `pnpm analyze`         | Bundle analysis via `rollup-plugin-visualizer` (`vite build --mode analyze`) |

> `pnpm build` and `pnpm typecheck` both run `tsc --noEmit` against the root `tsconfig.json` **and** `tsc -p tsconfig.worker.json --noEmit` against `src/workers/` -- two separate TypeScript projects, checked separately.

### Rust Development

```bash
cd src-tauri

# Lint with all warnings as errors
cargo clippy -- -D warnings

# Run unit tests
cargo test

# Format code
cargo fmt
```

### Code Quality Gates

- **TypeScript:** `pnpm typecheck` (strict mode, no emit, two tsconfig projects)
- **Biome:** Enforces formatting and linting rules (`src/styles/tokens.css` is excluded -- see [docs/contributing.md](docs/contributing.md))
- **Clippy:** `-D warnings` (zero tolerance for warnings)
- **Tests:** 61 Rust unit tests + 15 doc-tests, and 400 frontend tests across 40 test files

---

## Milestone Status

| Milestone | Description                                           | Status |
|-----------|-------------------------------------------------------|--------|
| 0.0.1     | Project scaffolding, Tauri + React + Rust setup       | Done   |
| 0.1.x     | Core architecture, stores, hooks, CSS, layout         | Done   |
| 0.2.x     | Worker management, PTY integration, event system      | Done   |
| 0.3.x     | AI integration, streaming, tool use, command palette  | Done   |
| 0.4.x     | Graph visualization, ELK layout, metrics charts       | Done   |
| 0.5.x     | AI chat interface, message history, model selector    | Done   |
| 0.6.x     | WebGPU particles, compute shaders, post-processing   | Done   |
| 0.7.x     | Sessions, snapshots, templates, export                | Done   |
| 0.8.x     | Metrics dashboard, charts, alerts, performance        | Done   |
| 0.9.0-6   | Performance, bundle, startup, memory, accessibility   | Done   |
| 0.9.7     | Documentation pass (Rust docs, README, CHANGELOG)     | Done   |
| 0.9.8     | Security audit (API keys, CSP, permissions, audit)    | Done   |
| 0.9.9     | Release candidate (final verification, version bump)  | Done   |
| 0.10.0    | Evergreen modernization pass (July 2026)              | Done   |

See [CHANGELOG.md](CHANGELOG.md) for detailed release notes per milestone.

---

## API Reference

Full IPC command documentation is available at [docs/api.md](docs/api.md).

> `ai_request` and the five `bus_*` commands below are implemented and tested but have no frontend caller in the shipped app -- see [Built, Not Wired](docs/architecture.md#built-not-wired).

**Commands at a glance:**

| Command                | Category     | Description                                   |
|------------------------|---------------|------------------------------------------------|
| `spawn_worker`         | Worker        | Create a new worker with PTY                   |
| `pause_worker`         | Worker        | Pause a running worker                          |
| `resume_worker`        | Worker        | Resume a paused worker                          |
| `kill_worker`          | Worker        | Terminate and remove a worker                   |
| `list_workers`         | Worker        | List all active workers                         |
| `worker_input`         | Worker        | Send input to a worker's PTY                    |
| `create_session`       | Session       | Create a new session                            |
| `delete_session`       | Session       | Delete a session                                |
| `list_sessions`        | Session       | List all sessions                               |
| `get_session`          | Session       | Get a session by ID                             |
| `session_add_worker`   | Session       | Register a worker against a session             |
| `ai_request`           | AI            | Enqueue an AI streaming request                 |
| `get_metrics`          | Metrics       | Get current system metrics snapshot (incl. `perWorker`) |
| `bus_send`             | Bus           | Send a direct or broadcast message between workers |
| `bus_subscribe`        | Bus           | Subscribe to a topic and stream messages as events |
| `bus_create_pipeline`  | Bus           | Create a multi-stage message processing pipeline |
| `bus_list_channels`    | Bus           | List all active message bus topic channels      |
| `bus_list_pipelines`   | Bus           | List all registered pipelines                   |
| `check_for_updates`    | Updater       | Check for an available application update       |
| `send_notification`    | Notification  | Send a native OS notification                   |

---

## Contributing

See [docs/contributing.md](docs/contributing.md) for development setup, code standards, commit conventions, and PR process.

---

## License

MIT
