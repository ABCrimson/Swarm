# End-to-End Testing

> Playwright coverage for SWARM Orchestrator's frontend shell, its hard boundary, and the documented (not yet built) path past it.

---

## Table of Contents

- [Current Suite](#current-suite)
- [Running It](#running-it)
- [CI](#ci)
- [The Hard Boundary: No Tauri Backend](#the-hard-boundary-no-tauri-backend)
- [Roadmap: `tauri-driver` + The Event-Log-As-Oracle Design](#roadmap-tauri-driver--the-event-log-as-oracle-design)

---

## Current Suite

Playwright drives the real app headless in Chromium — no mocking, no component harness. CI runs it against the production bundle (`vite build` + `vite preview`), local runs against the dev server. 40 tests across six spec files, all built on the shared fixture in `e2e/fixtures.ts`. Chromium is the default project; WebKit and Firefox are opt-in (see [Running It](#running-it)):

| File                    | Tests | Covers                                                                 |
|--------------------------|-------|------------------------------------------------------------------------|
| `e2e/fixtures.ts`       | n/a | The `app` fixture every spec uses: opens the app and waits for the app-ready signal (below), plus landmark locators, sidebar navigation and the palette shortcut |
| `e2e/navigation.spec.ts` | 12 | Dashboard load inside the shell's landmarks, the sidebar nav landmark with every top-level page, click-through navigation, arrow-key focus movement and Tab reaching the sidebar, command-palette routing to every page, a visited page keeping its state when you leave and return (`<Activity>`), the Workers empty state (graph + list view), the Sessions empty state |
| `e2e/palette.spec.ts`    | 6 | Ctrl+K open, Escape close, query filtering (a matching query narrows the list; a non-matching one hits `Command.Empty`), selecting a nav command routes and closes the palette, frecency (a used command's badge reads exactly `1` on next open) |
| `e2e/settings.spec.ts`   | 11 | Every settings section renders, the AI model catalog (switching selection, the gated-model warning toast), keybinding capture (accepting a new binding, rejecting a binding already in use), number-field min/max clamping on commit, keyboard focus rings (a model card keeps its ring after an arrow-key step; `test.fixme` on WebKit, which does not match `:focus-visible` there) and button contrast, the inverted-threshold inline error |
| `e2e/dialogs.spec.ts`    | 6 | The Spawn Worker dialog: opens from the Workers toolbar, provider radios render, Claude Code is deterministically disabled with the real `agentProbe()`-sourced reason, Escape/click-outside close it and restore focus |
| `e2e/styles.spec.ts`     | 3 | The stylesheet cascade: Tailwind's `utilities` layer is the last cascade layer and component/utility padding really applies, so no custom reset can zero it; under `prefers-reduced-motion` the staggered entrance has no delays |
| `e2e/temporal.spec.ts`   | 2 | The Temporal polyfill path: with `Temporal` deleted before load (standing in for WKWebView/WebKitGTK) `src/boot.ts` installs the polyfill and the palette, chart and log paths run on it; with a native `Temporal` it is left alone |

**The app-ready signal.** The global shortcuts (Ctrl+K, the graph/list toggle) attach their `keydown` listeners in effects of the shell's first commit; a key pressed before then is silently lost, which is what made the palette specs flaky. The fixture therefore waits for the current page's `<h1>` inside `<main>` — pages are lazy chunks that commit after the shell, and React flushes the shell's pending effects before rendering anything else — followed by one macrotask yield. No spec sleeps on the clock.

## Running It

```bash
pnpm exec playwright install --with-deps --only-shell chromium   # once per machine
pnpm test:e2e            # dev server on :1420, reused if already running (see below)
CI=1 pnpm test:e2e --shuffle   # what CI runs: production build + vite preview on :4173, random order

# opt-in engines (not part of the default run)
pnpm exec playwright install webkit firefox   # once per machine
pnpm exec playwright test --project=webkit    # or --project=firefox
```

The `webkit` and `firefox` projects (`default: false` in `playwright.config.ts`) are the check that the suite does not lean on Chromium: WebKit is the engine behind WKWebView and WebKitGTK, which the desktop app runs on macOS and Linux. The suite passes on all three engines (one test is `fixme` on WebKit). `--shuffle` randomizes the order of spec files and tests, so no spec may depend on another having run.

`playwright.config.ts`'s `webServer` block starts the server itself — no manual step. Locally it runs `pnpm dev` (Tauri's `devUrl` port, `strictPort`) and reuses whatever is already answering on :1420 -- which may be a dev server from another worktree, in which case that tree's code is the one under test. A parallel checkout needs its own port (a throwaway config that spreads `playwright.config.ts` and overrides `use.baseURL` and `webServer` with `vite --port <n> --strictPort` and `reuseExistingServer: false`); with `CI` set it runs `vite build && vite preview --port 4173 --strictPort`, so the suite exercises the same Rolldown and React Compiler output the desktop bundle ships. Both run Playwright's default worker count (half the logical cores); pass `--workers=2` on a busy machine. With `CI` set, a test only counts as passed on its first attempt: `retries: 2` classifies a failure, and `failOnFlakyTests` fails the run when a retry was needed, keeping that retry's trace for diagnosis.

## CI

`.github/workflows/ci.yml`'s `e2e` job (Ubuntu 26.04) runs on every push and PR to `main`, and inside every release: `pnpm/setup` (pnpm, the pinned Node and a frozen install) → `pnpm exec playwright install --with-deps --only-shell chromium` → `pnpm test:e2e --shuffle` with `CI` set, i.e. against the production preview build in random order. CI runs Chromium only. The `github` reporter annotates failures inline; the HTML report (`playwright-report/`) uploads as an artifact whenever the run was not cancelled (traces from retried tests included), kept 14 days.

## The Hard Boundary: No Tauri Backend

Playwright runs the web build directly in a browser (the dev server locally, `vite preview` in CI) — there is no `tauri dev`, no WebView2/WebKitGTK host, no Rust process. `src/lib/tauri.ts`'s `isTauri()` (from `@tauri-apps/api/core`) is only ever true inside an actual Tauri-hosted webview; under Playwright it's permanently `false`, and `#lib/transport`'s `wsTransport` is never selected either (that requires the `pnpm build:web` + `swarmd --serve-ui` combination, a different build entirely). So every `invoke()` call in this suite runs through `tauriTransport`'s no-bridge branch and resolves `undefined` rather than rejecting — see that file's doc comment. Most command wrappers in `#lib/tauri` are written to degrade gracefully from there (`agentProbe()` returns `{ available: false, detail: "No Backend Transport Available." }`, `spawnWorker`/`agentSpawn` resolve `null`, `readConfig` resolves `null`), which is exactly what lets `dialogs.spec.ts` assert the Spawn Worker dialog's Claude Code-disabled state deterministically instead of skipping it.

**What this means concretely:**

- **Testable headless (and tested here):** routing between pages, the command palette's open/filter/select/frecency behavior, Settings' client-side state (model selection, keybinding capture, number-field clamping — none of these round-trip through `invoke` for their observable UI effect), dialog open/close/focus/Escape, and every empty state that's reachable with zero workers/sessions (because zero workers/sessions is also the ONLY reachable state — nothing can spawn).
- **NOT testable headless, and not claimed here:** worker spawn (`spawn_worker`/`agent_spawn` never reach a real PTY), any PTY output or terminal I/O, real IPC round-trips (`read_config`/`write_config`/`set_max_workers` etc. no-op rather than persisting), the causality graph's non-empty state (`CausalityPanel`'s "measured" hint requires real `agent_*` events flowing from a real worker), session CRUD against the backend session manager, and — the motivating case for this whole document — the ordered event log's `seq` continuity under real load.

No test in this suite spawns a worker and asserts on the result. Where a command wrapper degrades to a no-op (`spawnWorker` → `null`) the corresponding UI path is asserted only up to that point (the dialog opens, the button is enabled, the disabled-reason renders) — never past it.

## Roadmap: `tauri-driver` + The Event-Log-As-Oracle Design

The event log (`orchestration::log`, `<app-data>/swarm-events.db`) is SWARM's actual source of truth: one writer thread, monotonically increasing `seq`, resumed from `EventLog::max_seq()` across restarts (see `docs/architecture.md`'s [Ordered Event Core](architecture.md#ordered-event-core)). Everything this frontend suite touches is upstream of that log — a real regression in `seq` assignment, persistence-policy classification (`is_persistent()`), or `events_since` paging under concurrent worker load would be invisible here no matter how much UI surface gets covered, because none of it happens without a live `swarm-core::runtime::Runtime` behind real IPC.

Closing that gap needs a real Tauri backend under WebDriver, i.e. [`tauri-driver`](https://github.com/tauri-apps/tauri/tree/dev/crates/tauri-driver) (`tauri build`/`tauri dev`'s WebDriver-compatible harness) driven by a `webdriverio`- or Playwright-over-CDP-style client, in place of (or alongside) the current Vite-only `webServer`. This is a substantial separate lift — a new CI job with a built desktop binary, a display server (`xvfb-run` on the Linux runner, since WebKitGTK still needs one headed even "headless"), and a WebDriver client library not currently a project dependency — and is deliberately **not built as part of this work**. What follows is the documented design for when that lift happens, not a stub test that pretends to exercise it today.

**The design — an "event-log-as-oracle" e2e test:**

1. **Drive real worker load through the actual UI**, not a backdoor: open the Spawn Worker dialog, spawn N workers via the Webview Anthropic provider (no external CLI dependency — `spawn_worker`, not `agent_spawn`), let a mix run to completion / get killed / error out.
2. **Matrix over the worker registry cap** (`set_max_workers`, Settings' "Worker Registry Cap" field, backed by `swarm_core`'s worker registry capacity) — at minimum: cap=1 (serialized spawns, exercises queueing/rejection at the boundary), a mid-size cap (e.g. 8, concurrent spawns), and a cap deliberately undersized relative to the spawn count (asserts the registry's honest rejection path, not a silent drop).
3. **Poll `events_since(afterSeq, limit)`** (the same command `CausalityPanel`'s backward-hop fallback and `swarmd`'s replay path already use — see `docs/api.md#events_since`) across the run and assert, for the returned persisted rows:
   - **Seq continuity:** no gaps in the ascending `seq` sequence among persisted rows (a gap would mean either a persistence-policy bug letting a supposedly-durable event fall through, or a writer-thread ordering violation — either is a real regression `is_persistent()`'s unit tests can't catch, since those test classification in isolation, not the live writer under concurrent load).
   - **Monotonicity across the poll window**, not just within one page (catches an `events_since` paging regression that returns rows out of order or re-orders on a boundary).
   - **Expected event presence per worker lifecycle**: `worker_spawned` → (`worker_state` transitions) → `worker_killed`/exit, present exactly once each per worker, matching the persistence table in `docs/architecture.md`'s [Ordered Event Core](architecture.md#ordered-event-core) section.
   - **Provenance where the UI path stamps it**: a spawn triggered via the palette's `worker:spawn` command has no `originWorker`/`causeSeq` (human-initiated); this is the negative case worth pinning alongside the AI-tool-driven positive case documented in `architecture.md`'s provenance table, once agent-driven spawns are in scope for this harness too.
4. **Assert the failure path too**: spawning past the registry cap should produce a truthful rejection (not a silently dropped `seq`) — this is where cap=1-and-oversubscribed in the matrix above earns its place; a passing "happy path" run alone wouldn't catch a registry that just drops requests instead of rejecting them.

This is intentionally scoped to `spawn_worker` (Webview Anthropic), not `agent_spawn` (Claude Code) — the latter needs the `claude` CLI installed and authenticated in the CI image, which is its own separate provisioning problem orthogonal to standing up `tauri-driver` in the first place. A `claude`-CLI-in-CI variant is a natural follow-up once the base harness exists, not a blocker for it.
