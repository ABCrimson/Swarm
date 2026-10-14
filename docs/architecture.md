# Architecture

> The current-state reference for SWARM Orchestrator: how the system is put together **at this
> commit**. Why it is shaped this way, and what each part replaced, is in the decision records under
> [`docs/adr/`](adr/README.md); links below point at them. Wire contracts (command arguments, event
> payloads, `swarmd` frames) are in [api.md](api.md), the operator guide for the daemon is in
> [daemon.md](daemon.md), and the module docs (`//!`) in the Rust source are the finest-grained
> description of each component.

## Contents

- [System overview](#system-overview)
- [Repository layout](#repository-layout)
- [Backend](#backend)
  - [The command registry](#the-command-registry)
  - [Ordered Event Core](#ordered-event-core)
  - [Event catalogue](#event-catalogue)
  - [Workers and PTYs](#workers-and-ptys)
  - [Worktree Isolation](#worktree-isolation)
  - [Ship Chain](#ship-chain)
  - [The Causal Record](#the-causal-record)
  - [Adapter Layer](#adapter-layer)
  - [Message Bus](#message-bus)
  - [Sessions, config and the data directory](#sessions-config-and-the-data-directory)
  - [Metrics](#metrics)
  - [Errors](#errors)
- [Desktop shell](#desktop-shell)
- [Runtime Modes](#runtime-modes)
- [Frontend](#frontend)
  - [Boot](#boot)
  - [Event bus and transport](#event-bus-and-transport)
  - [State](#state)
  - [Pages and components](#pages-and-components)
  - [Causality Graph](#causality-graph)
  - [AI chat paths](#ai-chat-paths)
  - [WebGPU background](#webgpu-background)
- [Security boundaries](#security-boundaries)
- [Known gaps](#known-gaps)

---

## System overview

SWARM Orchestrator supervises many coding agents at once. A **worker** is a shell on a real
pseudo-terminal, optionally given its own git worktree, optionally driving a provider agent (Claude
Code or Codex) over a structured protocol. Everything that happens is an **event** on one ordered
stream backed by a SQLite log, which the UI renders, a PR body cites, and a headless daemon replays to
remote clients.

It is a Tauri 3 desktop app (alpha, `tauri-runtime-wry`) with a React 19 frontend, and the same Rust
core also runs headless as `swarmd`:

```text
   ┌─────────────────────────── React 19 frontend (src/) ───────────────────────────┐
   │  pages · components · hooks · Zustand/Jotai stores · event bus · WebGPU canvas  │
   └───────────────┬───────────────────────────────────────────────┬─────────────────┘
        Tauri IPC  │ invoke() / listen("swarm://events")           │ WebSocket /ws  (pnpm build:web)
   ┌───────────────┴──────────────┐                 ┌──────────────┴───────────────┐
   │ swarm-desktop  (src-tauri/)  │                 │ swarmd  (crates/swarmd)      │
   │ forwarders · plugins · window│                 │ auth · replay · rpc · UI dir │
   └───────────────┬──────────────┘                 └──────────────┬───────────────┘
                   └──────────────────┬───────────────────────────┘
                     ┌────────────────┴────────────────┐
                     │ swarm-core  (crates/swarm-core) │  Tauri-free
                     │ Runtime · Registry · engine · … │
                     └─────────────────────────────────┘
```

Principles that hold throughout:

1. **Rust owns the mutable state** (workers, sessions, the scheduler, the event log). The frontend is
   a projection of the event stream plus snapshot commands, never a second source of truth.
2. **One ordered stream.** Every backend event gets a `seq` from a single writer; consumers detect gaps
   and heal them from the log ([ADR-0003](adr/0003-single-writer-ordered-event-log.md)).
3. **Measured, not inferred.** Causality, ship evidence and capabilities are recorded or observed;
   nothing is guessed to make a view look complete
   ([ADR-0005](adr/0005-provenance-recorded-never-inferred.md)).
4. **Nothing blocks an async thread.** Git, PTY writes, SQLite and process reaping run on
   `spawn_blocking` or on named dedicated threads.
5. **Wire conventions.** Command names and event `type` tags are `snake_case`; payload and argument
   fields are `camelCase`; UI strings are Title Case.

## Repository layout

| Path | What it is |
| --- | --- |
| `crates/swarm-core/` | The Tauri-free domain library. No `tauri*` dependency (CI checks `cargo tree`). |
| `crates/swarmd/` | The headless daemon: `auth`, `cli`, `ws`, `serve_ui`, and per-user service units in `service/`. |
| `src-tauri/` | `swarm-desktop`, the Tauri shell: `lib.rs`, `startup.rs`, `lifecycle.rs`, `dialog_grants.rs`, `build.rs` (ACL manifest), `commands/{mod,native,command_list}.rs`, `capabilities/default.json`, `tauri.conf.json`. |
| `src/` | The frontend. `boot.ts` → `main.tsx` → `App.tsx`; `components/`, `hooks/`, `lib/`, `store/`, `pages/`, `workers/elk.worker.ts`, `styles/`, `test/`. |
| `e2e/` | Playwright specs against the web build; no Tauri backend. Chromium by default, WebKit and Firefox as opt-in projects; CI runs the suite with `--shuffle` ([e2e.md](e2e.md)). |
| `scripts/`, `site/` | The React Compiler gate (`check-react-compiler.ts`), `sync-reference-repos.ts` (pinned upstream sources into the gitignored `.repos/`) and the documentation site build. |
| `docs/` | This file, [api.md](api.md), [daemon.md](daemon.md), [adr/](adr/README.md), and the rest. |

The Rust workspace (`Cargo.toml`, `Cargo.lock`, `clippy.toml`, `deny.toml`, `rust-toolchain.toml`) is
at the repository root; run cargo from there. The frontend uses Node subpath imports
(`package.json` `imports`): `#components/*`, `#store/*`, `#lib/*`, `#hooks/*`, `#pages/*`,
`#styles/*`, `#test/*`.

---

## Backend

`swarm-core` modules:

| Module | Role |
| --- | --- |
| `runtime` | `Runtime::start` / `shutdown`: the one constructor both shells call. |
| `commands` | The command `Registry`, `RemotePolicy`, and one handler module per area. |
| `events`, `orchestration` | The `SwarmEvent` enum and `EventSink`; the single-writer `OrchestrationEngine` and its SQLite `EventLog`. |
| `worker` | `handle` (config, state), `lifecycle` (spawn, pause, resume, resize, input, kill), `pty`, `proc` (piped children and the NDJSON framer), `registry`. |
| `agent` | `adapter` (trait pair, capabilities), `claude_code`, `codex`, `scheduler`, `registry`. |
| `git` | `cli` (runner, probe), `redact`, `repo`, `worktree`, `remote`, `ship/*`, `causal`. |
| `session` | `manager` (in memory), `persist` (`sessions.json`). |
| `bus` | `channel` (topic registry), `router` (a send becomes an event). |
| `config`, `state_file`, `paths`, `clock`, `error`, `lock`, `metrics`, `protocol` | Settings file, atomic JSON files, data-directory paths, epoch timestamps, `AppError`, the single-instance lock, sampling, `swarmd` frames. |

**Start** (`Runtime::start`): take the single-instance lock ([ADR-0025](adr/0025-single-instance-lock.md));
open the event log and start the writer; build the worker registry, session manager, bus and router;
load `sessions.json`; apply the persisted `max_workers`; start a background task that probes git and
prunes worktrees of `default_repo_root`; start the metrics loop; build both adapters, the agent session
registry and the scheduler; apply the persisted `agent_concurrency`.
**Shutdown** (`Runtime::shutdown`, once, on exit): stop the metrics loop, shut every live agent
session down (in-flight turns get their settlement), then drain the event writer and record the exact
head seq. `Runtime::shutdown` kills no PTY worker; `swarmd` stops them itself first (see [Runtime Modes](#runtime-modes)).

### The command registry

Every handler's logic exists once, in `swarm_core::commands::*`, keyed by name in a `Registry` with a
declared `RemotePolicy` ([ADR-0021](adr/0021-command-registry-remote-policy.md)). The desktop shell
calls `Registry::dispatch`; `swarmd` calls `Registry::dispatch_remote`, which enforces the policy.
Arguments are one JSON object (omitted or `null` becomes `{}`; anything else is refused). There are
**36** registry commands, plus **2** native ones that exist only in the desktop shell
(`check_for_updates`, `send_notification`; `NATIVE_ONLY`).

| Area | Commands | Remote policy |
| --- | --- | --- |
| Workers | `spawn_worker`, `pause_worker`, `resume_worker`, `kill_worker`, `list_workers`, `worker_input`, `resize_worker`, `set_max_workers` | Allowed |
| Git and ship | `validate_repo_root`, `git_ship_preflight`, `git_stage_commit`, `git_push`, `ship_compare_url`, `ship_context` | Allowed |
| Sessions | `create_session`, `delete_session`, `list_sessions`, `get_session`, `session_add_worker`, `session_remove_worker` | Allowed |
| Provider agents | `agent_turn_started`, `agent_spawn`, `agent_send_turn`, `agent_cancel`, `agent_shutdown`, `agent_probe`, `agent_permission_respond`, `set_agent_concurrency` | Allowed |
| Config | `read_config`, `write_config` | SecretFiltered |
| Files | `read_file`, `write_file` | Denied |
| Metrics, log, bus | `get_metrics`, `events_since`, `bus_send`, `bus_list_channels` | Allowed |

`Allowed` includes `spawn_worker` and `worker_input`: an authenticated remote client runs commands as
the daemon's user. That is the product, not a gap. A contract test pins the `Denied` and
`SecretFiltered` sets by name, and the desktop shell's forwarder list is compared with `Registry::keys()`
and `NATIVE_ONLY`.

### Ordered Event Core

Every backend event passes through `OrchestrationEngine` ([ADR-0003](adr/0003-single-writer-ordered-event-log.md)):

```text
any thread/task ──EventSink::emit / emit_with / emit_awaiting_seq──▶ one FIFO channel
                                                                          │
                                         swarm-event-writer thread (the only seq writer)
                                          seq += 1; ts = now
                                          reserve seq block (past the reservation) ── fails ─▶ drop, no emit
                                          is_persistent(event)? ── yes ─▶ EventLog::append  (SQLite WAL)
                                                                            └─ fails ─▶ drop, no emit, system_log
                                          emit(DomainEvent)  ──▶ shell's closure ──▶ "swarm://events"
                                          head_seq = seq
                                          broadcast fanout (4096, lossy under lag)
                                          ack.send(seq)            (emit_awaiting_seq only)
```

- **Envelope:** `{ seq, ts, originWorker?, causeSeq?, type, payload }`; the optional fields are absent,
  not `null`.
- **Seqs** are unique and strictly increasing for the life of the data directory. The writer reserves
  them in blocks of 1024 in the log's `meta` table before issuing them, and that reservation is
  committed (flushed, see Durability below) before the first seq of the block is issued, so a process
  crash, an OS crash or a power loss (on storage that honours flushes) skips at most one block and
  never reuses a seq; a clean shutdown records the exact head. Persisted seqs therefore have gaps
  (ephemeral events consume seqs too).
- **Log:** `<data dir>/swarm-events.db`, SQLite in WAL mode with `synchronous=EXTRA` and `fullfsync`, schema
  version 2 on a `PRAGMA user_version` ladder whose rungs each run in a transaction: `events(seq PK, ts,
  type, payload, origin_worker, cause_seq) STRICT` with an index on `(type, seq)`, and `meta`. A
  database newer than the build is refused. The writer owns the only read-write connection; readers open their own read-only.
- **Persistence by exclusion** ([ADR-0004](adr/0004-persistence-by-exclusion.md)): never persisted are
  `worker_output`, `system_metrics`, `system_log`, `agent_turn_delta`, and `worker_input` whose
  `source` is `terminal`. Everything else is appended before it is emitted.
- **Fails closed** ([ADR-0034](adr/0034-persist-before-emit-fails-closed.md); `engine.rs`, "Failing closed"): an event whose seq cannot be reserved, or whose
  append fails, reaches no delivery path (neither the shell's `emit` closure nor the fanout), does not
  move `head_seq`, and drops its `emit_awaiting_seq` ack so the awaiting caller sees an error. A failed
  reservation rolls the seq counter back and the next event retries. A failed append leaves a one-seq
  gap that one ephemeral `system_log` error event explains, and clients backfill an empty page and
  skip it. So an event a client saw live is always readable from the log
  (`test_failed_persist_emits_nothing_and_holds_the_head`).
- **Durability** ([ADR-0039](adr/0039-event-log-flushes-every-commit.md)): the writer connection runs
  `synchronous=EXTRA` (FULL's WAL sync after every commit, and the level SQLite documents as durable if
  WAL is ever refused) and `fullfsync=1` (macOS otherwise calls a plain fsync that leaves data in the
  drive cache), and `EventLog::open` fails if SQLite reports anything weaker. A committed event append
  and a committed seq reservation therefore survive a process crash, an OS crash and a power loss, on
  storage that honours fsync/flush. Not guaranteed: a drive or filesystem that acknowledges a flush it
  has not performed; an event whose append had not committed when the process died (it was never
  emitted either); ephemeral events, which are never stored. Persist-before-emit orders the log write
  before the emit; it is not one atomic transaction with the effect the event describes. A PTY write, a
  git push or a provider turn can happen with no event recorded if the process dies between the effect
  and the append, and an event can be recorded for an effect that then fails. Consumers must treat the
  log as the record of what was announced, not proof the effect completed. The cost is one flush per
  persistent event on the writer thread, and ephemeral events queued behind it wait too
  ([Event Log Persistence](performance.md#event-log-persistence)).
- **Replay:** `events_since(afterSeq, limit?)` returns persisted rows after a seq, ascending, capped at
  (and defaulting to) 5000 per call. Clients use it for gap backfill; `swarmd` for connection replay.
- **Receipts:** a terminal outcome is its own event (`ship_settled`, `agent_turn_settled`), never a flag
  on a stream event; the frontend awaits it with `waitFor`.

#### Provenance: who populates it

`originWorker` is the **causer**, a payload's `workerId` the **subject**
([ADR-0005](adr/0005-provenance-recorded-never-inferred.md)). Only these paths stamp it:

| Path | `originWorker` | `causeSeq` |
| --- | --- | --- |
| Webview AI tool calls (`spawn_worker`, `kill_worker`, `run_command`, `write_file`) | the calling panel's worker | the turn's `agent_turn_started` seq |
| `bus_message` | the sender | whatever the caller cites (`bus_send` takes an optional `causeSeq`) |
| Terminal keystrokes (`worker_input`, `source: terminal`) | none (a human) | none |
| `worker_input` with `source: automation` | none | none; no shipped caller |
| Palette and UI actions, session CRUD | none | none |
| Ship commits (`commit_created`) | none | none |

### Event catalogue

27 event types, one `snake_case` tag each (`SwarmEvent` in `events/emitter.rs`; `swarm_event_tags!`
keeps the tag list exhaustive). Payload fields are `camelCase`; full shapes are in
[api.md](api.md#events).

| Type | Payload fields | Persisted |
| --- | --- | --- |
| `worker_spawned` | `workerId, name, pid, isolation` | yes |
| `worker_killed` | `workerId` | yes |
| `worker_output` | `workerId, data` | no |
| `worker_state` | `workerId, state` | yes |
| `worker_input` | `workerId, bytes, source, preview` (redacted; withheld when the input contains any control other than CR or LF (BS, DEL, TAB, ESC, C1 controls)) | not when `source` is `terminal` |
| `session_created` / `session_deleted` | `sessionId, name` / `sessionId` | yes |
| `session_worker_added` / `session_worker_removed` | `sessionId, workerId` | yes |
| `system_metrics` | `cpuPercent, memoryMb, memoryTotalMb, workerCount, timestamp` | no |
| `system_log` | `level, message, target, timestamp` | no |
| `bus_message` | `messageId, fromWorker, toWorker, topic, payload` | yes |
| `worktree_created` | `workerId, sessionId, repoRoot, worktreePath, branch, baseCommit` | yes |
| `worktree_removed` | `workerId, worktreePath, branch, disposition, headCommit, reason` | yes |
| `ship_progress` | `shipId, workerId, step, status, detail` | yes |
| `ship_settled` | `shipId, workerId, commitSha, pushedRef, prUrl, status, error` | yes |
| `commit_created` | `workerId, sha, branch, seqFrom, seqTo` | yes |
| `file_written` | `path, bytes` | yes |
| `agent_turn_started` | `workerId, model, requestId` | yes |
| `agent_session_started` | `workerId, provider, sessionKey, model, cwd, capabilities` | yes |
| `agent_turn_delta` | `workerId, turnId, blockIndex, kind, text` | no |
| `agent_block` | `workerId, turnId, blockIndex, kind, content` | yes |
| `agent_tool_call` / `agent_tool_result` | `workerId, turnId, toolUseId, name, input` / `…, isError, content` | yes |
| `agent_permission_request` | `workerId, turnId, requestId, tool, input, suggestedDecision, denialSubclass, message` | yes |
| `agent_turn_settled` | `workerId, turnId, status, error, costUsd, usage, durationMs, numTurns` | yes |
| `agent_session_exited` | `workerId, exitCode, signal` | yes |

`system_metrics` carries only measured values; nothing counts provider requests, so it has no request-rate field.

### Workers and PTYs

`WorkerRegistry` holds live workers in a `DashMap<Uuid, WorkerHandle>` (sharded locks) and the system
config (`max_workers`, default 64, range 1 to 256; `worktrees_root`) behind a `parking_lot::RwLock`.
`reserve()` admits a spawn against `max_workers` before anything is created and returns
`RegistryFull` when the registry is at capacity. State changes use `update_state_if`, a compare-and-set
under the entry's lock. Callers clone what they need (a PTY writer, the master) out of an entry before
any blocking call, so a blocked write can never stall a kill on the same shard.

A worker's state is `idle` (in the wire enum but never produced: a worker is `running` from
registration), `running`, `paused` (state only on every platform; no signal reaches the process), or
`error` (terminal: the shell exited on its own; the worker stays registered with its output and worktree
until it is killed).

The shell runs on a `portable-pty` pair (ConPTY on Windows). `spawn_pty` keeps the master for the
worker's life (it resizes the terminal and, on Windows, owns the pseudoconsole) and hands the slave to
the shell, then drops it. Two named threads per worker start parked and run only after `worker_spawned`
is emitted: `pty-<id8>` (blocking 8 KiB reads, UTF-8 decoded across chunk boundaries, emitted as
`worker_output`) and `pty-exit-<id8>` (polls the shell; a shell that exits by itself moves the worker
to `error`). On Windows the first output is a cursor-position query (`ESC [ 6 n`) that the terminal
must answer before the shell renders, which xterm.js does once attached.

`kill_worker` stops the worker's provider session before it touches the worker, so no provider runs
against a checkout being removed:

1. It marks the worker closing in the `AgentSessionRegistry`. From then on a new session attach
   (`agent_spawn`), a new turn (`agent_send_turn`) and every session lookup for the worker (turn
   dispatch, `agent_cancel`, `agent_permission_respond`) fail with ``Worker `<id>` is closing``
   (`AppError::WorkerClosing`). It then waits for any attach still in its handshake; each attach
   holds a permit from before its handshake until it registers its session, so the wait is bounded by
   the adapter's 30 s handshake plus that attach's own session teardown. An attach that finishes after
   the mark cannot register its session: it shuts the session down itself and reports no surviving
   worker.
2. It removes the worker's session, one a drained attach registered included, and shuts it down, so
   the provider process is stopped and reaped. A failed shutdown is logged and never fails the kill.
   It then waits for any other shutdown of that session still running (an overlapping kill's, or
   `agent_shutdown`'s): every removal goes through `take_session`, which counts a `SessionStop` until
   the shutdown ends.
3. It removes the worker from the registry, kills and reaps the shell, **then** releases the writer
   and master (on Windows dropping the master closes the pseudoconsole under the shell), then removes
   the worktree and emits `worktree_removed` and `worker_killed`. Only the shell is signalled.
4. It clears the closing mark; later calls for the worker get ``Worker `<id>` not found``.

When `kill_worker` returns, no provider session of the worker is registered, still handshaking or
still shutting down. A
turn still queued for the worker settles as an error when dispatched (no live session), and a turn in
flight is settled by the session's shutdown. `Runtime::shutdown` stops each worker's session the same
way (steps 1 and 2) without killing the worker.

### Worktree Isolation

A spawn with `repoRoot` set and `isolation` of `worktree` (the default) runs in its own `git worktree`
([ADR-0007](adr/0007-worktree-per-worker-system-git.md), [ADR-0008](adr/0008-worktree-removal-never-forces.md)):

```text
spawn_worker(config)
  reserve capacity ─▶ discover_toplevel(repoRoot) ─▶ head_sha
  ─▶ git worktree add -b swarm/<slug>-<id8>  <worktrees_root>/<repo>-<hash8>/w-<id8>   (CREATE_TIMEOUT)
  ─▶ git worktree lock  (reason: the worker id)
  ─▶ spawn_pty(cwd = worktree) ─▶ register ─▶ emit worker_spawned, then worktree_created
  any step failing ─▶ roll back the shell, worktree and unchanged branch; the spawn fails (no fallback cwd)

kill_worker(id)
  mark closing + wait for attaches ─▶ shut the provider session down
  ─▶ kill + reap shell ─▶ git worktree unlock ─▶ git worktree remove   (never --force; REMOVE_TIMEOUT)
  disposition: removed | preserved_dirty (git refused: modified or untracked files) | failed (anything else)
  removed and the branch tip == base_commit ─▶ git branch -d   (never -D)   else the branch stays
  emit worktree_removed, worker_killed
```

`worktrees_root` defaults to `~/.swarm/worktrees`. Every mutating call runs under `RepoLocks`, keyed by
the canonical repo toplevel, with one retry after 200 ms on lock contention. A startup `git --version`
probe requires 2.32 or newer (a `system_log` event reports otherwise), and a startup
`git worktree prune` runs against `default_repo_root`. With no `repoRoot` the spawn is unisolated, as
a plain shell at `cwd`. `WorkerConfig`: `name, shell, cwd, env, rows, cols, repoRoot, isolation`.

### Ship Chain

A finished worker becomes a real commit, a real push and a prefilled GitHub compare page, with no AI in
the mechanics ([ADR-0009](adr/0009-ship-chain-structural-guarantees.md)). The logic is
`swarm_core::git::ship`; `commands/git.rs` emits events and marshals arguments.

| Command | What it does |
| --- | --- |
| `git_ship_preflight(workerId, mode?)` | Read-only. `mode` is `all` (default) or `staged`. Eight refusal conditions become Title Case `blockers` and `canShip = false`: not the worktree's toplevel, primary checkout, detached `HEAD`, branch equals the base branch, protected branch (`main`, `master`, `develop`, `release/*`), no `origin`, unresolved merge conflicts, nothing to ship. Also returns the deny-list preview, diff stat, ahead/behind and whether the host supports a compare URL. |
| `git_stage_commit(workerId, shipId, message, mode, finalStep)` | Primary-checkout guard, then one `git status --porcelain=v2 -z` snapshot (conflicts refuse), the deny list, `git restore --staged` of denied paths, in `all` mode `git add` of an explicit `:(top,literal)` path list, an index re-check, then `git commit --file=- --trailer=…`. Emits `ship_progress` and `commit_created`. |
| `git_push(workerId, shipId, finalStep)` | Primary-checkout guard, live branch (detached, protected `main`/`master`/`develop`/`release/*` and the base branch refuse), `HEAD` sha, `git push --set-upstream --end-of-options origin refs/heads/<branch>:refs/heads/<branch>`. On success records `last_shipped_seq` and `last_shipped_commit` (the only writer). |
| `ship_compare_url(workerId, shipId, commitSha, pushedRef, title, body)` | `https://<host>/<owner>/<repo>/compare/<base>...<branch>?quick_pull=1&title=&body=`, capped at 6000 characters (the body is cut first, the title as a last resort, the path never). |

- Each command ends an attempt with exactly one `ship_settled`, on failure or on the call marked
  `finalStep` (`ship_compare_url` is always final). `nothingToCommit` from `git_stage_commit` settles
  nothing: the client recovers by pushing commits that already exist (rule **B2**, in `useShip`).
- Preflight is mode-aware: the deny-list preview and diff stat describe what `mode` would commit (rule
  **B3**; `setMode` refetches). The base branch is `origin/HEAD`, else `init.defaultBranch`, else
  `main`, never the primary checkout's current branch.
- **Deny list:** basename (case-insensitive) starting `.env` or `id_rsa`, ending `.pem` or `.key`;
  `secret` anywhere in the path; a file over 5 MiB; an untracked `.claude/settings.json`. Denied paths
  are returned as `skipped[]` with a Title Case reason and never committed.
- **Trailers:** `Swarm-Seq-Range: <from>..<to>` (omitted when unknown or degenerate) and the configured
  `Co-Authored-By` (`shipCoAuthoredBy`; dropped if it contains a newline). The range `(seqFrom, seqTo]`
  runs from the worker's last shipped seq, or its `worktree_created` row, to the log's current maximum.
  `last_shipped_*` live in memory only.
- **Errors** are `ShipError { kind, message, remedy }` objects ([ADR-0010](adr/0010-typed-ship-errors.md));
  remedies are `fetchAndRebase`, `reAuthenticate`, `configureIdentity`.

**The git runner** ([ADR-0012](adr/0012-single-git-runner.md)) spawns every git child with an argv vector,
`-C <dir> -c core.longpaths=true`, `GIT_TERMINAL_PROMPT=0`, `GCM_INTERACTIVE=never`,
`GIT_OPTIONAL_LOCKS=0` and `LC_ALL=C`, with inherited `GIT_DIR`-style variables removed; stdout comes
back raw, stderr redacted then capped at 8 KB. Budgets:

| Budget | Value | Used for |
| --- | --- | --- |
| `READ_TIMEOUT` | 15 s | `rev-parse`, `config`, `remote get-url`, `symbolic-ref`, `worktree lock`/`unlock`/`prune`, `branch -d`, `--version` |
| `SCAN_TIMEOUT` | 60 s | `status`, `diff --numstat`, `show --numstat`, `rev-list --count` |
| `CREATE_TIMEOUT` | 120 s | `worktree add` |
| `MUTATE_TIMEOUT` | 600 s | `add`, `restore --staged`, `commit` (runs hooks) |
| `PUSH_TIMEOUT` | 600 s | `push` (runs `pre-push`) |
| `REMOVE_TIMEOUT` | 600 s | `worktree remove` |

On expiry the process tree is terminated (Unix: `SIGTERM` to the group, `SIGKILL` after 3 s; Windows:
`taskkill /T /F`, which can leave a stale `index.lock`) and the error is a typed `GitTimeout`.

The frontend half is `useShip` (`src/hooks/useShip.ts`), a thin view over a pure `shipReducer`
(`idle`, `preflighting`, `previewing`, `running`, `settled`, `failed`). A module-level in-flight set,
checked synchronously, stops a double click starting two commits. The `ship_settled` listener is armed
**before** the triggering call, because the event path and the IPC response have no ordering guarantee;
once that call has resolved, the flow waits up to 30 s more for a receipt that has not yet arrived
(`SHIP_SETTLED_TIMEOUT_MS`). Failing to open the compare page after a settled ship is a warning toast
and never flips the outcome. The default commit message is deterministic
(`src/lib/ship-message.ts`: a Conventional Commit inferred from paths and the diff stat).

### The Causal Record

`ship_context(workerId)` ([ADR-0011](adr/0011-pr-body-evidence-before-prose.md)) is read-only and
`Allowed` remotely. It resolves the commit's `(seqFrom, seqTo]` range, reads the log with
`EventLog::events_for_worker_between` (worker and type filtered in SQL, newest first, up to 50,000 rows,
reporting truncation), and `git::causal::build_ship_context` groups `agent_block`, `agent_tool_call`,
`agent_tool_result` and `agent_turn_settled` rows by `turnId` into turns with their tool calls, plus the
range's `commit_created` rows. At most 200 turns are kept (`omittedTurnCount` counts the rest). A tool
call's target comes from an allowlist of input keys (`path`, `file_path`, `filePath`, `command`, `cmd`,
`pattern`, `url`, `query`, `name`), cut at 200 characters, never file contents.

`src/lib/ship-causal.ts` composes the PR body: the deterministic Causal Record section first, an
optional model-written section after it, with `[seq N]` citations outside the range stripped. An empty
record says either "No Recorded Agent Turns" or that the worker's activity is not captured (webview chat
path); `ShipPreview.tsx` renders the table straight from `ShipContext`.

### Adapter Layer

Two provider adapters implement one trait pair ([ADR-0013](adr/0013-provider-adapter-trait-pair.md)):
`AgentAdapter` (`provider`, `capabilities`, `probe`, `spawn`) and `AgentSession` (`session_key`,
`send_turn`, `await_turn_completion`, `cancel`, `respond_permission`, `shutdown`). `ProviderId` also
reserves `OpenCode`, `Gemini` and `WebviewAnthropic` (the TypeScript chat path) with no adapter.
`agent_spawn` and `agent_probe` pick the adapter by provider; every other agent command reaches the
live `Arc<dyn AgentSession>` through the
`AgentSessionRegistry` by worker id. `AgentSpawnSpec` is `workerId, cwd, model, resume, permissionMode`.

| | Claude Code ([ADR-0016](adr/0016-claude-code-control-protocol.md)) | Codex ([ADR-0017](adr/0017-codex-app-server-protocol.md)) |
| --- | --- | --- |
| Process | `claude -p --input-format stream-json --output-format stream-json`, one child per session | `codex app-server`, JSON-RPC 2.0 without the `jsonrpc` member, one child per session (on Windows the `codex.cmd` npm shim is resolved through `PATHEXT`) |
| Verified against | `claude` 2.1.280 and 2.1.281; oldest accepted CLI 2.1.259 | codex-cli 0.156.1 |
| Handshake | `initialize` control request (30 s) opens every session | `initialize`, `initialized`, then `thread/start` or `thread/resume` (30 s) |
| A turn | user line stamped with the turn id as `uuid`; the `result` line settles it | `turn/start` (acknowledged within 30 s); `turn/completed` settles it |
| Permissions | `can_use_tool` over `--permission-prompt-tool stdio`; an unanswered ask is denied after 10 min | server requests `…/requestApproval`, answered by `respond_permission`; any other server request is answered `-32601` |
| Cancel (**Graceful**) | `interrupt` control request; kill fallback after 5 s without an ack or a further 10 s without a result | `turn/interrupt`; the thread survives |
| Capabilities | partial deltas, resume, native cost, worktree aware, interactive permissions; no mid-turn steering | the same, except no native cost (token counts only) |
| Teardown | idle: close stdin, 3 s grace; busy: kill | close stdin, 3 s grace, then kill |

- **Trust tiers** `restricted`, `standard` (default) and `write_enabled` are the only accepted
  `permissionMode` values ([ADR-0015](adr/0015-trust-tiers-closed-vocabulary.md)); `bypassPermissions`,
  `approvalPolicy: never` and `danger-full-access` cannot be constructed. Claude's deny list travels as
  inline `--settings` JSON with `--setting-sources project`, never as a file in the worktree; the Codex
  adapter refuses a session whose applied policy is looser than requested.
- **Exactly one `agent_turn_settled` per acknowledged turn**, synthesised ("Process Exited Without A
  Receipt (<cause>)", the cause being the known teardown reason or the stderr tail) if the process
  ends first. `send_turn` on a busy session is `AgentSessionBusy`.
- **Session state has three owners:** the provider CLI owns the conversation (SWARM keeps an opaque
  `SessionKey` and the cwd), the event log owns normalised history, the registry owns the live process.
- **Piped substrate** (`worker/proc.rs`, [ADR-0014](adr/0014-piped-stdio-for-json-providers.md)):
  `Stdio::piped()`, a bounded `mpsc(4096)`, `NdjsonFramer` with a 10 MiB line cap (`LineTooLong`), the last
  4 KiB of stderr kept for diagnostics. PTYs are for shells only.
- **Scheduler** ([ADR-0018](adr/0018-agent-turn-scheduler.md)): one app-wide `AgentScheduler`. A turn runs
  when a permit is free (default 3, range 1 to 16, live via `set_agent_concurrency`) and its worker has
  no turn running; order is priority (`low`, `normal`, `high`, `critical`) then FIFO; at most 256 wait
  (`QueueFull`). `agent_send_turn` confirms admission only.
- Fixtures in `crates/swarm-core/tests/fixtures/` play real orderings from ESM fake CLIs.

### Message Bus

([ADR-0020](adr/0020-bus-routes-by-recording-events.md).) `bus_send(fromWorkerId, toWorkerId?, topic, payload, causeSeq?)`
calls `Router::send`, which registers the topic and records a `bus_message` event stamped with the
sender as `originWorker`. Nothing else delivers it; every frontend and remote client sees it on the
ordered stream and a replay sees it again. `MessageBus` is only a set of topic names, capped at 1024
(`bus_list_channels` returns it sorted). No UI calls `bus_send` yet.

### Sessions, config and the data directory

The data directory is Tauri's app data directory for the bundle identifier
`dev.crimson.swarm-orchestrator`, or `swarmd --data-dir`. A session is
`{ id, name, workerIds, createdAt, config }`.

| File | Owner | Contents |
| --- | --- | --- |
| `swarm-events.db` (+ `-wal`, `-shm`) | Rust | The event log. |
| `sessions.json` | Rust | `{"sessions": [...]}`; saved after every create, delete and membership change. |
| `swarm-config.json` | Rust | `anthropic_api_key`, `max_workers`, `agent_concurrency`, `default_repo_root`, `shipCoAuthoredBy`, namespaced `<store>:<key>` entries. Owner-only on Unix. |
| `daemon.lock`, `daemon.lock.json` | Rust | The single-instance lock and who holds it. |
| `daemon-token` | `swarmd` | The bearer token (`0600`, or a current-user DACL on Windows). |
| `swarm-settings.json`, `swarm-snapshots.json`, `swarm-templates.json` | webview (`tauri-plugin-store`) | Preferences, session snapshots, templates. |

All JSON state files go through `state_file`: a malformed file is moved aside to
`<name>.corrupt-<unix ms>`, an unreadable one is left alone, and writes are atomic and durable
([ADR-0026](adr/0026-rust-owns-config-and-sessions.md)). The Rust side must never be opened through
`tauri-plugin-store`.

### Metrics

`metrics::start_metrics_loop` emits `system_metrics` every 500 ms (host CPU and RAM from a shared
`sysinfo` handle, plus the worker count; aggregation runs in `spawn_blocking`). `get_metrics` answers on
demand with the same host figures, the worker count per state, and each worker's CPU and memory summed
over its whole process tree.

### Errors

`AppError` (`thiserror`, serialised as its display string) has 17 variants: `WorkerNotFound`,
`PtySpawn`, `Ipc`, `Ai`, `Io`, `PermissionDenied`, `RegistryFull`, `Serialization`, `SessionNotFound`,
`ChannelClosed`, `EventLog`, `QueueFull`, `Config`, `Git`, `GitTimeout`, `AgentSessionBusy`,
`LineTooLong`. Registry handlers return `Result<Value, Value>`; the error value is usually a string.
The ship commands are the documented exception: they reject with a `ShipError` object
([ADR-0010](adr/0010-typed-ship-errors.md)), and the frontend wraps it in `ShipCommandError`. Both
shells return the registry's value untouched, so desktop and daemon report identical errors.

---

## Desktop shell

`swarm-desktop` ([ADR-0028](adr/0028-desktop-shell-registry-forwarders.md)) connects the core to a window:

- `lib.rs` installs the process's one Tokio runtime (threads named `swarm-tokio`) as Tauri's async runtime
  and builds `tauri::Builder::default().runtime(Wry::default())` with the plugins `fs`, `dialog`,
  `opener` (link-click handling off), `store`, `updater`, `notification` and the app's own `swarm-lifecycle`. Release builds log JSON at
  `info` to `swarm-desktop.log` in the app log directory (rotated past 8 MiB); `RUST_LOG` overrides.
- `startup.rs` runs in `setup`: resolve the data directory, `Runtime::start` with an `emit` closure that
  forwards each envelope to the webview on `swarm://events` from the writer thread (a slow webview backs
  up the writer instead of losing events), manage `Ctx`, `Registry` and the runtime, then show the main
  window (created hidden). A start failure is shown in a non-blocking dialog and the app exits.
- `commands/command_list.rs` is the one list of app command names (registry, then native). `commands/mod.rs` expands it through `commands!` into one forwarder per registry command (arguments in, registry JSON out, untouched); `build.rs` hands the same names to `tauri_build::AppManifest::commands`, which generates `allow-<command>`/`deny-<command>` for each. `commands/native.rs` holds `check_for_updates` and `send_notification`.
- `lifecycle.rs`: the app's `swarm-lifecycle` plugin. Its `on_cleanup_before_exit` hook, which every exit path reaches (including `restart` on the main thread, which skips `RunEvent::Exit`), runs `Runtime::shutdown` once (2.5 s per phase) on a scoped helper thread through the Tokio handle captured at registration, so it is safe when `exit` runs it on a Tokio worker; then it drops the release-log guard so the teardown's own lines are flushed. See [ADR-0033](adr/0033-cleanup-hook-teardown-and-command-acl.md).
- `dialog_grants.rs`: mirrors dialog folder grants into the global fs scope so dot-entries are readable
  on macOS and Linux.

**Capabilities** (`capabilities/default.json`, [ADR-0030](adr/0030-tauri-3-alpha-capability-scoped-fs.md)):
`core:default`, one `allow-<command>` grant per app command (38; nothing else is invocable; pinned by `app_commands_are_granted_one_by_one`), `dialog:default`, `store:default`; fs `read-file`, `read-dir`, `stat` and
`write-file` with **no static path scope** (only what the user picks in a dialog), `fs:deny-default` and
a deny list (app data, `.ssh`, `.gnupg`, `.aws`, `.azure`, `.kube`, `.docker`, `.config/gh`, `.claude`,
`.codex`, `.git-credentials`, `.netrc`); opener `openUrl` for `https://*/*/*/compare/*` and `openPath`
for `$HOME/.swarm/worktrees/**`. **CSP:** `default-src 'self'; script-src 'self'; style-src 'self'
'unsafe-inline'; img-src 'self'; connect-src ipc: http://ipc.localhost https://api.anthropic.com;
font-src 'self'; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; form-action 'none'`. Updates
come from the GitHub releases `latest.json`, verified against the public key embedded in
`tauri.conf.json` ([updater-keys.md](updater-keys.md)). `devtools` is an opt-in cargo feature; debug
builds always have the inspector.

---

## Runtime Modes

One domain layer, two shells ([ADR-0001](adr/0001-tauri-free-core-two-shells.md),
[ADR-0002](adr/0002-swarmd-separate-binary.md)): the desktop app (Tauri IPC, a webview) and `swarmd`
(WebSocket, no webview), both built on `Runtime` and the same `Registry`. Both take the
`SingleInstanceLock` first ([ADR-0025](adr/0025-single-instance-lock.md)), so two processes never share a
data directory: `swarmd` exits 75, the desktop app shows a dialog.

**`swarmd`** (`crates/swarmd`; operator guide in [daemon.md](daemon.md); frames in `swarm_core::protocol`
and [api.md](api.md#wire-protocol-swarmd)):

- **Transport:** one authenticated WebSocket at `/ws` (default bind `127.0.0.1:8787`). Frames: `hello`
  (`lastSeq`, token), `ready`, bare `event` (a `DomainEvent`, no `frame` key), `replayEnd`, `rpc`,
  `rpcResult`. `--serve-ui <dir>` serves a `pnpm build:web` bundle from disk with a strict CSP; it is not
  embedded in the binary.
- **Auth and exposure** ([ADR-0022](adr/0022-swarmd-authentication-and-exposure.md)): a 64-hex-character
  token in `<data dir>/daemon-token`; non-loopback `--bind` refused until an earlier loopback run minted
  it; a `Host`/`Origin` allow-list on every request (`--allow-host` for proxies); a 5 s handshake
  deadline; 32 connections and 16 pending handshakes; a 2 MiB message cap; the token only in the connect
  URL's fragment.
- **Delivery** ([ADR-0023](adr/0023-swarmd-one-ordered-lane.md)): each connection subscribes to the
  engine's broadcast fanout before reading the log head, replays `events_since` for a warm `hello`, heals
  lag by replaying again, and sends events on one ordered 4096-slot lane (ephemeral frames dropped past a
  512 watermark); `rpcResult` rides a separate 256-slot lane; at most 8 `rpc` calls run per connection.
- **Policy:** every `rpc` goes through `Registry::dispatch_remote`. An authenticated client can run
  commands as the daemon's user, so treat the token like an SSH key.
- **Shutdown:** SIGINT/SIGTERM closes clients with `1001`, stops every worker through `kill_worker` (each worktree gets its usual disposition; 10 s budget, `STOP_WORKERS_TIMEOUT`), then runs `Runtime::shutdown`. The desktop app instead leaves workers to the OS on quit.
- **Service units** (`crates/swarmd/service/`): `systemd --user`, a launchd LaunchAgent, and on Windows a
  per-user **logon Scheduled Task**, not a Windows service ([ADR-0029](adr/0029-windows-daemon-logon-task.md)).
- CI checks that neither `swarm-core` nor `swarmd` depends on `tauri*`.

---

## Frontend

React 19 canary with the React Compiler (Oxc port, WASI fallback binding,
[ADR-0032](adr/0032-react-compiler-oxc-wasi.md)), Vite, Tailwind, Zustand + immer, Jotai, XYFlow + ELK,
xterm.js (WebGL), Recharts, `modern-cmdk`, Sonner, `motion`. Versions are in `package.json`.

The bundle targets `esnext` and calls recent APIs (iterator helpers, `Error.isError`, `RegExp.escape`)
unguarded, so the webview must be WebKit 18.4 class or newer: WebView2 (Chromium) on Windows, WKWebView
on macOS, WebKitGTK on Linux ([ADR-0037](adr/0037-webkit-floor-and-macos-15-4.md)). macOS 15.4 is the
minimum system version (`bundle.macOS.minimumSystemVersion`); `Temporal` is the one API WebKit lacks and
is polyfilled at boot.

### Boot

`index.html` loads `src/boot.ts`, which awaits `ensureTemporal()` and only then imports `main.tsx`
([ADR-0031](adr/0031-temporal-polyfill-boot-entry.md)): WebKit-based webviews have no `Temporal`, so
`temporal-polyfill` is installed (as its own chunk) before any module that uses it evaluates.
`main.tsx` preloads `swarm-settings.json` in the desktop shell and suspends on it with `use()`, so the
first render already shows persisted settings, then renders `App`. `App` connects the event bus and mounts
the app-wide subscriptions once (`useTheme`, `useWorkerEvents`, `useAgentSessionEvents`,
`useProvenanceEvents`, `useSystemLogEvents`, `useSessionEvents`, `useMetrics`, `useAlerts`,
`useSettingsBridge`); the auto-snapshot loop and the store integrity check wait for the first idle period.
Dates and durations use `src/lib/time.ts` on `Temporal` and `Intl`; there is no date library.

### Event bus and transport

`src/lib/transport.ts` defines `Transport` with `tauriTransport` and `wsTransport`, chosen once at module
load by the Vite define `__SWARM_TRANSPORT__` (`"ws"` only for `pnpm build:web`)
([ADR-0024](adr/0024-transport-chosen-at-build-time.md)). `src/lib/tauri.ts` wraps every command with typed,
zod-validated functions on top; `isTauri()` means the Tauri bridge specifically, `hasTransport()` means
some backend is reachable. The remote surface is Dashboard, Workers, terminals, Metrics and agent chat.

`src/lib/event-bus.ts` subscribes to `swarm://events`, validates the envelope, dedupes by seq, and on a
seq gap buffers live events and backfills from `events_since` (pages of 5000), retrying with doubling
delays (0.25 s upward, 6 attempts) before skipping an unfillable gap. An empty page means the gap was
ephemeral by design. `onEvent(type, handler)` delivers payloads already parsed against the type's schema
in `src/lib/event-payloads.ts`; `onEvent("*", …)` receives every raw envelope; `waitFor(predicate, ms)`
resolves on a receipt event.

### State

Three tiers ([ADR-0027](adr/0027-three-tier-frontend-state.md)):

| Tier | Where | Examples |
| --- | --- | --- |
| Domain (Zustand 5, immer, `subscribeWithSelector`) | `src/store/` | `workers`, `sessions`, `agent-sessions`, `worker-agents`, `provenance`, `system`, `ai` (webview queue and accounting), `message-history`, `custom-tools`, `logs` |
| Ephemeral UI (Jotai) | `store/ui.ts` | selection, current page, panels, `causalityInspectorAtom`, `reducedMotionAtom` (starts from the OS setting and follows it), perf overlay |
| Persisted preferences (Jotai `atomWithSettings`) | `store/ui.ts` over `store/persisted.ts` | theme, pane sizes, app settings, keybindings, selected model; `swarm-settings.json`, validated per key |

Stores holding `Map`/`Set` call immer's `enableMapSet()` at module load. Provenance ingest bypasses
immer.

### Pages and components

`PageHost` renders the eight pages (`dashboard`, `workers`, `sessions`, `metrics`, `logs`, `tools`,
`workspace`, `settings`) as lazy chunks, each kept mounted in an `<Activity>` once visited; navigation
through `useNavigate` animates with a `ViewTransition`. `AppShell` is a CSS grid (sidebar, top bar, page
area, status bar) over the particle background; its entrance is pure CSS (`@starting-style`). The
`CommandPalette` (`modern-cmdk`) is frecency-ranked.

The Workers page is the centre: a graph/list switch (`WorkerGraph`, XYFlow with ELK layout in
`workers/elk.worker.ts`), a detail panel with three tabs (`WorkerDetail`, `WorkerAIPanel`, `ShipPanel`),
`WorkerTerminal` (xterm.js with the WebGL addon), `SpawnWorkerDialog` (a native modal `<dialog>` with
probed provider status and trust-tier copy), and `CausalityPanel`. Other component groups: `ai/`,
`session/`, `metrics/`, `logs/`, `workspace/` (file tree and viewer, desktop only), `tools/` (custom
tool builder), `ship/`, `ui/`.

### Causality Graph

([ADR-0006](adr/0006-measured-causality-graph.md).) `src/store/provenance.ts` derives edges from stamped
envelopes through `useProvenanceEvents` (one `onEvent("*")` subscription): an envelope with an
`originWorker` becomes an edge of kind `spawn`, `kill`, `command` or `message`, keyed `from->to:kind`,
with a count and `lastSeq`/`lastTs`; a bounded `bySeq` ring of recent events backs the inspector;
`file_written` becomes a "Wrote N Files" badge on the origin worker. `selectVisibleEdges` hides edges
whose endpoint is gone without deleting them.

- Node data (`state`, `pid`, file-write count) is overlaid every render; only the topology fingerprint
  feeds ELK, so a repeated edge does not relayout.
- User-drawn edges are `kind: "manual"`, React state only, a separate legend group, and the only edges
  workflow export touches.
- `CausalityPanel` is a focus-trapped modal that walks `causeSeq` backward (the ring first, then
  `events_since` with `limit: 1`) up to 50 hops, and says "Cause Event Not Available (Ephemeral Or
  Pruned)" instead of presenting a cold trail as a root. The graph's Delete and zoom shortcuts are off
  while it is open.
- With no measured causality, workers render with no edges and a quiet hint.

### AI chat paths

([ADR-0019](adr/0019-webview-chat-beside-adapters.md).) A worker's AI panel shows one of two chats:

- **Webview chat** (`AIChat`, `src/lib/ai-chat.ts`, `src/lib/anthropic.ts`): the Anthropic SDK called from
  the webview (key read from the config before each request, beta surface with server-side refusal
  fallbacks, no sampling parameters). The tool loop lives outside React in `ai-chat.ts`, writing into
  `message-history`, so a turn survives tab switches. Built-in tools are `spawn_worker`, `kill_worker`,
  `run_command`, `read_file`, `write_file`, `get_metrics`, plus user-defined ones (`src/lib/tools.ts`,
  `custom-tools.ts`); input is validated against zod schemas before any side effect. The five tools that
  act on the machine (`spawn_worker`, `kill_worker`, `run_command`, `read_file`, `write_file`) also wait
  for the user's answer inside their own `execute` ([ADR-0035](adr/0035-ai-tool-approval-and-fs-scope.md)):
  Allow Once, Allow For Session (one grant per tool, worker and exact argument; never offered for
  `write_file`) or Deny, in a prompt that shows every validated field escaped, with a cut value
  expanded before Allow is enabled. Stopping a turn or killing its worker denies the turn's pending tool
  calls (the turn's abort signal does it). Each turn calls
  `agent_turn_started` and passes the seq as `causeSeq` on side-effecting tools. Queueing and
  concurrency are `store/ai.ts`, independent of the Rust scheduler.
- **Model catalogue** (`src/lib/models.ts`, [ADR-0036](adr/0036-model-catalogue-and-per-attempt-pricing.md)): Fable 5.1,
  Mythos 5.1 (gated behind Anthropic's verification programs), Opus 5.5, Sonnet 5.5 and Haiku 5.5, each with
  a 1M-token context window and 128K output. Haiku 5.5 alone has a long-prompt price tier (prompts over
  100K input tokens, counting cache reads and writes, bill the whole request at the higher rates); the
  others bill the full window at one rate. Cost is estimated per attempt: with server-side refusal fallbacks
  each `usage.iterations` entry is priced by the model that served it, using a pricing-only table for
  fallback targets the picker never offers; an attempt served by a model with no rates is priced at the requested model's rates, and only a requested model with no rates at all costs 0.
- **Agent chat** (`AgentChat`): shown when `agent-sessions` holds a live session for the worker
  (`agent_spawn`); renders the `agent_*` stream and answers permission requests (Allow/Deny only for
  requests with no `suggestedDecision`, gated on `interactive_permissions`).

### WebGPU background

`ParticleBackground` (via `useWebGPU`) renders only when WebGPU exists, `particlesEnabled` is on and
reduced motion is off; otherwise it draws the plain background colour. `lib/webgpu.ts` initialises the
device with reason-specific failures and recovers a lost device. `lib/particles.ts` is a WGSL compute
shader (workgroup size 64; PCG respawn, damping, one gravity well per running worker, parameters from
live metrics) feeding an instanced additive billboard render; `lib/postprocess.ts` chains ping-pong
textures: bloom (threshold, dual Kawase blur, composite), chromatic aberration, vignette.

---

## Security boundaries

| Boundary | Enforcement |
| --- | --- |
| Remote clients of `swarmd` | Token, `Host`/`Origin` allow-list, non-loopback gate, `RemotePolicy` ([ADR-0021](adr/0021-command-registry-remote-policy.md), [ADR-0022](adr/0022-swarmd-authentication-and-exposure.md)). An authenticated client can run commands as the daemon's user. |
| Webview to OS | Capability file (per-command `allow-*` ACL, no static fs scope, deny list, opener scopes) and CSP ([ADR-0030](adr/0030-tauri-3-alpha-capability-scoped-fs.md)). |
| `read_file` / `write_file` commands | Absolute paths, canonicalized (symlinks, 8.3 short names) before the scope and deny checks; reads limited to the data directory and `$HOME`, writes to the data directory and `~/.swarm`; `swarm-config.json` (the API key), the daemon token and its temp form, and eighteen home credential stores (`~/.ssh`, `~/.gnupg`, `~/.aws`, `~/.azure`, `~/.kube`, `~/.docker`, `~/.config/gh`, `~/.claude`, `~/.codex`, `~/.git-credentials`, `~/.netrc`, `~/.npmrc`, `~/.pypirc`, `~/.cargo/credentials`, `~/.cargo/credentials.toml`, `~/.config/gcloud`, `~/AppData/Roaming/GitHub CLI`, `~/AppData/Roaming/gcloud`) are never accessible; the app's own state files in the data directory (`swarm-events.db`, `sessions.json`, `daemon.lock`, `swarm-settings.json`, `swarm-snapshots.json`, `swarm-templates.json`, and names with those prefixes) are never writable; Windows writes refuse `:`, a trailing `.` or space and device names; `Denied` remotely ([ADR-0035](adr/0035-ai-tool-approval-and-fs-scope.md)). |
| Webview AI tools | Every tool that acts on the machine, `kill_worker` included, needs the user's per-call answer inside its own `execute`; session grants are exact to tool, worker and argument ([ADR-0035](adr/0035-ai-tool-approval-and-fs-scope.md)). |
| Provider permissions | Closed trust tiers, no bypass modes ([ADR-0015](adr/0015-trust-tiers-closed-vocabulary.md)). |
| Git | No force push, no hook bypass, deny list, primary-checkout guard, secret redaction ([ADR-0009](adr/0009-ship-chain-structural-guarantees.md), [ADR-0012](adr/0012-single-git-runner.md)). |
| Data files | Atomic writes, quarantine of damaged files, owner-only config and token ([ADR-0026](adr/0026-rust-owns-config-and-sessions.md)). |

See [SECURITY.md](../SECURITY.md) for the reporting policy.

## Known gaps

True at this commit and deliberately not hidden:

- Nothing counts provider requests, so `system_metrics` reports no request rate.
- The provenance graph is session-scoped (never hydrated from the log) and a relayout overwrites manual
  node drags.
- Killing a worker signals only its shell; a detached process can keep a worktree busy
  (`disposition: "failed"`). Only the configured default repo is pruned at startup.
- `swarmd` does not embed the UI, and a desktop window cannot attach to a running daemon.
- `OpenCode`, `Gemini` and `WebviewAnthropic` provider ids have no adapter; `bus_send`, `bus_list_channels`, `get_session` and
  `agent_shutdown` have no frontend caller (`NOT_WIRED` in the desktop shell's contract test).
- A hard link to a denied file inside a scope is not detected by `read_file`/`write_file`.
