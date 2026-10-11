# Contributing

> Development setup, code standards, and contribution guidelines for SWARM Orchestrator.

The house rules (exact pins, pnpm only, no manual memoization, `parking_lot`, and the traps that waste an afternoon) live in [`AGENTS.md`](../AGENTS.md) and apply to every contributor, human or agent. This page covers setup, standards and process.

---

## Table of Contents

- [Development Setup](#development-setup)
- [Code Standards](#code-standards)
- [Design Rationale](#design-rationale)
- [Commit Conventions](#commit-conventions)
- [Pull Request Process](#pull-request-process)
- [Testing](#testing)

---

## Development Setup

### Prerequisites

| Tool    | Version                                  | Purpose                                      |
|---------|------------------------------------------|----------------------------------------------|
| Node.js | 27.0.0-nightly202610086d5e309871 (`devEngines.runtime`) | Frontend build and dev server (pnpm downloads it; do not install it separately) |
| pnpm    | 12.12.0 (`packageManager`)               | Package management; npm and yarn are not used |
| Rust    | nightly-2026-10-11 (`rust-toolchain.toml`) | Backend compilation (`rust-version` 1.101)   |

Every version is pinned exactly: `package.json`, `pnpm-workspace.yaml`, the root `Cargo.toml` and `rust-toolchain.toml` are the source of truth, and this table follows them. The Node nightly can trail the newest one when that build has no Windows x64 binary; `.peak-modern-holds.json` records the reason.

### Rust Toolchain

`rust-toolchain.toml` configures the toolchain, and any `cargo` command in the repo installs it:

```toml
[toolchain]
channel    = "nightly-2026-10-11"
profile    = "minimal"
components = ["rustfmt", "clippy", "rust-src", "rust-analyzer"]
targets    = [
  "x86_64-pc-windows-msvc",
  "aarch64-apple-darwin",
  "x86_64-apple-darwin"
]
```

The repo is one virtual Cargo workspace: run `cargo` from the repository root, not from `src-tauri`.

> [!WARNING]
> On a Windows host with Smart App Control in enforce mode, freshly compiled build scripts and test binaries are blocked (`os error 4551`). `cargo fmt` still works; run `clippy` and `test` in WSL. See [`AGENTS.md`](../AGENTS.md#ways-to-hurt-yourself).

### First-Time Setup

```bash
# Clone the repository
git clone https://github.com/ABCrimson/Swarm.git
cd Swarm

# Install frontend dependencies (exact versions from pnpm-lock.yaml)
pnpm install --frozen-lockfile

# Verify the Rust workspace
cargo check --workspace

# Start the desktop app
pnpm tauri:dev
```

On Linux, Tauri's WebKitGTK system libraries must be installed first; `.github/workflows/ci.yml` lists the exact packages.

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

**Formatter/Linter:** Biome 2.5.15 (the only one; no ESLint, no Prettier). Its nursery rules in `biome.json` (`noFloatingPromises`, `noReactObjectTypeAsDefaultProp`, `noMeaninglessVoidOperator`, `useReactCompiler` and others) are part of the standard.

```bash
# Lint + format (auto-fix)
pnpm check

# Lint only
pnpm lint

# Format only
pnpm format
```

CI runs `pnpm exec biome ci .`, which fails on any error-level diagnostic and writes no fixes; the rules `biome.json` sets to `warn` are reported but do not fail it.

**Import style:** Use hash imports exclusively. `package.json` `"imports"` is the only alias map, and Biome's `noRestrictedImports` rejects parent-relative paths (`../`).

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

- React 19 canary with the React Compiler (the Oxc port) -- no manual `useMemo`, `useCallback`, or `React.memo`; `pnpm check:compiler` fails when a key component ships uncompiled
- `ref` as a regular prop (React 19 pattern), not `forwardRef`
- `useOptimistic` for optimistic UI updates
- Zustand (with `immer` and `subscribeWithSelector` where a store needs them) for domain state
- Jotai atoms for UI state; settings that persist use `atomWithSettings` (`#store/persisted`)
- Dates and durations go through `#lib/time` (Temporal plus `Intl`); `src/boot.ts` installs the Temporal polyfill where the webview has none

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

Every user-facing UI string is Title Case.

### Rust

**Formatter:** `cargo fmt`

**Linter:** `cargo clippy` with warnings denied (zero tolerance). The workspace lint tables in the root `Cargo.toml` and `clippy.toml` are part of the standard: `unsafe_code` is denied, `allow_attributes` is denied (suppress only with `#[expect(lint, reason = "...")]`), `must_use_without_reason` is denied (write `#[must_use = "why"]`), and `std::sync::Mutex`/`RwLock` are banned types.

```bash
# From the repository root
cargo fmt --all --check
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo test --workspace --locked
cargo deny check
```

**Documentation:** Public items carry `///` doc comments: a one-line summary, a longer description when the behavior is non-obvious, and `# Errors` / `# Panics` sections where the function can fail or panic.

**Error handling:**

- `AppError` (`thiserror`) is the domain error in `swarm-core`; it serializes as its display string
- `anyhow::Result` is for internal/infrastructure errors (PTY, child processes); map it to `AppError` at module boundaries
- Command handlers live once in `swarm-core`'s command registry and return JSON values; the desktop forwarders and `swarmd`'s WebSocket `rpc` frames both go through it, so a command cannot behave differently in the two shells

**Concurrency:**

- `DashMap` for concurrent collections
- `parking_lot` for mutexes and rwlocks
- `tokio::task::spawn_blocking` for CPU-bound and blocking work (sysinfo refresh, child waits, PTY teardown)
- Never do blocking or CPU-bound work directly on a Tokio async task
- `WorkerRegistry::update_state_if` for compare-and-set state transitions instead of a separate get-then-set (avoids TOCTOU races)

---

## Design Rationale

Binding decisions live in the [architecture decision records](adr/README.md); read the record that covers a part before you change it. The notes below are short background on a few library choices; where a record exists (Zustand + Jotai: [ADR-0027](adr/0027-three-tier-frontend-state.md)), the record is authoritative.

### Why Zustand + Jotai?

**Zustand** manages domain state (workers, sessions, provenance, AI) because it provides:
- `subscribeWithSelector` for minimal re-renders
- `immer` middleware for immutable updates
- No providers or context -- works with Tauri's single-window model

**Jotai** manages UI state (theme, layout, selections, current page) because it provides:
- Atomic granularity (one atom per piece of state)
- Persistence through `atomWithSettings` without Zustand ceremony
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
- It is optional: without WebGPU, or with reduced motion, the background is a plain color

### Why portable-pty?

- Cross-platform PTY abstraction (Windows ConPTY, Unix openpty)
- Proper pseudo-terminal semantics (signal handling, job control)
- Compatible with @xterm/xterm for accurate terminal emulation
- Maintained crate with stable API

### Why DashMap?

- Concurrent reads: each shard is a `RwLock`, so readers never block each other (critical for metrics collection)
- Per-shard write locks (minimal contention)
- A direct replacement for `RwLock<HashMap<K, V>>`, with an API close to `std::collections::HashMap`
- Used by the worker registry, the session manager, the agent session registry and the per-repository git locks

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

2. **Run all checks locally** (the same gates CI runs, from `AGENTS.md`):
   ```bash
   # Frontend
   pnpm typecheck          # app, worker and node tsconfigs
   pnpm exec biome ci .
   pnpm test:coverage
   pnpm build && pnpm build:web
   pnpm check:compiler && NAPI_RS_FORCE_WASI=true pnpm check:compiler
   pnpm exec knip --treat-config-hints-as-errors
   pnpm test:e2e --shuffle
   pnpm build:site

   # Backend, from the repository root
   cargo fmt --all --check
   cargo clippy --workspace --all-targets --locked -- -D warnings
   cargo test --workspace --locked
   cargo deny check
   # swarm-core and swarmd stay Tauri-free (ci.yml `rust-policy`): no line may match ^tauri
   for crate in swarm-core swarmd; do
     cargo tree --locked -p "$crate" -e normal --prefix none --format "{p}" | grep -E "^tauri"
   done

   # Workflow files (ci.yml `workflows` job: actionlint, then zizmor); only needed when you touch .github/
   actionlint
   zizmor .github          # online audits (pinned SHA vs its # vX.Y.Z comment, known-vulnerable actions) run only with GH_TOKEN set
   ```

   CI also runs these as jobs of `ci.yml`: `frontend`, `knip`, `e2e`, `rust` (three operating systems), `rust-policy`, `cargo-deny` and `workflows`, gathered into the single required status `CI OK`.

3. **Write tests** for new behavior, frontend and backend.

4. **Walk the "Hit Every Surface" list** in `AGENTS.md`: desktop, `swarmd --serve-ui`, CLI, both providers, replay, reverse states.

5. **Update documentation** if your change affects:
   - Tauri IPC commands (update `docs/api.md`)
   - The daemon's wire protocol or flags (update `docs/daemon.md`)
   - Architecture (update `docs/architecture.md`)
   - A recorded design decision (write a new record under `docs/adr/` and mark the old one superseded, per [its README](adr/README.md))
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
- [ ] New commands are documented in `docs/api.md`
- [ ] No `rgb()`, `hsl()`, or hex colors (OKLCH only)
- [ ] No `forwardRef` or manual `useMemo`/`useCallback`
- [ ] Hash imports used (no relative paths)
- [ ] `isAnimationActive={false}` on new Recharts components
- [ ] Docs touched by the change state the code as it is now

---

## Testing

### Rust Tests

```bash
# From the repository root
cargo test --workspace --locked

# Run a specific test
cargo test -p swarm-core test_registry_insert_get_remove

# Run tests with output
cargo test --workspace -- --nocapture

# Run doc-tests only
cargo test --workspace --doc
```

**In-tree test functions** (counted by `#[test]` / `#[tokio::test]` attribute at the 2026-10-10 head; the number run varies with platform-gated tests):

| Crate / module                | Tests | Covers                                                  |
|-------------------------------|-------|---------------------------------------------------------|
| `swarm-core` `git`            | 179   | Binary discovery, worktree add/lock/unlock/remove, ship preflight/commit/push, causal-record generation, secret redaction |
| `swarm-core` `agent`          | 128   | The `AgentAdapter` contract, Claude Code and Codex adapters against the fake-CLI fixtures, the session registry, the turn scheduler |
| `swarm-core` `worker`         | 71    | Registry (capacity, `update_state_if`), lifecycle, PTY and piped-process plumbing, NDJSON framing |
| `swarm-core` `commands`       | 61    | Registry dispatch, `RemotePolicy` gating, `events_since` paging, `read_file`/`write_file` scope and deny list (canonicalization, Windows name refusals), credential-leak regressions |
| `swarm-core` `orchestration`  | 46    | Persistence policy, envelope shape, provenance stamping, the SQLite event log, fail-closed persistence and seq reservation |
| `swarm-core` `events`         | 40    | Wire serialization, `snake_case` type tags, `camelCase` payloads, provenance |
| `swarm-core` `session`        | 16    | Session manager CRUD and atomic persistence |
| `swarm-core` `bus`            | 7     | Channels and the router |
| `swarm-core` top-level modules | 52    | `error`, `config`, `lock`, `metrics`, `protocol`, `runtime`, `state_file`, `clock` |
| `swarmd`                      | 86    | 41 unit tests (CLI parsing, the daemon token and Host/Origin policy, the WebSocket writer, per-peer caps and replay) and 45 integration tests: 37 drive a real daemon over WebSocket and HTTP (the static UI included), 8 cover the service scripts (4 run `install.sh`/`uninstall.sh` against shims on Linux; 4 check the PowerShell scripts and unit files statically) |
| `swarm-desktop`               | 36    | 35 unit tests (command list and per-command ACL, capability and config contracts, dialog grants, lifecycle teardown) and 1 integration test (the shared Tokio runtime) |
| **Total**                     | **722** |                                                       |

`cargo test --workspace --locked` ran 735 tests at that head (in WSL; one more is ignored: it drives the installed `claude` CLI): 613 in `swarm-core` (597 unit plus 16 doc-tests), 36 in `swarm-desktop` and 86 in `swarmd`. The attribute total leaves out the 16 doc-tests but counts tests that did not run in WSL: the ignored one and the `#[cfg(windows)]` tests (for example the short-name and invalid-name tests in `commands/fs.rs`). The doc-tests run with `cargo test --workspace --doc`.

### Frontend Testing

Frontend tests run via Vitest (`pnpm test`): **122 test files, 1281 tests** _(all green at the 2026-10-10 head)_, covering components, hooks, stores, and `lib/` utilities. `pnpm test:coverage` adds the coverage floor from `vitest.config.ts`.

Tests are **colocated**: `X.test.ts(x)` sits next to the `X.ts(x)` it covers, and a suite that covers one facet of a larger module takes a dotted suffix (`src/lib/tools.file-io.test.ts`, `src/lib/tools.spawn-worker.test.ts`). Import the module under test through its `#` alias like any other code. Vitest collects `src/**/*.test.{ts,tsx}` only, so the Playwright `e2e/*.spec.ts` suites are never picked up.

| Location                          | Files | Focus                                                          |
|-----------------------------------|-------|-----------------------------------------------------------------|
| `src/components/**/*.test.{ts,tsx}` | 49  | UI primitives, the graph and causality surfaces, layout, logs, metrics charts, sessions, and the agent/ship surfaces |
| `src/hooks/*.test.tsx`            | 15    | `useWorker`, `useElkLayout`, `useTerminal`, `useWebGPU`, `useSettingsBridge`, `useShip`, and the event-stream hooks |
| `src/lib/*.test.ts`               | 43    | `anthropic`, `event-bus`, `export`, `keybindings`, `models`, `time`, the `tools*` suites, `transport` (the `wsTransport` client), `webgpu`, `worker-spawn`, ... |
| `src/pages/*.test.tsx`            | 3     | The pages with their own control surface (e.g. `Settings`) |
| `src/store/*.test.ts`             | 12    | The Zustand stores and persisted settings |

Tauri IPC is mocked globally in `src/test/setup.ts`: `vi.mock` stubs `@tauri-apps/api/core` (`invoke`, `isTauri`) and `@tauri-apps/api/event` (`listen`), plus the `dialog`, `fs`, `opener` and `store` plugins and `sonner`. Individual tests override the default rejected/no-op behavior with `vi.mocked(invoke).mockResolvedValueOnce(...)` as needed. `src/test/dom-polyfills.ts` fills the jsdom gaps.

### End-to-End Tests (Playwright)

```bash
pnpm exec playwright install --with-deps --only-shell chromium   # once per machine
pnpm test:e2e
pnpm exec playwright test --project=webkit   # opt-in: after `playwright install webkit firefox`; or --project=firefox
```

41 tests across seven spec files (`boot`, `navigation`, `palette`, `settings`, `dialogs`, `styles`, `temporal`), run headless against the real Vite build with no Tauri backend -- the start-failure message, routing, the command palette, Settings' client-side controls, dialog open/close/focus, the stylesheet cascade and the Temporal polyfill path run without a webview or Rust process, since `invoke()` degrades gracefully rather than throwing (see `src/lib/tauri.ts`). Wired into CI as its own `e2e` job (`.github/workflows/ci.yml`), Chromium only, with `--shuffle` so no spec may depend on order; the WebKit and Firefox projects are opt-in. `boot.spec.ts` currently passes only against the dev server: its route matches the dev module URL, not the built `/assets/main-<hash>.js` chunk the CI job serves. See **[docs/e2e.md](e2e.md)** for the per-file coverage table, the exact no-backend boundary, and the `tauri-driver` + event-log-oracle design for the next phase (real worker spawn, `seq`-continuity assertions against the ordered event log) -- documented, not yet built.
