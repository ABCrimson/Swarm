# AGENTS.md — Swarm Orchestrator

The house rules for every agent and contributor working in this repo. This
file is canonical; `CLAUDE.md` only imports it.

## Dependencies: Bleeding Edge, Exact Pins

- **Newest on any channel.** Every dependency, toolchain and runtime pins the
  newest version on any channel (latest/next/canary/alpha/beta/rc/nightly).
  The only exception is a newest build that is verifiably broken for this repo:
  pin the newest working build and record the evidence (CHANGELOG).
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
  `devEngines.runtime` provisions the pinned Node (26.10.0) for scripts. No
  Corepack (it is not bundled with Node 25+).

## TypeScript / React

- ESM only — no CommonJS anywhere. Node scripts in `scripts/` are erasable
  TypeScript that Node runs natively.
- The React Compiler owns memoization: no manual `useMemo`, `useCallback` or
  `memo`. No `forwardRef` — pass `ref` as a prop (React 19).
- `package.json` `"imports"` is the only alias map (`#components/*`,
  `#hooks/*`, `#lib/*`, `#pages/*`, `#store/*`, `#styles/*`). Parent-relative
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

## Docs

`docs/*.md` is the only source for the GitHub Pages site. `pnpm build:site`
renders it into `site/_template.html` and writes `dist-site/`; never commit
generated HTML. A new page needs a nav link in `site/_template.html` and
`site/index.html` (the build fails otherwise).

## Gates

Frontend (all must pass):

```bash
pnpm install --frozen-lockfile
pnpm typecheck          # tsconfig.json, tsconfig.worker.json, tsconfig.node.json
pnpm exec biome ci .
pnpm test               # Vitest
pnpm build              # also: pnpm build:web
pnpm test:e2e           # Playwright
pnpm build:site         # docs site
```

Rust (from the repo root):

```bash
cargo fmt --all --check
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo test --workspace --locked
cargo deny check
```

Run the desktop app with `pnpm tauri:dev`; package it with `pnpm tauri:build`.
