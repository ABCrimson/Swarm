# Contributing

> Development setup, code standards, and contribution guidelines for SWARM Orchestrator.

---

## Table of Contents

- [Development Setup](#development-setup)
- [Code Standards](#code-standards)
- [Architecture Decisions](#architecture-decisions)
- [Commit Conventions](#commit-conventions)
- [Pull Request Process](#pull-request-process)
- [Testing](#testing)

---

## Development Setup

### Prerequisites

| Tool      | Version        | Purpose                              |
|-----------|----------------|--------------------------------------|
| Node.js   | 26.8.1         | Frontend build and dev server        |
| pnpm      | 12.0.0        | Package management (pinned via `packageManager` in `package.json`; npm is not used in this project) |
| Rust      | nightly-2026-08-27 | Backend compilation              |

### Rust Toolchain

The Rust toolchain is automatically configured by `rust-toolchain.toml`:

```toml
[toolchain]
channel    = "nightly-2026-08-27"
profile    = "minimal"
components = ["rustfmt", "clippy", "rust-src", "rust-analyzer"]
targets    = [
  "x86_64-pc-windows-msvc",
  "aarch64-apple-darwin",
  "x86_64-apple-darwin"
]
```

Running any `cargo` command in the project will auto-install the correct toolchain.

### First-Time Setup

```bash
# Clone the repository
git clone https://github.com/ABCrimson/Swarm.git
cd Swarm

# Install frontend dependencies
pnpm install

# Verify Rust toolchain
cd src-tauri
cargo check
cd ..

# Start the dev server
pnpm tauri:dev
```

### Editor Setup

**VS Code recommended extensions:**

- `rust-analyzer` -- Rust language server
- `biomejs.biome` -- Biome formatter/linter
- `Tailwind CSS IntelliSense` -- Tailwind autocomplete
- `tauri-apps.tauri-vscode` -- Tauri helpers

**Settings:**

```json
{
  "editor.defaultFormatter": "biomejs.biome",
  "editor.formatOnSave": true,
  "[rust]": {
    "editor.defaultFormatter": "rust-lang.rust-analyzer"
  }
}
```

---

## Code Standards

### TypeScript / React

**Formatter/Linter:** Biome 2.5.10

```bash
# Lint + format (auto-fix)
pnpm check

# Lint only
pnpm lint

# Format only
pnpm format
```

> [!WARNING]
> **Exclusion note:** `src/styles/tokens.css` is excluded from Biome's `files.includes` (`biome.json`). Biome's CSS parser does not yet support the `@function` at-rule syntax used in that file for OKLCH token derivation, so it is formatted/linted by hand until upstream support lands. Do not remove the exclusion without first confirming Biome's CSS parser handles `@function`.

**Import style:** Use hash imports exclusively.

```typescript
// Correct
import { Button } from "#components/ui/Button";
import { useWorker } from "#hooks/useWorker";
import { useWorkerStore } from "#store/workers";

// Incorrect
import { Button } from "../../components/ui/Button";
import { Button } from "@/components/ui/Button";
```

**React patterns:**

- React 19 canary with React Compiler -- no manual `useMemo`, `useCallback`, or `React.memo`
- `ref` as a regular prop (React 19 pattern), not `forwardRef`
- `useOptimistic` for optimistic UI updates
- Zustand `subscribeWithSelector` for store subscriptions
- Jotai atoms for ephemeral UI state (not domain state)

**Color system:** OKLCH only. Never use `rgb()`, `hsl()`, `hex`, or named colors.

```css
/* Correct */
color: oklch(0.85 0.15 220);
background: oklch(0.12 0.02 220 / 0.8);

/* Incorrect */
color: #3b82f6;
color: rgb(59, 130, 246);
color: hsl(217, 91%, 60%);
```

### Rust

**Formatter:** `cargo fmt`

**Linter:** `cargo clippy -- -D warnings` (zero tolerance for warnings)

```bash
cd src-tauri

# Format
cargo fmt

# Lint
cargo clippy -- -D warnings

# Test
cargo test
```

**Documentation:** Every public item must have `///` doc comments with:

- Brief one-line description
- Longer description if behavior is non-obvious
- `# Arguments` section for functions with parameters
- `# Returns` section describing the return value
- `# Errors` section listing error conditions
- `# Examples` section with runnable (or `ignore`-annotated) code

**Error handling:**

- Use `AppError` for all domain errors
- Use `anyhow::Result` for internal/infrastructure errors (PTY, HTTP)
- Map `anyhow` to `AppError` at module boundaries
- Command handlers map `AppError` to `String` for Tauri IPC

**Concurrency:**

- `DashMap` for concurrent collections
- `parking_lot` for mutexes and rwlocks (faster than `std::sync`)
- `tokio::task::spawn_blocking` for CPU-bound and blocking work (sysinfo refresh, worker metrics aggregation, session persistence)
- Never do blocking or CPU-bound work directly on a Tokio async task -- always `spawn_blocking`
- `WorkerRegistry::update_state_if` for compare-and-set state transitions instead of a separate get-then-set (avoids TOCTOU races)

---

## Architecture Decisions

### Why Zustand + Jotai?

**Zustand** manages domain state (workers, sessions, metrics) because it provides:
- `subscribeWithSelector` for minimal re-renders
- `immer` middleware for immutable updates
- No providers or context -- works with Tauri's single-window model

**Jotai** manages UI state (theme, layout, selections) because it provides:
- Atomic granularity (one atom per piece of state)
- `atomWithStorage` for persistence without Zustand ceremony
- Bottom-up reactivity ideal for UI toggles

### Why OKLCH?

OKLCH (Oklab Lightness Chroma Hue) is a perceptually uniform color space:
- Lightness changes look linear to the human eye
- Hue interpolation produces natural transitions (no gray zones)
- Chroma control prevents over-saturation on wide-gamut displays
- CSS `oklch()` is supported in all modern browsers

### Why WebGPU (not Canvas 2D or WebGL)?

- Compute shaders enable GPU-driven particle simulation (no CPU overhead)
- Instanced rendering handles thousands of particles in a single draw call
- Post-processing pipeline (bloom, chromatic aberration) runs entirely on GPU
- Future-proof: WebGPU is the successor to WebGL

### Why portable-pty?

- Cross-platform PTY abstraction (Windows ConPTY, Unix openpty)
- Proper pseudo-terminal semantics (signal handling, job control)
- Compatible with @xterm/xterm for accurate terminal emulation
- Maintained crate with stable API

### Why DashMap?

- Lock-free concurrent reads (critical for metrics collection)
- Per-shard write locks (minimal contention)
- Drop-in replacement for `HashMap` with `Arc<Mutex<_>>`
- Used by both worker registry and session manager

---

## Commit Conventions

Follow [Conventional Commits](https://www.conventionalcommits.org/) with these types:

| Type       | Description                                         |
|------------|-----------------------------------------------------|
| `feat`     | A new feature                                       |
| `fix`      | A bug fix                                           |
| `docs`     | Documentation changes only                          |
| `style`    | Code style (formatting, missing semicolons, etc.)   |
| `refactor` | Code change that neither fixes a bug nor adds a feature |
| `perf`     | Performance improvement                             |
| `test`     | Adding or correcting tests                          |
| `build`    | Changes to build system or dependencies             |
| `ci`       | CI/CD configuration changes                         |
| `chore`    | Other changes that don't modify src or test         |

**Format:**

```text
<type>(<scope>): <description>

[optional body]

[optional footer(s)]
```

**Examples:**

```text
feat(worker): add PTY resize support

Add resize_pty command that sends SIGWINCH to the worker's PTY
when the terminal panel is resized.

Closes #42
```

```text
fix(ai): handle rate-limit 429 responses

The AI client now recognizes 429 status codes and returns a
specific error variant instead of a generic AI error.
```

```text
docs(api): document the ship_context causal record
```

---

## Pull Request Process

### Before Opening a PR

1. **Branch from `main`** -- create a feature branch:
   ```bash
   git checkout -b feat/my-feature main
   ```

2. **Run all checks locally:**
   ```bash
   # Frontend
   pnpm check
   pnpm typecheck   # runs tsc --noEmit against both the app tsconfig.json and tsconfig.worker.json

   # Backend
   cd src-tauri
   cargo clippy -- -D warnings
   cargo test
   cargo fmt --check
   ```

3. **Write tests** for new backend functionality.

4. **Update documentation** if your change affects:
   - Tauri IPC commands (update `docs/api.md`)
   - Architecture (update `docs/architecture.md`)
   - Public Rust APIs (update `///` doc comments)

### PR Guidelines

- **Title:** Use conventional commit format (`feat(scope): description`)
- **Description:** Explain *what* changed and *why*
- **Size:** Keep PRs focused. One feature or fix per PR.
- **Screenshots:** Include before/after screenshots for UI changes
- **Breaking changes:** Call out in the PR description and add a `BREAKING CHANGE:` footer

### Review Checklist

- [ ] All CI checks pass (lint, type-check, clippy, tests)
- [ ] New public Rust items have `///` doc comments
- [ ] New Tauri commands are documented in `docs/api.md`
- [ ] No `rgb()`, `hsl()`, or hex colors (OKLCH only)
- [ ] No `forwardRef` or manual `useMemo`/`useCallback`
- [ ] Hash imports used (no relative paths)
- [ ] `isAnimationActive={false}` on new Recharts components

---

## Testing

### Rust Tests

```bash
cd src-tauri

# Run all tests
cargo test

# Run a specific test
cargo test test_registry_insert_get_remove

# Run tests with output
cargo test -- --nocapture

# Run doc-tests only
cargo test --doc
```

**Current test coverage** (the `ai::queue`/`ai::stream` modules below were deleted in Phase 2 of the multi-provider agent-execution plan — absorbed into `agent::scheduler`/transplanted into `worker::proc` respectively; this table now reflects the replacement modules, not the deleted ones):

| Module                    | Tests | Description                                              |
|----------------------------|-------|-------------------------------------------------------------|
| `error`                    | 13    | Display formatting, serialization                            |
| `events::emitter`          | 40    | Roundtrip serialization, `snake_case` type tags, `camelCase` payload fields, provenance, the `agent_*` family |
| `worker::registry`         | 12    | Insert, get, remove, `update_state_if` compare-and-set, capacity, aggregate metrics |
| `worker::lifecycle`        | 17    | Spawn/pause/resume/kill lifecycle transitions, worktree isolation, credential-leak span-capture regression |
| `worker::proc`             | 15    | NDJSON framer (linear scan, line cap, overrun-tail discard), `spawn_piped` round-trip and spawn failure, `kill_and_wait`, stderr tail and its cap |
| `agent::adapter`           | 5     | `AgentAdapter`/`AgentSession` trait contract + object safety, session lifecycle through a live engine, concurrency contract (busy/idempotent shutdown/exactly-once settlement), `ProviderId` wire-value pin |
| `agent::claude_code`       | 17    | `ClaudeCodeAdapter` against the fake `claude` CLI fixture: turn settlement, tool-call/result ID pairing, permission-denied subclassing, inline-JSON settings flag, probe availability |
| `agent::codex`             | 17    | `CodexAdapter` against the fake `codex` app-server fixture: JSON-RPC settlement ordering, approval round-trip, kill-mid-turn, resume rejection, trust-tier policy pins |
| `agent::registry`          | 5     | `AgentSessionRegistry`: rapid-turn ordering, semaphore-bounded concurrency across sessions |
| `agent::scheduler`         | 15    | Priority ordering, concurrency limiting, enqueue/dequeue |
| `orchestration::engine`    | 15    | Persistence policy, envelope shape, provenance stamping, `agent_*` persistence pinning |
| `orchestration::log`       | 22    | SQLite append/read, migration ladder, partial index |
| `git::*` (8 files)         | 123   | Binary discovery, worktree add/lock/unlock/remove, ship preflight/commit/push, causal-record generation, secret redaction |
| `bus::channel`             | 4     | Channel creation, send/receive, broadcast, message serialization |
| `bus::router`              | 2     | Direct/broadcast send; unconditional `bus_message` emission onto the ordered spine |
| `session::*`               | 8     | Session manager CRUD + atomic persistence (plugin-store-era file compatibility, no-tmp-file-left-behind) |
| `config`                   | 7     | Atomic key-value JSON config persistence |
| `lock`                     | 5     | Single-instance advisory lock, holder-naming error message |
| `metrics`                  | 3     | `SharedSystem` construction, collection loop |
| `protocol`                 | 6     | `swarmd` wire-frame serde: `hello`/`ready`/`rpc`/`rpcResult` shapes, cold-attach `lastSeq` |
| `runtime`                  | 2     | Fresh-data-dir startup, second-instance lock refusal |
| `commands::*` (6 files)    | 27    | Registry dispatch + `RemotePolicy` gating, `events_since` paging, path scoping, argument-shape and credential-leak regressions |
| **Total**                  | **377 (swarm-core) + 27 (swarmd) + 4 (swarm-desktop `registry_contract`)** test functions in-tree | the 2026-08-27 evergreen gate ran **391 green** on Windows (platform-gated tests vary by OS), plus the doc-tests via `cargo test --doc` |

Run `cargo test --workspace` from `src-tauri/` to reproduce this locally; run `cargo test --doc` for just the doc-tests.

### Frontend Testing

Frontend tests run via Vitest (`pnpm test`): **62 test files, 621 tests** _(all green on the 2026-09-23 modernization gate)_, covering components, hooks, stores, and `lib/` utilities.

Tests are **colocated**: `X.test.ts(x)` sits next to the `X.ts(x)` it covers, and a suite that covers one facet of a larger module takes a dotted suffix (`src/lib/tools.file-io.test.ts`, `src/lib/tauri.worker-spawn.test.ts`). Import the module under test through its `#` alias like any other code. Vitest collects `src/**/*.test.{ts,tsx}` only, so the Playwright `e2e/*.spec.ts` suites are never picked up.

| Location                          | Files | Focus                                                          |
|-----------------------------------|-------|-----------------------------------------------------------------|
| `src/components/**/*.test.tsx`    | 19    | UI primitives (`Badge`, `Button`, `Pill`, `ErrorBoundary`, `MetricCard`), graph surfaces (`WorkerGraph`, `CausalityPanel`, `GraphControls`, `GraphLegend`, `ParticleBackground`), and agent/ship surfaces (`SpawnWorkerDialog`, `AgentChat`, `AIChat`, `ShipPreview`, `ProviderBadge`, ...) |
| `src/hooks/*.test.tsx`            | 12    | `useAiStream`, `useSession`, `useShip`, `useStream`, `useWorker`, `useElkLayout`, `useSettingsBridge`, and the event-stream hooks (`useWorkerEvents`, `useSessionEvents`, `useAgentSessionEvents`, `useProvenanceEvents`, `useSystemLogEvents`) |
| `src/lib/*.test.ts`               | 24    | `alerts`, `anthropic`, `event-bus`, `export`, `keybindings`, `kv`, `log-store`, `metrics-aggregation`, `ship-causal`/`ship-message`, `theme`, the `tools*` suites, `transport` (the `wsTransport` client), `webgpu`, `worker-spawn`, ... |
| `src/pages/*.test.tsx`            | 1     | `Settings` -- the settings page's full control surface |
| `src/store/*.test.ts`             | 6     | `ai`, `message-history`, `provenance`, `sessions`, `system`, `workers` Zustand stores |

Tauri IPC is mocked globally in `src/test/setup.ts` via `vi.mock("@tauri-apps/api/core")` (stubs `invoke`) and `vi.mock("@tauri-apps/api/event")` (stubs `listen`), plus mocks for the `dialog`, `fs`, `shell`, and `store` plugins. Individual tests override the default rejected/no-op behavior with `vi.mocked(invoke).mockResolvedValueOnce(...)` as needed. There is no standalone `src/lib/test-utils.ts` module -- the old `agent-loop`, `diff`, `replay`, `test-utils`, and `token-costs` modules under `src/lib/` were removed along with the (dead) session-replay feature.

### End-to-End Tests (Playwright)

```bash
pnpm exec playwright install --with-deps chromium   # once per machine
pnpm test:e2e
```

29 tests across `e2e/navigation.spec.ts`, `e2e/palette.spec.ts`, `e2e/settings.spec.ts`, and `e2e/dialogs.spec.ts`, run headless against the real Vite build with no Tauri backend -- routing, the command palette, Settings' client-side controls, and dialog open/close/focus all pass without a webview or Rust process, since `invoke()` degrades gracefully rather than throwing (see `src/lib/tauri.ts`). Wired into CI as its own `e2e` job (`.github/workflows/ci.yml`). See **[docs/e2e.md](e2e.md)** for the full per-file coverage table, the exact no-backend boundary, and the `tauri-driver` + event-log-oracle design for the next phase (real worker spawn, `seq`-continuity assertions against the ordered event log) -- documented, not yet built.
