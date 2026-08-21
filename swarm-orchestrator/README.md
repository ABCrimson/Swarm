<h1 align="center">SWARM Orchestrator</h1>

<p align="center">
  Multi-agent AI orchestration — isolated worktrees, a single ordered event log, a causal ship chain, and a headless daemon.
</p>

<p align="center">
  <strong>👉 Start with the <a href="../README.md">project README</a></strong> for the overview, architecture, and feature tour.
</p>

---

This directory is the Tauri application. The Rust side is a **three-crate workspace** — `swarm-core` (tauri-free domain logic), `swarmd` (the headless daemon), and `swarm-desktop` (the Tauri shell, at `src-tauri/`).

## Develop

```bash
pnpm install
pnpm tauri:dev        # build the Rust core + launch the desktop app
pnpm tauri:build      # production installers → src-tauri/target/release/
```

| Command | Description |
|---|---|
| `pnpm tauri:dev` | Tauri dev server (hot-reload frontend + Rust) |
| `pnpm dev` | Vite dev server only (no Tauri backend) |
| `pnpm build` | Type-check both tsconfig projects + Vite production build |
| `pnpm typecheck` | `tsc --noEmit` for the app and `tsconfig.worker.json` |
| `pnpm check` / `pnpm lint` / `pnpm format` | Biome (auto-fix / lint-only / format-only) |
| `pnpm test` / `pnpm test:e2e` | Vitest unit tests / Playwright end-to-end |
| `pnpm analyze` | Bundle analysis (`vite build --mode analyze`) |

Rust: `cd src-tauri && cargo clippy --workspace -- -D warnings && cargo test --workspace`.

## Documentation

| Doc | What it covers |
|---|---|
| [`docs/architecture.md`](docs/architecture.md) | System architecture — event spine, adapters, ship chain, runtime modes |
| [`docs/api.md`](docs/api.md) | The command `Registry` + wire protocol reference |
| [`docs/daemon.md`](docs/daemon.md) | Running & installing the `swarmd` daemon |
| [`docs/performance.md`](docs/performance.md) | Performance targets, virtualization, WebGPU budget |
| [`docs/e2e.md`](docs/e2e.md) | Playwright coverage and its no-backend boundary |
| [`docs/contributing.md`](docs/contributing.md) | Setup, standards, and the review process |
| [`CHANGELOG.md`](CHANGELOG.md) | Release history |

## License

[MIT](LICENSE).
