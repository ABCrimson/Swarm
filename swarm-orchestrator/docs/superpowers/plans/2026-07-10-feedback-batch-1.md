# Feedback Batch 1 — Fix Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Branch: `fix/feedback-batch-1` (base `7fc81ce` = main). Detailed diagnosis with file:line evidence for every task lives in `C:\Users\alber\Desktop\Projects\Swarm\.superpowers\sdd\feedback-batch-1-findings.json` — each task brief references its finding by `issue` text; implementers MUST read their finding entry.

**Goal:** Fix the 7 diagnosed defects from Albert's 2026-07-10 feedback session plus the discovered P0 (broken AI config path). No feature expansion — the settings catalog is deferred to a separate design session.

## Global Constraints

- Owner decisions (binding): Title Case applies to ALL user-facing strings including full sentences, toasts, and error messages. Mythos 5 appears in the model picker with a "Requires Project Glasswing" badge/warning. P0 config fix is in scope.
- Frontend: NO `useMemo`/`useCallback`/`memo`/`forwardRef` (React Compiler). zod from `"zod"`. ESM only. pnpm only. OKLCH-only colors in any new styles.
- Rust: no `std::sync::Mutex` (parking_lot only); thiserror variants on `AppError`; commands map errors to `String`.
- Gates per task: frontend `pnpm exec biome check --write . && pnpm typecheck && pnpm test`; Rust (when touched) `cargo fmt && cargo clippy -- -D warnings && cargo test` from `src-tauri/`. Full e2e (`pnpm test:e2e`) at final task.
- Every task: TDD where a behavior is testable (new commands, computation changes); commit per task with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`. Never commit the root `.gitignore` (pre-existing unstaged change).
- New wire/schema fields must be added consistently: Rust payload struct → zod schema (`src/store/types.ts`) → store → consumers. snake_case Rust / camelCase wire.

## Tasks

### Task 1: Real memory totals (216% fix) [S]
Finding: "Dashboard shows Memory usage: critically high: 216%". Add `memory_total_mb: f64` to `SystemMetricsPayload` (emitter.rs) sourced from `sys.total_memory()` in both `start_metrics_loop` and `get_metrics` (metrics.rs). Add `memoryTotalMb` to `SystemMetricsSchema`, thread through `useMetrics`/system store. Replace ALL FOUR hardcoded 16_384 sites (useAlerts.ts:13/32, Dashboard.tsx:56-57, Metrics.tsx:50-51, MemoryChart.tsx:64) with the store value; extract ONE shared `memPercent`/severity helper so no fifth copy can diverge. Guard divide-by-zero (percent undefined until total > 0 observed). Tests: Rust roundtrip test for new field; TS test for helper incl. zero-total guard.

### Task 2 (P0): Working config path + API Key setting [M]
Finding: "Owner asks whether the app needs more settings" (the P0 portion ONLY — not the settings catalog). Create `src-tauri/src/commands/config.rs` implementing `read_config`/`write_config` matching the signatures the frontend's tauri.ts wrapper expects (verify exact expected shape from the frontend call sites); persist to app-data config file. Register commands. Add an "API Key" field to Settings (masked input, stored via write_config) so the AI chat key path works in packaged builds. Do NOT add other settings. Tests: Rust unit tests for config read/write roundtrip + missing-file default.

### Task 3: Model picker from shared catalog [S-M]
Finding: "Settings → AI Model only shows Opus/Sonn…". Delete the local MODELS array in Settings.tsx; render from the shared catalog in `src/lib/models.ts` (verify it matches: fable/opus/sonnet/haiku with 1M/1M/1M/200K contexts; add mythos entry gated with "Requires Project Glasswing" badge per owner decision — selecting it shows the warning but is allowed). Derive context/output labels from catalog data, never hardcode strings. Widen the model atom type + ModelSelector to iterate the catalog. Ensure Rust client sends nothing Fable rejects (no thinking config or sampling params for fable; verify client.rs request construction) and handles `stop_reason: "refusal"` gracefully (surface a Title-Cased error toast; do not read content on refusal).

### Task 4: ELK worker fix (Graph hang) [S]
Finding: "Workers Graph view shows Computing la…". In `src/workers/elk.worker.ts`, construct ELK so it does not spawn a nested worker (drive the layout engine directly/synchronously inside this worker). In `useElkLayout.ts` add `worker.onerror` + error state; WorkerGraph renders a Title-Cased error state instead of an infinite spinner. Test: vitest for the hook's error path (mock Worker erroring).

### Task 5: Particle diagnostics + stacking fix [S]
Finding: "Settings shows Particle Background ena…". Add one-time Title-Cased toast + console.warn on each silent failure gate (`!navigator.gpu`, null adapter, null context) in ParticleBackground.tsx / webgpu.ts; fix the canvas z-index/stacking so a successful init is actually visible above the page background but below content. Manual runtime verification happens at final task's smoke test (note which gate fires on Albert's machine — likely WebView2 WebGPU flag).

### Task 6: Dropdown portal [M]
Finding: "(A) The model dropdown in AI Chat…" part A. Portal the ModelSelector dropdown panel to `document.body` via `createPortal`, positioned from the trigger's `getBoundingClientRect()` with update on scroll/resize/open; keep the toolbar's backdrop-filter glass look. Keyboard nav/focus behavior must survive the portal. Test: vitest asserting the panel mounts outside the toolbar subtree and receives position style.

### Task 7: Pill component consolidation [M]
Finding: "(A)…(B)" part B. Create one `Pill` component (`src/components/ui/Pill.tsx`) with size/tone variants (OKLCH tokens, consistent padding/radius/height/font); migrate every inventoried pill instance (see finding evidence list) including the "Kill" control in Workers list detail — controls that act must look/behave like buttons (Pill with `as="button"` or a Button variant), not static chips. No visual one-offs left behind.

### Task 8: Title Case sweep + final verification [M]
Finding: "A copy-convention audit found many user-…". Apply Title Case to EVERY user-facing string in the finding's inventory — including full sentences, toasts, and error messages (owner decision; word-for-word Title Case). Centralize worker-count pluralization in a shared helper. Sweep for any strings the inventory missed (new ones from Tasks 1–7 must already comply). Then full verification: both gates + `pnpm exec vite build` + `pnpm test:e2e`, bump nothing (no version change — patch batch lands under 0.11.x at owner's discretion). Final commit.

## Final: whole-branch review → merge decision (Albert)
Same as Phase 1: review package from merge-base, most-capable-model review, one consolidated fix wave if findings, then Albert decides merge + runs the app to verify particles/graph/dropdown visually.
