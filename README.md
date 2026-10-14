<p align="center">
  <img src="site/favicon.svg" alt="SWARM Orchestrator logo" width="96" height="96" />
</p>

<h1 align="center">SWARM Orchestrator</h1>

<p align="center">
  <a href="https://github.com/ABCrimson/Swarm/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/ABCrimson/Swarm/actions/workflows/ci.yml/badge.svg" /></a>
  <a href="https://github.com/ABCrimson/Swarm/releases/latest"><img alt="Latest release" src="https://img.shields.io/github/v/release/ABCrimson/Swarm" /></a>
  <a href="LICENSE"><img alt="License" src="https://img.shields.io/github/license/ABCrimson/Swarm" /></a>
  <a href="https://abcrimson.github.io/Swarm/"><img alt="Docs site" src="https://img.shields.io/badge/docs-abcrimson.github.io%2FSwarm-informational" /></a>
</p>

## What It Is

SWARM Orchestrator supervises many coding agents at once. Each worker is a shell on its own pseudo-terminal, optionally in its own git worktree and driving Claude Code or Codex over a structured protocol. Everything that happens is an event on one ordered stream backed by a SQLite log, which the UI renders, a pull request body cites, and a headless daemon replays to remote clients. It is a Tauri 3 (alpha) desktop app with a React 19 frontend, and the same Rust core also runs headless as `swarmd`.

## Status

