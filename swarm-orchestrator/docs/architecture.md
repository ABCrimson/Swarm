# Architecture

> System architecture reference for the SWARM Orchestrator desktop application.

---

## Table of Contents

- [System Overview](#system-overview)
- [Backend Architecture](#backend-architecture)
  - [Worktree Isolation](#worktree-isolation)
  - [Ship Chain](#ship-chain)
- [Frontend Architecture](#frontend-architecture)
- [WebGPU Pipeline](#webgpu-pipeline)
- [Data Flow](#data-flow)
- [State Management](#state-management)
- [Event System](#event-system)
- [Built, Not Wired](#built-not-wired)
- [Error Handling](#error-handling)

---

## System Overview

SWARM Orchestrator is a Tauri 2.11 desktop application with a clear separation between a Rust backend and a React 19 frontend. Communication between the two layers happens exclusively through Tauri's IPC mechanism: **invoke** (request/response) and **listen** (event stream).

```text
 ┌──────────────────────────────────────────────────────┐
 │                   React 19 Frontend                  │
 │  Components  │  Hooks  │  Stores  │  WebGPU Canvas  │
 ├──────────────────────────────────────────────────────┤
 │              Tauri IPC Bridge                        │
 │         invoke() ↕ listen() / emit()                │
 ├──────────────────────────────────────────────────────┤
 │                   Rust Backend                       │
 │  Commands  │  Worker Registry  │  AI Queue  │  Store│
 │                                                      │
 │            Tokio Multi-Thread Runtime                │
 └──────────────────────────────────────────────────────┘
```

**Design principles:**

1. The Rust backend owns all mutable state (workers, sessions, AI queue, message bus)
2. The frontend receives state updates via Tauri events, not polling
3. CPU-bound and blocking work (sysinfo refresh, worker metrics aggregation, session persistence) runs on `spawn_blocking` threads, never on the async executor
4. All IPC payloads use `camelCase` fields; all event type tags use `snake_case`
5. Worker state transitions are TOCTOU-safe: `WorkerRegistry::update_state_if` performs a compare-and-set under the registry's per-entry lock rather than a separate read-then-write

---

## Backend Architecture

The backend is organized into five domain modules under `src-tauri/src/`:

### Module Map

The Rust side is a two-crate workspace: domain logic lives in the tauri-free `swarm-core` library crate, the Tauri shell (`swarm-desktop`) wires it to IPC commands and platform paths. CI enforces that `swarm-core` never depends on `tauri`/`tauri-plugin-*` (`cargo tree -p swarm-core -e normal`).

```text
src-tauri/crates/swarm-core/src/   (swarm-core -- tauri-free domain crate)
├── ai/              AI integration
│   ├── client.rs    Anthropic API client (reqwest + SSE streaming; always emits a terminal `done: true`)
│   ├── queue.rs     Priority queue with semaphore concurrency control
│   └── stream.rs    SSE event parser (content_block_delta, message_stop)
├── bus/             Inter-agent message bus
│   ├── channel.rs   MessageBus -- per-topic tokio::sync::broadcast channels
│   └── router.rs    Router -- direct/broadcast send + pipeline orchestration
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
│   └── manager.rs   DashMap-backed CRUD + SessionStore port
├── worker/          Worker management
│   ├── handle.rs    WorkerHandle, WorkerState, WorkerConfig, WorkerIsolation, WorkerInfo (incl. lastShippedSeq/lastShippedCommit, written only by the ship chain)
│   ├── lifecycle.rs Spawn, pause, resume, kill, input operations (worktree create/remove on spawn/kill)
│   ├── pty.rs       PTY spawning (portable-pty) + Tokio I/O bridge
│   └── registry.rs  DashMap registry, TOCTOU-safe update_state_if, aggregate metrics
├── config.rs        Atomic key-value JSON config persistence
├── paths.rs         Paths (data dir), constructed by the shell and passed in
├── error.rs         AppError enum (thiserror + Serialize for IPC)
└── lib.rs           Crate root, module re-exports

src-tauri/src/   (swarm-desktop -- Tauri shell)
├── commands/        Tauri IPC command handlers, thin wrappers over swarm-core
│   ├── worker.rs        spawn, pause, resume, kill, list, input
│   ├── session.rs       create, delete, list, get, session_add_worker
│   ├── ai.rs            ai_request, agent_turn_started (the latter actively used -- see "Ordered Event Core")
│   ├── bus.rs           bus_send, bus_subscribe, bus_create_pipeline, bus_list_channels, bus_list_pipelines
│   ├── metrics.rs       get_metrics (incl. perWorker) + background collection loop
│   ├── orchestration.rs events_since
│   ├── config.rs        read_config, write_config
│   ├── git.rs           validate_repo_root, git_ship_preflight, git_stage_commit, git_push, ship_compare_url
│   ├── updater.rs       check_for_updates
│   ├── notification.rs  send_notification
│   └── fs.rs            read_file, write_file (path-scoped like tauri-plugin-fs; write_file emits a stamped file_written event)
├── session/         Session persistence via tauri-plugin-store
├── lib.rs           Tauri app builder and setup (git capability probe + startup prune live here)
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

### AI Queue (Built, Not Wired)

**Nothing in `src/` calls `ai_request` today** -- see [Built, Not Wired](#built-not-wired) for the full picture. The diagram below documents what this Rust-side apparatus does when invoked (it is fully implemented and unit-tested, not a stub); it is not what happens when a user sends a chat message in the shipped app today -- for that, see [AI Streaming](#ai-streaming) under Data Flow.

```text
ai_request command   (no shipped caller -- documented for the next consumer)
                         │
                    mpsc::channel(256)          Bounded queue
                         │
                    process_loop (long-lived task)
                         │
                    BinaryHeap<PrioritizedRequest>
                    (Higher priority first, FIFO within same level)
                         │
                    Semaphore::acquire_owned() [concurrent_limit = 3]
                         │
                    tokio::spawn(client.stream_message())
                         │
                    SSE parser → emit_event(AiStreamDelta) events, terminated by emit_event(AiStreamSettled)
```

Priority levels: `Low (0) < Normal (1) < High (2) < Critical (3)`

On stream failure (network error, malformed SSE, provider error) or a stream that ends without a `message_stop` event, the client still emits a final `ai_stream_delta` with `done: true`, followed by `ai_stream_settled` -- were this path in use, the frontend would be guaranteed a terminal receipt for every enqueued `requestId`.

### Session Persistence

Sessions are stored in `DashMap<Uuid, Session>` and persisted to disk:

- **Storage file:** `sessions.json` in Tauri's app data directory
- **Backend:** `tauri-plugin-store` 2.4.3
- **Auto-save:** After every create/delete/`session_add_worker` operation, offloaded to `spawn_blocking`
- **Restore:** Loaded once during app setup, before any commands are processed

### Message Bus

The `bus` module provides inter-agent communication independent of the AI queue:

- **`MessageBus`** (`bus/channel.rs`): creates and holds one `tokio::sync::broadcast` channel per topic string, in a `DashMap<String, Sender<BusMessage>>`
- **`Router`** (`bus/router.rs`): sends direct messages (`send_direct`, tagged with a `to_worker`) and broadcasts (`send_broadcast`), and owns a `DashMap<Uuid, Pipeline>` of registered multi-stage pipelines
- **Pipelines:** an ordered list of `PipelineStage { worker_id, transform }`; `execute_pipeline` forwards a payload from stage to stage, applying an optional dot-notation field-selector transform (e.g. `.result`, `.data.items`) between stages
- **Frontend delivery contract:** `bus_send` only publishes to the internal bus and never emits an event itself. `bus_subscribe` spawns the sole background task that forwards messages on a topic to the frontend as `bus_message` envelopes on `swarm://events`. This keeps delivery to exactly one event per message, in one payload shape (`BusMessagePayload`), regardless of how many (if any) subscribers are attached -- see [docs/api.md](api.md#unified-bus-event-contract)

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
- **Persistence policy:** every event consumes a `seq`, but only some are written to the log. `is_persistent()` (`orchestration/engine.rs`) excludes `WorkerOutput`, `SystemMetrics`, and `SystemLog` by variant -- high-frequency telemetry that flows live but is not history -- plus `WorkerInput` by a **field-level** carve-out: `source == InputSource::Terminal` (raw human keystrokes) is excluded even though the `WorkerInput` variant itself persists for `source.is_machine_issued()` (`Tool`/`Automation`). `source` is a closed, typed enum (`crate::events::InputSource`, `#[serde(rename_all = "snake_case")]`), not a bare string -- an unrecognized wire value fails IPC deserialization before this function ever runs, so the "raw keystrokes/secrets never archived" guarantee doesn't depend on the webview spelling `"terminal"` correctly. A per-keystroke durable row would both flood the log and archive whatever a human typed into a shell, secrets included. Everything else (`worker_spawned`, `worker_killed`, `worker_state`, `worker_input` [non-terminal], `session_created`, `session_deleted`, `ai_stream_delta`, `ai_stream_settled`, `agent_turn_started`, `bus_message`, `worktree_created`, `worktree_removed`, `ship_progress`, `ship_settled`, `commit_created`, `file_written`) persists before being emitted. `is_persistent()` excludes by name (or, for `WorkerInput`, by field) rather than allowlisting, so a new variant is persistent by construction unless explicitly added to the exclusion list -- pinned down for the two worktree events by `orchestration::engine::tests::test_worktree_events_are_persistent`, the three ship events by `orchestration::engine::tests::test_ship_events_are_persistent`, and the `worker_input` source carve-out by `test_worker_input_persistence_depends_on_source`.
- **Causal attribution (`Provenance`):** every `WriterMsg` carries a `Provenance { origin_worker: Option<Uuid>, cause_seq: Option<u64> }` alongside its event -- `Provenance::default()` (both `None`) for `EventSink::emit`, an explicit value for `emit_with`/`emit_awaiting_seq`. The writer stamps it straight onto the `DomainEvent` envelope as `originWorker`/`causeSeq` (`skip_serializing_if` keeps the common unattributed case wire-lean -- absent, not `null`) and into the persisted row's `origin_worker`/`cause_seq` columns. **The subject-vs-causer rule:** a payload's own `workerId` field is the SUBJECT of the event (whose worker spawned, whose PTY got input); `originWorker` on the envelope is the CAUSER (who made it happen). For a human-driven action the two are typically unrelated or `originWorker` is simply absent; for a tool-driven action (an AI turn's `spawn_worker`/`kill_worker`/`worker_input`/`write_file` tool call) `originWorker` is the panel worker whose turn issued the call, distinct from the payload's own `workerId` -- and that difference IS the causal edge a future provenance graph is built from. **The invariant, enforced by doc-comment and review, not by the type system:** the engine *records* provenance, it never *infers* it -- there is no "the last AI turn probably caused this" heuristic anywhere in this codebase; every `Provenance` passed to `emit_with`/`emit_awaiting_seq` traces back to an explicit, caller-supplied value (an IPC argument, a bus message's own `from_worker`, a turn's own recorded seq).
- **The ack-oneshot (`emit_awaiting_seq`):** returns a `tokio::sync::oneshot::Receiver<u64>` that resolves to the seq the writer thread assigns the event -- deterministic, no polling, no timeout-bound `waitFor` correlation. Used by the `agent_turn_started` command (see [docs/api.md#agent_turn_started](api.md#agent_turn_started)) so a chat turn can learn its own seq before any tool call needs to cite it as `causeSeq`. Non-blocking and stall-proof by oneshot construction: if the caller drops the receiver (e.g. a cancelled IPC call) before the writer gets to it, `ack.send(seq)` simply returns `Err` and is ignored -- the writer thread never waits on, or even notices, a disinterested receiver.
- **Emission:** after the persistence step, the writer wraps the event in a `DomainEvent { seq, ts, originWorker?, causeSeq?, ..flattened SwarmEvent }` and hands it to the primary `emit` closure passed to `OrchestrationEngine::start` (the Tauri shell's closure forwards it onto the single `swarm://events` channel). See [docs/api.md#events](api.md#events) for the wire shape and full type-tag list.
- **The receipt pattern:** rather than overload a stream event's payload with a completion flag, terminal outcomes get their own event type -- e.g. `ai_stream_settled`, emitted exactly once per AI request after the final `ai_stream_delta`, on both success and failure. Frontend code awaits the receipt (`waitFor()` in `src/lib/event-bus.ts`) instead of inferring completion from stream contents.
- **Replay foundation:** `commands/orchestration.rs::events_since(after_seq, limit?)` returns persisted rows with `seq > after_seq`, ascending, capped at (and defaulting to) 5000 per call, with an optional smaller `limit` for a future causality inspector's single-row backward hops (see [docs/api.md#events_since](api.md#events_since)). This is the data-layer foundation for gap backfill -- already wired into `src/lib/event-bus.ts`'s `connectEventBus` -- and for future replay; a replay *UI* is out of scope for this phase.

#### The honest v1 attribution table

Provenance is wired end-to-end (envelope, SQLite columns, IPC args), but only some call sites actually populate it today -- the rest wire the *plumbing* (optional `originWorker`/`causeSeq` args exist and are honored) without a caller ever passing a value. This table is the single source of truth for which is which; code comments elsewhere in this codebase point back here rather than restating it.

| Path | `originWorker` | `causeSeq` |
|---|---|---|
| AI tool → `spawn_worker`/`kill_worker`/`worker_input`/`write_file` | real (the calling panel's `workerId`) | real (`agent_turn_started`'s seq) |
| `bus_message` | real (`fromWorker`, free -- `bus_subscribe`'s forwarder already holds it) | none -- v2 would need the sending side to thread its own turn's seq through `bus_send` |
| Terminal keystrokes (`worker_input`, `source: "terminal"`) | none (the causer is a human, not a worker's turn) | none |
| Workspace auto-inject (`worker_input`, `source: "automation"`) | none | none -- v2 needs a `workspace_changed` event to exist first, to cite as the cause |
| Palette/UI actions | none | none in v1 (v2: a single `ui_action` event for mutating commands only -- deferred deliberately, not overlooked) |
| Session CRUD (`create_session`/`delete_session`) | none in practice (the IPC args exist -- see `parse_provenance` -- but no shipped caller populates them; session CRUD is exclusively user-initiated today) | none |
| Ship-chain commits | reserved (`commit_created` already covers the "what did this worker change" query a `git_committed` event would have answered) | reserved |

### Updates and Notifications

- **`commands/updater.rs`**: `check_for_updates` wraps `tauri-plugin-updater`'s `UpdaterExt::check()`, returning an `available`/`version`/`body`/`date` JSON summary. Updates are signed with an Ed25519 keypair (see [`src-tauri/UPDATER_KEYS.md`](../src-tauri/UPDATER_KEYS.md)); the public key is embedded in `tauri.conf.json` under `plugins.updater.pubkey`
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
│   │   ├── TopologyGraph (XYFlow + ELK)
│   │   │   ├── WorkerNode (custom node)
│   │   │   └── SpawnOrderEdge (custom edge, labeled "Spawn Order" in the graph's legend -- not a real dependency graph)
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

This is the flow that actually runs when a user sends a chat message today. The message content itself never leaves the webview except for one config read -- no Rust IPC carries the request or the response, no `swarm://events` envelope is involved for the stream itself, and no message text is persisted. Contrast with [AI Queue](#ai-queue-built-not-wired) above, which documents Rust machinery this flow does not use; see [Built, Not Wired](#built-not-wired) for why both exist.

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

Zustand stores manage domain entities with `subscribeWithSelector` for minimal re-renders and `immer` (11.1.11, with `enableMapSet()` enabled in production) for immutable updates:

| Store            | Purpose                        | Persistence         |
|------------------|--------------------------------|----------------------|
| `workerStore`    | Worker list, states, metadata  | In-memory            |
| `sessionStore`   | Session list and active session| `tauri-plugin-store` |
| `aiQueueStore`   | AI request queue and history   | In-memory            |
| `metricsStore`   | System metrics time series     | In-memory            |

`enableMapSet()` is called once at store-module load in production, not gated behind a dev-only path, so any store that models domain data as a `Map`/`Set` under Immer's `produce` works correctly in a production build, not just in dev/test where Immer's dev warnings previously masked the missing plugin registration.

### Tier 2: UI State (Jotai)

Jotai atoms manage ephemeral UI state that does not belong in domain stores:

- Theme preferences (particles enabled, reduced motion)
- Frecency scores for command palette
- Pane sizes and layout state
- Selected worker/session IDs

### Tier 3: Persistent State (tauri-plugin-store)

Long-lived state that must survive restarts:

- Session data (`sessions.json`)
- Theme preferences
- Layout preferences (pane sizes)

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
| `system_metrics`     | `{ cpuPercent, memoryMb, workerCount, aiReqPerSec, timestamp }`  | 500ms metrics tick           | No |
| `ai_stream_delta`    | `{ requestId, delta, done }`                                     | AI response chunk            | Yes |
| `ai_stream_settled`  | `{ requestId, status, error }`                                   | Terminal receipt, once per AI request | Yes |
| `agent_turn_started` | `{ workerId, model, requestId }`                                 | AI/agent turn started (causal root) | Yes |
| `system_log`         | `{ level, message, target, timestamp }`                          | Backend log message          | No |
| `bus_message`        | `{ messageId, fromWorker, toWorker, topic, payload }`            | Bus message, forwarded by an active `bus_subscribe` task | Yes |
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
| `create_session`       | `Session`                          |
| `delete_session`       | `()`                               |
| `list_sessions`        | `Session[]`                        |
| `get_session`          | `Session`                          |
| `session_add_worker`   | `()`                               |
| `validate_repo_root`   | Canonical toplevel path string     |
| `git_ship_preflight`   | `ShipPreflight`                    |
| `git_stage_commit`     | `CommitOutcome`                    |
| `git_push`             | `PushOutcome`                      |
| `ship_compare_url`     | Compare URL string                 |
| `ai_request`           | Request ID string (no shipped caller -- see [Built, Not Wired](#built-not-wired)) |
| `get_metrics`          | Metrics JSON, incl. `perWorker`    |
| `bus_send`             | Receiver count (`number`) (no shipped caller -- see [Built, Not Wired](#built-not-wired)) |
| `bus_subscribe`        | `()` (no shipped caller -- see [Built, Not Wired](#built-not-wired)) |
| `bus_create_pipeline`  | Pipeline UUID string (no shipped caller -- see [Built, Not Wired](#built-not-wired)) |
| `bus_list_channels`    | `string[]` (no shipped caller -- see [Built, Not Wired](#built-not-wired)) |
| `bus_list_pipelines`   | `PipelineInfo[]` (no shipped caller -- see [Built, Not Wired](#built-not-wired)) |
| `events_since`          | Persisted `DomainEvent[]`, `seq > afterSeq`, capped at 5000 |
| `check_for_updates`    | Update-availability JSON            |
| `send_notification`    | `()`                                |

---

## Built, Not Wired

Three pieces of the shipped Rust backend are fully implemented and tested but have zero frontend callers today. They are not stubs or dead code -- they are the backend half of features that have not been wired up yet, built ahead of the multi-provider (ACP) rework that is expected to route AI traffic (and possibly agent-to-agent bus traffic) through Rust instead of the webview.

| Piece | Where | Why it isn't live today |
|-------|-------|---------------------------|
| The AI request path: [`ai_request`](api.md#ai_request), `AiQueue`, the SSE parser (`ai/stream.rs`) | `src-tauri/src/ai/`, `src-tauri/src/commands/ai.rs` | The shipped AI flow runs `@anthropic-ai/sdk` directly in the webview (`src/lib/anthropic.ts`, `dangerouslyAllowBrowser: true`) and streams straight to `api.anthropic.com` -- see [AI Streaming](#ai-streaming). Scheduled to become the real transport once the multi-provider (ACP) rework lands. |
| The five `bus_*` commands: [`bus_send`](api.md#bus_send), [`bus_subscribe`](api.md#bus_subscribe), [`bus_create_pipeline`](api.md#bus_create_pipeline), [`bus_list_channels`](api.md#bus_list_channels), [`bus_list_pipelines`](api.md#bus_list_pipelines) | `src-tauri/src/bus/`, `src-tauri/src/commands/bus.rs` | No UI surface invokes any of them -- inter-agent messaging is implemented but not exposed to a user today. Scheduled alongside the ACP rework, which introduces the agent-to-agent flows that would need it. |
| The `ai_stream_settled` receipt | `crates/swarm-core/src/events/emitter.rs`, emitted from `AiQueue`'s process loop | Downstream of `ai_request` above -- since nothing calls `ai_request`, nothing ever triggers this event. Documents the intended terminal-receipt contract for whichever consumer eventually calls `ai_request`. |

Read the [AI Queue](#ai-queue-built-not-wired) diagram and the `ai_request`/`bus_*` entries in [docs/api.md](api.md) as a description of what the Rust side does *if* called -- not as a description of what happens when a user sends a chat message or a worker talks to another worker in the app today.

---

## Error Handling

### Backend Errors

All backend errors flow through the `AppError` enum (11 variants), which implements:

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
└── QueueFull { capacity }       AI queue backpressure
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
