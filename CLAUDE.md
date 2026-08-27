# CLAUDE.md — Swarm Orchestrator

House rules for working in this repo. Distilled from the original build spec
(`docs/history/SWARM_NEW.md`); this file is the current source of truth.

## Package management — pnpm only

- pnpm is the only package manager. Never use npm or yarn (`packageManager` in
  `package.json` pins pnpm; enable via `corepack enable`).
- **Exact-pin everything.** All dependency versions are pinned exactly — zero
  `^`, zero `~`, zero ranges, ever (`.npmrc` enforces `save-exact=true` and
  `engine-strict=true`).

## Rust

- **No `std::sync::Mutex`.** Use `parking_lot::Mutex` / `RwLock` everywhere.
- No blocking calls on Tokio async threads — use `spawn_blocking` for CPU work.

## React

- **No manual `useMemo` / `useCallback`.** The React Compiler auto-memoizes;
  manual memoization is dead weight and will be rejected in review.
- No `forwardRef` — React 19 ref-as-prop directly.

## Tooling

- Biome is the single linter + formatter (`pnpm check` / `pnpm lint` /
  `pnpm format`). No ESLint, no Prettier.
- ESM only — no CommonJS anywhere.

## Build & test commands

```bash
pnpm install        # install dependencies (exact versions from pnpm-lock.yaml)
pnpm tauri:dev      # build the Rust core and launch the desktop app
pnpm test           # frontend unit tests (Vitest)
pnpm test:e2e       # end-to-end tests (Playwright)
```

Also useful: `pnpm typecheck`, `pnpm build`, `pnpm tauri:build`.