> [!IMPORTANT]
> **Latest release: v0.13.1 (2026-08-22).** `main` carries the unreleased 0.14.0 work (see `[Unreleased]` in [CHANGELOG.md](CHANGELOG.md)), including breaking changes such as the move from Tauri v2 to Tauri 3 (alpha). No 0.14.0 tag or release exists. Most of what is listed below is not in v0.13.1. The trust tiers and the worktree per worker already held there, and the Tauri-free core with two shells, the provider trait pair and the ship chain shipped there in an earlier form. Released binaries: [v0.13.1](https://github.com/ABCrimson/Swarm/releases/tag/v0.13.1).

## What Main Does Today

The code on `main` as of this commit; Status above names what v0.13.1 already had.

- **One Tauri-free core, two shells.** A Tauri 3 (alpha) desktop app and the headless `swarmd` daemon both embed the same `swarm-core` library ([ADR-0001](docs/adr/0001-tauri-free-core-two-shells.md), [daemon guide](docs/daemon.md)).
- **Two providers behind one trait pair.** Claude Code over its stream-json control protocol and Codex over `codex app-server` implement `AgentAdapter` and `AgentSession` ([ADR-0013](docs/adr/0013-provider-adapter-trait-pair.md), [ADR-0016](docs/adr/0016-claude-code-control-protocol.md), [ADR-0017](docs/adr/0017-codex-app-server-protocol.md)).
- **Trust tiers.** A closed vocabulary (`restricted`, `standard`, `write_enabled`) that fails closed on anything else ([ADR-0015](docs/adr/0015-trust-tiers-closed-vocabulary.md)).
- **Agent sessions trust no repo configuration.** A Claude Code session loads no settings file from the repo, and the provider CLI is found only on absolute `PATH` entries ([ADR-0038](docs/adr/0038-agent-provider-trust-model.md)).
- **A kill stops the provider session first**, then the worker's shell and worktree ([ADR-0040](docs/adr/0040-kill-stops-the-session-first.md)).
- **The event log flushes every commit**, so an event is on stable storage before it is emitted ([ADR-0039](docs/adr/0039-event-log-flushes-every-commit.md)).
- **An isolated git worktree per worker**, created with `git worktree add -b swarm/<slug>-<id8>` and locked; removal never forces, and a dirty tree is preserved ([ADR-0007](docs/adr/0007-worktree-per-worker-system-git.md), [ADR-0008](docs/adr/0008-worktree-removal-never-forces.md)).
- **A ship chain** from commit to push to a prefilled GitHub compare page. The push is bound to the commit sha (`git push --end-of-options origin <sha>:refs/heads/<branch>`, non-force), and every attempt ends in one `ship_settled` receipt ([ADR-0009](docs/adr/0009-ship-chain-structural-guarantees.md), [architecture: Ship Chain](docs/architecture.md#ship-chain)).
- **A browser build that gates desktop-only controls.** The `pnpm build:web` bundle, served by `swarmd --serve-ui`, reads the transport's capability flags and hides or disables controls that need the desktop app ([daemon guide: What the Browser Build Offers](docs/daemon.md#what-the-browser-build-offers), [ADR-0024](docs/adr/0024-transport-chosen-at-build-time.md)).
- **React Compiler on Oxc.** The compiler, TypeScript stripping, JSX and Fast Refresh run in one pass through `oxc-transform-react`, with a WASI fallback binding ([ADR-0032](docs/adr/0032-react-compiler-oxc-wasi.md)).
- **Temporal for dates**, with `temporal-polyfill` loaded at boot only when the runtime lacks `Temporal` ([ADR-0031](docs/adr/0031-temporal-polyfill-boot-entry.md)).

## Architecture

```mermaid
flowchart TB
    FE["React 19 Frontend (src/)"]
    subgraph shells["Two Shells"]
        DESK["swarm-desktop (src-tauri/)"]
        DAEMON["swarmd (crates/swarmd)"]
    end
    subgraph core["swarm-core (crates/swarm-core), Tauri-Free"]
        RT["Runtime and Command Registry"]
        SCHED["AgentScheduler"]
        PROV["ClaudeCodeAdapter and CodexAdapter"]
        ENG["OrchestrationEngine"]
        LOG[("EventLog (SQLite)")]
        GIT["Worktrees and Ship Chain (git/)"]
    end
    FE -->|"Tauri IPC"| DESK
    FE -->|"WebSocket /ws"| DAEMON
    DESK --> RT
    DAEMON --> RT
    RT --> SCHED
    SCHED --> PROV
    RT --> PROV
    RT --> ENG
    ENG --> LOG
    RT --> GIT
```

One Rust core, two shells. `swarm-desktop` forwards Tauri IPC calls to the core; `swarmd` serves the same commands and the event stream over an authenticated WebSocket, and the frontend reaches it with the `pnpm build:web` bundle. CI checks that `cargo tree -p swarm-core` and `cargo tree -p swarmd` contain no `tauri` crate. Full reference: [docs/architecture.md](docs/architecture.md).

## Providers and Trust Tiers

Each worker's tier maps onto the provider's own permission settings ([ADR-0015](docs/adr/0015-trust-tiers-closed-vocabulary.md)). Absent means `standard`; any other token is refused.

| Tier | Claude Code | Codex |
| --- | --- | --- |
| `restricted` | `--restricted`, `--permission-mode dontAsk`, deny list for `Bash`, `PowerShell`, `Write`, `Edit`, `NotebookEdit`, `EnterWorktree`, `ExitWorktree`, `DesignSync`, `WebSearch`, `PushNotification` | `untrusted` approvals, `read-only` sandbox |
| `standard` | `--permission-mode manual`, deny list of `EnterWorktree`, `ExitWorktree` and destructive Bash patterns | `untrusted` approvals, `workspace-write` sandbox |
| `write_enabled` | `--permission-mode acceptEdits`, the same deny list as `standard` | `on-request` approvals, `workspace-write` sandbox |

No tier maps to Claude Code's `bypassPermissions`, and the Codex types have no `never` or `danger-full-access` variants, so those values cannot be put on the wire.

Per [ADR-0038](docs/adr/0038-agent-provider-trust-model.md), a Claude Code session loads no repo settings (`--setting-sources ""`). SWARM reads only the `permissions.deny` string entries from `<cwd>/.claude/settings.json` and appends them, in file order and up to 8 KiB of JSON, to the tier's deny list (at the first entry that does not fit, that entry and all later ones are dropped): a repo can narrow a session and nothing else. The Bash deny patterns are a convenience fence, not the gate; the gate is the permission mode plus the human.

## The Event Log Guarantee

The decision, verbatim from [ADR-0039](docs/adr/0039-event-log-flushes-every-commit.md):

> `EventLog::init` sets `PRAGMA synchronous = EXTRA` and `PRAGMA fullfsync = 1` on the writer connection, reads both back (neither pragma echoes its value) and fails the open with `AppError::EventLog` unless they read 3 and 1. In WAL mode EXTRA is FULL: each event append and each seq reservation is its own committed transaction and syncs the `-wal` file before the writer goes on, so an event is on stable storage before it is emitted and a block of seqs before its first seq is issued.

The cost, as measured on 2026-10-13 on an Intel Core Ultra 9 290HX Plus under WSL2 (Ubuntu-26.04, ext4 on a VHD), 3000 appends of a 392-byte payload: 469 to 514 events/s at `synchronous=FULL` (p50 1.97 to 2.19 ms), against 23219 to 31606 events/s at `NORMAL`. Native Windows NTFS and macOS (`F_FULLFSYNC`) are unmeasured. Method and the full table: [docs/performance.md](docs/performance.md#event-log-persistence).

## Install and Run

Prerequisites, as pinned in `package.json`, `rust-toolchain.toml` and [docs/contributing.md](docs/contributing.md):

- **pnpm** at the version in `packageManager` (`pnpm@12.13.0`).
- **Node.js** at the nightly pinned in `engines.node` and `devEngines.runtime` (`onFail: download`); per docs/contributing.md, pnpm downloads it, so do not install it separately.
- **Rust** at the nightly pinned by `rust-toolchain.toml`; any `cargo` command in the repo installs it.
- **git 2.32 or newer** (a startup probe reports older versions).
- **macOS 15.4 or newer** to run the desktop app on macOS ([ADR-0037](docs/adr/0037-webkit-floor-and-macos-15-4.md)).

Desktop app, from a clone:

```bash
pnpm install
pnpm tauri:dev      # builds the Rust core and launches the desktop app
```

Headless daemon with the browser UI, from the repository root ([docs/daemon.md](docs/daemon.md)):

```bash
pnpm build:web                       # the browser bundle, output in dist-web/
cargo build -p swarmd --release      # binary at target/release/swarmd (swarmd.exe on Windows)
target/release/swarmd --serve-ui dist-web
```

`swarmd` binds `127.0.0.1:8787` by default. When stdout is a terminal it prints the connect URL, `http://127.0.0.1:8787/#t=<token>`; otherwise `swarmd connect-url` prints it. Without `--serve-ui`, a WebSocket client connects to `ws://127.0.0.1:8787/ws`.

> [!WARNING]
> The token is the only authentication and the WebSocket is plain `ws://`. Do not put `--bind 0.0.0.0:PORT` on the open internet; reach a remote daemon through an SSH tunnel or a reverse proxy that terminates TLS ([daemon guide](docs/daemon.md#reaching-the-daemon-off-box)).

Released binaries (desktop installers and `swarmd`) are attached to the [v0.13.1 release](https://github.com/ABCrimson/Swarm/releases/tag/v0.13.1), which predates the `[Unreleased]` work in [CHANGELOG.md](CHANGELOG.md).

## Gates

The commands a change must pass, copied from [AGENTS.md](AGENTS.md#gates).

<details>
<summary>Frontend, Rust and Workflow Gates</summary>

Frontend (all must pass):

```bash
pnpm install --frozen-lockfile
pnpm typecheck          # tsconfig.json, tsconfig.worker.json, tsconfig.node.json
pnpm exec biome ci .
pnpm test:coverage      # Vitest plus the coverage floor in vitest.config.ts
pnpm build              # also: pnpm build:web
pnpm check:compiler     # also: NAPI_RS_FORCE_WASI=true pnpm check:compiler
pnpm exec knip --treat-config-hints-as-errors   # dead code / unused deps (knip.jsonc)
pnpm test:e2e --shuffle # Playwright (chromium; webkit and firefox are opt-in projects)
pnpm build:site         # docs site
```

Rust (from the repo root):

```bash
cargo fmt --all --check
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo test --workspace --locked
cargo deny check
# plus: cargo tree -p swarm-core / -p swarmd must contain no tauri crate (ci.yml rust-policy)
```

Workflows (the `workflows` job of `ci.yml`; run it when you touch `.github/`):

```bash
actionlint              # the version pinned in ci.yml
zizmor .github          # the version pinned in ci.yml; set GH_TOKEN so the online audits (pinned SHA vs its # vX.Y.Z comment, known-vulnerable actions) run as they do in CI
```

CI gathers every job into the single required status `CI OK`.

</details>

## Docs

Also published at <https://abcrimson.github.io/Swarm/>.

| Page | Summary |
| --- | --- |
| [API Reference](docs/api.md) | The command, event and wire-protocol contract of the backend: 38 commands, one ordered event stream, two transports. |
| [Architecture](docs/architecture.md) | The current-state reference: how the system is put together at this commit. |
| [Contributing](docs/contributing.md) | Development setup, code standards, and contribution guidelines. |
| [The `swarmd` Daemon](docs/daemon.md) | Running SWARM Orchestrator headless, as a per-user background program reachable over an authenticated WebSocket. |
| [End-to-End Testing](docs/e2e.md) | Playwright coverage for the frontend shell, its hard boundary, and the documented (not yet built) path past it. |
| [Performance Architecture](docs/performance.md) | Performance targets, budgets, and implementation details. |
| [Roadmap](docs/roadmap.md) | The next ten major releases and the minor releases between them, as planned on 2026-10-13. |
| [Updater Keys](docs/updater-keys.md) | How the in-app updater is signed: the Ed25519 keypair, the CI signing flow, signed-version enforcement, and how each Linux bundle would update. |

Decision records are indexed in [docs/adr/README.md](docs/adr/README.md).

## Security

Do not open a public issue for a vulnerability. Report it through [GitHub Security Advisories](https://github.com/ABCrimson/Swarm/security/advisories/new) or by email to security@crimson.dev, as described in [SECURITY.md](SECURITY.md).

## Contributing

Setup, standards and the pull request process are in [docs/contributing.md](docs/contributing.md). House rules from [AGENTS.md](AGENTS.md), which `CLAUDE.md` imports: pnpm is the only package manager, every dependency version is pinned exactly, and Biome is the only frontend linter and formatter.

## License

[MIT](LICENSE). Copyright (c) 2026 Albert Badalov.

<details>
<summary>Pinned Versions at This Commit</summary>

| Component | Pin | Source |
| --- | --- | --- |
| App | 0.13.1 | `package.json` |
| pnpm | 12.13.0 | `package.json` `packageManager` |
| Node.js | 27.0.0-nightly202610123b639be3a4 | `package.json` `devEngines.runtime` |
| Rust toolchain | nightly-2026-10-14 (`rust-version` 1.101, edition 2024) | `rust-toolchain.toml`, `Cargo.toml` |
| Tauri | 3.0.0-alpha.4 (`tauri`, `tauri-runtime-wry`) | `Cargo.toml` |
| React | 19.3.0-canary-07dde64d-20261013 | `package.json` |
| TypeScript | 7.1.0-dev.20261014.1 | `package.json` |
| Vite | 8.3.4 | `package.json` |
| Biome | 2.5.15 | `package.json` |
| Vitest | 5.0.4 | `package.json` |
| Playwright | 1.65.0-alpha-2026-10-14 | `package.json` |

</details>
