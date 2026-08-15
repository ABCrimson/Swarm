# Changelog

All notable changes to SWARM Orchestrator will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Conventional Commits](https://www.conventionalcommits.org/).

---

## [0.12.0] - 2026-08-15

Eleven PRs since 0.11.2: the evergreen dependency wave, the Phase-0 boundary-bug fixes it unblocked, CI's first real runs ever, worktree-per-worker isolation, the tauri-free `swarm-core` crate split, the Linux release target and the repo's first-ever macOS bundles, the ship chain, the provenance envelope and measured causality graph, and the multi-provider agent adapter layer culminating in the `ClaudeCodeAdapter` — SWARM workers can now be real Claude Code sessions.

### Added — Multi-provider agent adapter layer (Phase 3: ClaudeCodeAdapter, complete)

- **Two spike verdicts underpin this phase:** the Phase 1 adapter spike's GO verdict (a six-gate empirical measurement against the real `claude` CLI) authorized building the Phase 2 contract this phase completes; the permission-gating mini-spike's verdict — interactive mid-turn permissioning is not buildable on this provider (`--permission-mode manual` is a silent no-op) — is why `agent_permission_request` below is a report, not a request.
- **`ClaudeCodeAdapter`/`ClaudeCodeSession`** (`crates/swarm-core/src/agent/claude_code.rs`) — the first concrete `AgentAdapter`/`AgentSession` implementation, driving `claude -p --output-format stream-json --input-format stream-json --include-partial-messages --verbose` over `spawn_piped`. Maps `system/init` → `agent_session_started`; `stream_event content_block_delta` → `agent_turn_delta` (ephemeral); the `assistant` line completing a block → `agent_block`, plus `agent_tool_call` for `tool_use` blocks; `user` tool-result lines → `agent_tool_result`; the terminal `result` line → `agent_turn_settled` (`status` from `subtype == "success"`, `costUsd`/`usage`/`durationMs`/`numTurns` verbatim).
- **Condition A, concretely implemented:** every spawn passes `--setting-sources project` and writes a SWARM-authored `<cwd>/.claude/settings.json` (`{"permissions":{"deny":[...]}}`) before the child starts — the mini-spike's single lever combining real permission gating, a controlled config environment, and lower cost. Trust tiers (`ClaudeCodeTrustTier`: `Restricted`/`Standard`/`WriteEnabled`) map to `--permission-mode dontAsk`/no-flag/`acceptEdits` plus a tier-specific deny list. `bypassPermissions` is unconstructible by this adapter — `AgentSpawnSpec::permission_mode` is parsed through a closed 3-token vocabulary that fails closed on anything else, argv-proven in tests.
- **Condition B implemented:** `ClaudeCodeSession` synthesizes exactly one `agent_turn_settled{status: "error", error: "Process Exited Without A Receipt"}` + `agent_session_exited` on kill, crash, or an NDJSON framer error — never zero, never two (an async `teardown_gate` mutex serializes the teardown critical section across `shutdown`/`cancel`/the reader task's own natural-EOF path; a `parking_lot` mutex handles the ownership handshake between a genuine `result` line and a concurrent teardown).
- **`agent_permission_request` repurposed as a denial REPORT for this provider** — the mid-turn interactive round-trip is not buildable (`--permission-mode manual` is a silent no-op, verified empirically). The payload gained `denialSubclass` (`"mode"` / `"ungranted_write"` / `"redirection_guard"`, classified from the provider's `decision_reason_type`/`message`) and `message` (the provider's raw text) — additive, `#[serde(default)]`, mirrored in `agent-events.ts`.
- **Empirical finding — multi-turn reality:** one `claude -p` process, fed more than one stream-json turn before EOF, handles each in the SAME process and session (own `init`/`result` pair per turn, stable `session_id`). `ClaudeCodeSession` keeps one child alive for its whole lifetime; `--resume` is used only to rehydrate a session whose process is gone, never as a per-turn respawn strategy.
- **`acceptEdits` canary — PASS.** A real-CLI canary run (`--permission-mode acceptEdits --setting-sources project`, $0.05) confirmed Write executes cleanly with zero `permission_denied` events, gating the `WriteEnabled` trust tier.
- **Command surface:** `agent_spawn` (spawns a worker via the existing worktree-isolation path, then attaches a session), `agent_send_turn` (enqueues through the new `AgentScheduler`), `agent_cancel`, `agent_shutdown`, `agent_probe` (bounded `--version` check, never a hang). `kill_worker` now also tears down any attached agent session (best-effort). New `AgentSessionRegistry` (live `Arc<dyn AgentSession>` by worker id).
- **Minimal frontend wiring:** a provider/model/trust-tier picker on the Workers page spawn flow (`agentSpawn`), a provider badge on worker rows and in `WorkerAIPanel`'s toolbar, and `AgentChat.tsx` — a simple event-driven transcript rendering directly from `agent_block`/`agent_tool_call`/`agent_tool_result`/`agent_permission_request`/`agent_turn_settled`, wired to `agentSendTurn`. The full spawn-dialog/polished-panel redesign is a deferred follow-up branch.
- **Tests:** adapter unit tests drive a fake `node` child process replaying canned NDJSON copied verbatim from the spike logs (`crates/swarm-core/tests/fixtures/claude_code/`), covering the happy path onto a live engine with persistence-class assertions, tool-call/result id correlation, kill-mid-turn synthesis, NDJSON-framer-error surfacing, all three permission-denial subclasses, busy rejection, idempotent shutdown, `settings.json` per-tier content, and the `bypassPermissions` argv proof. 268 `swarm-core` tests (was 251), 20 `swarm-desktop` tests (unchanged), 16 doctests (unchanged), 518 vitest (was 515).

### Fixed — Phase 2 review wave (adapter contract + NDJSON framer hardening)

- **NDJSON framer O(n²) scan amplification.** The framer's `\n` search re-scanned the retained partial-line prefix from byte 0 on every `push()` call — for a large line fed in `spawn_piped`'s 4096-byte read chunks, this measured ~13.4B byte-comparisons for a single 10MB line (a >1000x blowup). Fixed with a persistent `scan_from` cursor: each byte is now scanned at most once over the framer's lifetime. A test with an instrumented scan-byte counter proves linear behavior and fails against the pre-fix code.
- **No line-length cap.** An unterminated line (a desynced/non-NDJSON provider) grew the framer's buffer without bound. Added `MAX_LINE_BYTES` (10MB); an overrun returns a typed `AppError::LineTooLong` that `spawn_piped` surfaces via a new `PipedHandle::framer_errors` channel — the framer clears its own buffer and keeps parsing subsequent lines, but the caller must treat the overrun as a session-level failure (never silently truncate JSON).
- **`AgentSession::shutdown` contract change** (binding before any Phase 3 adapter is built against it): `shutdown(self: Box<Self>)` → `shutdown(&self)`, now idempotent (a second call returns the cached `ExitSummary`, never re-kills or re-emits) — this is what lets a session live behind `Arc<dyn AgentSession>` instead of a one-shot `Box`. The trait's doc now states the full concurrency contract as binding: `send_turn` while a turn is in flight returns a typed `AppError::AgentSessionBusy` (a session never queues — that's the scheduler's job); `cancel` may race `send_turn`/`shutdown` safely; no internal lock may be held across an `.await`; and Condition B is restated as a hard invariant — shutdown (or child death) during an in-flight turn yields EXACTLY ONE synthesized `agent_turn_settled`, never zero, never two. `MockAgentSession` gained interior mutability and an ownership handshake between `send_turn`/`shutdown` to prove it; new tests cover shutdown-during-in-flight (exactly one settled), double-shutdown (idempotent), and send-while-busy.
- **`agent_turn_settled.status` is now a closed `AgentTurnStatus` enum** (`Ok`/`Error`), matching the `ProviderId`/`PermissionDecision` precedent this branch already set, rather than a bare string.
- **Piped-process substrate hardening:** `PipedHandle::kill_and_wait` mirrors the PTY reap pattern (drop stdin, kill, wait) so nothing forgets to reap a child; stderr now retains a live, bounded ~4KB tail (`PipedHandle::stderr_tail`) instead of only a byte count, so a provider's fatal startup message is recoverable; `spawn_piped` documents the runtime it requires (`# Panics` if called outside a Tokio context).
- **Credential-leak regression coverage extended to the command layer:** a second span-capture test (`commands::worker::tests`) reproduces `spawn_worker`'s own `#[tracing::instrument]` shape (no live `tauri::App` harness exists in this codebase, so it mirrors the established `WorkerInputArgs` shadow-struct pattern) and asserts no env secret leaks there either.
- **Scheduler test hardened** from `<=` to `assert_eq!` on peak concurrent-executor count, and the module doc now documents two pre-existing, unchanged-behavior limitations inherited from the deleted `ai/queue.rs`: priority cannot preempt already-running lower-priority work, and `QueueFull` can trigger against an "idle" heap (backpressure is on the channel, not heap depth).
- **`agent-events.ts`** gained a Rust-side serde-pin test for all five `ProviderId` wire values and a doc comment stating it is consumed starting Phase 3.
- **Docs:** `docs/architecture.md`'s adapter-layer trait snippet and piped-process-substrate description updated to match; `docs/contributing.md`'s test-coverage table refreshed (the deleted `ai::queue`/`ai::stream` rows replaced with the actual current per-module counts); `docs/api.md`'s remaining `ai_stream_settled` `waitFor` example replaced with the actively-emitted `ship_settled`; `README.md`'s AI-streaming blurb, source tree, and commands table no longer advertise the deleted `ai_request` command.

### Added — Multi-provider agent adapter layer (Phase 2: spine contract + traits)

- **`AgentAdapter`/`AgentSession` trait pair** (`crates/swarm-core/src/agent/adapter.rs`): the one Rust interface every provider CLI (Claude Code, Codex, OpenCode, Gemini) will implement so all their turns land as normalized events on the existing ordered spine. `ProviderId`, `Capabilities` (with doc comments carrying the Phase 1 spike's empirical findings — sentence-clause delta granularity, kill-only cancel on Windows, native-cost truth, permission-mode support), `ProbeReport`, `AgentSpawnSpec`, `TurnInput`, `ExitSummary`, and `PermissionDecision` round out the contract. Object-safe via a hand-written `BoxFuture` alias rather than a new `async-trait` dependency.
- **The `agent_*` event family**, extending (not duplicating) the existing `agent_turn_started`: `agent_session_started`, `agent_turn_delta` (ephemeral), `agent_block`, `agent_tool_call`, `agent_tool_result`, `agent_permission_request`, `agent_turn_settled`, `agent_session_exited`. Causality rides the existing envelope-level `originWorker`/`causeSeq` (no payload-level duplication). A `MockAdapter` integration test drives a full session lifecycle (spawn → turn → deltas → settled → shutdown) through a live `OrchestrationEngine`, asserting every variant lands in its correct persistence class.
- **`AgentScheduler`** (`agent/scheduler.rs`): absorbed `ai/queue.rs` wholesale — the same BinaryHeap-priority + Semaphore-gated + JoinSet-tracked + bounded-mpsc(256) machinery, retyped from `AiRequest`/`AiPriority` to `AgentTurnRequest`/`TurnPriority` and made generic over an injected executor (no concrete provider client exists yet). Unwired in this shell — constructed lazily once Phase 3's adapters exist.
- **`spawn_piped` + `NdjsonFramer`** (`worker/proc.rs`): a sibling to `spawn_pty` for JSON-protocol provider CLIs, reusing the identical `spawn_blocking` reader → bounded `mpsc(4096)` → forwarder backpressure shape over `Stdio::piped()` instead of a pseudo-terminal (a PTY's line discipline corrupts NDJSON framing). The framer transplants and improves on `ai/client.rs`'s line-splitting loop, compacting its buffer once per `push()` call instead of once per line.
- **The credential-leak-in-waiting tracing fix:** `do_spawn_worker` and its Tauri command wrapper both `#[tracing::instrument]`ed `config: WorkerConfig` unskipped — `WorkerConfig` derives `Debug` including `env: HashMap<String, String>` verbatim, so any env value (a future per-profile API key) would have been captured into the span at `swarm_core=debug`. Both are fixed (`config` now skipped; a redacted summary logged instead); a regression test drives a real spawn with a secret-shaped env value through a captured `tracing_subscriber::fmt` subscriber and asserts it never appears in the output.

### Removed — the Rust AI stack (Phase 2)

- **Deleted `ai/client.rs`, `ai/stream.rs`, `ai/queue.rs`** (the whole `ai` module) — the Anthropic Messages API client, its SSE parser, and its priority queue existed to speak an API the multi-provider pivot stops calling from Rust. The line-framing loop was transplanted into `worker/proc.rs`'s `NdjsonFramer` first; the queue's machinery was absorbed into `agent/scheduler.rs`'s `AgentScheduler` first.
- **Deleted the `ai_request` command and its `AiQueue` shell wiring.** Zero shipped frontend code ever called it (the real chat flow streams `@anthropic-ai/sdk` directly from the webview). `agent_turn_started` — actively used by that webview chat flow — survives, moved to a new `commands/agent.rs`, unrenamed (no frontend change needed).
- **`AiPriority` retired** in favor of the scheduler's own `TurnPriority`. `AiStreamDelta`/`AiStreamSettled` `SwarmEvent` variants are KEPT for now (the webview path may still bridge onto them during the Phase 5 migration) — `AgentTurnDelta` is added to `is_persistent`'s ephemeral exclusion list now, closing the latent "streamed deltas persisted at ~800 rows/s" bug before any real adapter could trigger it.
- **Frontend:** additive Zod schemas for the new `agent_*` event payloads (`src/lib/agent-events.ts`) for future event-bus consumption — no UI wired to them yet.

### Added — Measured causality graph + inspector (Phases 6–7)

- **The Workers topology graph now renders MEASURED causal edges, never fabricated ones.** Deleted the phase0 "Spawn Order" chain (`SpawnOrderEdge.tsx`, which connected every worker in Map insertion order regardless of whether anything actually happened between them) in favor of edges derived from stamped `swarm://events` envelopes — a new `src/store/provenance.ts` Zustand store ingests every envelope, deriving `spawn`/`kill`/`command`/`message` edges only from a real `originWorker` plus a resolvable target. Repeated same-kind occurrences collapse into one edge with a `×N` label and a thickness ramp; `file_written` becomes a `"Wrote N Files"` node badge instead of an edge (files aren't workers).
- **The empty state is the deliverable:** hand-spawned workers with no measured causality render as nodes with ZERO edges and a quiet "No Measured Causality Yet" hint — an honest empty canvas rather than a meaningless line. `GraphLegend.tsx` shows a row only for edge kinds actually present, and nothing at all when the graph has none.
- **User-drawn annotations stay visually and structurally distinct:** hand-drawing an edge (`onConnect`, unchanged UX) now tags it `kind: "manual"` with its own desaturated style and legend row — measured facts and user annotations are never merged.
- **Causality inspector (`CausalityPanel.tsx`):** click a measured edge, or use a worker's new "View Causality" action, to walk its causal chain backward — the bySeq ring first, falling back to a single-row `events_since({ limit: 1 })` backfill on a miss — terminating at a real root (typically `agent_turn_started`) or a 50-hop cap. Renders as a vertical, root-first trace with tabular-nums seqs; rows click through to the worker they name.
- Endpoint-drop: an edge whose endpoint worker was killed drops off the canvas but is never deleted from the provenance store — still findable via the inspector by seq.

### Added — Provenance stamping (ordered log → causality graph, Phases 2–5)

- **Envelope-level causal attribution:** every `swarm://events` envelope and persisted row can now carry `originWorker`/`causeSeq` — who caused an event and what it was reacting to, distinct from a payload's own subject `workerId` (see the subject-vs-causer rule in `docs/architecture.md`). Absent (not `null`) when unattributed, so the common case (e.g. `worker_output`) pays no wire tax. The engine records provenance; it never infers it.
- **`agent_turn_started` command:** a narrow webview intake `AIChat.tsx` calls once per AI/agent turn, before the first streaming round, returning the real seq the engine assigned via a non-blocking ack-oneshot (`EventSink::emit_awaiting_seq`). That seq becomes `causeSeq` on every tool-driven side effect the turn executes (`spawn_worker`, `kill_worker`, `worker_input`, `write_file`).
- **`worker_input` event:** emitted after a successful PTY write, with `{ workerId, bytes, source, preview? }`. `source` is `"terminal"`, `"tool"`, or `"automation"`; a control-stripped preview (first ~120 chars) is generated only for `tool`/`automation` — raw human keystrokes get a byte count only and are excluded from persistence entirely, so typed secrets are never archived.
- **Real `read_file`/`write_file` Rust commands** (`commands/fs.rs`, previously an empty stub) with path scoping matching `tauri-plugin-fs`'s capability config (reads under `$APPDATA`/`$HOME`, writes under `$APPDATA`/`$HOME/.swarm`). `write_file` emits a stamped, persisted `file_written { path, bytes }` event; `src/lib/tools.ts`'s `read_file`/`write_file` AI tools now invoke these commands instead of the plugin-fs path.
- **`bus_message` free attribution:** `bus_subscribe`'s forwarder now stamps `originWorker` from the message's own `fromWorker` — real attribution for every inter-agent bus message with no additional caller plumbing.
- **Optional `originWorker`/`causeSeq` IPC args** on `spawn_worker`, `kill_worker`, `pause_worker`, `resume_worker`, `worker_input`, `create_session`, `delete_session` — absent by default, every pre-existing caller is unaffected.
- **SQLite migration ladder:** a `PRAGMA user_version` ladder adds `origin_worker`/`cause_seq` columns to the events table (existing rows come back `NULL` — the truthful historical value) plus a partial index on `(origin_worker, seq)` for worker-scoped queries. `events_since` gains an optional `limit` (clamped to the existing 5000-row cap) for future single-row lookups.

### Fixed

- **`worker_input` was broken for every caller:** the Rust command's `data: Vec<u8>` parameter could not deserialize the plain JS string every frontend call site (`useTerminal.ts`, the `run_command` AI tool, the workspace watcher's auto-injection) actually sends — `serde_json` expects a JSON array of byte numbers for `Vec<u8>`, not a string. Changed to `data: String`, writing its UTF-8 bytes to the PTY; a regression test pins the old signature's failure mode down permanently.

### BREAKING CHANGE

`worker_input`'s Tauri command signature changed from `data: Vec<u8>` to `data: String`. Every in-repo caller was already broken by the old signature (it has never worked since it was written) and is updated by this release, but any external code invoking `worker_input` directly over IPC with a JSON byte array will now fail deserialization the other way — pass a plain UTF-8 string instead.

### Added — Ship chain (Phases 0–1): commit → push → prefilled compare page

- **One confirmed click ships a worker's changes**: `git_ship_preflight` → `git_stage_commit` → `git_push` → `ship_compare_url`, wired to a new Ship tab with a literal per-action command plan (trailers disclosed) and an editable, deterministic Conventional-Commit message.
- **Preflight refuses before it mutates**: a primary-checkout guard, detached HEAD, protected-branch prefix globs, and a missing remote all leave `canShip` honestly false before anything runs; `--force`, `--no-verify`, and `git add -A` are unconstructible by the command surface (argv-tested), every mutation runs under a per-repo lock, and hooks always run.
- **The secret deny list is enforced, not just previewed**: in "Already Staged" mode, denied paths a human already `git add`ed are actively unstaged before commit (`git restore --staged`), and an unstage failure hard-aborts rather than shipping the secret; redaction is proven at the choke point against a real credentialed URL, including a split-token-at-truncation case.
- **Honest ship lifecycle**: receipts are now awaited with a 30s budget that exceeds the backend's own 20s git timeout (closing a window where a slow-but-successful push could still be reported "failed"); `NothingToCommit` with `ahead > 0` (already-committed, unpushed work) proceeds straight to push instead of stranding the commit; push resolves the live branch and HEAD sha server-side; the compare-page base comes from the remote's default branch; degenerate `Swarm-Seq-Range` trailers are omitted rather than emitting `0..0`.
- **Commits carry a `Swarm-Seq-Range` trailer** binding them to the event log. `worktree_created`'s lookup is one indexed `(type, seq)` query, replacing a full-log scan.
- Hardened across two adversarial review rounds — 3 blockers (receipt-timeout vs. git budget, stranded commits with no push affordance, staged-mode committing what it labeled "Skipped") plus 12 further fixes, every one landing with a regression test (including a receipt-timeout test whose mock `waitFor` had no real timer until this wave). Gates: Rust 215 unit + 16 doctests (main: 165 + 16) · vitest 448/448 (44 files) · clippy `-D warnings` all-targets · biome ci · typecheck.

### Fixed — macOS release bundling (the repo's first-ever macOS bundles)

- **`.icns` was missing from `bundle.icon`**: the first-ever Release dry run proved Linux and Windows, but macOS bundling died with `Failed to create app icon: No matching IconType` (only PNGs and a Windows `.ico` were listed). Generated the full-fidelity `icon.icns` via `tauri icon` from the existing 1024px source and added it to the bundle config — no other icon churn.
- **The macos-13 Intel runner pool is dead**: the x86_64 leg sat queued 2h+ while every other leg ran — the last free Intel runner pool no longer schedules. The Intel build now cross-compiles on the arm64 runner (`--target x86_64-apple-darwin`); both mac legs carry explicit targets. The updater manifest keeps all four platform keys.

### Added — Worktree-per-worker isolation (Phase 1)

- **Spawning a worker inside a git project creates its own worktree**: `~/.swarm/worktrees/<repo>-<hash8>/w-<id8>` on a fresh `swarm/*` branch off HEAD, locked with the worker's UUID, PTY started there. No repo present → exactly today's shared-cwd behavior; repo present but worktree creation fails → the spawn hard-fails rather than silently colliding on a shared cwd.
- **Safety as tested guarantees**: worktree removal never uses `--force` and branch cleanup never uses `-D` (both argv-proven unconstructible); dirty worktrees are preserved (real-git integration tests, including an end-to-end PTY-kill case); `preserved_dirty` is reserved strictly for git's own dirty-tree refusal — a locked tree, a permission error, or any unrecognized failure now report honestly as `failed` instead of being laundered into "preserved"; the `swarm/*` branch is deleted only on clean removal with an unmoved tip, so real committed agent work always survives.
- **Two persisted events** ride the ordered spine: `worktree_created` (its own seq is the anchor the ship chain binds diffs to) and `worktree_removed`.
- **Git facade in the tauri-free core**: arg-vector-only invocations (injection surface reviewed and cleared), `CREATE_NO_WINDOW`, timeouts with child kill, per-repo op serialization, startup prune, and a git-capability probe wired to the UI for the first time ever (`system_log`'s first frontend consumer).
- **Also fixed along the way**: `plugins.shell.open`'s regex was never configured, so every `open()` call in the app silently no-op'd; the Project Root picker now validates the target is a real repo before persisting and revalidates on load; template spawns inherit isolation.
- Hardened by an adversarial review round: proof tests that hardcoded `cmd.exe` (never ran on Linux CI) now resolve the shell via the real production default-shell path; worktree disposition no longer launders a locked tree or a mid-delete permission error into `preserved_dirty`; the forever-leaking `swarm/*` branches are now cleaned up on an unmoved tip. Gates: Rust 159 tests (was 92 + 16 on main) · vitest 424/424 (42 files) · clippy `-D warnings` all-targets · biome ci · typecheck.

### Added — Crate split: tauri-free `swarm-core` (headless plan, Phase 1)

- **Zero-behavior-change extraction** of the domain core (worker/PTY, AI, bus, sessions, orchestration/event log, errors) into a workspace lib crate: `src-tauri/` is now a workspace root with `swarm-desktop` (the Tauri shell) and `crates/swarm-core` (no `tauri` anywhere in its dependency tree — now enforced by a CI gate, `cargo tree -p swarm-core -e normal`). Every exact dependency pin now lives once in `[workspace.dependencies]`; the crate version is single-sourced via `[workspace.package]`.
- **The `EventSink` emit seam** replaces `emit_event(&AppHandle, …)` at 8 call sites. A review round caught the initial broadcast-only design losing real events: a `tokio::broadcast(4096)` channel never blocks and overwrites the oldest entry on overflow, and one worker streaming a few thousand `worker_output` events/sec against that global buffer trips `Lagged` in well under a second — since those events aren't persisted, the unmodified frontend gap-backfill loop then returns `[]` forever and the terminal livelocks. Fixed by keeping the primary delivery path a synchronous injected closure (lossless, back-pressured, per-failure logged) that exactly mirrors the pre-split direct `app.emit` call; the broadcast fanout survives only as a documented-lossy secondary channel, reserved for a future `swarmd` remote-subscriber phase that will heal lag via `events_since` replay instead.
- **Ports for Phase 2**: `Paths` (data-dir injection), config logic (atomic writes, process-wide lock) moved into the core, and a `SessionStore` trait with the `tauri-plugin-store` impl kept in the shell.
- Proof of zero behavior change: `git diff main -- swarm-orchestrator/src …` empty · 92 unit + 16 doctests at exact parity with pre-split main, none modified · `cargo doc` warnings 4 → 0 · full gate suite green (fmt, clippy `-D warnings` workspace-wide, biome ci, typecheck, 400 frontend tests). Unblocks worktree-per-worker isolation, the ship chain, provenance, the multi-provider adapters, and a future `swarmd` daemon — all land their Rust inside `swarm-core`.

### Added — Linux release target (provenance plan, Phase 1)

- **`ubuntu-22.04` release leg** (deliberately not `ubuntu-latest` — 24.04's glibc 2.39 floor would exclude Debian 12 / Ubuntu 22.04 users) building deb + AppImage via matrix-scoped `--bundles` args; `tauri.conf.json` untouched.
- **`workflow_dispatch` dry runs stay release-free**: an empty `tagName` makes `tauri-action` build bundles without creating a GitHub release — the de-risk for the fact this repo had compiled on Linux in CI but never *bundled* there. (A review round caught the first cut creating a bogus `main`-tagged release on a dispatch run; fixed before merge.)
- **`verify-updater-manifest` job**: the four parallel per-platform build jobs fetch-modify-upload `latest.json` non-atomically — a lost platform key was silent before this job existed; it is now a red X before a human publishes the draft. Gated to tag pushes.
- Docs: AppImage-only updater support on Linux called out in `UPDATER_KEYS.md` and `README.md` (a `.deb` install will see updates it cannot apply).

### Fixed — Phase 0: the boundary bugs the evergreen audit found

- **File tools work for the first time**: `read_file`/`write_file` AI tools invoked Tauri commands that did not exist — every call silently failed. Rerouted through `#lib/fs` over `tauri-plugin-fs`, with OS permission errors now distinguished from capability-scope denials by matching the plugin's exact `forbidden path:` error text (the previous looser substring match had also been misclassifying legitimate in-scope OS errors, e.g. Windows' "Access is denied").
- **The `WorkerConfig` naming collision is gone (`WorkerSpawnSpec` split)**: two incompatible types shared one name — Rust's `{name,shell,cwd,env,rows,cols}` and TS's `{name,role?,model?,systemPrompt?}` — so `spawnWorker` sent only `{config:{name}}` and every templated worker silently produced an identical bare shell, while Rust's `shell`/`cwd`/`env` were unreachable from the frontend. The TS type is renamed `WorkerSpawnSpec` and split into `WorkerProcessOptions` (name/shell/cwd/env, sent to Rust) and `WorkerAgentMetadata` (role/model/systemPrompt, client-side only, in a new `useWorkerAgentStore`). Templates finally configure workers, and `session_add_worker` got its first caller.
- **Pre-existing `create_session` bug fixed**: the required `config` argument was never sent, so template application failed IPC deserialization on every call ("missing required key config") — structurally dead before this branch. Fixed at the one raw `invoke()` call site, with the response now normalized (`createdAt` → ISO, `updatedAt` seeded) and Zod-validated before it reaches the store.
- **Session creation race closed both ways**: an earlier fix that dropped the client-side `addSession()` call (relying solely on the `session_created` event) introduced a race between Rust's event-writer thread and `create_session`'s own return — either ordering could lose `workerIds`. `addSession()` is restored AND the `session_created` handler now merges into an existing store entry instead of replacing it, so whichever write lands first is preserved.
- **Per-worker model truth**: a templated worker's effective model was already computed correctly for the AI request, but `ModelSelector` still read/wrote only the global persisted atom, so the dropdown could show Sonnet while requests went to Opus and picking Haiku did nothing. `ModelSelector` now accepts a `workerId` and, when that worker has a pinned model, becomes the single source of truth for both display and selection — a manual pick scopes to that worker's own metadata instead of clobbering the shared, persisted selection.
- Three adversarial review rounds total (4 blockers, 10 fixes, 9 nits found and resolved); final diff independently re-verified in code. Gates (post-rebase, under Biome 2.5.8 / React canary 22e4f993 / motion 13): `pnpm exec biome ci .` exit 0 (176 files) · typecheck clean · 400/400 tests, 40 files (main: 342/32).

### Fixed — CI actually runs

- **The workflow files had never executed, ever**: GitHub Actions only reads workflows from the repository-root `.github/workflows`; SWARM's lived under `swarm-orchestrator/.github/` — zero runs exist for this repo despite Actions being enabled in the GitHub UI. Relocated `ci.yml`/`deps.yml`/`release.yml` (plus `CODEOWNERS` and the issue templates) to the repo root and repointed every path-sensitive step for the subdirectory layout: per-job `working-directory` defaults, `pnpm/action-setup`'s `package_json_file`, `setup-node`'s `cache-dependency-path`, `rust-cache` workspaces, step-level cargo working directories, and `tauri-action`'s `projectPath`.

### Added / Fixed — Evergreen dependency wave (44 verified upgrade rows)

- All 44 verified upgrade rows from the 2026-08-13 evergreen sweep, landed as 13 sequenced commits respecting every coupling rule, plus two review-wave commits. Headliners: **React canary** `5123b063-20260708` → **`22e4f993-20260811`** (with a stale exclude-hash rewrite), **Vite** `8.1.4` → **`8.2.1`** (`@vitejs/plugin-react` `6.0.5`, rolldown `1.2.4`), **Biome** `2.5.4` → **`2.5.8`** (`$schema` added; two small chore commits had already carried `main` from `2.5.3` to `2.5.4` immediately after 0.11.2 shipped), **Tailwind CSS** `4.3.2` → **`4.3.3`** (core + Vite plugin), a 14-package UI/state batch (`radix-ui`, `recharts`, `sonner`, `xyflow`, `elkjs`, the fontsource trio, `@testing-library/user-event`, `immer`, `jotai`, `zustand`, zod canary `20260812`, `@anthropic-ai/sdk` `0.116.0`), the `@xterm/xterm`/`addon-fit`/`addon-webgl` beta trio, **`motion`** `12.42.2` → **`13.1.0`** (major; sole breaking change — `@emotion/is-prop-valid` removal — verified inert in this codebase), the Tauri dialog/store plugin pair (npm + crate in lockstep), a `tokio`/`serde`/`anyhow`/`thiserror`/`uuid`/`rusqlite` batch (`serde_core` split verified aligned in `Cargo.lock`), **`dashmap`** `7.0.0-rc2` → **`6.2.1`** (owner's call: the maintained line over an abandoned release candidate; zero API delta, `update_state_if`'s CAS atomicity re-verified against 6.2.1's shard-lock source), **Rust toolchain** `1.98.0-beta` → **`nightly-2026-08-13`** (owner's call: rustc 1.99.0-nightly), **Node** `26.5.0` → **`26.7.0`** + pnpm `11.21.0` + Playwright `1.62.1`, and workflow environment pins synced across `ci`/`release`/`deps.yml`.
- **Found along the way: Biome 2.5.8 fixed a module-resolver panic that had been silently skipping `useTauri.ts`** from every formatting check — `main`'s `biome ci` had been reporting green while actually checking only 163 of the repo's 165 files. This wave formats the previously-unmasked file so the gate checks what it claims to check.
- Gates (independently re-run by the reviewer): `pnpm exec biome ci .` exit 0 · typecheck clean · 342/342 tests (delta vs. pre-wave main: zero) · `cargo fmt --check` · `cargo clippy --all-targets -- -D warnings` · cargo test 92 unit + 16 doctests · e2e 3/3.

---

## [0.11.2] - 2026-07-15

### Post-release polish

### Added

- **Native alert notifications:** an Alerts toggle (off by default) mirrors every alert toast as a native OS notification via the previously-uncalled `send_notification` command — visible even when the app is in the background
- **Configurable worker registry cap:** the backend's 64-worker limit is now a real setting — `set_max_workers` validates (1–256), persists to `swarm-config.json`, applies immediately to new spawns (running workers are never evicted), and is re-applied on launch; the command validates → persists → applies, so a failure always leaves the live cap unchanged

### Fixed

- **Command palette search works:** `filter={false}` had switched off the machine's multi-strategy scorer entirely, so typing never filtered anything and the most-used command stayed first regardless of the query; items now pass their visible label as the scored value, frecency presorts the empty-query order, and the dialog remounts per open cycle (the machine's search state survives close while the input resets — a stale query silently corrupted the next open)
- **App settings hydrate by merging over defaults**, so settings persisted by older versions don't surface newer keys as `undefined`

### Feedback Batch 1 + follow-up cleanups

Fixes every defect from the 2026-07-10 owner feedback session, wires two previously-inert feature surfaces end-to-end, and promotes the most-wanted hardcoded constants into real settings.

### Fixed

- **Memory metrics use real hardware totals:** the backend now transmits `memory_total_mb` (from `sysinfo`), replacing four independent hardcoded 16 GB denominators — no more "Memory usage critically high: 216%" on large machines; one shared `memSeverity`/`memoryAvailableMb` helper (`src/lib/memory.ts`) guards divide-by-zero until the first real total arrives
- **AI configuration works in packaged builds:** new `read_config`/`write_config` Tauri commands persist to `swarm-config.json`, and Settings gains a masked API Key field — the AI chat key path previously invoked commands that did not exist
- **Workers Graph no longer hangs on "Computing layout...":** the ELK layout engine runs inside its own worker without the nested-worker spawn that crashed on module evaluation; worker failures surface as an error state with a 10s watchdog, StrictMode replay and rAF starvation (occluded/minimized windows) are handled, and superseded layout runs are ignored via a run token
- **Model picker renders from the shared catalog:** Fable 5 and Mythos 5 (with a "Requires Project Glasswing" badge on its own row) are selectable everywhere; context/output labels derive from catalog data; the Rust client never sends sampling parameters and surfaces `stop_reason: "refusal"` instead of rendering a blank reply
- **Particle background diagnostics:** each silent WebGPU failure gate (missing `navigator.gpu`, null adapter, null context) warns once with the specific reason; canvas stacking fixed so a successful init renders behind content
- **AI chat model dropdown escapes the toolbar:** portaled to `document.body` with position tracking, keyboard focus handling preserved
- **Charts cap at the trailing 20 samples** (`MAX_CHART_POINTS`/`lastN`): long-lived sessions no longer compress every chart into noise; AI token-usage records prune to the trailing 60s rate window
- **GPU Frame Time Overlay setting actually works:** the Settings toggle and the status bar's Hide/Show GPU button now share one persisted atom (the toggle was dead); theme storage migrated to a v2 key so existing installs keep their particles preference and regain the readout
- **Title Case everywhere:** all user-facing strings — labels, toasts, errors, full sentences — follow the owner's Title Case convention, with worker-count pluralization centralized
- **Pill component consolidation:** one `Pill` with size/tone variants replaces every ad-hoc chip; interactive controls (e.g. Kill) are real buttons
- **Tools, Logs, and Workspace pages are reachable again** via new command-palette navigation entries (no code path set the page atom to them)
- **Dead IPC wrappers removed:** `startAiStream`/`cancelAiStream`/`searchHistory` pointed at backend commands that were never registered

### Added

- **Tools run end-to-end:** AI chat sends built-in + custom tool schemas with every request and executes tool calls in a capped agentic loop (execute → `tool_result` → continue); custom tools persist via the settings store, run their scripts in a sandboxed Blob Worker (off-thread, no Tauri IPC, hard 10s termination), and enforce the API's `^[a-zA-Z0-9_-]{1,64}$` name contract at save, hydrate, and request assembly; turns are cancellable at every await boundary (Cancel/unmount/queue-dequeue)
- **Settings catalog:** alert cooldown, auto-snapshot interval, log retention cap, AI concurrent stream limit, chat history worker cap (all live-wired, committed on blur/Enter with clamping), remappable keybindings for the command palette / graph toggle / performance overlay (with duplicate-assignment guard), a Check For Updates button, and an update-check-on-launch toggle

### Phase 1: ordered event core

Replaces the legacy per-channel event system with a single ordered channel. Every backend event -- worker, session, AI streaming, metrics, logs, bus messages -- now flows through one `swarm://events` Tauri channel as a `{ seq, ts, type, payload }` envelope, assigned by a single-writer `OrchestrationEngine` running on its own thread, so wire order is total across every event type.

- **Single-writer engine:** `OrchestrationEngine` (`src-tauri/src/orchestration/engine.rs`) owns one dedicated writer thread that every `emit_event()` call is routed through; it assigns the monotonic `seq`, persists per policy, and emits -- eliminating the possibility of two threads racing to claim the same sequence number
- **SQLite append-only log:** events are persisted to `<app-data>/swarm-events.db` (WAL mode, `events(seq PRIMARY KEY, ts, type, payload) STRICT`); sequence numbering resumes from the log's max `seq` across restarts
- **Persistence policy:** `worker_output`, `system_metrics`, and `system_log` are high-frequency telemetry -- they consume a `seq` and flow live but are never written to the log. Every other type (`worker_spawned`, `worker_killed`, `worker_state`, `session_created`, `session_deleted`, `ai_stream_delta`, `ai_stream_settled`, `bus_message`) persists
- **`ai_stream_settled` receipt:** a new terminal event emitted exactly once per AI request, after the final `ai_stream_delta`, on both success (`status: "ok"`) and failure (`status: "error"`, with `error` set) -- the receipt pattern that replaces inferring completion from a stream event's `done` flag. (Frontend consumption is not yet wired to a UI -- this lands the contract.)
- **`events_since(after_seq)`:** a new IPC command returning persisted envelopes ascending, capped at 5000 rows per call, for gap backfill and replay
- **Frontend event bus:** `src/lib/event-bus.ts` replaces all `listen()`-per-channel call sites with `connectEventBus()` + `onEvent()`/`waitFor()`; envelopes are zod-validated, sequence gaps trigger an `events_since` backfill with a pending-buffer to preserve ordering against concurrently-arriving live events
- **Legacy per-channel events removed:** `worker:spawned`, `worker:killed`, `worker:output`, `worker:state`, `session:created`, `session:deleted`, `system:metrics`, `ai:stream_delta`, `system:log`, and `swarm://bus-message` are no longer emitted as distinct Tauri channels -- `emit_event()` now routes exclusively through the engine

### BREAKING CHANGE

Any code still calling `listen("worker:spawned", ...)` (or any other legacy per-channel name) against the Tauri backend will no longer receive events. Subscribe via `swarm://events` and the `type` field, or use `src/lib/event-bus.ts`'s `onEvent()`.

---

## [0.10.0] - 2026-07-09

### Evergreen Modernization Pass

Full dependency refresh to July-2026 latest across the entire stack, plus a batch of critical runtime fixes and new features surfaced along the way. Headline dependency bumps:

- TypeScript `6.0.0-dev` -> **7.0.2** (native compiler)
- Vite `8.0.0` -> **8.1.4** (Rolldown; `minify: "oxc"`; `manualChunks` replaced by `rolldownOptions.output.advancedChunks`)
- Vitest `3.x` -> **4.1.10**
- `@vitejs/plugin-react` `4.x` -> **6.0.3**, with React Compiler now running via `@rolldown/plugin-babel` + `reactCompilerPreset()` instead of a Babel-in-plugin-react pipeline
- `jsdom` `26.x` -> **29.1.1**
- Biome `2.4.6` -> **2.5.3**
- Tailwind CSS `4.2.1` -> **4.3.2**
- `@anthropic-ai/sdk` `0.78.0` -> **0.110.0**
- Tauri `2.10` -> **2.11.5** (CLI 2.11.4)
- `tokio` `1.50.0` -> **1.52.3**
- `sysinfo` `0.35.x` -> **0.39.6**
- Rust toolchain `1.95.0-beta` -> **1.98.0-beta**
- Node.js `25.8.1` -> **26.5.0**
- Package manager: **npm -> pnpm 11.11.0** (pinned via `packageManager` in `package.json`; every script and CI workflow now runs through pnpm)
- `framer-motion` -> **`motion` 12.42.2** (the package was renamed upstream; there is no `framer-motion` dependency anymore)

### Fixed

- **Immer MapSet in production:** `enableMapSet()` is now called unconditionally at module load (`main.tsx` and each store that models domain data as `Map`/`Set`), not only reachable in dev/test paths -- Map/Set-backed Zustand stores now work correctly in production builds
- **Fonts actually load:** Migrated from a `public/fonts` static asset directory (which had gone stale) to the `@fontsource-variable/{jetbrains-mono,syne,dm-sans}` packages, so the three variable fonts are guaranteed to load and stay in sync with their declared versions
- **Post-process pipeline await bug:** WebGPU post-processing pipeline creation now correctly awaits `createRenderPipelineAsync`/`createComputePipelineAsync` end-to-end instead of racing pipeline use against in-flight compilation
- **Resize-observer virtualization:** Virtualized lists (`SessionList`, `FileTree`, `LogViewer`) now recompute visible ranges correctly on container resize via `@crimson_dev/use-resize-observer`
- **AI stream error termination:** The AI client now always emits a terminal `ai:stream_delta` event with `done: true` for a given `requestId`, even on network failure, malformed SSE, or a stream that ends without `message_stop` -- the frontend can no longer be left waiting on a request that never resolves
- **Bus contract unification:** `bus_send` no longer emits `swarm://bus-message` directly; delivery to the frontend happens exclusively through the background task spawned by `bus_subscribe`, guaranteeing each message reaches the frontend at most once in one consistent shape
- **TOCTOU-safe pause/resume:** Worker state transitions now go through `WorkerRegistry::update_state_if`, an atomic compare-and-set, closing a race window where a separate read-then-write could clobber a concurrent state change
- **Atomic session writes + fs permissions:** Session persistence writes are atomic, and `src-tauri/capabilities/default.json` now scopes write/remove/rename permissions to `$APPDATA/**` and `$HOME/.swarm/**` (reads remain broader, under `$APPDATA/**` and `$HOME/**`, to support workspace browsing)
- **GPU buffer clamp + per-frame texture reuse:** Particle and post-processing GPU buffers/textures are allocated once at a fixed `maxParticles`/canvas size and reused every frame, instead of being reallocated per frame; the adaptive particle count is clamped to `[2,000, 50,000]`
- **Honest charts:** Metrics charts render only real telemetry (`sysinfo` CPU/memory, worker counts) -- no synthetic/placeholder series remain in the shipped charts
- **TopBar live count:** The TopBar worker/session count now reflects live store state instead of a stale snapshot

### Added

- `WorkerAIPanel` is now mounted on the Workers page -- a combined terminal + AI chat split view per worker, with tool execution routed through the worker's PTY
- Tool-call display: AI tool calls and their results render inline in the chat stream
- `session_add_worker` Tauri command -- registers a worker against a session's `workerIds` list, auto-saving to `sessions.json`
- Per-worker metrics: `get_metrics` now returns a `perWorker` array (workerId, pid, cpuPercent, memoryBytes) sourced from a single shared `sysinfo::System` (`SharedSystem`), alongside the existing aggregate counts
- Update signing is fully configured: Ed25519 keypair generated, public key set in `tauri.conf.json`, CI release workflow (`release.yml`) signs artifacts via the `TAURI_SIGNING_PRIVATE_KEY` secret

### Removed

- Dead code: `src/lib/{agent-loop,diff,replay,test-utils,token-costs}.ts` and the `src/lib/providers/` multi-provider registry (the app is Anthropic-native via `src/lib/anthropic.ts`)
- Dead components: `DiffViewer`, `ReplayControls`, `ReplayTimeline`, `Drawer`, `ScrollArea`, `WorkerAnalytics`, `WorkerCard` -- the session replay feature they supported was removed as dead code
- `rayon` removed from `Cargo.toml` (unused; sequential aggregation under `spawn_blocking` is cheaper than parallel dispatch overhead at the 64-worker cap)
- `vaul` removed from `package.json` (no longer used now that `Drawer` is gone)

---

## [0.9.9] - 2026-03-16

### Changed
- Final integration verification pass across all 100+ files
- Pinned all Cargo.toml dependency versions exactly
- Removed CSP `unsafe-inline` from style-src
- Narrowed Tauri capability permissions
- Added Biome domain rules for React and test files
- Version bump to release candidate

### Fixed
- Fixed AbortSignal propagation through provider abstraction layer
- Fixed remaining floating promises and unstable useEffect dependencies

---

## [0.9.8] - 2026-03-16

### Security Audit
- Removed all manual `useMemo`/`useCallback` (112 instances) for React Compiler compliance
- Replaced `std::sync::Mutex` with `parking_lot::Mutex` throughout Rust backend
- Pinned all dependency versions exactly (zero ranges)
- Redacted API key from Debug/Serialize derives
- Added reqwest timeout configuration (120s request, 10s connect)
- Wrapped all blocking lifecycle functions in `spawn_blocking`
- Added `CancellationToken` with `tokio::select!` for metrics loop shutdown
- Added `JoinSet` for AI queue task lifecycle management
- Converted unbounded channels to bounded (PTY: 4096, AI queue: 256)
- Added `AbortSignal` propagation through streaming pipeline
- Removed all light mode CSS (dark-only mandate)
- Added virtualization to SessionList and FileTree
- Added search debouncing to LogFilter
- Replaced `globalThis.confirm` with Tauri native dialog
- Migrated `atomWithStorage` to Tauri plugin-store backend
- Created LICENSE (MIT) and SECURITY.md
- Fixed CHANGELOG formatting and milestone alignment
- Added frontend test step to CI workflow
- Barrel distortion chromatic aberration in WebGPU post-processing
- Async WebGPU pipeline creation

---

## [0.9.7] - 2026-03-14

### Added

- Comprehensive `///` doc comments on every public function, struct, enum, trait, and module across all 23 Rust source files
- Module-level `//!` documentation with architecture diagrams and data flow descriptions
- `# Arguments`, `# Returns`, `# Errors`, and `# Examples` sections following Rust doc conventions
- README.md complete rewrite with architecture diagram, tech stack table, project structure, and milestone status
- CHANGELOG.md documenting all milestones from 0.0.1 through 0.9.7
- `docs/architecture.md` -- system architecture deep dive
- `docs/api.md` -- Tauri IPC command reference with parameters, return types, errors, and examples
- `docs/contributing.md` -- development setup, code standards, commit conventions, and PR process

---

## [0.9.6] - 2026-03-14

### Added

- Cross-platform build verification (Windows, macOS ARM64, macOS x86_64)
- Platform-specific PTY shell defaults (PowerShell on Windows, bash on Unix)
- Target triples in `rust-toolchain.toml` (`x86_64-pc-windows-msvc`, `aarch64-apple-darwin`, `x86_64-apple-darwin`)

---

## [0.9.5] - 2026-03-14

### Changed

- Comprehensive error boundary coverage across all page shells
- Graceful degradation for WebGPU context loss with automatic recovery
- Retry logic hardening for AI streaming failures with exponential backoff
- PTY spawn error recovery with user-facing diagnostic messages

---

## [0.9.4] - 2026-03-14

### Added

- ARIA attributes for all interactive components
- `aria-hidden` on decorative WebGPU canvas
- Keyboard navigation support for command palette, graph controls, and context menus
- `prefers-reduced-motion` media query integration across all animations

---

## [0.9.3] - 2026-03-14

### Changed

- Memory optimization: eliminated unnecessary clones in worker registry iteration
- Reduced allocation pressure in PTY output bridge (4KB buffer with zero-copy forwarding)
- Session manager uses `DashMap::get()` with clone instead of full iteration where possible

---

## [0.9.2] - 2026-03-14

### Changed

- Startup time optimization: deferred AI client initialization to `setup` closure
- Lazy-loaded WebGPU device initialization with fallback detection
- Session restore runs synchronously in setup to avoid race conditions

---

## [0.9.1] - 2026-03-14

### Changed

- Vite 8 bundle optimization with Rolldown bundler
- Tree-shaking analysis via `VITE_BUNDLE_ANALYZE=true`
- Release profile: `lto = "fat"`, `codegen-units = 1`, `panic = "abort"`, `strip = "symbols"`

---

## [0.9.0] - 2026-03-14

### Changed

- Performance audit and optimization pass across frontend and backend
- Zustand `subscribeWithSelector` for minimal re-renders
- Jotai atoms with `atomWithStorage` for persistent UI state
- React 19 Compiler integration via `babel-plugin-react-compiler`
- Hash imports (`#components/*`, `#store/*`, `#lib/*`, etc.) for clean module resolution
- Recharts `isAnimationActive={false}` globally for render performance
- `tokio::task::spawn_blocking` for all rayon-based computations

---

## [0.8.x] - 2026-03-14

### Added

- Real-time metrics dashboard with CPU, memory, throughput, and AI queue charts
- MetricCard component with sparkline trend indicators
- CPUChart, MemoryChart, ThroughputChart, AIMetricsChart, AIQueueChart components using Recharts
- AlertRule system with configurable thresholds and notification channels
- PerformanceOverlay dev tool: React render count, Zustand selector count, GPU frame time (Ctrl+Shift+P toggle)
- Background metrics collection loop (500ms interval) with `spawn_blocking` for rayon
- `get_metrics` Tauri command for on-demand metrics snapshot
- System metrics event (`system:metrics`) with cpu, memory, worker count, and AI request rate

---

## [0.7.x] - 2026-03-14

### Added

- Session management system with DashMap-backed CRUD operations
- Persistent session storage via `tauri-plugin-store` (`sessions.json`)
- Auto-save on session create/delete with crash recovery on startup
- Session components: SessionList, SessionCard, SessionActions (export/import)
- HistorySearch component for filtering session history
- TemplateSelector for creating sessions from predefined templates
- Snapshot/restore functionality for workspace state
- Session export/import via JSON files with `tauri-plugin-dialog`

---

## [0.6.7] - 2026-03-14

### Added

- ParticleBackground conditional wrapper with WebGPU support detection
- `isWebGPUSupported()` gate, `themeAtom.particlesEnabled` toggle, and `reducedMotionAtom` respect
- Solid OKLCH background fallback (`oklch(0.06 0.02 220)`) when particles are disabled

---

## [0.6.x] - 2026-03-14

### Added

- WebGPU device initialization with adapter selection, context loss recovery, and graceful fallback (`lib/webgpu.ts`)
- GPU-driven particle compute pipeline: 64-workgroup WGSL compute shader for position/velocity update (`lib/particles.ts`)
- Instanced billboard render pipeline: WGSL vertex/fragment shaders with additive blending
- Post-processing pipeline: bloom, chromatic aberration, vignette via ping-pong framebuffers (`lib/postprocess.ts`)
- `useWebGPU` hook: device lifecycle, canvas resize handling, context loss recovery, reduced-motion integration
- `useParticleSync` hook: maps worker states to particle simulation parameters (delta hue, spawn rate, turbulence)
- ParticleCanvas component: fixed `z-index: 0` WebGPU canvas, `pointer-events: none`, `aria-hidden`
- All WGSL shaders use OKLCH-derived color calculations

---

## [0.5.x] - 2026-03-14

### Added

- AIChat component: full chat interface with message input, scroll-to-bottom, per-worker conversations
- AIMessageStream component: streaming AI response renderer with markdown code blocks, OKLCH syntax highlighting, cursor animation
- AIQueue component: visual queue display with position indicators, priority badges, estimated wait times, cancel functionality
- ModelSelector component: Claude opus/sonnet/haiku selector with context window, cost estimate, capability badges
- ToolCallDisplay component: animated accordion for tool name, input, and result with Framer Motion expand/collapse
- MessageHistory component: per-worker conversation history with virtualized list and IntersectionObserver
- WorkerAIPanel component: combined terminal + AI chat split view with tool execution routed through worker PTY
- AI error classification system with retry logic and rate-limit handling (`lib/ai-error.ts`)
- Swarm tool framework: Zod v4 schema-driven tool definitions with Anthropic API conversion (`lib/tools.ts`)
- Message history Zustand store with per-worker conversation persistence (`store/message-history.ts`)

---

## [0.4.x] - 2026-03-14

### Added

- WorkerGraph component: full interactive DAG topology with XYFlow ReactFlow, minimap, and background grid
- WorkerNode custom node: status-colored borders, sparkline badges, selection ring with OKLCH glow
- DependencyEdge custom edge: animated dash-flow SVG markers with OKLCH stroke
- GraphControls component: zoom/fit/reset controls with Framer Motion button animations
- GraphContextMenu component: right-click context menu for worker actions (restart, kill, inspect, detach)
- WorkerDetail panel: expanded worker info with uptime, message count, tool calls, error metrics
- WorkerCard component: per-worker stats card with inline Recharts sparklines
- WorkerAnalytics component: detailed per-worker analytics (messages/time, tool calls, error timeline) using Recharts
- WorkerTerminal component: xterm.js terminal with WebGL2 renderer per worker
- StatusBar component: fixed bottom bar with AI cost estimate, worker count, system status
- Shared Recharts OKLCH theme: axis props, grid props, tooltip styles, legend styles (`lib/chart-theme.ts`)
- Dedicated metrics chart components: CPUChart, MemoryChart, ThroughputChart, AIMetricsChart, AIQueueChart, MetricCard
- PerformanceOverlay dev tool: React render count, Zustand selector count, GPU frame time (Ctrl+Shift+P toggle)
- Session components: SessionList, SessionCard, SessionActions (export/import), HistorySearch, TemplateSelector
- All Recharts components use `isAnimationActive={false}` for performance

---

## [0.3.9] - 2026-03-14

### Added

- Command Palette component (`modern-cmdk`) with frecency-ranked sorting
- Graph components: WorkerNode, DependencyEdge, GraphControls (XYFlow + ELK)
- SplitPane resizable layout with persistent pane sizes via Jotai + `plugin-store`
- Drawer component wrapping vaul with snap points and OKLCH styling
- MetricsChart real-time dashboard using Recharts with OKLCH stroke colors
- AI streaming integration: `useAiStream` hook, Anthropic SDK async generator, Zod v4 tool schema conversion
- Worker lifecycle hooks: `useWorker` with React 19 `useOptimistic`, `useSpawnWorker`
- Session CRUD hooks: `useSession`, `useSessionActions` with IPC-backed operations
- ELK layout Web Worker with topology fingerprinting for diff-based re-layout
- JSON syntax highlighter with full OKLCH token palette

---

## [0.2.x] - 2026-03-14

### Added

- Tauri event system: typed `SwarmEvent` enum with `snake_case` type tags and `camelCase` payload fields
- Worker PTY bridge: `portable-pty` 0.9.0 spawn with Tokio mpsc output streaming
- Worker registry: `DashMap`-backed concurrent store with rayon aggregate metrics
- Worker lifecycle operations: spawn, pause, resume, kill with event emission
- Session manager: `DashMap`-backed CRUD with persistent store via `tauri-plugin-store`
- AI client: `reqwest`-based Anthropic Messages API with SSE streaming
- AI priority queue: `BinaryHeap` with `Semaphore`-based concurrency limiting (default: 3 concurrent)
- Metrics collection loop: 500ms interval with `spawn_blocking` for rayon
- Structured tracing: JSON output in release, pretty output in debug, `RUST_LOG` env override
- Error system: `thiserror` 2.0.18 with custom `Serialize` impl for IPC transport (10 error variants)
- Application entry point: Tokio multi-thread runtime scaled to CPU cores

---

## [0.1.x] - 2026-03-13

### Added

- OKLCH design token system with `@theme`, `@utility`, `@variant` blocks
- CSS `@property` typed custom properties for GPU-accelerated animations
- Reduced motion media query with universal animation/transition override
- Component CSS: buttons, inputs, badges, scroll areas, command palette
- Animation keyframes: pulse-ring, glow-breathe, dash-flow, scan-line, shimmer, spinner
- Zustand 5 stores: workers, sessions, AI queue, system metrics (all with `subscribeWithSelector` + immer)
- Jotai atoms: UI state, frecency scoring, theme persistence
- Zod v4 schemas: Worker, Session, MetricPoint, SystemMetrics, AiMessage, AiQueueItem
- `useTauri` hooks: `useInvoke`, `useListen` with proper cleanup
- `useTheme` hook: `prefers-reduced-motion` media query sync
- `useTerminal` hook: xterm.js with WebGL2 renderer, FitAddon, resize observer integration
- Tauri IPC wrapper: typed `invoke`/`listen` functions for all backend commands
- File system utilities: atomic write pattern, scoped read/write, JSON helpers
- Test utilities: mock invoke/listen, mock event emitter, mock worker store
- UI components: Button (ref as prop), Badge, Input, ScrollArea, Spinner, Toast (Sonner), ErrorBoundary
- Layout components: AppShell (CSS Grid + GSAP startup), Sidebar, Topbar
- Page shells: Dashboard, Workers, Sessions, Metrics, Settings

---

## [0.0.1] - 2026-03-13

### Added

- Initial project scaffold with Tauri 2.10, React 19 canary, TypeScript 6.0-dev
- Complete dependency manifest with exact pinned versions
- Vite 8.0.0 stable build configuration with Rolldown bundler
- Biome 2.4.6 linting and formatting configuration
- Rust 1.95.0-beta workspace with all crate dependencies
- OKLCH-based CSS architecture with Tailwind CSS 4.2.1
- Zustand 5, Jotai 2.18.1, and Zod v4 state management setup
- Rust module skeleton with DashMap worker registry
- CI/CD workflows for lint, build, release, and dependency auditing
- Cosmic Nexus application icon at multiple resolutions
