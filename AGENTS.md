# AGENTS.md — Swarm Orchestrator

The house rules for every agent and contributor working in this repo. This
file is canonical; `CLAUDE.md` only imports it.

## Dependencies: Bleeding Edge, Exact Pins

- **Newest on any channel.** Every dependency, toolchain and runtime pins the
  newest version on any channel (latest/next/canary/alpha/beta/rc/nightly).
  The only exception is a newest build that is verifiably broken for this repo:
  pin the newest working build and record it, with the reason and an evidence URL, in `.peak-modern-holds.json` (the freshness sweep reads it).
- **Exact pins only.** Zero `^`, `~` or ranges in `package.json`; Rust crates
  use `=x.y.z` in the root `[workspace.dependencies]`; Rust is pinned to a
  dated nightly in `rust-toolchain.toml`.
- `pnpm-workspace.yaml` enforces this: `saveExact`, `engineStrict`,
  `minimumReleaseAge` (24h) and `trustPolicy: no-downgrade`. A pin younger than
  24h needs a `minimumReleaseAgeExclude` entry. There is no `.npmrc`.

## Package Management: pnpm Only

- Never npm, npx or yarn. Use `pnpm add -D <pkg>@<version>`, `pnpm exec`,
  `pnpm dlx`.
- pnpm switches itself to the `packageManager` version, and
  `devEngines.runtime` provisions the pinned Node nightly for scripts (the
  version is in `package.json`, held back only when a newer nightly lacks a
  win-x64 build — see `.peak-modern-holds.json`). No Corepack (it is not
  bundled with Node 25+).
- Ground API use in the installed version: `node scripts/sync-reference-repos.ts` checks
  out Tauri, xterm.js and React at the exact pinned versions into the gitignored
  `.repos/` (read-only; never edit it). Read those sources and `node_modules/<pkg>`
  types instead of recalling an API.

## TypeScript / React

- ESM only — no CommonJS anywhere. Node scripts in `scripts/` are erasable
  TypeScript that Node runs natively.
- The React Compiler owns memoization: no manual `useMemo`, `useCallback` or
  `memo`. No `forwardRef` — pass `ref` as a prop (React 19).
- `package.json` `"imports"` is the only alias map (`#components/*`,
  `#hooks/*`, `#lib/*`, `#pages/*`, `#store/*`, `#styles/*`, `#test/*`). Parent-relative
  imports (`../`) are forbidden (Biome `noRestrictedImports`).
- Tests are colocated: `X.test.ts(x)` sits next to `X.ts(x)`; a suite for one
  facet of a module is `X.<facet>.test.ts`. Shared setup is `src/test/setup.ts`;
  Playwright specs live in `e2e/`.
- Every user-facing UI string is Title Case. Colors are OKLCH only — never
  hex, `rgb()`, `hsl()` or named colors.
- Biome is the only frontend linter and formatter. No ESLint, no Prettier.

## Rust

- One virtual workspace at the repo root: `crates/swarm-core` (tauri-free
  core), `crates/swarmd` (headless daemon), `src-tauri` (desktop shell).
- No `std::sync::Mutex` / `RwLock` — use `parking_lot`. Enforced by
  `clippy.toml` + `[workspace.lints]`.
- Never block a Tokio worker thread; use `spawn_blocking` for CPU or blocking
  work.
- Suppress a lint only with `#[expect(lint, reason = "...")]`; `#[allow]` is
  denied.

## Ways to Hurt Yourself

Traps this repo and its maintainer's Windows host actually set. Each one fails
silently or misleadingly; know them before you debug anything else.

