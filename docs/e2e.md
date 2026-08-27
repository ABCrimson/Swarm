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

Playwright drives the real Vite build (`pnpm dev`, port 1420) headless in Chromium — no mocking, no component harness. 29 tests across four files:

| File                    | Covers                                                                 |
|--------------------------|------------------------------------------------------------------------|
| `e2e/navigation.spec.ts` | Dashboard load, the sidebar nav landmark, click-through to all 5 sidebar pages, arrow/Home/End keyboard nav, palette-only routing to Tools/Logs/Workspace (no sidebar entry for these three), the Workers empty state (graph + list view), the Sessions empty state |
| `e2e/palette.spec.ts`    | Ctrl+K open, Escape close, query filtering (a matching query narrows the list; a non-matching one hits `Command.Empty`), selecting a nav command routes and closes the palette, frecency (a used command shows a usage-count badge on next open) |
| `e2e/settings.spec.ts`   | Every settings section renders, the AI model catalog (switching selection, the gated-model warning toast), keybinding capture (accepting a new binding, rejecting a binding already in use), number-field min/max clamping on blur |
| `e2e/dialogs.spec.ts`    | The Spawn Worker dialog: opens from the Workers toolbar, provider radios render, Claude Code is deterministically disabled with the real `agentProbe()`-sourced reason, Escape/click-outside close it and restore focus |

This replaces the previous 3-assertion smoke suite (`e2e/app.spec.ts` — SWARM branding, sidebar presence, Ctrl+K open) with grouped, role/text-selector assertions on every headless-reachable surface. All 29 pass locally against `pnpm test:e2e` (`workers: 1`, matching CI — see [Running It](#running-it) for why worker count matters).

## Running It

```bash
pnpm exec playwright install --with-deps chromium   # once per machine
pnpm test:e2e
```

`playwright.config.ts`'s `webServer` block starts `pnpm dev` itself and waits for `http://localhost:1420` — no manual server step needed. `workers: process.env.CI ? 1 : undefined` means a bare local run auto-parallelizes across CPU cores; on a many-core machine this can start to contend for CPU with the Chromium instances themselves (GSAP/WebGPU-particle/recharts/elkjs rendering work) and produce timeouts that aren't real bugs — the app never touches a shared server-side data store, so nothing about the SUITE requires parallel isolation, it's purely a local speed/stability trade-off. To reproduce CI's exact behavior locally (serial, 2 retries, `forbidOnly`), run `CI=true pnpm test:e2e`.

## CI

`.github/workflows/ci.yml`'s `e2e` job runs on every push/PR to `main`: `pnpm install --frozen-lockfile` → `pnpm exec playwright install --with-deps chromium` → `pnpm test:e2e`. Chromium only, matching `playwright.config.ts`'s single `chromium` project — Firefox/WebKit aren't configured, so installing them would burn CI minutes for zero coverage gain. The HTML report (`playwright-report/`) uploads as a build artifact on failure only, kept 14 days.

## The Hard Boundary: No Tauri Backend

Playwright runs the Vite dev build directly in a browser — there is no `tauri dev`, no WebView2/WebKitGTK host, no Rust process. `src/lib/tauri.ts`'s `isTauri()` checks for `"__TAURI_INTERNALS__" in window`, which is only ever true inside an actual Tauri-hosted webview; under Playwright it's permanently `false`, and `#lib/transport`'s `wsTransport` is never selected either (that requires the `pnpm build:web` + `swarmd --serve-ui` combination, a different build entirely). So every `invoke()` call in this suite runs through `tauriTransport`'s no-bridge branch and resolves `undefined` rather than rejecting — see that file's doc comment. Most command wrappers in `#lib/tauri` are written to degrade gracefully from there (`agentProbe()` returns `{ available: false, detail: "No Backend Transport Available." }`, `spawnWorker`/`agentSpawn` resolve `null`, `readConfig` resolves `null`), which is exactly what lets `dialogs.spec.ts` assert the Spawn Worker dialog's Claude Code-disabled state deterministically instead of skipping it.

**What this means concretely:**

- **Testable headless (and tested here):** routing between pages, the command palette's open/filter/select/frecency behavior, Settings' client-side state (model selection, keybinding capture, number-field clamping — none of these round-trip through `invoke` for their observable UI effect), dialog open/close/focus/Escape, and every empty state that's reachable with zero workers/sessions (because zero workers/sessions is also the ONLY reachable state — nothing can spawn).
- **NOT testable headless, and not claimed here:** worker spawn (`spawn_worker`/`agent_spawn` never reach a real PTY), any PTY output or terminal I/O, real IPC round-trips (`read_config`/`write_config`/`set_max_workers` etc. no-op rather than persisting), the causality graph's non-empty state (`CausalityPanel`'s "measured" hint requires real `agent_*` events flowing from a real worker), session CRUD against the backend session manager, and — the motivating case for this whole document — the ordered event log's `seq` continuity under real load.

No test in this suite spawns a worker and asserts on the result. Where a command wrapper degrades to a no-op (`spawnWorker` → `null`) the corresponding UI path is asserted only up to that point (the dialog opens, the button is enabled, the disabled-reason renders) — never past it.

## Roadmap: `tauri-driver` + The Event-Log-As-Oracle Design

The event log (`orchestration::log`, `<app-data>/swarm-events.db`) is SWARM's actual source of truth: one writer thread, monotonically increasing `seq`, resumed from `EventLog::max_seq()` across restarts (see `docs/architecture.md`'s [Ordered Event Core](architecture.md#ordered-event-core)). Everything this frontend suite touches is upstream of that log — a real regression in `seq` assignment, persistence-policy classification (`is_persistent()`), or `events_since` paging under concurrent worker load would be invisible here no matter how much UI surface gets covered, because none of it happens without a live `swarm-core::runtime::Runtime` behind real IPC.

Closing that gap needs a real Tauri backend under WebDriver, i.e. [`tauri-driver`](https://github.com/tauri-apps/tauri-driver) (`tauri build`/`tauri dev`'s WebDriver-compatible harness) driven by a `webdriverio`- or Playwright-over-CDP-style client, in place of (or alongside) the current Vite-only `webServer`. This is a substantial separate lift — a new CI job with a built desktop binary, a display server (`xvfb-run` on `ubuntu-latest`, since WebKitGTK still needs one headed even "headless"), and a WebDriver client library not currently a project dependency — and is deliberately **not built as part of this work**. What follows is the documented design for when that lift happens, not a stub test that pretends to exercise it today.

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
