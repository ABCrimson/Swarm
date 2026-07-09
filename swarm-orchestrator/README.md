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
  <img src="https://img.shields.io/badge/version-0.9.9-blue" alt="Version 0.9.9" />
  <img src="https://img.shields.io/badge/rust-1.95--beta-orange" alt="Rust 1.95-beta" />
  <img src="https://img.shields.io/badge/node-25.8.1-green" alt="Node 25.8.1" />
  <img src="https://img.shields.io/badge/biome-2.4.6-blue" alt="Biome 2.4.6" />
  <img src="https://img.shields.io/badge/license-MIT-brightgreen" alt="License MIT" />
</p>

---

## Overview

SWARM Orchestrator is a high-performance desktop application for managing and orchestrating multiple parallel AI worker agents. Built on Tauri 2.10, it pairs a Rust backend with a React 19 frontend to deliver sub-frame latency across every interaction.

**Key capabilities:**

- **Multi-agent orchestration** -- Spawn, pause, resume, and kill worker agents with real-time state tracking across a concurrent registry supporting up to 64 simultaneous workers
- **Interactive topology graph** -- Visualize worker relationships as a directed acyclic graph (DAG) using XYFlow + ELK layout with animated edges, sparkline badges, and context menus
- **Integrated terminal per worker** -- Each worker runs in its own PTY with @xterm/xterm (WebGL2 renderer), bridged to Tokio via non-blocking mpsc channels
- **Streaming AI responses** -- Anthropic Claude API integration with SSE streaming, priority queue with semaphore-based concurrency limiting, and tool-use capabilities
- **Real-time metrics dashboard** -- CPU, memory, throughput, and AI queue metrics displayed via Recharts with 500ms refresh and performance overlay
- **WebGPU particle system** -- GPU-driven compute shaders, instanced billboard rendering, and post-processing (bloom, chromatic aberration, vignette)
- **Persistent sessions** -- Create, restore, and export workspace sessions with crash recovery via `tauri-plugin-store`
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
 │  │ + rayon      │ (portable │ + Queue   │ + DashMap    │   │
 │  │   metrics    │  -pty)    │ + Stream  │ + persist    │   │
 │  └──────────────┴───────────┴───────────┴──────────────┘   │
 │                Tokio Multi-Thread Runtime                    │
 │              (CPU-scaled worker threads)                     │
 └─────────────────────────────────────────────────────────────┘
```

For detailed architecture documentation, see [docs/architecture.md](docs/architecture.md).

---

## Tech Stack

| Layer              | Technology                  | Version                       |
|--------------------|-----------------------------|-------------------------------|
| Desktop Shell      | Tauri                       | 2.10                          |
| Frontend           | React                       | 19.3.0-canary                 |
| Language (TS)      | TypeScript                  | 6.0.0-dev                     |
| Styling            | Tailwind CSS                | 4.2.1                         |
| Build Tool         | Vite (Rolldown)             | 8.0.0                         |
| Linting/Formatting | Biome                       | 2.4.6                         |
| Backend            | Rust                        | 1.95.0-beta                   |
| Async Runtime      | Tokio                       | 1.50.0                        |
| Concurrency        | DashMap + parking_lot       | 7.0.0-rc2 / 0.12.5           |
| Parallelism        | rayon                       | 1.11.0                        |
| State (Global)     | Zustand + Immer             | 5.0.11 / 11.1.4              |
| State (Local)      | Jotai                       | 2.18.1                        |
| Validation         | Zod v4                      | canary                        |
| AI                 | Anthropic SDK + reqwest      | 0.78.0 / 0.13.2              |
| Graph              | XYFlow + ELK                | 12.10.1 / 0.11.1             |
| Terminal           | @xterm/xterm                | 6.1.0-beta                    |
| PTY                | portable-pty                | 0.9.0                         |
| Animation          | Framer Motion + GSAP        | 12.36.0 / 3.14.2             |
| Charts             | Recharts                    | 3.8.0                         |
| GPU                | WebGPU (WGSL)               | ---                            |
| Error Handling     | thiserror + anyhow          | 2.0.18 / 1.0.102             |
| Logging            | tracing + tracing-subscriber| 0.1.44 / 0.3                  |

---

## Quick Start

### Prerequisites

| Tool      | Version        | Install                                                    |
|-----------|----------------|------------------------------------------------------------|
| Node.js   | 25.8.1         | [nodejs.org](https://nodejs.org)                           |
| Rust      | 1.95.0-beta    | `rustup` (auto-configured via `rust-toolchain.toml`)       |
| npm       | latest          | Bundled with Node.js                                       |

### Setup

```bash
# Clone the repository
git clone https://github.com/crimson-dev/swarm-orchestrator.git
cd swarm-orchestrator