- **Rust builds cannot run natively on the maintainer's Windows host.** Smart
  App Control (enforce mode) blocks every freshly compiled build script and
  test binary (`os error 4551`, "An Application Control policy has blocked
  this file"). `cargo fmt` works; `clippy`, `test` and `build` run in WSL
  (Ubuntu-26.04) against the Windows checkout. Never suggest turning Smart
  App Control off (it cannot be undone without reinstalling Windows), and
  never run `pnpm tauri build` natively. `cfg(windows)` code only runs on the
  CI Windows runner.
- **The user `PATH` on that host is longer than 8191 characters.** `cmd.exe`,
  which pnpm uses to run package scripts on Windows, expands it to nothing, so
  `pnpm typecheck` or `pnpm test` then fail with "tsc is not recognized" even
  though the tools are installed. Run scripts with a deduplicated PATH of
  existing directories only. A nested `pnpm` inside a script also self-switches
  to the `packageManager` pin and refuses a pin younger than `minimumReleaseAge`
  (it ignores `minimumReleaseAgeExclude`), so put the pinned pnpm itself first
  on PATH, as CI's pnpm setup does. Never modify the global pnpm.
- **Vite owns port 1420 (`strictPort`), and local Playwright reuses whatever
  answers there.** `playwright.config.ts` sets `reuseExistingServer` outside
  CI, so a dev server left running from another worktree is silently tested
  instead of your code. Give a parallel worktree its own port (a throwaway
  Playwright config with its own `webServer`), or stop the stray server. CI
  never reuses: it builds and serves `vite preview` on 4173.
- **`wsl.exe` re-parses its arguments.** Paths, `$VARS`, quotes and
  parentheses from the Windows side get mangled or expanded twice. From Git
  Bash set `MSYS_NO_PATHCONV=1` and pass `/mnt/c/...` paths, and put the real
  command in a script file run with `bash script.sh` instead of `bash -lc
  "..."`.
- **The React Compiler runs through Oxc, and its native binding may be blocked
  too.** The loader falls back to the WASI binding
  (`@oxc-transform-react/binding-wasm32-wasip1`); `NAPI_RS_FORCE_WASI=true pnpm
  check:compiler` proves that path and CI runs it. A component that silently
  ships uncompiled is a performance bug, not an error, so `pnpm
  check:compiler` is a gate.
- **A pin younger than 24 hours does not install** until it has a
  `minimumReleaseAgeExclude` entry, and the Node nightly must have a win-x64
  build or `devEngines.runtime` cannot provision it (see
  `.peak-modern-holds.json`). Let `pnpm install` name what it rejects; add
  exactly that, nothing broader.
- **Temporal is missing in WKWebView and WebKitGTK.** `src/boot.ts` loads
  `temporal-polyfill` before the app and only then imports `main.tsx`. Do not
  import app code from `index.html` or add an earlier entry. Other ES2026+
  APIs have the same gap on WebKit; check support before using one.
- **`swarm-core` and `swarmd` must stay Tauri-free.** A `tauri` crate in their
  `cargo tree` is a CI failure. Put shared behavior in `swarm-core`, shell
  behavior in `src-tauri`.
- **Never kill processes by name pattern, and never write to a live install.**
  Other worktrees and the user's running app share this machine; stop only the
  PIDs you started. Tests use temp data directories, never the app data
  directory.

## Hit Every Surface

A change is not done until every surface it can reach behaves. Walk this list
before reporting done, and say which items you could not run.

- **Tauri desktop** (`pnpm tauri:dev`): the same `swarm_core::commands::Registry`
  behind Tauri commands, capability ACLs (`src-tauri/capabilities/`), CSP,
  native-only commands.
- **`swarmd --serve-ui`** (`pnpm build:web`, then `swarmd --serve-ui dist-web`):
  the browser build over the authenticated WebSocket, `wsTransport` instead of
  Tauri IPC, no native dialogs or fs plugin.
- **CLI**: `swarmd` itself (`--help`, `connect-url`, flags) and the provider
  CLIs it drives.
- **Both providers**: Claude Code (`claude`, `stream-json`) and Codex (`codex
  app-server`, JSON-RPC), plus the webview Anthropic path (`spawn_worker`). The
  fake CLI fixtures under `crates/swarm-core/tests/fixtures/` cover the first
  two without credentials.
- **Replay**: the ordered event log. A new or changed event must persist (or
  be deliberately ephemeral), keep `seq` continuous, and survive cold attach
  and `events_since` paging with a `lastSeq` replay.
- **Reverse states**: a one-way door is a bug. Pause has resume, kill is
  followed by a clean registry, a cancelled turn leaves no queued work, a
  denied approval leaves no half-applied write, a failed persist emits nothing.
- **Contracts and docs**: command names, event payloads and wire frames match
  on both sides (Rust and TypeScript), and the docs that describe them are
  updated in the same change.

## Docs

`docs/*.md` is the only source for the GitHub Pages site. `pnpm build:site`
renders it into `site/_template.html` and writes `dist-site/`; never commit
generated HTML. A new page needs a nav link in `site/_template.html` and
`site/index.html` (the build fails otherwise).

Content rules:

- **Internals only for what a maintainer would get wrong without it**:
  decisions, constraints and traps. No feature catalogs, no PR summaries, no
  narrative of how the code got here (history lives in the git log and
  `CHANGELOG.md`).
- **Rewrite, never append.** When a decision changes, edit or delete the old
  text. A paragraph that says "previously" or "was removed in" is a sign the
  rewrite was skipped.
- **A doc states the code at this head.** Versions, counts, paths, limits and
  command names are checked against the code or a command run today, in the
  same change that moves them. If a number is not worth re-measuring, leave it
  out.
- Do not commit plans, research notes or agent scratch files.

## Gates

Frontend (all must pass):

```bash
pnpm install --frozen-lockfile
pnpm typecheck          # tsconfig.json, tsconfig.worker.json, tsconfig.node.json
pnpm exec biome ci .
pnpm test:coverage      # Vitest plus the coverage floor in vitest.config.ts
pnpm build              # also: pnpm build:web
pnpm check:compiler     # also: NAPI_RS_FORCE_WASI=true pnpm check:compiler
pnpm exec knip --treat-config-hints-as-errors   # dead code / unused deps (knip.jsonc)
pnpm test:e2e           # Playwright
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

Run the desktop app with `pnpm tauri:dev`; package it with `pnpm tauri:build`.
