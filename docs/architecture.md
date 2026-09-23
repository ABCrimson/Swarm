# Architecture

> System architecture reference for the SWARM Orchestrator desktop application.

---

## Table of Contents

- [System Overview](#system-overview)
- [Backend Architecture](#backend-architecture)
  - [Worktree Isolation](#worktree-isolation)
  - [Ship Chain](#ship-chain)
  - [Adapter Layer](#adapter-layer)
- [Frontend Architecture](#frontend-architecture)
- [WebGPU Pipeline](#webgpu-pipeline)
- [Data Flow](#data-flow)
- [State Management](#state-management)
- [Event System](#event-system)
- [Built, Not Wired](#built-not-wired)
- [Error Handling](#error-handling)
- [Runtime Modes](#runtime-modes)

---

## System Overview

SWARM Orchestrator is a Tauri 2.11 desktop application with a clear separation between a Rust backend and a React 19 frontend. Communication between the two layers happens exclusively through Tauri's IPC mechanism: **invoke** (request/response) and **listen** (event stream).

```text
 ┌──────────────────────────────────────────────────────────────┐
 │                      React 19 Frontend                       │
 │  Components  │  Hooks  │  Stores  │  WebGPU Canvas           │
 ├──────────────────────────────────────────────────────────────┤
 │                       Tauri IPC Bridge                       │
 │                 invoke() ↕ listen() / emit()                 │
 ├──────────────────────────────────────────────────────────────┤
 │                         Rust Backend                         │
 │  Commands  │  Worker Registry  │  Agent Scheduler  │  Store  │
 │                                                              │
 │                  Tokio Multi-Thread Runtime                  │
 └──────────────────────────────────────────────────────────────┘
```

**Design principles:**

1. The Rust backend owns all mutable state (workers, sessions, agent scheduler, message bus)
2. The frontend receives state updates via Tauri events, not polling
3. CPU-bound and blocking work (sysinfo refresh, worker metrics aggregation, session persistence) runs on `spawn_blocking` threads, never on the async executor
4. All IPC payloads use `camelCase` fields; all event type tags use `snake_case`
5. Worker state transitions are TOCTOU-safe: `WorkerRegistry::update_state_if` performs a compare-and-set under the registry's per-entry lock rather than a separate read-then-write

---

## Backend Architecture

The backend's domain logic lives in the tauri-free `crates/swarm-core/src/`, organized into modules (`agent`, `bus`, `commands`, `events`, `git`, `orchestration`, `session`, `worker`, plus `runtime`/`lock`/`protocol`/`paths`/`error`):

### Module Map

The Rust side is a three-crate workspace: domain logic lives in the tauri-free `swarm-core` library crate, the Tauri shell (`swarm-desktop`) wires it to IPC commands and platform paths, and the headless `swarmd` daemon serves the same core over an authenticated WebSocket (see [Runtime Modes](#runtime-modes)). CI enforces that `swarm-core` never depends on `tauri`/`tauri-plugin-*` (`cargo tree -p swarm-core -e normal`).

```text
src-tauri/crates/swarm-core/src/   (swarm-core -- tauri-free domain crate)
├── agent/           Multi-provider agent execution -- see "Adapter Layer" below
│   ├── adapter.rs   AgentAdapter/AgentSession trait pair, Capabilities, ProviderId
│   ├── claude_code.rs ClaudeCodeAdapter/ClaudeCodeSession -- claude CLI stream-json over piped stdio
│   ├── codex.rs     CodexAdapter/CodexSession -- codex app-server bidirectional JSON-RPC
│   ├── registry.rs  AgentSessionRegistry -- live Arc<dyn AgentSession> by worker id
│   └── scheduler.rs AgentScheduler -- priority queue + semaphore concurrency control (absorbed the deleted ai/queue.rs)
├── bus/             Inter-agent message bus
│   ├── channel.rs   MessageBus -- per-topic tokio::sync::broadcast channels
│   └── router.rs    Router -- direct/broadcast send, emits bus_message onto the ordered spine (pipeline machinery deleted in Phase 4)
├── commands/        The drift-proof command Registry (35 entries) + per-command RemotePolicy -- both shells dispatch through it
├── events/          Event emission system
│   └── emitter.rs   SwarmEvent enum + EventSink (routes into OrchestrationEngine)
├── git/             Worktree-per-worker isolation + ship chain -- see "Worktree Isolation"/"Ship Chain" below
│   ├── cli.rs       git binary discovery + arg-vector Command runner, capability probe, env hygiene, redact-then-truncate choke point
│   ├── redact.rs    Secret redaction (URL creds, GitHub/Anthropic tokens) + 8KB output truncation
│   ├── remote.rs    Remote URL parsing (https/ssh/GHES) + GitHub-style compare-URL construction
│   ├── repo.rs      Repo toplevel discovery, HEAD sha resolution
│   ├── ship.rs      Preflight, staged commit, push -- see "Ship Chain" below
│   ├── worktree.rs  add/lock/unlock/remove/list/prune + porcelain parsing
│   └── mod.rs       RepoLocks (per-repo serialization + lock-contention retry), home_dir/slugify/short_hash8
├── orchestration/   Ordered event core -- see "Ordered Event Core" below
│   ├── engine.rs    OrchestrationEngine (single writer thread) + DomainEvent envelope
│   └── log.rs       EventLog -- SQLite (WAL) append-only event log
├── session/         Session management
│   ├── manager.rs   DashMap-backed CRUD + SessionStore port
│   └── persist.rs   JsonSessionStore -- tauri-free atomic sessions.json persistence, shared by both shells
├── worker/          Worker management
│   ├── handle.rs    WorkerHandle, WorkerState, WorkerConfig, WorkerIsolation, WorkerInfo (incl. lastShippedSeq/lastShippedCommit, written only by the ship chain)
│   ├── lifecycle.rs Spawn, pause, resume, kill, input operations (worktree create/remove on spawn/kill)
│   ├── pty.rs       PTY spawning (portable-pty) + Tokio I/O bridge -- interactive shells only
│   ├── proc.rs      Piped-stdio process spawning + NDJSON framer -- JSON-protocol provider CLIs only (a PTY corrupts NDJSON; see "Adapter Layer" below)
│   └── registry.rs  DashMap registry, TOCTOU-safe update_state_if, aggregate metrics
├── config.rs        Atomic key-value JSON config persistence
├── error.rs         AppError enum (thiserror + Serialize for IPC)
├── lock.rs          SingleInstanceLock -- OS-native advisory lock, one engine per data directory
├── metrics.rs       Background metrics collection loop (500ms, SharedSystem)
├── paths.rs         Paths (data dir), constructed by the shell and passed in
├── protocol.rs      swarmd wire frames (hello/ready/event/replayEnd/rpc/rpcResult), serde-only
├── runtime.rs       Runtime -- the shared constructor both shells call (incl. git capability probe + startup worktree prune)
└── lib.rs           Crate root, module re-exports

src-tauri/src/   (swarm-desktop -- Tauri shell)
├── commands/        Tauri IPC command handlers, thin wrappers over swarm-core
│   ├── worker.rs        spawn, pause, resume, kill, list, input, set_max_workers
│   ├── session.rs       create, delete, list, get, session_add_worker, session_remove_worker
│   ├── agent.rs         agent_turn_started, agent_spawn/agent_probe (provider-routed), agent_send_turn/agent_cancel/agent_shutdown/agent_permission_respond/set_agent_concurrency (provider-generic); ai_request/ai.rs removed in Phase 2, see "Adapter Layer"
│   ├── bus.rs           bus_send, bus_list_channels (bus_subscribe/bus_create_pipeline/bus_list_pipelines DELETED in Phase 4, see "Message Bus")
│   ├── metrics.rs       get_metrics (incl. perWorker) + background collection loop
│   ├── orchestration.rs events_since
│   ├── config.rs        read_config, write_config
│   ├── git.rs           validate_repo_root, git_ship_preflight, git_stage_commit, git_push, ship_compare_url, ship_context
│   ├── updater.rs       check_for_updates
│   ├── notification.rs  send_notification
│   ├── fs.rs            read_file, write_file (path-scoped like tauri-plugin-fs; write_file emits a stamped file_written event)
│   └── registry_contract.rs  contract test: generate_handler! command set == Registry::keys() ∪ NATIVE_ONLY
├── lib.rs           Tauri app builder and setup (path resolution + swarm_core Runtime::start + app.manage())
└── main.rs          Binary entry point (Tokio runtime)
```

### Tokio Runtime

The application creates an explicit Tokio multi-threaded runtime with one worker thread per logical CPU core:

```rust
let runtime = tokio::runtime::Builder::new_multi_thread()
    .worker_threads(std::thread::available_parallelism().map(|n| n.get()).unwrap_or(1))
    .enable_all()
    .build()
    .expect("failed to build Tokio runtime");
```

### Worker Registry

The `WorkerRegistry` is the central data structure for worker management:

- **Storage:** `DashMap<Uuid, WorkerHandle>` -- lock-free concurrent reads, per-shard write locks
- **Configuration:** `parking_lot::RwLock<SystemConfig>` -- max workers (64) and default shell
- **Metrics:** Sequential iteration over worker states for aggregate counts, run inside `tokio::task::spawn_blocking` so the async executor is never blocked. (The 64-worker cap makes sequential aggregation cheaper than `rayon`-style parallel dispatch overhead, so `rayon` was removed from the dependency tree.)
- **Capacity:** Enforces `max_workers` limit, returns `AppError::RegistryFull` on overflow
- **State transitions:** `update_state_if(id, expected, new)` performs an atomic compare-and-set against the current state under the entry's lock, eliminating the read-then-write TOCTOU window that a separate `get` + `insert` would have

### PTY Management

Workers spawn real processes via `portable-pty` 0.9.0:

```text
spawn_pty()
    │
    ├── native_pty_system().openpty()     Create PTY pair
    ├── slave.spawn_command(shell)        Spawn shell in slave PTY
    ├── master.take_writer()              Get writer for input
    ├── master.try_clone_reader()         Get reader for output
    │
    ├── spawn_blocking(reader loop)       4KB buffer, blocking reads
    │       │
    │       └── mpsc::channel(4096)        Bridge to async world (bounded)
    │               │
    └── tokio::spawn(event emitter)       Forward as worker_output events (ephemeral)
```

The PTY writer and child process are wrapped in `parking_lot::Mutex` to satisfy `Sync` requirements for `DashMap` storage.

### Worktree Isolation

A worker spawned with `WorkerConfig.repoRoot` set (and `isolation` resolving to `"worktree"`, the default) gets its own `git worktree` instead of sharing a cwd with every other worker on the same repo -- the collision unit is the process writing files, and N PTYs in one working tree is exactly the failure this protects against. Everything lives in the tauri-free `git` module (`crates/swarm-core/src/git/`), which shells out to the system `git` binary rather than a Rust git library -- `gix` doesn't yet implement creating/removing worktrees, and `git2`/libgit2 checks out through a different code path than the user's own hooks/LFS/attributes.

```text
do_spawn_worker(config)
    │
    ├── config.repoRoot present, isolation == "worktree"?
    │       │
    │       ├── git::repo::discover_toplevel(repoRoot)   -C <dir> rev-parse --show-toplevel
    │       ├── git::repo::head_sha(toplevel)             -C <root> rev-parse HEAD
    │       ├── path = ~/.swarm/worktrees/<repo>-<hash8>/w-<id8>
    │       ├── branch = swarm/<slug(name)>-<id8>
    │       ├── RepoLocks::run_serialized(root, || git::worktree::add(root, path, branch, sha))
    │       └── RepoLocks::run_serialized(root, || git::worktree::lock(root, path, "swarm worker <uuid>"))
    │               any step fails ──> hard-fail the whole spawn (no worker, no PTY, no fallback cwd)
    │
    ├── spawn_pty(cwd = path, or config.cwd if unisolated)
    ├── WorkerHandle { worktree_path, repo_root, branch, base_commit, .. } inserted into registry
    └── emit worker_spawned { isolation: "worktree" | "none" }, then (if isolated) worktree_created

do_kill_worker(id)
    │
    ├── remove from registry, drop PTY writer, kill + wait the child
    │       (waiting for exit matters on Windows: a live child holding the
    │        worktree dir as its cwd would block removal — see the
    │        surviving-grandchild caveat below)
    │
    ├── handle.worktree_path present?
    │       │
    │       ├── RepoLocks::run_serialized(root, || git::worktree::unlock(root, path))
    │       │       unlock fails ──> disposition "failed" directly; remove is never attempted
    │       ├── RepoLocks::run_serialized(root, || git::worktree::remove(root, path))  -- NEVER --force
    │       ├── disposition == "removed"? ──> compare branch tip to base_commit;
    │       │       tip == base_commit ──> RepoLocks::run_serialized(root, || git::worktree::delete_branch(root, branch))  -- NEVER -D
    │       │       tip != base_commit ──> branch retained (logged, not an event)
    │       └── emit worktree_removed { disposition: "removed" | "preserved_dirty" | "failed" }
    │
    └── emit worker_killed
```

- **Arg-vector only, never a shell string.** Every `git` invocation (`git/cli.rs::run`) is a `std::process::Command` with an explicit argument vector -- injection-proof by construction, unlike a shell command line. `GIT_TERMINAL_PROMPT=0` is set on every call (a missing credential can never block on an interactive prompt); on Windows, `CREATE_NO_WINDOW` (`0x0800_0000`) suppresses the console-window flash a GUI app would otherwise get from spawning a console subprocess. Every invocation carries `-C <dir> -c core.longpaths=true` (per-invocation, never written to the user's own git config) so long checkout paths under `~/.swarm/worktrees/**` survive Windows' legacy `MAX_PATH` limit.
- **Timeouts.** 20s for `worktree add` (a full checkout, can legitimately take longer on a large repo), 5s for everything else (`rev-parse`, `worktree list`/`lock`/`unlock`/`remove`/`branch -d`, `--version`). A timed-out child is killed.
- **Disposition is classified honestly, not optimistically.** `git::worktree::remove` reserves `RemoveOutcome::Preserved` (`disposition: "preserved_dirty"` on the wire) **strictly** for git's specific refusal (`"contains modified or untracked files"`) -- every other non-zero exit (a still-locked worktree, a permission error partway through delete, a missing path, an unrecognized message) is an `Err` that the caller reports as `disposition: "failed"`. An earlier version of this classification treated any non-zero exit other than two hardcoded strings as "preserved", which is a lie for a locked-but-clean worktree and dangerous for a permission error that struck mid-delete (git may have already removed tracked files by then). The narrow classification is pinned down by `git::worktree::tests::test_is_dirty_tree_refusal_*` and an end-to-end `test_remove_returns_err_not_preserved_for_still_locked_worktree`.
- **The preserve-on-dirty guarantee.** `git::worktree::remove` never constructs a `--force`/`-f` argument -- the argv builder is structurally incapable of it (`git::worktree::tests::test_remove_args_never_contains_force`). Without `--force`, git itself refuses to remove a worktree with uncommitted changes or untracked files; that refusal, and *only* that refusal, becomes `disposition: "preserved_dirty"`. SWARM never deletes a worktree's contents itself -- it only ever asks git, and git says no when it would lose something.
- **A surviving grandchild process can produce `disposition: "failed"`.** `portable-pty` 0.9 has no Windows job object and no Unix process-group kill -- `do_kill_worker`'s `child.kill()` only terminates the direct shell, not anything it spawned (e.g. a long build). A surviving grandchild can hold the worktree directory open as its own cwd, which makes `git worktree remove` fail with a permission error -- correctly `"failed"` (never laundered into "preserved"), but the worktree then sits on disk until the process exits and the operation is retried or cleaned up manually. TODO in `worker::lifecycle::do_kill_worker`: the real fix is a job object (Windows) / process-group kill (Unix) at spawn time; out of Phase 1 scope.
- **Branch cleanup.** After a `"removed"` disposition (never any other), `do_kill_worker` resolves the isolation branch's tip (`git::repo::rev_parse`, which works even though the worktree directory is already gone -- branches live in the shared `.git` ref database) and compares it to the `base_commit` recorded at spawn time. Unchanged -> `git branch -d` (never `-D`; `git::worktree::tests::test_branch_delete_args_never_contains_capital_d` proves `-D` isn't constructible, same pattern as the no-`--force` guarantee) deletes it, so `swarm/*` branches don't accumulate forever in the user's real repo. Diverged (the agent committed) -> left in place; a `tracing` log records which happened (not a `SwarmEvent` -- this is bookkeeping, not history), and a failure at either step never fails `do_kill_worker` itself.
- **Per-repo serialization, everywhere.** `RepoLocks` (`git/mod.rs`) holds a `DashMap<PathBuf, Mutex<()>>` keyed by the *canonical* repo toplevel (every call site resolves through `discover_toplevel` first). Every mutating call in the isolation lifecycle -- `worktree add`, `worktree lock`, `worktree unlock`, `worktree remove`, `branch -d`, including the best-effort cleanup path when spawn fails partway through -- runs under its repo's lock, with one retry (200ms backoff) if the failure looks like transient index/ref-lock contention (`index.lock`, "cannot lock ref", "another git process..."). Two different repos' operations run fully in parallel; only operations against the *same* repo queue behind each other.
- **Startup capability probe.** `git::probe_capability()` runs `git --version` and requires >= 2.17 (when `worktree remove` was added). Missing or too-old git is never silently degraded: `swarm-desktop`'s `setup()` logs a warning and emits a `system_log` envelope (consumed by `useSystemLogEvents` into the existing Logs page -- the first live consumer of what was previously a documented-but-unwired event type) reading "Git Unavailable -- Isolated Spawns Will Fail Until Git Is Installed Or Upgraded". It does not claim workers spawn unisolated -- a `repoRoot`-bearing spawn still hard-fails naturally at the `discover_toplevel`/`head_sha` step, since there is no working `git` to run.
- **Startup prune.** `setup()` also runs `git worktree prune` against the persisted `default_repo_root` config key (set via the Workers page's Project Root picker, which validates it as a real repo via `validate_repo_root` before persisting -- see [docs/api.md#validate_repo_root](api.md#validate_repo_root)), logging the pruned count. This is intentionally the Phase 1 scope -- a full multi-repo orphan reconciliation (rebuilding the expected worktree set from the event log and diffing against `git worktree list --porcelain`) is a later phase.
- **Failure policy.** No `repoRoot` -> unconditionally today's unisolated spawn (zero regression, `worker::lifecycle::tests::test_spawn_without_repo_root_is_unisolated_zero_regression`). `repoRoot` present and the pipeline fails at any step -> the whole spawn fails; no silent fallback to a shared cwd (`worker::lifecycle::tests::test_spawn_hard_fails_when_repo_root_is_not_a_git_repo`).

See [docs/api.md#worktree-isolation-lifecycle](api.md#worktree-isolation-lifecycle) for the IPC-level contract (`WorkerConfig` fields, `worktree_created`/`worktree_removed` payload shapes, `validate_repo_root`) and [Events](#event-system) below for where these events sit in the persistence policy.

### Ship Chain

**Outcome (Phase 1 MVP): a worker's finished work becomes a real commit, a real upstream push, and a browser open on a prefilled GitHub compare page — zero AI dependency.** Everything git-mutating lives in `swarm_core::git::ship` (tauri-free, same reasoning as Worktree Isolation above); `commands/git.rs` is IPC plumbing only.

**Ownership split (the Phase 0 contract).** There is no separate `WorktreeRegistry` type — the registry *is* `WorkerRegistry` + `WorkerHandle`. The worktree feature (above) owns creation/branch-naming/removal; ship owns commit/push and is the **only** writer of `WorkerHandle.last_shipped_seq`/`last_shipped_commit` (via `WorkerRegistry::set_last_shipped`, called only after a successful `git_push`). The two features meet at exactly one frozen accessor:

```rust
pub struct ShipWorktreeInfo {
    pub worker_id: Uuid,
    pub repo_root: PathBuf,
    pub worktree_path: PathBuf,
    pub branch: String,
    pub base_branch: String,       // origin/HEAD -> init.defaultBranch config -> "main" -- NEVER the primary checkout's live HEAD
    pub base_commit: String,
    pub last_shipped_seq: Option<u64>,
    pub last_shipped_commit: Option<String>,
}
// swarm_core::git::ship::worktree_info_for_worker(registry, id) -> Result<ShipWorktreeInfo, ShipError>
```

`created_seq` is deliberately **not** on this struct: the single-writer `OrchestrationEngine` assigns `worktree_created`'s `seq` asynchronously, after `do_spawn_worker`'s `emit()` call already returned, so it cannot be captured synchronously at spawn time. When a never-shipped worker needs a starting seq for its `Swarm-Seq-Range` trailer, `commands/git.rs::resolve_seq_range` recovers it via `EventLog::find_first_for_worker` — an indexed lookup (`idx_events_type_seq` on `(type, seq)`) against the event log for that worker's `worktree_created` row — the one place ship needs event-log access, which is why that logic lives in the command layer, not in the tauri-free `ship` module. **`last_shipped_seq`/`last_shipped_commit` are session-scoped** (in-memory `WorkerHandle` fields only, never persisted) — a restart falls back to the indexed `worktree_created` lookup, which is harmless since the trailer is provenance metadata a future phase reads, not something Phase 1 itself consumes; durable persistence is deferred to the provenance phase.

`resolve_base_branch` (used only for `ShipWorktreeInfo.base_branch`) deliberately never reads the primary checkout's currently-checked-out branch — a human can have any branch checked out there at any moment, unrelated to what a worktree's isolation branch actually forked from. Resolution order: `git symbolic-ref --short refs/remotes/origin/HEAD` (stripped of `origin/`) → the repo's local `init.defaultBranch` config → the literal `"main"`.

```text
git_ship_preflight(workerId, mode?)                             read-only, no events; mode defaults to "all"
    │
    ├── ship::worktree_info_for_worker(registry, id)             the frozen accessor
    ├── toplevel_matches?  is_primary_checkout?  detached HEAD?  branch == baseBranch?
    │   protected branch?  origin remote present?  nothing to ship at all (clean tree AND ahead==0)?
    │       any true ──> pushed onto `blockers` (Title Case), canShip = false     seven refusal conditions
    │       (informational only here -- NOT the mutation guard, see below)
    ├── no upstream? ── ahead = rev-list --count <base_commit>..HEAD, behind = 0   B2 fallback (was hardcoded 0,0)
    ├── git status --porcelain=v1 --untracked-files=all           staged/unstaged/untracked
    ├── candidate set is MODE-AWARE: "all" -> full union; "staged" -> index only   B3 -- accurate per-mode preview
    ├── deny-list scan (.env*/*.pem/*.key/id_rsa* on basename, "secret" on the FULL path, >5MB)
    │       skipped[] = { path, reason: "Skipped — Looks Like A Credential" | "Skipped — Larger Than 5 MB" }
    └── git diff --numstat HEAD (tracked survivors) + line-count (untracked survivors)   diffStat estimate, mode-aware

git_stage_commit(workerId, shipId, message, mode, finalStep)     mutates
    │
    ├── ship::guard_not_primary_checkout(worktreePath)            HARD guard, literal first statement --
    │       fires before touching the working tree at all, even if preflight was stale or skipped
    ├── mode "all": deny-list filter again ──> git add -- <survivors>   (never -A; explicit path list only)
    │   mode "staged": deny-list paths in the index are ACTIVELY UNSTAGED first
    │       git restore --staged -- <denied paths>                B3 -- enforced, not just previewed;
    │       unstage failure ──> hard-abort the commit, never risk committing the secret anyway
    │       each mutating git call: RepoLocks::run_serialized(repoRoot, || cli::run(args))
    ├── git commit -m "<message>[\n\nSwarm-Seq-Range: <seqFrom>..<seqTo>][\nCo-Authored-By: <trimmed, single-line>]"
    │       trailer OMITTED when seqFrom==seqTo==0 (unknown) or seqTo<seqFrom (degenerate)     F10
    │       co-author value trimmed; dropped entirely if it contains an embedded \n or \r       nit
    │       -n/--no-verify not constructible anywhere in commit_args -- hooks always run
    └── emit ship_progress×2 (staging, commit), commit_created on success;
        ship_settled UNLESS the failure kind is nothingToCommit -- B2, see below

git_push(workerId, shipId, finalStep)                            mutates -- NO commitSha/seqTo params (B2/F8)
    │
    ├── ship::guard_not_primary_checkout(worktreePath)            same hard guard, independently re-checked
    ├── branch = resolve_live_branch(worktreePath)                 LIVE lookup, hard-fails on detached HEAD (F8) --
    │       never the stored WorkerHandle.branch; same resolution git_ship_preflight's branch display uses
    ├── sha = git rev-parse HEAD                                   resolved server-side, never caller-supplied
    ├── git push --set-upstream origin <branch>                   fixed argv -- --force/-f not constructible
    │       RepoLocks::run_serialized(repoRoot, || cli::run(args))
    ├── success ──> WorkerRegistry::set_last_shipped(id, seqTo, sha)   the ONLY writer of these fields;
    │       seqTo snapshotted here (current max log seq) -- works with or without a preceding git_stage_commit
    └── emit ship_progress (push); ship_settled iff finalStep or failure

ship_compare_url(workerId, shipId, commitSha, pushedRef, title, body)
    │
    ├── branch = resolve_live_branch(worktreePath)                 same live resolution as git_push (F8)
    ├── remote::parse(origin url) -> {host, owner, repo}; reject known-non-GitHub hosts
    ├── remote::compare_url(...)  https://<host>/<owner>/<repo>/compare/<base>...<branch>?quick_pull=1&title=&body=
    │       body truncated (binary search on char count) if the encoded URL would exceed 6000 chars;
    │       if even an EMPTY body doesn't fit, title is clamped too (last resort) -- the compare path itself
    │       (host/owner/repo/base/branch) is never truncated
    └── emit ship_progress (compare); ship_settled (always -- the true final step of "Commit+Push+Compare")
```

- **Defense in depth: the primary-checkout guard fires twice, independently.** `preflight` reports "primary checkout" as one of seven non-fatal `blockers` (informational, `canShip: false`). `stage_and_commit`/`push` do **not** trust that a caller checked `canShip` first — each calls `guard_not_primary_checkout` as its own literal first statement, before `git status`, before anything. A stale preflight (working tree changed between preview and click) or a future caller that skips preflight entirely can never turn into a commit or push against the repo's primary checkout. Pinned down by `git::ship::tests::test_primary_checkout_guard_fires_before_any_mutation`, which points a fake `ShipWorktreeInfo` at a repo's own primary checkout and asserts zero mutation (nothing staged, `HEAD` unmoved) alongside the `PrimaryCheckout` error.
- **Never `--force`, never `--no-verify` — structurally, not by convention.** `add_args_explicit` never constructs `-A`/`--all` (deny-listed paths are simply never in the explicit path list passed to `git add --`). `commit_args` has no code path that can append `-n`/`--no-verify`. `push_args` is a fixed five-token argv (`-C <dir> -c core.longpaths=true push --set-upstream origin <branch>`) with no branch for a force flag to attach to. All three are pinned by argv-shape unit tests, the same pattern `git::worktree`'s no-`--force` guarantee uses.
- **`"staged"` mode enforces the deny list; it doesn't just narrate it.** The original Phase 1 cut computed `skipped` for a pre-staged index but never actually unstaged anything — a secret a human staged with their own `git add .` would still land in the commit, with the UI's "Skipped" label quietly lying about it. `stage_and_commit` now runs `git restore --staged -- <denied paths>` (under the same `RepoLocks` serialization as every other mutation) before committing; an unstage failure hard-aborts the commit rather than risk shipping the secret anyway. `git::ship::tests::test_staged_mode_unstages_and_omits_denied_secret_from_the_commit` pre-stages a `.env` alongside a safe file and asserts both that the resulting commit doesn't contain it *and* that it ends up untracked-but-present on disk (`git restore --staged` never touches the working-tree copy).
- **Redaction is a choke point, not a per-call-site discipline.** `git::cli::run` — already the sole place a child git process is spawned — redacts (`redact::redact`: URL `user:pass@` credentials, `gh[pousr]_...` tokens, `sk-ant-...` keys) and then truncates to 8KB (`redact::truncate`) every captured stdout/stderr **before** returning `GitOutput`. Redact-before-truncate is the only ordering that can't leak half a token by slicing it at the 8KB boundary. Every error message, log line, and event payload built from a `GitOutput` downstream is sanitized by construction — proven end-to-end (not just against synthetic strings) by `git::cli::tests::test_run_redacts_url_credentials_from_real_git_stderr`, which points a real `git clone` at a closed local port with embedded credentials and asserts they never reach the returned `GitOutput`.
- **Env hygiene, alongside `GIT_TERMINAL_PROMPT=0`.** `GCM_INTERACTIVE=never` (Git Credential Manager's own GUI/terminal prompt path on Windows, independent of `GIT_TERMINAL_PROMPT`), `GIT_OPTIONAL_LOCKS=0` (skips background lock-taking reads that could contend with a concurrent SWARM-issued mutation), `LC_ALL=C` (stable, unlocalized stderr — the push-error classifier pattern-matches English substrings like `"rejected"`/`"non-fast-forward"`, which a localized git could translate out from under it).
- **Typed `ShipError`, a documented divergence.** Every ship command rejects with `{ kind, message, remedy }` instead of the plain-string convention the rest of the IPC surface uses — the UI needs to branch on `kind` for the right second-click remedy. See [docs/api.md#ship-commands](api.md#ship-commands) for the full `ShipErrorKind`/`ShipRemedy` enumerations and per-command error tables.
- **Push rejection never triggers an automatic force-push.** `pushRejected`'s remedy is `fetchAndRebase` (`git pull --rebase`, re-preview, ship again) — a worker's branch can be a human's branch, so history-rewrite is always an explicit second click, never automatic.
- **The bare-repo integration test.** `git::ship::tests::test_full_ship_cycle_advances_a_real_bare_remote` builds a disposable `git init --bare` `file://` origin, a real linked worktree, runs the actual `stage_and_commit` → `push` path (including a `.env` file that must survive as `skipped`, never committed), and asserts the *bare* repo's branch tip equals the pushed sha — the true, no-mock proof that push actually happened, on whichever platform CI runs on (no hardcoded shell/platform assumptions, matching the worktree tests' own convention). `git::ship::tests::test_push_resolves_and_pushes_existing_head_with_no_prior_stage_and_commit_call` and `test_push_uses_live_branch_not_stale_stored_handle_branch` cover the B2/F8 additions the same way — real bare remotes, no mocks.
- **Deterministic commit message, zero AI dependency in Phase 1.** `src/lib/ship-message.ts`'s `generateCommitMessage` infers a Conventional Commit type from the changed paths (`docs/`/`*.md` → `docs`; known lockfile/config shapes → `chore`; otherwise → `feat`) and builds a summary from the file list + diff stat — pure, client-side, no Rust round-trip. Unlike the rest of this app's UI copy, the generated message body follows Conventional Commits' own lowercase-type convention, not Title Case (Title Case is a house rule for UI labels, not git commit content). The AI-assisted generator (`ship-copy.ts`) is Phase 2+ scope.
- **`useShip` (`src/hooks/useShip.ts`): idle → preflighting → previewing → running → settled | failed.** A module-level `Set<workerId>` in-flight guard is checked synchronously (no `await` between check and add) at the top of every mutating action, so a double-click on the Ship button can never start two overlapping commits regardless of React re-render timing.
  - **Explicit 30s receipt timeout, armed before the triggering call.** The `waitFor("ship_settled", ...)` listener for `commitOnly`/`commitAndPush`/`commitPushAndOpenCompare` always passes an explicit `30_000`ms budget (the backend's own `CREATE_TIMEOUT` is 20s; the frontend's must exceed it, never rely on `waitFor`'s 5s library default) and is armed (with a no-op `.catch()` attached immediately, to prevent a transient unhandled-rejection warning) **before** calling `gitPush`/`shipCompareUrl`, not after — event delivery (the webview event channel) and the IPC response (the `invoke()` promise) are two independent transport paths with no ordering guarantee between them, so registering the listener only after the triggering call resolves risks missing an event that already fired. This raced and timed out in the hook's own test suite before the fix (the original mock `waitFor` had no timer at all, which is exactly why the suite was blind to it) — `useShip.test.tsx`'s fake-timer test now delivers the receipt at t≈8s and asserts a settled success, proving the 30s budget (not the 5s default) is what's in effect.
  - **`nothingToCommit` recovery (B2).** A worker can have already-committed, unpushed work (e.g. an earlier "Commit Only") — `git_stage_commit` failing with `nothingToCommit` is not automatically a ship failure. `commitAndPush`/`commitPushAndOpenCompare` catch it and, when `ShipPreflight.ahead > 0`, skip straight to `gitPush` (which resolves its own sha server-side, needing no `commitSha` from a preceding commit at all — see `git_push`'s doc). `ahead == 0` still propagates as a genuine failure — there really is nothing to ship.
  - **Mode-change refetch (B3).** `setMode` refetches `git_ship_preflight` for the new mode whenever a preview is already showing, so the skipped-files/diffStat preview stays accurate to what will actually be committed rather than showing the `"all"`-mode preview while `"staged"` is selected.
  - **Post-settle side effects never flip a success to failure.** `open(url)` for the compare page runs *after* `runAction` has already resolved to `"settled"` — a shell-open failure (no default browser configured, etc.) downgrades to a `toast.warning`, it never re-flips the ship outcome to `"failed"`.

See [docs/api.md#ship-commands](api.md#ship-commands) for the full IPC contract and [Events](#event-system) below for `ship_progress`/`ship_settled`/`commit_created`'s place in the persistence policy.

#### Phase 2 — The Causal Record

**Outcome: the ship PR body cites the actual turns and tool calls in the commit's seq range — evidence generated by code, prose generated by a model, and the two never confused.** This is the T3-Code-parity differentiator the ship-chain plan called for; the mechanism it landed as diverges from that plan's original draft in one load-bearing way, documented below.

**Plan-vs-landed adaptation: `agent_turn_started` is NOT the turn root.** The plan assumed a turn's causal root event was `agent_turn_started {workerId, model, requestId}` (§2 item 1). Reading the landed code instead of re-implementing that draft turned up two independent AI paths with two *different* correlation-id spaces:

- `AIChat.tsx` (the webview-direct `@anthropic-ai/sdk` path, still the shipped default) calls `agent_turn_started` once per turn to obtain a `causeSeq` for tool-driven side effects — but never emits `agent_block`/`agent_tool_call`/`agent_tool_result` itself, and its `requestId` is a chat-item id, not a `TurnId`.
- `crates/swarm-core/src/agent/claude_code.rs` (`ClaudeCodeAdapter`, driving `AgentChat.tsx`) generates its own `turn_id: TurnId = Uuid::new_v4().to_string()` inside `send_turn` and **never emits `AgentTurnStarted` at all** — every `sink.emit(...)` call in that file uses `emit`, not `emit_with`, and the first wire event for one of its turns is `agent_block`/`agent_tool_call`.

A causal record keyed off `agent_turn_started` would silently show ZERO turns for every `ClaudeCodeAdapter`-driven worker — exactly the fabricated-emptiness failure mode the honesty rule (below) exists to prevent. `git::causal::build_ship_context` instead derives turn existence from the `agent_block`/`agent_tool_call`/`agent_tool_result`/`agent_turn_settled` family directly, grouped by their own `turnId` — the richer, tool-call-bearing signal RECONCILIATION.md §1 designates canonical. **Known scope boundary:** `AIChat.tsx`'s tool-driven side effects (correlated via the envelope `causeSeq`, not a payload `turnId`) are not surfaced by `ship_context` — a different-shaped signal (orchestration actions, not the tool calls that produced a worktree's own diff) that a future phase can add as its own clearly-labeled section rather than blurring into this one.

```text
ship_context(workerId)                                read-only, no events — RemotePolicy::Allowed
    │
    ├── resolve_seq_range(engine, registry, id)         the SAME algorithm git_stage_commit already
    │       uses (lastShippedSeq ?? worktree_created seq .. current max) — a ship_context call made
    │       right before "Commit + Push" describes the same range the resulting commit's
    │       Swarm-Seq-Range trailer will (barring new events landing in the preview-to-commit gap,
    │       which is unavoidable and harmless: the trailer is always the source of truth)
    ├── EventLog::open_readonly + events_for_worker_between(RELEVANT_EVENT_TYPES, workerId, ...),
    │       inside spawn_blocking — worker-AND-type-scoped in the SQL itself (see review FIX-1
    │       below), fetched newest-first (DESC) and reversed to ascending, returning (events, truncated)
    └── git::causal::build_ship_context(events, workerId, seqFrom, seqTo, truncated)   pure, tauri-free,
            unit-tested without a real EventLog — filters to payload.workerId (never envelope
            originWorker: none of the agent_* family stamps it today), groups agent_block/
            agent_tool_call/agent_tool_result/agent_turn_settled by turnId into
            CausalTurn{turnId, status, toolCalls[]}, and commit_created rows into CausalCommit[] —
            turns beyond MAX_TURNS (200) are dropped oldest-first with an honest omittedTurnCount;
            agent_turn_started rows set has_uncaptured_webview_activity (never a CausalTurn — see
            the module doc) for the NIT-4 empty-state message below
```

**RemotePolicy::Allowed, matching `git_ship_preflight`.** `ship_context` is read-only, exactly like preflight — a remote client legitimately previewing a ship it's about to trigger needs the causal record exactly as much as it needs the deny-list preview. No new remote-surface risk: the query is scoped to one worker's already-resolved seq range, and every field it returns (tool names, allowlist-extracted targets, ok/err) is already what `ShipPreflight`/`CommitOutcome` expose about that same worker's work.

**Review FIX-1: a second silent-truncation path, closed.** The first cut of `ship_context` called `EventLog::events_between(fromSeq, toSeq, 50_000)` — a range-WIDE cap applied BEFORE filtering to one worker, in Rust, after the fetch. On a long, busy, multi-worker session (SWARM's real workload) with more than 50,000 persisted events across ALL workers in range, the oldest 50,000 fill that cap and the shipping worker's own NEWEST, most ship-relevant turns are silently dropped — while `omittedTurnCount` stayed `0`, since that count is computed from whatever survived the cap, with no way to know what didn't. `EventLog::events_for_worker_between` (`orchestration/log.rs`) closes this two ways: `worker_id`/`RELEVANT_EVENT_TYPES` are filtered in the SQL itself (`json_extract(payload, '$.workerId') = ? AND type IN (...)`), so the 50,000-row budget is spent entirely on rows this specific worker's causal record can use; and the fetch is `ORDER BY seq DESC LIMIT` (a one-row truncation sentinel proves whether more matching rows exist), with the cut taken off the OLD end before reversing to ascending — so even a single worker whose own matching-row count exceeds the cap keeps its newest activity. The resulting `truncated: bool` flows straight through `build_ship_context` into `ShipContext.events_truncated`, folded into the SAME honest disclosure `omittedTurnCount` renders (`src/lib/ship-causal.ts`'s `renderTruncationNote` — see below) rather than a second, easy-to-miss signal. Pinned by `commands::git::tests::test_ship_context_worker_scoping_survives_heavy_cross_worker_noise` (20 other-worker rows against a limit of 3 — the shipping worker's one real turn still survives, untruncated) and `orchestration::log::tests::test_events_for_worker_between_truncation_keeps_newest_and_reports_it_honestly`.

**The target-extraction allowlist is the no-secrets boundary.** `git::causal::extract_target` reads only `path`/`file_path`/`filePath`/`command`/`cmd`/`pattern`/`url`/`query`/`name` off a tool call's `input` object, length-capped at 200 chars — never `content`/`body`/`text`/`data`, which a `Write`/`Edit` call's `input` can legitimately carry verbatim file contents in. This is what makes "no config value/token/`.env` content can reach the model" true by construction for the AI-prose half below, not by convention: the field a secret would have to travel through is never read in the first place.

**The two-part body composer (`src/lib/ship-causal.ts`).** `renderCausalRecordSection(context, diffStat)` is entirely deterministic — seq range, turn count, diff stat, any commits already in range, and a tool-call table (turn, tool, target, ok/err), every value read directly off `ShipContext`/`DiffStat`, no free text. A zero-turn range renders one of two honest messages via `emptyRecordMessage` (review NIT-4, below), alongside the diff stat (a diff-only body, never an empty one). `generateCausalProse` is the one function in the module that can fail — a single-shot `streamMessage` call (tools omitted, the same webview AI path `ship-message.ts`'s Phase 1 generator would have used) that collects the full response and strips it through `stripUnknownSeqCitations` before returning. `buildCausalPromptInput` is the sole prompt-assembly site, reading only `diffStat`'s three numbers, `branch`/`baseBranch`, and each turn's status + tool call `name`/`target`/`ok` — pinned by a static source-scan test (`ship-causal.test.ts`) asserting the module never imports `#lib/tauri`/calls `readConfig` at all, plus a runtime test that a contaminated `context` object's extra fields never reach the built prompt text.

**Review FIX-1 (UI half): `renderTruncationNote` unifies both truncation sources.** `omittedTurnCount > 0` (the `MAX_TURNS` cap dropped older turns from an otherwise-complete fetch — exact count known) and `eventsTruncated` (the SQL-level fetch itself hit its cap — turns older than what's visible may exist beyond what `omittedTurnCount` alone can count) render the identical honest sentence — `"Showing The Most Recent N Turns In This Range — Older Turns Omitted."`, `N` being what's actually shown — rather than two disclosures a reader would have to reconcile themselves. Shared by both `renderCausalRecordSection`'s markdown output and `ShipPreview.tsx`'s in-app table, so the composed PR body and the UI panel never drift on wording.

**Review NIT-4: "did nothing" vs. "structurally invisible."** A zero-turn `ShipContext` reads identically whether a `ClaudeCodeAdapter` worker genuinely had no activity in range, or an `AIChat.tsx` (webview) worker's activity used a correlation-id space this query structurally cannot see (see the plan-vs-landed adaptation above) — asserting "did nothing" about the latter would be misleading, not merely imprecise. `build_ship_context` fetches `agent_turn_started` alongside the turn-bearing types specifically to detect this (never building a `CausalTurn` from it — the id-space mismatch still holds) and sets `ShipContext.has_uncaptured_webview_activity`; `emptyRecordMessage` renders `"Causal Record Unavailable For This Range — No Recorded Agent Turns."` when `false` and `"This Worker's Activity Is Not Captured In The Causal Record (Webview Chat Path)."` when `true` — two distinct sentences, never one papering over both.

**The honesty rule: `stripUnknownSeqCitations`.** Same rule that killed the `Math.random()` charts — a `[seq N]` citation the model writes is checked against `context`'s actual `(seqFrom, seqTo]` range and removed, unconditionally, if `N` falls outside it (matching preceding whitespace so the removal doesn't leave a double space). A hallucinated seq and a genuinely out-of-range one are functionally indistinguishable and treated identically: neither survives to render.

**Review FIX-2: the deterministic Causal Record renders FIRST, always.** `composeShipBody(context, diffStat, aiProse)` puts the (already-stripped) Causal Record BEFORE the AI prose, separated by a rule — not the reverse. `stripUnknownSeqCitations` only strips an out-of-range citation; nothing stops a model from writing its OWN `## Causal Record` heading plus a fabricated table inside its prose, which — if the prose rendered first — would appear ABOVE the real section and read as the authoritative one to anyone skimming the PR body. Rendering the real section first removes the ambiguity structurally: the first `## Causal Record` heading anywhere in the composed body is always the code-generated one, whatever the model writes always follows it. Pinned by a test that injects a fake `## Causal Record` heading (plus a fabricated table) into the prose and asserts the real section's own table still appears first. `aiProse: null` — no key configured, a network failure, a refusal, or simply never having clicked Generate — renders the deterministic section alone. Shipping never blocks on any of this: `useShip.ts`'s `fetchContext`/`regenerateProse` are both best-effort, and `commitPushAndOpenCompare` falls back to the Phase 1 commit-message-derived body if `composedBody` never resolved.

**UI (`ShipPreview.tsx`).** An editable "What Changed / Why" textarea (seeded empty; a Generate/Regenerate pill triggers `regenerateProse`, disabled while `context` hasn't loaded or a generation is already in flight) sits above a read-only Causal Record table rendered directly from `ShipContext` (not the markdown string, which is reserved for the actual PR body) — `context == null` (still loading) and a genuinely empty range render two DISTINCT Title Case messages ("Loading Causal Record…" vs. one of `emptyRecordMessage`'s two — see NIT-4 above) so a user is never left wondering which case they're looking at.

**Known scope boundary, unchanged (review NIT-3, skipped by ruling):** the window between a commit landing and the resulting `commit_created` event being queryable is uncited — inherited from Phase 1's own commit/push sequencing, out of scope for this phase.

See [docs/api.md#ship_context](api.md#ship_context) for the full IPC contract.

### Adapter Layer

**Outcome:** one Rust trait pair every provider CLI (Claude Code, Codex, OpenCode, Gemini) implements, so every provider's turns land as normalized `agent_*` events on the same ordered spine every other backend event already flows through (see [Ordered Event Core](#ordered-event-core)). Phase 2 of the multi-provider agent-execution plan shipped this typed and tested with no concrete adapter. **Phase 3 landed the first one** -- `ClaudeCodeAdapter`/`ClaudeCodeSession` (`crates/swarm-core/src/agent/claude_code.rs`), driving the `claude` CLI's `-p --output-format stream-json` protocol over `spawn_piped`. **Phase 4 lands the second** -- `CodexAdapter`/`CodexSession` (`crates/swarm-core/src/agent/codex.rs`), driving `codex app-server`'s stateful, bidirectional JSON-RPC 2.0 protocol over the SAME `spawn_piped` substrate. `swarm-desktop`'s `lib.rs` constructs and `app.manage()`s BOTH adapters, one shared `AgentSessionRegistry` (live `Arc<dyn AgentSession>` by worker id -- the Tauri-free, process-lifetime counterpart to `WorkerRegistry`), and one shared `AgentScheduler`; `agent_spawn`/`agent_probe` route to the right adapter by `ProviderId`, every other command (`agent_send_turn`/`agent_cancel`/`agent_shutdown`/`agent_permission_respond`, `src-tauri/src/commands/agent.rs`) stays provider-generic, reaching the live session purely through the registry by worker id (documented in [docs/api.md](api.md#agent-commands)). OpenCode/Gemini remain unimplemented -- see [Built, Not Wired](#built-not-wired).

**Phase 4 verdict -- the trait survives a genuinely different protocol family, unchanged:** Claude Code's `stream-json` is one-way NDJSON with no request ids and no server-initiated questions. `codex app-server` is the structural opposite: **stateful, bidirectional JSON-RPC 2.0** -- the client sends `id`-bearing requests and gets matching responses (`thread/start`, `thread/sendMessage`), the server sends one-way notifications for streaming/lifecycle (`item/started`, `item/agentMessage/delta`, `item/completed`, `turn/completed`), AND the server can send the client its OWN `id`-bearing REQUEST mid-turn that blocks until answered (an approval). `CodexAdapter` landed with **zero changes to either trait method's signature**. The one addition -- `Capabilities::interactive_permissions` -- is exactly the kind of change the trait's own design anticipated: a new FIELD on a plain data type the trait already returns (see the Capabilities honesty doctrine below), never a new method or a changed signature. `CodexSession::respond_permission` is a REAL round-trip (it writes a matching JSON-RPC response back to the child, proven by a fixture whose fake server hangs until that write arrives) -- the exact opposite of `ClaudeCodeSession::respond_permission`'s documented no-op, and the concrete, wire-verified reason the flag exists.

#### Phase 4 findings that shaped `CodexAdapter` -- and what remains ASSUMED

Codex is not installed on the machine this adapter was built on, so unlike `ClaudeCodeAdapter` (every design choice traced to a live spike run), `CodexAdapter`'s protocol shapes are **authored, not captured**. Every fixture under `tests/fixtures/codex/` is hand-written JSON-RPC, not a copied wire log. `codex.rs`'s module doc carries the full, itemized ASSUMPTIONS list; the load-bearing points:

- **Plan-cited verbatim:** `item/started`, `item/completed`, `item/agentMessage/delta` -- the three method names the multi-provider plan's own source citation names.
- **This adapter's own JSON-RPC extrapolation, UNVERIFIED against a live install:** `thread/start`/`thread/sendMessage` (session start / turn submission, both real request/response), `turn/completed`/`turn/failed` (terminal notifications), `approval/request` (the server-initiated approval request), and every params shape carrying them. `turn/failed`'s CODE PATH (not its method name) is now fixture-exercised (review FIX-3) -- `tests::test_turn_failed_settles_with_the_reported_error`.
- **Higher-confidence, grounded in the real Codex CLI's documented config vocabulary (not the JSON-RPC shape carrying them):** `approvalPolicy` tokens `untrusted`/`on-request`/`on-failure`/`never` and `sandboxPolicy` tokens `read-only`/`workspace-write`/`danger-full-access` -- `CodexTrustTier`'s three tiers map onto the first three of each; `"never"`/`"danger-full-access"` are never constructed by this adapter (argv/params-proven in `codex.rs`'s test suite), the sandbox-side analog of Claude Code's unconstructible `bypassPermissions`.
- **`resume` is honestly `false`, not merely unverified-but-claimed.** `CodexAdapter::spawn` explicitly REJECTS a spawn spec's `resume` field (an `AppError`, not a silent ignore) -- no `thread/resume`-equivalent request is implemented in this cut.
- **A genuine cross-task race, found by a flaky test under full-workspace load, not by inspection.** Promoting a turn's confirmation sentinel to its real, server-issued `TurnId` originally happened in `send_turn`'s own post-`.await` continuation -- but resolving a oneshot only WAKES the awaiting task, it does not preempt whatever is currently running. On the single-threaded executor this adapter's reader task runs on, already-buffered notifications (including the terminal one) could be processed before `send_turn`'s continuation ever got scheduled, corrupting the turn's settlement. Fixed by moving the promotion into the reader task's own synchronous response handling (`handle_response`, `codex.rs`) -- see that function's doc for the full mechanics.
- **Wire-order independence (review FIX-1) -- `thread/sendMessage`'s response confirming a turn before vs. after that turn's own terminal notification is NO LONGER a correctness dependency, only an open naming/shape question.** ASSUMPTION #2 in `codex.rs`'s module doc originally read "this adapter's design leans on the response arriving first"; a review caught that JSON-RPC 2.0 gives no such guarantee, and the ORIGINAL wire-order-dependent version silently produced ZERO `agent_turn_settled` events for a turn Codex genuinely completed if the terminal notification won the race (the sentinel was still in place when `settle_turn` ran, so it skipped; `handle_response`'s later promotion attempt found nothing left to promote; `teardown` would eventually misreport the turn as an ungraceful-exit error). Fixed: `settle_turn` now trusts the terminal notification's OWN `turnId` (every notification already carries one, same as every per-item handler in this file already relies on) whenever the sentinel hasn't been promoted yet, settling exactly once regardless of which line wins the wire race -- `handle_response`'s promotion is now belt-and-suspenders, not load-bearing. Proven both ways: `tests::test_send_message_response_before_terminal_notification_settles_exactly_once` (the common order) and `tests::test_terminal_notification_arriving_before_the_send_message_response_still_settles_exactly_once` (the reversed one, the actual regression fixed). What genuinely still needs live-codex confirmation, narrowed by this fix: the exact method/param names themselves, and whether turn acceptance is signaled via a response at all.
- **Condition B corollary specific to a request/response `send_turn`.** A turn that dies BEFORE `thread/sendMessage`'s response ever confirms it never receives a real `TurnId` -- there is nothing to attach a synthesized settlement to. It resolves by directly failing the caller's still-pending `send_turn` call (via `teardown`'s pending-request drain) instead: never a hang, and never a phantom `agent_turn_settled` for a turn nobody ever received. Once a turn IS confirmed (holds a real `TurnId`), Condition B applies identically to Claude Code.

#### Phase 3 findings that shaped `ClaudeCodeAdapter` (`RECONCILIATION.md` §0/§0b, binding)

- **Permission modes are spawn-time configurations, never a mid-turn prompt.** A dedicated permission-gating mini-spike found `--permission-mode manual` is a **silent no-op** in `-p` mode (accepted, exit 0, `init` still reports `"default"`, the tool executes anyway, zero control-request messages in the raw stream) -- the interactive `agent_permission_request` -> `respond_permission` round-trip this event's payload was originally shaped for is **not buildable** on this provider. `ClaudeCodeSession::respond_permission` is accordingly a documented no-op (`Ok(())` always); every `agent_permission_request` this adapter emits is instead a **REPORT** of a denial that already happened, sourced from the provider's own `system/permission_denied` line. `suggestedDecision` is always `Deny` on these reports; the actual reason is carried by two new fields the struct gained in Phase 3 -- `denialSubclass` (one of `"mode"` / `"ungranted_write"` / `"redirection_guard"`, the three subclasses the mini-spike observed, classified from the provider's `decision_reason_type`/`message` fields) and `message` (the provider's raw text, verbatim). See `crate::events::emitter::AgentPermissionRequestPayload`'s doc for the full semantics-shift writeup.
- **Trust tiers (`ClaudeCodeTrustTier`: `Restricted` / `Standard` / `WriteEnabled`) map to spawn-time flags, not to Condition C's rejected `allowedTools`.** `Restricted` = `--permission-mode dontAsk` + a belt-and-suspenders `settings.json` deny list (`Bash`, `Write`, `Edit`, `NotebookEdit`); `Standard` = the implicit default mode (no flag -- `"default"` itself is not a selectable value, per the Phase 1 spike's flag-drift note) + a deny list for dangerous Bash patterns; `WriteEnabled` = `--permission-mode acceptEdits` + the same Bash-pattern deny list. `AgentSpawnSpec::permission_mode` (the generic cross-provider field) is parsed through a closed 3-token vocabulary (`"restricted"`/`"standard"`/`"write_enabled"`) that fails closed on anything else -- **this is what makes `--bypassPermissions` unconstructible by this adapter**: there is no code path, not a runtime check but an absent one, through which any of the three variants could ever produce that flag value (argv-proven in `claude_code.rs`'s test suite).
- **`acceptEdits` canary (Phase 3 entry criterion for `WriteEnabled`) -- PASS.** The mini-spike left `acceptEdits` as the one untested permission-mode cell. A dedicated canary run against the real CLI (`scratchpad/spike-permissions/logs/13-acceptedits-canary.*`, `--permission-mode acceptEdits --setting-sources project`, $0.05) confirmed the Write tool executed cleanly with zero `permission_denied` events and `init.permissionMode == "acceptEdits"`.
- **`Tool(pattern)` glob-form deny, spike-verified -- PASS, pattern-granular.** Bullet above's Standard/WriteEnabled dangerous-Bash-pattern deny list used the `Tool(pattern)` glob grammar beyond Condition A's own spike coverage, which only verified the bare-tool-name form (`"Bash"`, which removes the tool from `init.tools` entirely -- a full-tool deny, not a per-call one). A dedicated canary (`scratchpad/spike-permissions/logs/15-glob-deny-echo-vs-pwd.*`, `--settings '{"permissions":{"deny":["Bash(echo*)"]}}' --setting-sources project`, one turn instructed to invoke Bash for both `echo hi` and `pwd`, $0.02 -- run on `--model haiku` rather than the harness's usual `sonnet` solely to stay under budget, since permission gating is enforced by the CLI around the tool call rather than by the model) confirmed the glob restricts exactly the matching invocation: `echo hi` was denied (`is_error: true`, content `"Permission to use Bash with command echo hi has been denied."`, and a matching `permission_denials` entry naming that exact command) while `pwd` executed normally in the SAME run (`is_error: false`, real cwd in the tool result) -- with `Bash` still listed in `init.tools` throughout. Neither "deny all Bash" nor "deny nothing" (the run terminated via `error_max_turns` after both tool results were already captured in the transcript -- same harmless `--max-turns`-bounds-the-harness-not-the-real-adapter nuance as the `acceptEdits` canary bullet above; the measurement itself stands regardless of how the run formally ended). `deny_list`'s other four Standard/WriteEnabled pattern-form entries (`Bash(rm -rf*)`, `Bash(git push --force*)`, `Bash(git push -f*)`, `Bash(git reset --hard*)`, `Bash(sudo*)`) were not independently run through this canary -- they follow the same `Tool(pattern)` glob grammar verified pattern-granular here, not a separately confirmed empirical result apiece.
- **Condition A, concretely: `--setting-sources project` + `--settings '<inline JSON>'`.** `{"permissions": {"deny": [...tier-specific list...]}}` is passed as an argv VALUE (`claude --help`: `--settings <file-or-json>` accepts either), never written to disk, never touching the worker's cwd/worktree at all. **The first cut of this module got this wrong** -- it wrote `<cwd>/.claude/settings.json` into the worker's own worktree on the false premise that no `--settings` override existed. A review caught three compounding failure modes that design had: (a) the file gets staged and shipped by the ship chain's commit-all path into the user's repo, (b) it makes the worktree permanently dirty, so `git worktree remove` refuses forever -- every Claude Code worker leaked its worktree on kill, (c) a bare `fs::write` would clobber a human-committed `.claude/settings.json` if one existed. The inline-`--settings` fix was re-verified empirically before landing (`scratchpad/spike-permissions/logs/14-inline-settings-plus-setting-sources.*`): byte-identical behavior to the file-based approach the mini-spike originally validated -- same `init` tool/plugin/mcp counts (30/0/0) and the same deny-by-omission pattern, so the "one winning lever" (real permission gating + Condition A's controlled config environment + lower cost, all from one mechanism) still holds with zero worktree-write risk.
- **Multi-turn reality, confirmed empirically (`scratchpad/spike/logs/multi-turn-same-process.*`): one process, fed more than one stream-json user message before EOF, handles each as a separate turn IN THE SAME PROCESS AND SESSION** -- each turn gets its own `system/init` + terminal `result` line, but `session_id` (and conversation context) is stable across all of them. `ClaudeCodeSession` therefore keeps ONE child process alive for a session's whole lifetime; `send_turn` writes to the same already-open stdin every time. `--resume` is used only to rehydrate a session whose process is gone (app restart, a prior kill), never as a per-turn respawn strategy -- the plan's original "does it respawn with `--resume` per turn" question resolved to "no."

**The trait pair** (`crates/swarm-core/src/agent/adapter.rs`):

```rust
pub trait AgentAdapter: Send + Sync {
    fn provider(&self) -> ProviderId;
    fn capabilities(&self) -> Capabilities;
    fn probe(&self) -> BoxFuture<'_, Result<ProbeReport, AppError>>;
    fn spawn(&self, spec: AgentSpawnSpec) -> BoxFuture<'_, Result<Box<dyn AgentSession>, AppError>>;
}

pub trait AgentSession: Send + Sync {
    fn session_key(&self) -> &SessionKey;
    fn send_turn(&self, turn: TurnInput) -> BoxFuture<'_, Result<TurnId, AppError>>;
    fn cancel(&self, turn: TurnId) -> BoxFuture<'_, Result<(), AppError>>;
    fn respond_permission(&self, req: PermissionId, d: PermissionDecision) -> BoxFuture<'_, Result<(), AppError>>;
    fn shutdown(&self) -> BoxFuture<'_, Result<ExitSummary, AppError>>;
}
```

`AgentAdapter` is the provider-level, stateless launcher (one instance per provider); `AgentSession` is the per-worker, stateful handle to one live conversation. `BoxFuture<'a, T>` is `Pin<Box<dyn Future<Output = T> + Send + 'a>>` -- the multi-provider plan's pseudocode wrote these methods as `-> impl Future<Output = ...>` (RPITIT), which reads cleanly but is **not dyn-compatible**: `AgentAdapter::spawn` must return `Box<dyn AgentSession>`, a trait object, and a trait with RPITIT methods cannot be turned into one on stable Rust. `BoxFuture` is the hand-written equivalent of what the `async-trait` crate generates, chosen so this trait pair is object-safe without taking on a new dependency.

**`shutdown` takes `&self`, not `self: Box<Self>` (changed after review), and is idempotent** -- a second call returns the same cached `ExitSummary` rather than re-killing an already-dead process. This is what lets a session live behind `Arc<dyn AgentSession>`: multiple call sites (a cancel handler, an app-shutdown hook, a health check) can each hold a reference, and any of them may be the one that actually triggers teardown. The full concurrency contract (binding on every implementation): `send_turn` while a turn is in flight returns a typed `AppError::AgentSessionBusy` -- a session never queues internally, that is the scheduler's job; `cancel` may race `send_turn`/`shutdown` safely; no internal lock may be held across an `.await` point; and Condition B is restated as a hard invariant -- a turn in flight when `shutdown` runs (or the child dies on its own) MUST yield **exactly one** `agent_turn_settled`, synthesized by the session, never zero and never two.

**Capabilities honesty doctrine:** `Capabilities` (`partial_deltas`, `resume`, `native_cost`, `permission_modes`, `cancel_granularity`, `interrupt_midturn`, `worktree_aware`, `interactive_permissions`) exists so the UI disables an affordance instead of silently no-op'ing it when a provider structurally cannot do something (OpenCode's HTTP/SSE has no stdin to interrupt; `codex exec --json` has no mid-turn steering). For `ClaudeCodeAdapter`, every field is backed by an empirical finding from the Phase 1 spike (claude CLI 2.1.232, `stream-json` over piped stdio, six-gate measurement, `scratchpad/spike/`) -- not an aspiration:

| Capability field | Spike finding |
|---|---|
| `partial_deltas` | PASS, but **sentence-clause granularity** -- 4-6 deltas per response, ~100-230 chars each. Chunkier than the webview SDK's token-level streaming. |
| `resume` | PASS -- context, including tool results from an error-terminated turn, carried across invocations by session id. |
| `native_cost` | PASS on every clean exit (`total_cost_usd` always present, `modelUsage` breakdown included). **Killed turns lose cost data** -- see Condition B below. |
| `cancel_granularity` | `KillOnly` is the honest default: 43ms cancel latency via `kill()` (well inside the ≤500ms gate), but stdin-close is NOT a cancel (the child runs to completion), and Windows `kill()` is `TerminateProcess` with no graceful signal path at all. |
| `interactive_permissions` | `false` -- `--permission-mode manual` is a silent no-op; `respond_permission` has nothing on the wire to answer (see §0b's Phase 3 findings above). |

`CodexAdapter`'s `Capabilities` are, by contrast, mostly CONSERVATIVE defaults (`resume: false`, `native_cost: false`, `cancel_granularity: KillOnly`, `interrupt_midturn: false`) precisely because there is no live install to verify against -- see the Phase 4 findings below. The one exception is `interactive_permissions: true`, backed by an actual fixture-tested wire mechanism rather than an assumption.

**The three binding spike conditions:**

- **Condition A** (controlled config environment): SWARM workers MUST run provider CLIs with a controlled config environment (per-profile config home / `--setting-sources`) -- the operator's personal plugin/hook loadout added ~5s to first-token latency in the spike (6.6s p50 → 1.73s p50 with `--setting-sources ""`). Enforced by `ClaudeCodeAdapter::spawn` as of Phase 3 -- see the Phase 3 findings above.
- **Condition B** (synthesize the terminal receipt on ungraceful exit): every clean exit gets exactly one terminal event, including `max-turns` errors -- but **zero** terminal events on process kill. Every `AgentSession::shutdown` implementation MUST itself emit a synthesized `agent_turn_settled` (`status: "error"`, `costUsd`/`usage: None` -- honestly, not fabricated) for any turn still in flight when the process exits ungracefully, mirroring the pattern the deleted `AiClient::stream_message`'s error branch already established for `ai_stream_delta`'s `done: true` guarantee.
- **Condition C** (never gate on `allowedTools`): `--allowedTools Read` did **not** prevent a `Bash` tool from executing in `-p` mode -- `allowedTools` is an auto-approve list, not a restriction. Permission gating MUST rest on `--permission-mode`/`disallowedTools`/hooks, never on reading an "allowed" list as if it were a denylist's complement. `ClaudeCodeAdapter` gates exclusively on `--permission-mode` + `settings.json` `permissions.deny` (Condition A's file) -- see the Phase 3 findings above for the tier-by-tier mapping.

**Session state -- three owners, no mirroring:**

| Layer | Owner | Rule |
|---|---|---|
| Conversation | The provider CLI | SWARM stores only an opaque `SessionKey` + `cwd`. Never mirror the transcript -- that was the dead Rust AI stack's mistake. |
| History | SWARM's ordered event log | Every normalized `agent_*` event, seq-ordered -- see [docs/api.md](api.md#type-tags) for the full family and its persistence table. |
| Process | `AgentSessionRegistry` (ephemeral, `crates/swarm-core/src/agent/registry.rs`) | Live `Arc<dyn AgentSession>` by worker id -- child handle, stdin writer, current turn live inside `ClaudeCodeSession` itself. Reconstructible from the log + `--resume`. |

**Piped-process substrate** (`worker/proc.rs`, `spawn_piped`): a sibling to `spawn_pty` reusing the identical backpressure shape (`spawn_blocking` reader → bounded `mpsc(4096)` → forwarder task) but over `Stdio::piped()` instead of a pseudo-terminal, plus an `NdjsonFramer` that compacts its buffer once per `push()` call rather than once per line (see the module doc for the `ai/client.rs` line-framing loop this transplants and improves on). **A PTY is wrong for JSON**: line discipline echoes input, injects `\r`, and can inject ANSI escapes -- all of which corrupt NDJSON framing. `spawn_pty` stays correct for interactive shells; `spawn_piped` is the only substrate a JSON-protocol provider CLI may use.

- **Linear scanning, post-review fix.** The framer's `\n` search persists a `scan_from` cursor across `push()` calls instead of rescanning from byte 0 every time -- the first cut re-scanned the retained partial-line prefix on every chunk, an O(n²) amplification measured at ~13.4B byte-comparisons for a single 10MB line fed in `spawn_piped`'s 4096-byte read chunks (>1000x the actual work). Now each byte is scanned at most once over the framer's whole lifetime.
- **A line cap (`MAX_LINE_BYTES`, 10MB).** An unterminated line past the cap returns `AppError::LineTooLong` -- never silently truncated JSON, and never an unbounded buffer for a provider that desyncs and stops emitting `\n`. The framer clears its own buffer as part of returning the error (subsequent lines keep parsing); the caller must still treat it as a session-level failure.
- **`PipedHandle::kill_and_wait`** mirrors `spawn_pty`'s reap pattern (drop the stdin writer, kill, wait) so Phase 3 has one call that avoids zombies. `PipedHandle::stderr_tail` retains the last ~4KB of stderr live (not just a byte count) so a provider's fatal startup message is recoverable for diagnostics; the drain thread's lifetime is tied to the child's own (its `read()` unblocks with EOF once the child dies, whether via `kill_and_wait` or on its own).

**The agent-turn scheduler** (`agent/scheduler.rs`, `AgentScheduler`) absorbed the deleted `ai/queue.rs` wholesale: the same `BinaryHeap<PrioritizedRequest>` + `Semaphore::acquire_owned()` + `JoinSet` + bounded `mpsc(256)` machinery, retyped from `AiRequest`/`AiPriority` to `AgentTurnRequest`/`TurnPriority`. The one structural change: the old queue owned a concrete `AiClient` and called `client.stream_message()` directly; `AgentScheduler` is generic over an injected `executor` closure instead. As of Phase 3, `swarm-desktop`'s `lib.rs` constructs one at startup with `AgentSchedulerConfig::default()` (`concurrent_limit: 3`, mirroring `useAiStore`'s existing `concurrentLimit` default -- that TS store is client-side-only and not yet synced to this Rust-side value; a `set_agent_concurrency` command to keep them live-synced is a follow-up) and an executor that looks up the target session in `AgentSessionRegistry` and calls `send_turn` on it. The `agent_send_turn` command (`docs/api.md`) enqueues through this scheduler rather than calling a session directly, so concurrent turns are gated app-wide -- concurrent agent turns are the scarce resource for the reason the plan gives: you do not want 20 Claude Code processes running tools against one repo at once. It is fire-and-forget by design: the command confirms admission, not completion, and the frontend renders from the live `agent_*` event stream rather than a synchronous return value.

### Session Persistence

Sessions are stored in `DashMap<Uuid, Session>` and persisted to disk:

- **Storage file:** `sessions.json` in the app data directory — same file and `{"sessions": [...]}` shape the pre-Phase-2 `tauri-plugin-store` backend wrote, so an existing file loads unmodified (no migration step)
- **Backend:** `swarm_core::session::persist::JsonSessionStore` — tauri-free atomic JSON (write-then-rename), shared by both shells since headless-daemon Phase 2; `tauri-plugin-store` remains in the desktop shell only for frontend key-value stores (`src/lib/kv.ts`)
- **Auto-save:** After every create/delete/`session_add_worker` operation, offloaded to `spawn_blocking`
- **Restore:** Loaded once during app setup, before any commands are processed

### Message Bus

**Outcome (Phase 4 of the multi-provider plan, "bus disposition, part 2"): the bus is the inter-agent handoff ROUTING layer, not dead scaffolding.** Before Phase 4 it was worse than unwired -- `bus_send` published to the internal bus, but delivery to the frontend depended entirely on an active `bus_subscribe` forwarder task, and nothing in the shipped app ever called `bus_subscribe`. A message sent had, in practice, nowhere to go.

- **`MessageBus`** (`bus/channel.rs`, unchanged): creates and holds one `tokio::sync::broadcast` channel per topic string, in a `DashMap<String, Sender<BusMessage>>`.
- **`Router`** (`bus/router.rs`): sends direct messages (`send_direct`, tagged with a `to_worker`) and broadcasts (`send_broadcast`) -- and now ALSO emits `bus_message` onto the ordered spine itself, synchronously, via the `EventSink` it's constructed with (`Router::new(bus, sink)`). This is the actual fix: every send reaches the frontend unconditionally, the same guarantee every other `agent_*`/`worker_*` event already had, instead of requiring an active subscriber that nothing ever started. `causeSeq`/`originWorker` thread straight through from the caller onto the envelope, so a Rust-side adapter handing a turn off to another worker (or a human-initiated `bus_send`) can cite the real causing event.
- **DELETED (~150 lines): `create_pipeline`/`execute_pipeline`/`PipelineStage`/`apply_transform`.** `execute_pipeline` never awaited any stage's completion, and `apply_transform` only ever narrowed the INITIAL payload -- never a worker's actual output. A synchronous fan-out wearing a pipeline's name, not a real one. Real multi-stage handoffs are handoff CHAINS derived from `causedBySeq` on successive `bus_message`/`agent_turn_started` events -- the ordered causal log already gives you a pipeline for free, without a separate stage-registration API that can silently drift from what actually happened.
- **DELETED: `bus_subscribe`/`bus_create_pipeline`/`bus_list_pipelines` commands.** `bus_subscribe` was a second subscription primitive recreating the exact ad-hoc-events problem the ordered spine already eliminated -- and had zero callers anywhere in the shipped app. `grep -rn "create_pipeline|execute_pipeline|PipelineStage|apply_transform|bus_subscribe|bus_create_pipeline|bus_list_pipelines" --include="*.rs"` returns zero live references (doc-comment mentions of the deletion itself aside).
- **KEPT: `bus_send`, `bus_list_channels`.** Registry entry count settled at 35 (ship Phase 2's `ship_context` had brought it to 37; this change's net +1 `agent_permission_respond`, -3 deleted bus commands then landed it at 35) -- see [docs/api.md](api.md#unified-bus-event-contract).

### Ordered Event Core

The `orchestration` module owns the single ordered event pipeline that every `EventSink::emit`/`emit_with`/`emit_awaiting_seq` call (`crates/swarm-core/src/events/emitter.rs`) is routed through:

```text
Any backend call ──EventSink::emit[_with|_awaiting_seq]()──> WriterMsg { event, provenance, ack? }
                                              │                       (mpsc::Sender, any thread)
                                    swarm-event-writer thread        (the only writer)
                                              │
                                    seq += 1; ts = now_millis()
                                              │
                                    is_persistent(event)? ──yes──> EventLog::append(.., provenance)   SQLite (WAL)
                                              │                        <app-data>/swarm-events.db
                                              ├──ack.send(seq) (if requested, non-blocking)
                                              ▼
                                    emit closure(DomainEvent { seq, ts, originWorker?, causeSeq?, ..flattened SwarmEvent })
                                              │  (the Tauri shell's closure forwards it onto swarm://events)
```

- **Single writer, one thread:** `OrchestrationEngine::start` spawns one dedicated `swarm-event-writer` OS thread owning an `mpsc::Receiver<WriterMsg>` and the `EventLog` connection. `EventSink::emit`/`emit_with` are a non-blocking `Sender::send` callable from any thread/task; the writer loop is the *only* place that assigns `seq`, so wire order is totally ordered by construction -- there is no window where two threads could race to claim the same sequence number.
- **SQLite WAL log, migrated:** `EventLog` (`orchestration/log.rs`) opens a SQLite database at `<app-data>/swarm-events.db` in WAL journal mode (`synchronous = NORMAL`). The base `events(seq INTEGER PRIMARY KEY, ts, type, payload) STRICT` table is created legacy-shape-first, then a `PRAGMA user_version` migration ladder adds `origin_worker TEXT`/`cause_seq INTEGER` (both nullable -- existing rows come back `NULL`, the truthful historical value) plus a partial index `idx_events_origin_seq(origin_worker, seq) WHERE origin_worker IS NOT NULL` for worker-scoped seq-range queries. `seq` is the primary key, so a duplicate-seq append is a hard error -- an invariant the writer thread's exclusive ownership of `seq` assignment guarantees never fires in practice. On startup, the engine resumes numbering from `EventLog::max_seq()`, so sequence numbers stay monotonic across restarts, not just within one process lifetime.
- **Persistence policy:** every event consumes a `seq`, but only some are written to the log. `is_persistent()` (`orchestration/engine.rs`) excludes `WorkerOutput`, `SystemMetrics`, and `SystemLog` by variant -- high-frequency telemetry that flows live but is not history -- plus `WorkerInput` by a **field-level** carve-out: `source == InputSource::Terminal` (raw human keystrokes) is excluded even though the `WorkerInput` variant itself persists for `source.is_machine_issued()` (`Tool`/`Automation`). `source` is a closed, typed enum (`crate::events::InputSource`, `#[serde(rename_all = "snake_case")]`), not a bare string -- an unrecognized wire value fails IPC deserialization before this function ever runs, so the "raw keystrokes/secrets never archived" guarantee doesn't depend on the webview spelling `"terminal"` correctly. A per-keystroke durable row would both flood the log and archive whatever a human typed into a shell, secrets included. Everything else (`worker_spawned`, `worker_killed`, `worker_state`, `worker_input` [non-terminal], `session_created`, `session_deleted`, `session_worker_removed`, `ai_stream_delta`, `ai_stream_settled`, `agent_turn_started`, `agent_session_started`, `agent_block`, `agent_tool_call`, `agent_tool_result`, `agent_permission_request`, `agent_turn_settled`, `agent_session_exited`, `bus_message`, `worktree_created`, `worktree_removed`, `ship_progress`, `ship_settled`, `commit_created`, `file_written`) persists before being emitted -- **except `agent_turn_delta`**, excluded by variant alongside `WorkerOutput`/`SystemMetrics`/`SystemLog` above (per-clause streaming rows would be ~800 SQLite rows/s at 8 workers; its durable counterpart is `agent_block`). `is_persistent()` excludes by name (or, for `WorkerInput`, by field) rather than allowlisting, so a new variant is persistent by construction unless explicitly added to the exclusion list -- pinned down for the two worktree events by `orchestration::engine::tests::test_worktree_events_are_persistent`, the three ship events by `orchestration::engine::tests::test_ship_events_are_persistent`, every new `agent_*` variant by `test_agent_turn_delta_is_ephemeral`/`test_every_other_new_agent_variant_is_persistent`, and the `worker_input` source carve-out by `test_worker_input_persistence_depends_on_source`.
- **Causal attribution (`Provenance`):** every `WriterMsg` carries a `Provenance { origin_worker: Option<Uuid>, cause_seq: Option<u64> }` alongside its event -- `Provenance::default()` (both `None`) for `EventSink::emit`, an explicit value for `emit_with`/`emit_awaiting_seq`. The writer stamps it straight onto the `DomainEvent` envelope as `originWorker`/`causeSeq` (`skip_serializing_if` keeps the common unattributed case wire-lean -- absent, not `null`) and into the persisted row's `origin_worker`/`cause_seq` columns. **The subject-vs-causer rule:** a payload's own `workerId` field is the SUBJECT of the event (whose worker spawned, whose PTY got input); `originWorker` on the envelope is the CAUSER (who made it happen). For a human-driven action the two are typically unrelated or `originWorker` is simply absent; for a tool-driven action (an AI turn's `spawn_worker`/`kill_worker`/`worker_input`/`write_file` tool call) `originWorker` is the panel worker whose turn issued the call, distinct from the payload's own `workerId` -- and that difference IS the causal edge the provenance graph is built from (see [Causality Graph](#causality-graph) below). **The invariant, enforced by doc-comment and review, not by the type system:** the engine *records* provenance, it never *infers* it -- there is no "the last AI turn probably caused this" heuristic anywhere in this codebase; every `Provenance` passed to `emit_with`/`emit_awaiting_seq` traces back to an explicit, caller-supplied value (an IPC argument, a bus message's own `from_worker`, a turn's own recorded seq).
- **The ack-oneshot (`emit_awaiting_seq`):** returns a `tokio::sync::oneshot::Receiver<u64>` that resolves to the seq the writer thread assigns the event -- deterministic, no polling, no timeout-bound `waitFor` correlation. Used by the `agent_turn_started` command (see [docs/api.md#agent_turn_started](api.md#agent_turn_started)) so a chat turn can learn its own seq before any tool call needs to cite it as `causeSeq`. Non-blocking and stall-proof by oneshot construction: if the caller drops the receiver (e.g. a cancelled IPC call) before the writer gets to it, `ack.send(seq)` simply returns `Err` and is ignored -- the writer thread never waits on, or even notices, a disinterested receiver.
- **Emission:** after the persistence step, the writer wraps the event in a `DomainEvent { seq, ts, originWorker?, causeSeq?, ..flattened SwarmEvent }` and hands it to the primary `emit` closure passed to `OrchestrationEngine::start` (the Tauri shell's closure forwards it onto the single `swarm://events` channel). See [docs/api.md#events](api.md#events) for the wire shape and full type-tag list.
- **The receipt pattern:** rather than overload a stream event's payload with a completion flag, terminal outcomes get their own event type -- e.g. `ai_stream_settled`, emitted exactly once per AI request after the final `ai_stream_delta`, on both success and failure. Frontend code awaits the receipt (`waitFor()` in `src/lib/event-bus.ts`) instead of inferring completion from stream contents.
- **Replay foundation:** `commands/orchestration.rs::events_since(after_seq, limit?)` returns persisted rows with `seq > after_seq`, ascending, capped at (and defaulting to) 5000 per call, with an optional smaller `limit` used by the causality inspector's single-row backward hops (see [docs/api.md#events_since](api.md#events_since) and [Causality Graph](#causality-graph) below). This is the data-layer foundation for gap backfill -- already wired into `src/lib/event-bus.ts`'s `connectEventBus` -- and for future replay; a replay *UI* is out of scope for this phase.

#### The honest v1 attribution table

Provenance is wired end-to-end (envelope, SQLite columns, IPC args), but only some call sites actually populate it today -- the rest wire the *plumbing* (optional `originWorker`/`causeSeq` args exist and are honored) without a caller ever passing a value. This table is the single source of truth for which is which; code comments elsewhere in this codebase point back here rather than restating it.

| Path | `originWorker` | `causeSeq` |
|---|---|---|
| AI tool → `spawn_worker`/`kill_worker`/`worker_input`/`write_file` | real (the calling panel's `workerId`) | real (`agent_turn_started`'s seq) |
| `bus_message` | real (`fromWorker`, free -- `Router::send_direct`/`send_broadcast` already have it) | real as of Phase 4 -- `bus_send`/an adapter-side `Router` call may thread a `causeSeq` straight through (`commands/bus.rs`'s `BusSendArgs.cause_seq`); `None` when the sender doesn't have one to cite |
| Terminal keystrokes (`worker_input`, `source: "terminal"`) | none (the causer is a human, not a worker's turn) | none |
| Workspace auto-inject (`worker_input`, `source: "automation"`) | none | none -- v2 needs a `workspace_changed` event to exist first, to cite as the cause |
| Palette/UI actions | none | none in v1 (v2: a single `ui_action` event for mutating commands only -- deferred deliberately, not overlooked) |
| Session CRUD (`create_session`/`delete_session`) | none in practice (the IPC args exist -- see `parse_provenance` -- but no shipped caller populates them; session CRUD is exclusively user-initiated today) | none |
| Ship-chain commits | reserved (`commit_created` already covers the "what did this worker change" query a `git_committed` event would have answered) | reserved |

### Updates and Notifications

- **`commands/updater.rs`**: `check_for_updates` wraps `tauri-plugin-updater`'s `UpdaterExt::check()`, returning an `available`/`version`/`body`/`date` JSON summary. Updates are signed with an Ed25519 keypair (see [Updater Keys](updater-keys.md)); the public key is embedded in `tauri.conf.json` under `plugins.updater.pubkey`
- **`commands/notification.rs`**: `send_notification` wraps `tauri-plugin-notification`'s builder API for native OS notifications (title, body, optional icon)

---

## Frontend Architecture

### React 19 + Compiler

The frontend uses React 19 canary with the React Compiler (`babel-plugin-react-compiler`), enabling automatic memoization and eliminating the need for manual `useMemo`/`useCallback`.

### Module Resolution

The project uses Node.js hash imports for clean module paths:

```json
{
  "#components/*": "./src/components/*.tsx",
  "#store/*":      "./src/store/*.ts",
  "#lib/*":        "./src/lib/*.ts",
  "#workers/*":    "./src/workers/*.ts",
  "#hooks/*":      "./src/hooks/*.ts",
  "#pages/*":      "./src/pages/*.tsx",
  "#styles/*":     "./src/styles/*.css"
}
```

### Component Architecture

```text
AppShell (CSS Grid + GSAP startup animation)
├── Sidebar (navigation, command palette trigger)
├── Topbar (status indicators, session selector)
├── Main Content Area
│   ├── Dashboard (overview metrics)
│   ├── Workers Page
│   │   ├── WorkerGraph (XYFlow + ELK)
│   │   │   ├── WorkerNode (custom node -- "Wrote N Files" badge from file_written)
│   │   │   ├── ProvenanceEdge (custom edge, parameterized by kind: spawn/kill/command/message/manual -- see Causality Graph below)
│   │   │   ├── GraphLegend (one row per edge kind actually present; hidden entirely when none are)
│   │   │   └── CausalityPanel (opened from an edge click or WorkerDetail's "View Causality")
│   │   ├── WorkerTerminal (xterm.js + WebGL2)
│   │   ├── WorkerAIPanel (terminal + AI chat split, toolbar Ship button)
│   │   └── ShipPanel (Ship tab: preflight → preview → progress → receipt, backed by useShip)
│   │       ├── ShipPreview (branch/base/remote, diff stat, editable message, actions)
│   │       └── ShipProgress (live checklist, fed by ship_progress events)
│   ├── Sessions Page
│   │   ├── SessionList
│   │   └── SessionCard
│   ├── Metrics Page
│   │   ├── CPUChart, MemoryChart
│   │   ├── ThroughputChart, AIMetricsChart
│   │   └── MetricCard
│   └── Settings Page
├── StatusBar (AI cost, worker count, system status)
├── CommandPalette (modern-cmdk, frecency-ranked)
├── WebGPU Canvas (particles + post-processing)
└── Toast (Sonner)
```

### Causality Graph

The Workers topology graph renders MEASURED causal edges derived from stamped `swarm://events` envelopes -- it never fabricates one. This replaces the phase0 "Spawn Order" chain (a Map-insertion-order line connecting every worker regardless of whether anything actually happened between them, deleted along with `SpawnOrderEdge.tsx`) with edges that only exist because the ordered event core actually recorded a cause.

- **`src/store/provenance.ts`:** a Zustand store (immer + `subscribeWithSelector`, matching `store/workers.ts`'s conventions) holding `edges: Map<string, ProvenanceEdgeRecord>` keyed `${from}->${to}:${kind}`, a bounded (~2000-entry) `bySeq` ring of recent `DomainEvent`s for the causality inspector's fast path, and per-worker `fileWriteCounts`. `ingestEvent(event)` is the single derivation entrypoint -- pure, synchronous, and independently unit-testable without any event-bus mocking.
- **Edge derivation:** an envelope becomes a measured edge only when it carries a real `originWorker` (the CAUSER) AND its type resolves to both an edge kind and a target (the SUBJECT, from the payload) -- `worker_spawned`/`worker_killed`/`worker_input` → `payload.workerId`; `bus_message` → `payload.toWorker`, when present (a broadcast with no target draws nothing). Kinds: `spawn`, `kill`, `command`, `message`. `file_written` is deliberately NOT an edge -- files aren't workers, and a node-per-file would explode the layout -- it becomes a `"Wrote N Files"` badge on the origin worker's node instead (`WorkerNode.tsx`).
- **Collapse and count:** repeated same-`{from,to,kind}` occurrences collapse into one `ProvenanceEdgeRecord` with an incrementing `count` and an advancing `lastSeq`/`lastTs` -- `ProvenanceEdge.tsx` renders this as a `×N` label with a log-scaled stroke-width ramp (capped) rather than N overlapping edges.
- **Endpoint-drop:** `selectVisibleEdges` (exported from `#store/provenance` for direct testing) filters to edges whose `from`/`to` are both still in the live worker registry -- an edge whose endpoint departed (killed, never re-spawned) drops off the canvas but is never deleted from the store, so `CausalityPanel` can still look it up by seq afterward. `selectMostRecentSeqForWorker` (same file) picks the highest-`lastSeq` edge touching a given worker, either endpoint -- the starting seq `WorkerDetail`'s "View Causality" action hands to `CausalityPanel`.
- **`useProvenanceEvents.ts`:** mounted once at the app root beside `useWorkerEvents` (`App.tsx`). A single `onEvent("*", ...)` wildcard subscription forwarding every envelope to `ingestEvent` -- unlike `useWorkerEvents`'s per-type subscriptions, provenance can be derived from any stamped envelope, not a fixed list of types.
- **The empty state IS the acceptance criterion:** hand-spawned workers with no measured causality render as nodes with ZERO edges and a quiet "No Measured Causality Yet" hint (`WorkerGraph.tsx`) -- never a fabricated line. `GraphLegend.tsx` gates each row on that kind actually being present on the canvas and renders nothing at all when there are no edges to label.
- **Provenance edges are session-scoped in v1:** the store is populated purely by live envelopes flowing over `useProvenanceEvents` -- it is never hydrated from `events_since` on startup. A reload (or a fresh window) shows every live worker as a node with zero edges until new causality is measured, by design; the persisted SQLite log still has the full history (queryable via `events_since`/`sqlite3` directly), but the graph itself doesn't replay it. The empty-causality hint's `title` tooltip states this inline; a v2 hydration pass is future work, not a bug.
- **Live per-render node data, not round-tripped through ELK:** `WorkerNode`'s `state`/`pid`/`fileWriteCount` are overlaid onto already-positioned nodes fresh every render (`WorkerGraph.tsx`'s `withLiveNodeData`), the same principle as measured edges below -- none of the three ever change the ELK topology fingerprint (same node ids, same edges), so if they were baked into the nodes ELK lays out, they'd only refresh on the next relayout, which in practice is close to never. A `file_written` badge in particular would render whatever the count was at the last time a worker was added or removed -- usually zero, i.e. it would never appear.
- **Manual annotations stay distinct:** a user can still hand-draw an edge via `onConnect` (unchanged UX) -- it gets `kind: "manual"`, a visually desaturated style, and its own legend row (under a small "Annotation" group header, separated from the measured rows by a rule -- the never-merge claim is visible on screen, not just documented). Only manual edges are real React state (`manualEdges`); measured edges are recomputed fresh from the provenance store every render (so a repeat occurrence's `×N` label never goes stale waiting on a layout pass -- ELK repositions nodes only, it never re-derives edge content). `GraphControls`' Export Workflow is wired to `manualEdges` only, never the combined measured+manual list -- `exportWorkflow`/`importWorkflow` (`#lib/workflow`) round-trip every edge as `kind: "manual"` by construction, so handing it a measured edge would silently launder a measured fact into a user annotation on the next import, exactly the merge this section opens by forbidding.
- **ELK layout:** only measured edges feed `useElkLayout`'s topology (crossing minimization); manual edges never did and still don't. The topology fingerprint (`source->target` pairs) is unaffected by a same-kind edge's `count` changing, so a chatty pair of workers re-using the same edge doesn't retrigger a relayout -- a genuinely new edge (a new pair, or a new kind between an existing pair) does. **Known, deferred:** a relayout (any topology change -- a spawn, a kill, a new measured edge) recomputes every node's ELK position and stomps an in-progress manual drag; there's no "pin this node" affordance yet. Not fixed here.
- **`src/components/graph/CausalityPanel.tsx`:** opened from a measured edge click (`WorkerGraph.tsx`'s `handleEdgeClick`) or `WorkerDetail`'s "View Causality" action (both via the shared `causalityInspectorAtom`, rendered once at the `Workers` page level). `walkCausalityChain` resolves the starting seq's event, then follows its `causeSeq` backward, hop by hop -- the `bySeq` ring first, falling back to `invoke("events_since", { afterSeq: causeSeq - 1, limit: 1 })` on a miss (why `events_since` grew an optional `limit`). Terminates on a real root (an event with no `causeSeq` -- typically `agent_turn_started`), a 50-hop cap, or a genuine lookup miss, whichever comes first -- a miss sets `incomplete: true` (distinct from `truncated`, the hop-cap case) and renders a terminal "Cause Event Not Available (Ephemeral Or Pruned)" row, so the topmost thing on screen never silently reads as a real root when the trail actually just went cold. Renders as a vertical, root-first trace ("Worker A's Turn @412 → Spawned B @418 → B Ran pnpm build @441"); rows click through to the worker they name, when it's still live. Forward traversal (from a cause to everything it caused) is deliberately out of scope for v1.
- **CausalityPanel focus management:** a real modal dialog, not just `role="dialog"` styling -- focus moves to the close button on open, is trapped within the panel's own focusable elements (Tab/Shift+Tab wrap at the boundary, recomputed on every press since rows arrive asynchronously once the walk resolves), and is restored to whatever had focus before on close/unmount. Esc-to-close and click-outside-to-close (a document-level `mousedown` listener, same pattern as `GraphContextMenu.tsx`) predate this and are unchanged.
- **Keyboard shortcuts are gated on the modal being closed:** `WorkerGraph.tsx`'s Delete/Backspace (manual-edge deletion) and `GraphControls.tsx`'s `+`/`-`/`0` (zoom/fit-view) handlers are both document-level listeners that stay live underneath the causality inspector's own overlay -- both read `causalityInspectorAtom` and bail immediately when it's non-null, so a keystroke meant for the modal (or meant to do nothing in particular there) can't reach into the canvas behind it.
- **Known, deferred (not fixed here):** `CausalityPanel`'s `describeRow`/`workerLabel` fall back to an 8-character UUID prefix for a departed worker with no store entry to look a name up in -- readable enough for now, a friendlier "last known name" cache is future work. `selectVisibleEdges`/`selectMostRecentSeqForWorker` are both O(edges) linear scans over the full provenance store on every render -- fine at today's scale, worth an index if a session's edge count ever grows large enough to matter.

---

## WebGPU Pipeline

The WebGPU particle system runs in a three-stage pipeline:

### Stage 1: Compute

A WGSL compute shader updates particle positions and velocities. Dispatched with 64-workgroup granularity.

```text
Particle Buffer ──> Compute Shader ──> Updated Particle Buffer
                    (position, velocity, lifetime, color)
```

### Stage 2: Render

An instanced billboard render pipeline draws particles as camera-facing quads with additive blending.

```text
Particle Buffer ──> Vertex Shader ──> Fragment Shader ──> Framebuffer
                    (billboard quad)   (OKLCH color)       (offscreen)
```

### Stage 3: Post-Processing

Ping-pong framebuffers apply effects in sequence:

```text
Framebuffer A ──> Bloom ──> Framebuffer B
Framebuffer B ──> Chromatic Aberration ──> Framebuffer A
Framebuffer A ──> Vignette ──> Screen
```

### WebGPU Lifecycle

- Device initialization with adapter selection and capability detection
- `isWebGPUSupported()` gate with solid OKLCH fallback background
- Context loss recovery with automatic re-initialization
- `prefers-reduced-motion` integration: particles disabled when reduced motion is preferred

---

## Data Flow

### Worker Lifecycle

```text
User clicks "Spawn Worker"
        │
        ▼
Frontend: invoke("spawn_worker", { name, shell, cwd })
        │
        ▼
Backend: commands::worker::spawn_worker()
        │
        ▼
Backend: lifecycle::do_spawn_worker()
        ├── pty::spawn_pty()          Spawn PTY process
        ├── WorkerRegistry.spawn()    Register in DashMap
        └── emit_event(WorkerSpawned) Hand off to OrchestrationEngine
        │
        ▼
OrchestrationEngine writer thread: seq++, persist, emit
        │  DomainEvent{ seq, ts, type: "worker_spawned", payload } on swarm://events
        ▼
Frontend: onEvent("worker_spawned", ...)   (src/lib/event-bus.ts)
        │
        ▼
Zustand worker store updates → React re-renders
```

### AI Streaming

This is the flow that actually runs when a user sends a chat message today. The message content itself never leaves the webview except for one config read -- no Rust IPC carries the request or the response, no `swarm://events` envelope is involved for the stream itself, and no message text is persisted. Contrast with [Adapter Layer](#adapter-layer) above, which documents the Rust-side machinery this flow does not use (and, for the now-removed `ai_request` path this flow never used either, never did); see [Built, Not Wired](#built-not-wired) for why both exist.

```text
User sends message
        │
        ▼
Frontend: src/lib/anthropic.ts getClient()
        ├── invoke("read_config", { key: "anthropic_api_key" })   A Rust round-trip in this flow
        ▼
Frontend: AIChat.tsx doSend(), before round 0
        ├── invoke("agent_turn_started", { workerId, model, requestId })   Another one -- returns turnSeq
        ▼
new Anthropic({ apiKey, dangerouslyAllowBrowser: true })   @anthropic-ai/sdk client, held in the webview
        │
        ▼
client.messages.stream(requestParams, { signal })   Direct HTTPS request, webview → api.anthropic.com
        │
        ▼
SSE Stream, parsed by the Anthropic SDK itself (not src-tauri's ai/stream.rs)
        │
        ▼
Frontend: streamMessage() (src/lib/anthropic.ts) yields StreamDelta objects
        │
        ▼
Frontend: useAiStream (src/hooks/useAiStream.ts) -- Zustand AI store accumulates deltas → React re-renders message
        │
        ▼
Stream ends (or is aborted) -- useAiStream resolves/rejects its promise directly; no separate terminal event exists for this path
```

Tool calls the model requests (`spawn_worker`, `kill_worker`, `worker_input`, `write_file`) run as ordinary `invoke()` IPC through the ordered event core, exactly like any other command -- and, since `agent_turn_started` gave the turn a real seq, every one of those calls carries `originWorker: workerId, causeSeq: turnSeq` as extra IPC args (see `AIChat.tsx`'s `turnProvenance`), so the resulting `worker_spawned`/`worker_killed`/`worker_input`/`file_written` envelopes are stamped. `read_file` and `get_metrics` are the two tools with no side effect to stamp -- both emit nothing (see [docs/api.md#read_file](api.md#read_file)); `get_metrics` is a read besides.

### Metrics Collection

```text
Background task (500ms interval)
        │
        ▼
spawn_blocking(registry.aggregate_metrics())    Sequential (spawn_blocking-offloaded)
        │
        ▼
emit_event(SystemMetrics{ cpuPercent, memoryMb, workerCount, ... })
        │  OrchestrationEngine: seq++, NOT persisted (ephemeral), emit as swarm://events
        ▼
Frontend: onEvent("system_metrics", ...)
        │
        ▼
Zustand metrics store → Recharts re-renders
```

---

## State Management

The application uses a three-tier state management strategy:

### Tier 1: Domain State (Zustand 5)

Zustand stores manage domain entities with `subscribeWithSelector` for minimal re-renders and `immer` (11.1.18, with `enableMapSet()` enabled in production) for immutable updates:

| Store              | Purpose                        | Persistence         |
|--------------------|--------------------------------|----------------------|
| `useWorkerStore`   | Worker list, states, metadata  | In-memory            |
| `useSessionStore`  | Session list and active session| In-memory (backend persists `sessions.json` via `JsonSessionStore`) |
| `useAiStore`       | AI request queue and history   | In-memory            |
| `useSystemStore`   | System metrics time series     | In-memory            |

`enableMapSet()` is called once at store-module load in production, not gated behind a dev-only path, so any store that models domain data as a `Map`/`Set` under Immer's `produce` works correctly in a production build, not just in dev/test where Immer's dev warnings previously masked the missing plugin registration.

### Tier 2: UI State (Jotai)

Jotai atoms manage ephemeral UI state that does not belong in domain stores:

- Theme preferences (particles enabled, reduced motion)
- Frecency scores for command palette
- Pane sizes and layout state
- Selected worker/session IDs

### Tier 3: Persistent State

Long-lived state that must survive restarts:

- Session data (`sessions.json`) — persisted backend-side by `swarm_core`'s atomic `JsonSessionStore`, not by the frontend
- Theme preferences — `tauri-plugin-store` behind the `Kv` wrapper (`src/lib/kv.ts`)
- Layout preferences (pane sizes) — same `Kv`-backed plugin-store files

---

## Event System

### Backend to Frontend (Push)

The backend emits typed events via the `SwarmEvent` enum, but not directly: every emission is routed through `EventSink::emit`/`emit_with`/`emit_awaiting_seq` into the `OrchestrationEngine` (see [Ordered Event Core](#ordered-event-core) above), which is the sole source of the single `swarm://events` channel. There is one channel, not one channel per event type -- the type tag lives in the envelope's `type` field:

| Type                 | Payload                                                        | Trigger                    | Persisted |
|-----------------------|-----------------------------------------------------------------|-----------------------------|-----------|
| `worker_spawned`     | `{ workerId, name, pid, isolation }`                             | Worker registered           | Yes |
| `worker_killed`      | `{ workerId }`                                                   | Worker terminated           | Yes |
| `worker_output`      | `{ workerId, data }`                                             | PTY output available        | No |
| `worker_state`       | `{ workerId, state }`                                            | State transition            | Yes |
| `worker_input`       | `{ workerId, bytes, source, preview? }`                          | Input written to a worker's PTY | Only when `source != "terminal"` |
| `session_created`    | `{ sessionId, name }`                                            | Session created              | Yes |
| `session_deleted`    | `{ sessionId }`                                                  | Session removed              | Yes |
| `session_worker_removed` | `{ sessionId, workerId }`                                    | Worker pruned from a session's `workerIds` (`session_remove_worker`) | Yes |
| `system_metrics`     | `{ cpuPercent, memoryMb, workerCount, aiReqPerSec, timestamp }`  | 500ms metrics tick           | No |
| `ai_stream_delta`    | `{ requestId, delta, done }`                                     | Webview-path variant, kept but unemitted since `ai_request`'s Phase 2 removal | Yes |
| `ai_stream_settled`  | `{ requestId, status, error }`                                   | Same kept-but-unemitted status | Yes |
| `agent_turn_started` | `{ workerId, model, requestId }`                                 | AI/agent turn started (causal root) | Yes |
| `agent_session_started` | `{ workerId, provider, sessionKey, model, cwd, capabilities }` | Phase 3+ provider-adapter session started | Yes |
| `agent_turn_delta`   | `{ workerId, turnId, blockIndex, kind, text }`                   | Streamed sub-message chunk within a turn | **No** |
| `agent_block`        | `{ workerId, turnId, blockIndex, kind, content }`                | Complete content block within a turn | Yes |
| `agent_tool_call`    | `{ workerId, turnId, toolUseId, name, input }`                   | Provider-agent tool call     | Yes |
| `agent_tool_result`  | `{ workerId, turnId, toolUseId, isError, content }`              | Result of a provider-agent tool call | Yes |
| `agent_permission_request` | `{ workerId, turnId, requestId, tool, input, suggestedDecision? }` | Provider is asking for tool approval | Yes |
| `agent_turn_settled` | `{ workerId, turnId, status, error, costUsd, usage, durationMs, numTurns }` | Terminal receipt for one provider-adapter turn | Yes |
| `agent_session_exited` | `{ workerId, exitCode, signal }`                               | Provider-adapter session's process exited | Yes |
| `system_log`         | `{ level, message, target, timestamp }`                          | Backend log message          | No |
| `bus_message`        | `{ messageId, fromWorker, toWorker, topic, payload }`            | Bus message, emitted directly by `Router::send_direct`/`send_broadcast` (Phase 4 -- no subscriber required, see [Message Bus](#message-bus)) | Yes |
| `worktree_created`   | `{ workerId, sessionId, repoRoot, worktreePath, branch, baseCommit }` | Worker's git worktree created | Yes |
| `worktree_removed`   | `{ workerId, worktreePath, branch, disposition, headCommit, reason }` | Worker killed; worktree removed/preserved | Yes |
| `ship_progress`      | `{ shipId, workerId, step, status, detail }`                     | One step of an in-flight ship operation | Yes |
| `ship_settled`       | `{ shipId, workerId, commitSha, pushedRef, prUrl, status, error }` | Terminal receipt, once per `shipId` | Yes |
| `commit_created`     | `{ workerId, sha, branch, seqFrom, seqTo }`                      | Ship chain created a commit  | Yes |
| `file_written`       | `{ path, bytes }`                                                | `write_file` command succeeded | Yes |

See [docs/api.md#events](api.md#events) for the full envelope contract (`{ seq, ts, originWorker?, causeSeq?, type, payload }`), the persistence policy, the receipt pattern, and `events_since` paging.

### Frontend to Backend (Pull)

The frontend invokes Tauri commands via `invoke()`:

| Command               | Response                          |
|------------------------|-----------------------------------|
| `spawn_worker`         | Worker UUID string                |
| `pause_worker`         | `()`                               |
| `resume_worker`        | `()`                               |
| `kill_worker`          | `()`                               |
| `list_workers`         | `WorkerInfo[]`                     |
| `worker_input`         | `()`                               |
| `set_max_workers`      | `()` -- registry ceiling resized live, persisted (`1..=256`) |
| `create_session`       | `Session`                          |
| `delete_session`       | `()`                               |
| `list_sessions`        | `Session[]`                        |
| `get_session`          | `Session`                          |
| `session_add_worker`   | `()`                               |
| `session_remove_worker` | `()` -- emits `session_worker_removed` |
| `validate_repo_root`   | Canonical toplevel path string     |
| `git_ship_preflight`   | `ShipPreflight`                    |
| `git_stage_commit`     | `CommitOutcome`                    |
| `git_push`             | `PushOutcome`                      |
| `ship_compare_url`     | Compare URL string                 |
| `ship_context`         | `ShipContext` -- the machine-readable causal record for a worker's pending seq range |
| `agent_turn_started`   | `number` (the assigned seq)        |
| `agent_spawn`          | `string` (worker UUID, same contract as `spawn_worker`) |
| `agent_send_turn`      | `()` -- fire-and-forget; confirms scheduler admission, not completion |
| `agent_cancel`         | `()`                               |
| `agent_shutdown`       | `()`                               |
| `agent_probe`          | `ProbeReport`                      |
| `agent_permission_respond` | `()` -- real round-trip against `CodexAdapter`, documented no-op against `ClaudeCodeAdapter` |
| `set_agent_concurrency` | `()` -- scheduler limit adjusted live, persisted |
| `read_file`            | File content string (path-scoped)  |
| `write_file`           | `()` -- emits `file_written`       |
| `read_config`          | Stored value, or `null` when unset |
| `write_config`         | `()`                               |
| `get_metrics`          | Metrics JSON, incl. `perWorker`    |
| `bus_send`             | Receiver count (`number`) -- emits `bus_message` onto the spine unconditionally (Phase 4, see [Message Bus](#message-bus)); no UI caller yet |
| `bus_list_channels`    | `string[]` (no shipped caller -- see [Built, Not Wired](#built-not-wired)) |
| `events_since`          | Persisted `DomainEvent[]`, `seq > afterSeq`, capped at 5000 |
| `check_for_updates`    | Update-availability JSON            |
| `send_notification`    | `()`                                |

---

## Built, Not Wired

Several pieces of the shipped Rust backend are fully implemented and tested but have zero frontend callers today. They are not stubs or dead code -- they are the backend half of features that have not been wired up yet, built ahead of the multi-provider agent-execution rework that is expected to route AI traffic (and possibly agent-to-agent bus traffic) through Rust instead of the webview.

| Piece | Where | Why it isn't live today |
|-------|-------|---------------------------|
| The `agent_*` event family + `AgentAdapter`/`AgentSession` traits + `AgentScheduler` | `crates/swarm-core/src/agent/`, `crates/swarm-core/src/events/emitter.rs` | **No longer in this table for Claude Code or Codex** -- both adapters emit the full family as of Phase 3/4, wired through `agent_spawn`/`agent_send_turn`/etc, the Workers page's provider picker, and a minimal `AgentChat` transcript (`src/components/ai/AgentChat.tsx`). Still true for OpenCode/Gemini: the trait pair is provider-agnostic and tested via `MockAdapter`, but no concrete adapter exists yet for either. See [Adapter Layer](#adapter-layer). |
| [`bus_send`](api.md#bus_send)/[`bus_list_channels`](api.md#bus_list_channels) | `src-tauri/src/bus/`, `src-tauri/src/commands/bus.rs` | **Routing is real as of Phase 4** -- `Router::send_direct`/`send_broadcast` emit `bus_message` onto the ordered spine unconditionally (see [Message Bus](#message-bus)), no active subscriber required. What remains not-live is purely the FRONTEND caller: no UI surface invokes `bus_send` today (the agent-to-agent handoff flows an adapter-side caller would need are a later phase). The second subscription primitive (`bus_subscribe`) and the non-functional pipeline machinery (`create_pipeline`/`execute_pipeline`) that used to sit alongside this row are DELETED, not merely unwired. |
| The `ai_stream_settled`/`ai_stream_delta` `SwarmEvent` variants | `crates/swarm-core/src/events/emitter.rs` | Downstream of `ai_request`, which was **removed** in Phase 2 (absorbed into `AgentScheduler`) -- nothing emits these variants in the app as shipped. Kept only because the webview chat path may still bridge onto them during the Phase 5 migration; retired alongside that path. |
| The full spawn-dialog / polished `WorkerAIPanel` redesign (provider auth-health dot, richly interactive tool-call cards, a real permission-denial timeline, "Queue Next Turn" capability-driven labeling) | -- | Phase 3 ships the minimal surface only (a provider/model/trust-tier picker on the Workers page, a provider badge, and `AgentChat`'s plain append-only transcript) -- the full UI overhaul is an explicitly deferred follow-up branch. |

Read the [Adapter Layer](#adapter-layer) section and the `agent/`/`bus_*` entries in [docs/api.md](api.md) as a description of what the Rust side does *if* called -- not as a description of what happens when a user sends a chat message or a worker talks to another worker in the app today.

---

## Error Handling

### Backend Errors

All backend errors flow through the `AppError` enum (16 variants), which implements:

- `thiserror::Error` for `Display` and `From` impls
- Custom `Serialize` that serializes as a plain string for IPC

```text
AppError
├── WorkerNotFound { id }        Worker ID missing from registry
├── PtySpawn(String)             PTY creation failed
├── Ipc(String)                  IPC write/flush/parse failure
├── Ai(String)                   AI API error
├── Io(io::Error)                Standard I/O error
├── PermissionDenied(String)     Access denied
├── RegistryFull { max }         Worker limit exceeded
├── Serialization(serde_json)    JSON error
├── SessionNotFound { id }       Session ID missing
├── ChannelClosed(String)        Channel dropped
├── EventLog(String)             Ordered event log / WAL failure
├── QueueFull { capacity }       Agent turn queue backpressure
├── Config(String)               Config read/write failure
├── Git(String)                  Git / worktree / ship error
├── AgentSessionBusy             A turn is already in flight for this worker
└── LineTooLong { ... }          NDJSON framer line-length cap exceeded
```

### Error Propagation

```text
Domain function (returns AppError)
        │
        ▼
Command handler (maps to String via .to_string())
        │
        ▼
Tauri IPC (sends error string to frontend)
        │
        ▼
Frontend (displays in Toast via Sonner)
```

The `AppError -> String` mapping at the command boundary is intentional: Tauri commands return `Result<T, String>`, so we serialize errors as human-readable messages.

### Ship Errors (a Documented Divergence)

The four ship commands (`git_ship_preflight`, `git_stage_commit`, `git_push`, `ship_compare_url`) do **not** follow the `AppError -> String` convention above. They reject with `swarm_core::git::ShipError`, a struct (`{ kind, message, remedy }`) with its own `Serialize` impl that preserves its shape as a JSON object rather than flattening to a display string:

```text
Domain function (returns ShipError directly -- not AppError)
        │
        ▼
Command handler (passes ShipError through unchanged; #[tauri::command] fn ... -> Result<T, ShipError>)
        │
        ▼
Tauri IPC (sends { kind, message, remedy } object to frontend)
        │
        ▼
Frontend (#lib/tauri wraps it in ShipCommandError, a real Error subclass carrying .shipError;
          the Ship tab UI branches on .shipError.kind for the right second-click remedy)
```

This exists because the UI needs to distinguish `pushRejected` (remedy: fetch-and-rebase, re-preview, ship again) from `authExpired` (remedy: re-authenticate) from `nothingToCommit` (no remedy, just report it) — a bare string can carry the message but not a machine-checkable `kind` to switch on. `AppError::Git` errors from lower-level git plumbing (e.g. a `rev-parse` failure) are bridged into `ShipError` via a `From<AppError> for ShipError` impl that classifies a timeout message into `kind: "timeout"` and everything else into `kind: "unknown"`, so the divergence is contained to the ship module's own boundary rather than requiring `AppError` itself to change shape. See [docs/api.md#ship-commands](api.md#ship-commands) for the full `ShipErrorKind`/`ShipRemedy` enumerations.

---

## Runtime Modes

SWARM Orchestrator runs in one of two shells over the SAME domain layer (`swarm-core`, tauri-free): the desktop app (`swarm-desktop`, this document's default assumption throughout) or the headless daemon (`swarmd`). Both are thin adapters over one constructor and one command registry — see `crates/swarm-core/src/runtime.rs` and `crates/swarm-core/src/commands/mod.rs`.

```text
                  ┌──────────────────────────────────┐
                  │   swarm_core::runtime::Runtime   │
                  │  (worker registry, session mgr,  │
                  │     ordered event log, agent     │
                  │    scheduler, metrics loop --    │
                  │    ONE constructor, ONE lock)    │
                  └─────────────────┬────────────────┘
                                    │
                   ┌────────────────┴────────────────────┐
                   ▼                                     ▼
    ┌─────────────────────────────┐       ┌─────────────────────────────┐
    │        swarm-desktop        │       │           swarmd            │
    │  Tauri IPC (invoke/listen)  │       │ WebSocket (hello/rpc/event) │
    │   webview, native plugins   │       │  no webview, no tauri link  │
    └─────────────────────────────┘       └─────────────────────────────┘
```

### Single-instance lock

Both shells call `swarm_core::lock::SingleInstanceLock::acquire(data_dir, ...)` as the FIRST action inside `Runtime::start`, before the event log is even opened. Two engines writing the same `swarm-events.db` would both resume `seq` from `max_seq()` and collide on the primary key -- appends would silently fail while live emission kept assigning duplicate sequence numbers. The lock is OS-native and advisory (`flock(2)` on Unix, a deny-all share mode on Windows via `OpenOptionsExt::share_mode(0)`) -- it releases itself automatically on process exit or crash, so there is no stale-lock file to clean up by hand. A losing contender gets a Title Case message naming the winning process's pid (and, for `swarmd`, its bind address) sourced from a small sidecar info file (`daemon.lock.json`) the winner refreshes on every successful acquire.

### The command registry

Every command handler's REAL logic lives exactly once, in `swarm_core::commands::*`, keyed by name in a `Registry`. Both shells are pure marshaling around it:

- `swarm-desktop`'s `#[tauri::command]` functions pack their typed parameters into a `serde_json::Value`, call `Registry::dispatch(name, ctx, args)`, and unpack the result back into the command's declared return type.
- `swarmd`'s WebSocket `rpc` frame handler does the identical `Registry::dispatch` call, sourcing `cmd`/`args` from the frame instead of typed Tauri parameters.

A contract test (`src-tauri/src/commands/registry_contract.rs`) parses `swarm-desktop/src/lib.rs`'s own `tauri::generate_handler![...]` block via `include_str!` (re-read every test run, never a hand-maintained snapshot) and asserts its command-name set equals `Registry::new().keys()` union `swarm_core::commands::NATIVE_ONLY` -- the two commands (`check_for_updates`, `send_notification`) that need a live webview/OS plugin and therefore have no registry entry at all. A command added to `generate_handler!` without a matching registry entry (or the reverse) fails this test.

### `swarmd`: the headless daemon

A separate binary, not a `--headless` flag -- Tauri links `libwebkit2gtk` at BUILD time on Linux (a runtime flag cannot unlink it), and the release desktop binary is `windows_subsystem = "windows"` (no console for error output). `swarmd` drops the updater/dialog/notification plugins entirely, shrinking the network-exposed dependency surface.

**Transport:** one authenticated WebSocket (`/ws`), both directions -- PTY input is a command per keystroke, so separate HTTP requests per keystroke would both flood the connection count and lose cross-request ordering. Frame shapes live in `swarm_core::protocol` (serde-only, no networking code) -- see `docs/api.md`'s [Wire Protocol](api.md#wire-protocol-swarmd) section for the full frame catalogue.

**Event delivery:** the desktop shell's PRIMARY delivery path (a synchronous `app.emit` closure passed into `OrchestrationEngine::start`, lossless by construction) has no webview to emit into under `swarmd`. Every WS connection instead rides the engine's SECONDARY `broadcast::Sender<Arc<DomainEvent>>` fanout -- documented since Phase 1 as "lossy under lag by design, reserved for future `swarmd` subscribers." `swarmd` is that first real consumer: each connection's own feeder task subscribes to the broadcast channel BEFORE reading any SQLite history (no hole between snapshot and live cutover), pages `events_since` for replay, and re-runs the identical paging routine whenever it observes `RecvError::Lagged` -- the client's own gap-detection logic (`#lib/event-bus.ts`) stays as defense-in-depth, not the only safety net.

**Auth:** a 256-bit token (`getrandom`, hex-encoded) persists at `<data_dir>/daemon-token` across restarts, permissioned 0600 on Unix and a current-user-only DACL via `icacls` on Windows (re-applied on every load, not just at mint time; escalates to a hard startup error if it fails while binding non-loopback). Binding a non-loopback address is refused outright unless a token file already existed BEFORE that run -- a fresh install must complete one loopback-bound run first (where the token is minted and the connect URL is printed), so `--bind 0.0.0.0` can never be the very first thing a fresh install does unattended. **The existence check and the mint are two separate functions, evaluated in that order** (`DaemonToken::exists` before `DaemonToken::load_or_create`) -- an earlier version called the mint FIRST, which minted the token file as a side effect even on a run the gate went on to refuse, so a second identical invocation found a "pre-existing" token and slipped through; a real two-process integration test (`swarmd/tests/integration.rs`, spawning the actual compiled binary via `std::process::Command`) now drives both this bypass and the ordinary single-instance-lock collision. Every WS upgrade validates `Host` against the daemon's own bind address and, when present, `Origin` against `Host` -- WebSocket upgrades are exempt from CORS, so without this check any web page a user's browser has open could reach a localhost daemon, and DNS rebinding could reach it from off-box; both checks are bracket-aware for IPv6 (`[::1]:8787`) and bare portless IPv6 (`::1`) -- a naive colon-split mangles both shapes. The 5-second handshake deadline applies to EVERY connection, including one that pre-authenticated via an `Authorization: Bearer` header at upgrade time -- a Bearer-authed socket that never sends `hello` is closed, not left hanging. The connect URL is printed with the token ONLY in the fragment (`http://host:port/#t=...`) -- fragments are never sent to the server or logged by an intermediary proxy.

**Per-command remote policy, not command-name string checks:** every [`Registry`](#the-command-registry) entry declares a `RemotePolicy` -- `Allowed` (the default: worker/session/agent/bus/metrics/orchestration commands), `Denied` (`read_file`/`write_file` -- arbitrary daemon-host filesystem access, never on the MVP remote surface), or `SecretFiltered` (`read_config`/`write_config` -- a secret-shaped `key` argument, e.g. `anthropic_api_key` or anything ending `_key`/`_token`/`_secret`, is denied both directions: reading one is exfiltration, writing one is poisoning a value the desktop app might later trust). `swarmd`'s WS `rpc` handler dispatches EVERY command through `Registry::dispatch_remote`, which consults this declared policy -- it never special-cases a command by comparing its name as a string. An earlier version only special-cased `read_config`, which is exactly how `read_file`/`write_file` reached a live daemon's filesystem unfiltered -- reproduced as reading `<data_dir>/daemon-token` verbatim, `swarm-config.json` (the Anthropic key), and arbitrary `$HOME` files (`~/.gitconfig`, `~/.claude/settings.json`) over an authenticated WS connection before the fix. The Tauri desktop path is unaffected: `swarm-desktop`'s command wrappers call the separate, policy-free `Registry::dispatch` -- the local app on the user's own machine was never the vulnerability, the network boundary was. A contract test asserts every registry entry declares a policy and that the `Denied`/`SecretFiltered` sets are EXACTLY `{read_file, write_file}` / `{read_config, write_config}`, by name.

**The trust boundary this does NOT close:** an authenticated remote client gets arbitrary command execution on the daemon's host. `spawn_worker` takes `shell`/`env`/`cwd` and starts a real process; `worker_input` writes raw bytes to that process's stdin. This is not an oversight -- running commands on the host IS the product (a worker is a PTY-backed shell the whole point of SWARM is to drive remotely). The token is the ONLY thing standing between "an authenticated SWARM user" and "root on this machine, effectively, as this user" -- treat it exactly like an SSH private key: never commit it, never paste it into a chat, and assume anyone who has it can do anything the `$USER` running `swarmd` can do. `RemotePolicy` narrows WHICH commands are reachable at all (no filesystem browsing, no secret-key access) but does not, and cannot, sandbox what an *allowed* command can do once invoked.

**Backpressure, one ordered lane plus a separate control lane:** `ready`, `replayEnd`, and every `event` frame (replayed or live) share ONE bounded (4096), FIFO channel per connection -- this is what guarantees wire order matches seq order. An earlier three-channel design (separate control/persistent/ephemeral lanes, merged via a `biased select!` in the writer task) let wire order diverge from seq order whenever a live event and a replay/lag-heal page raced across the `select!` -- a client backfilling a gap could see an out-of-order seq, advance past a later-but-lower-seq frame, and silently discard real PTY output. Persistent frames (everything durable) always enqueue onto this one lane, blocking the CONNECTION (never the engine) if it's momentarily full. Ephemeral frames (`worker_output`, `system_metrics`, `system_log`, `agent_turn_delta`, terminal-source `worker_input`) are dropped newest-first once the lane's occupied length reaches a watermark well below its full capacity (reserving headroom so an ephemeral flood can never starve a persistent frame's blocking send) -- but anything that DOES get enqueued keeps its FIFO position, so wire order among delivered frames is always seq order. `rpcResult` frames (no seq, no ordering relationship to the event stream) ride a separate bounded (256) control lane; concurrently in-flight `rpc` tasks are capped per connection (8) -- above the cap, a new `rpc` frame gets an immediate typed busy `rpcResult` rather than spawning an unbounded number of handler tasks.

**Serving the UI:** `swarmd --serve-ui <dir>` serves a `pnpm build:web` bundle via `tower-http`'s `ServeDir` (SPA fallback to `index.html`), with a `Content-Security-Policy` response header: `default-src 'self'; connect-src 'self'` (same-origin covers the page's own `ws:`/`wss:` connection back to the daemon that served it -- no separate `ws:`/`wss:` scheme grant needed or wanted), `frame-ancestors 'none'` (the daemon's UI must never be embeddable in another page's iframe -- clickjacking against an authenticated session), and no `api.anthropic.com` -- the browser build's webview-direct AI chat path is capability-gated off (`TransportCapabilities.localAiChat`); remote AI goes entirely through the agent-adapter RPC surface (Rust-side, same as local `agent_spawn`), never a direct browser fetch to Anthropic. Embedding the bundle into the `swarmd` binary itself (`include_dir`, for a single-file release artifact) is deferred to the service-units release-wiring phase -- today's `--serve-ui` points at a plain directory on disk, which is what a Tailscale/`ssh -L` deployment needs.

**CI:** `cargo tree -p swarm-core -e normal | grep tauri` must be empty (Phase 1's original gate); `cargo tree -p swarmd -e normal | grep tauri` must ALSO be empty -- `swarmd` depends on `swarm-core` but must never itself grow a `tauri`/`tauri-plugin-*` dependency (nothing stops a future PR from adding one directly to `crates/swarmd/Cargo.toml`, which the `swarm-core`-only gate would never catch).

### The frontend transport seam

`src/lib/transport.ts` exports a `Transport` interface (`invoke`/`listen`/`connect`/`capabilities`) with two implementations: `tauriTransport` (today's Tauri IPC code, moved intact) and `wsTransport` (a WebSocket client matching `swarmd`'s wire protocol, with backoff+jitter reconnect and `hello{lastSeq}` on every reconnect, sourcing that cursor from `event-bus.ts`'s `getLastSeq()`). Which one backs `src/lib/tauri.ts`'s `invoke`/`listen` is chosen ONCE, at module load, by a Vite `define` (`__SWARM_TRANSPORT__`, set to `"ws"` only by `pnpm build:web` -- every other build keeps `tauriTransport` unconditionally, so a plain `pnpm dev` browser preview's existing graceful no-op behavior is completely unaffected).

`tauri.ts` keeps its entire existing public API -- every one of the 41 other files that referenced `#lib/tauri` when the transport seam landed (source and tests combined) needed zero changes. `isTauri()` keeps its original meaning ("the Tauri IPC bridge specifically") for the handful of call sites gating genuinely Tauri-only features (`tauri-plugin-fs`/`-dialog`/`-shell`/`-notification`/`-updater`, the webview-direct AI chat path); a new `hasTransport()` ("some backend is reachable, Tauri or WS") backs the small set of command wrappers (`spawnWorker`, `agentSpawn`, `listSessions`, `agentProbe`) that work identically over either transport.

The MVP remote surface is intentionally narrow: Dashboard, Workers, Terminals, Metrics, and Agent chat. Filesystem browsing (`FileTree`/`FileViewer`/`WorkspacePanel`/`useWorkspaceWatcher`) and the plugin-store-backed settings surfaces (`lazy-store`/`templates`/`snapshots`/`store-integrity`) still import `@tauri-apps/plugin-*` directly and are gated by their own existing `isTauri()` checks, which now doubles as the remote-capability gate for free. `src/lib/kv.ts` (a `TauriStoreKv`/`DaemonConfigKv`-backed key-value abstraction) exists as the migration target for the plugin-store surfaces but is not yet wired to any of the four call sites -- five surfaces that work over the network beat twelve that half-work.