# Install frontend dependencies
npm install

# Start development server (builds Rust + launches Tauri)
npm run tauri:dev
```

### Build for Production

```bash
# Type-check, bundle, and compile the desktop application
npm run tauri:build
```

The compiled binary will be in `src-tauri/target/release/`.

---

## Project Structure

```text
swarm-orchestrator/
├── src/                          # React frontend
│   ├── components/               # UI components (Button, Badge, Toast, etc.)
│   ├── hooks/                    # React hooks (useInvoke, useListen, useTheme, etc.)
│   ├── lib/                      # Utility libraries (ai-error, tools, chart-theme, webgpu)
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
│   │   ├── commands/             # Tauri IPC command handlers
│   │   │   ├── worker.rs         # spawn, pause, resume, kill, list, input
│   │   │   ├── session.rs        # create, delete, list, get
│   │   │   ├── ai.rs             # ai_request
│   │   │   ├── metrics.rs        # get_metrics + background loop
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
│   │   │   └── registry.rs       # DashMap registry + rayon metrics
│   │   ├── error.rs              # AppError enum (thiserror + Serialize)
│   │   ├── lib.rs                # Tauri app builder and setup
│   │   └── main.rs               # Binary entry point (Tokio runtime)
│   ├── icons/                    # Application icons
│   ├── Cargo.toml                # Rust dependencies
│   └── tauri.conf.json           # Tauri configuration
├── docs/                         # Documentation
│   ├── architecture.md           # System architecture deep dive
│   ├── api.md                    # Tauri IPC command reference
│   └── contributing.md           # Development and contribution guide
├── vite.config.ts                # Vite 8 + Rolldown configuration
├── biome.json                    # Biome linter/formatter config
├── rust-toolchain.toml           # Rust toolchain pinning
├── package.json                  # Frontend dependencies and scripts
├── CHANGELOG.md                  # Release history (all milestones)
└── README.md                     # This file
```

---

## Development

### Available Scripts

| Command                | Description                                      |
|------------------------|--------------------------------------------------|
| `npm run tauri:dev`    | Start Tauri dev server (hot-reload frontend + Rust) |
| `npm run tauri:build`  | Build production desktop binary                  |
| `npm run dev`          | Vite dev server only (no Tauri)                  |
| `npm run build`        | Type-check + Vite production build               |
| `npm run check`        | Biome lint + format (auto-fix)                   |
| `npm run lint`         | Biome lint only                                  |
| `npm run format`       | Biome format only                                |
| `npm run test`          | Run unit tests via Vitest                        |
| `npm run test:watch`    | Run tests in watch mode                          |
| `npm run test:e2e`      | Run end-to-end tests via Playwright              |
| `npm run test:coverage` | Run tests with coverage report                   |
| `npm run analyze`       | Bundle analysis via `rollup-plugin-visualizer`   |

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

- **TypeScript:** `npx tsc --noEmit` (strict mode, no emit)
- **Biome 2.4.6:** Enforces formatting and linting rules
- **Clippy:** `-D warnings` (zero tolerance for warnings)
- **Tests:** 28 unit tests + 12 doc-tests in the Rust backend

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

See [CHANGELOG.md](CHANGELOG.md) for detailed release notes per milestone.

---

## API Reference

Full IPC command documentation is available at [docs/api.md](docs/api.md).

**Commands at a glance:**

| Command          | Category | Description                          |
|------------------|----------|--------------------------------------|
| `spawn_worker`   | Worker   | Create a new worker with PTY         |
| `pause_worker`   | Worker   | Pause a running worker               |
| `resume_worker`  | Worker   | Resume a paused worker               |
| `kill_worker`    | Worker   | Terminate and remove a worker        |
| `list_workers`   | Worker   | List all active workers              |
| `worker_input`   | Worker   | Send input to a worker's PTY         |
| `create_session` | Session  | Create a new session                 |
| `delete_session` | Session  | Delete a session                     |
| `list_sessions`  | Session  | List all sessions                    |
| `get_session`    | Session  | Get a session by ID                  |
| `ai_request`     | AI       | Enqueue an AI streaming request      |
| `get_metrics`    | Metrics  | Get current system metrics snapshot  |

---

## Contributing

See [docs/contributing.md](docs/contributing.md) for development setup, code standards, commit conventions, and PR process.

---

## License

MIT
