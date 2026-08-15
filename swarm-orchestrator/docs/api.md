# API Reference

> Tauri IPC command documentation for the SWARM Orchestrator backend.

All commands are invoked from the React frontend via `@tauri-apps/api`:

```typescript
import { invoke } from "@tauri-apps/api/core";
const result = await invoke("command_name", { arg1: value1 });
```

Events are received on a single ordered channel, `swarm://events` -- see [Events](#events) below for the envelope contract. The frontend does not call `listen()` directly outside of `src/lib/event-bus.ts`; application code subscribes via `onEvent()`/`waitFor()`.

---

## Table of Contents

- [Worker Commands](#worker-commands)
  - [spawn_worker](#spawn_worker)
  - [pause_worker](#pause_worker)
  - [resume_worker](#resume_worker)
  - [kill_worker](#kill_worker)
  - [list_workers](#list_workers)
  - [worker_input](#worker_input)
  - [Worktree Isolation Lifecycle](#worktree-isolation-lifecycle)
  - [validate_repo_root](#validate_repo_root)
- [Ship Commands](#ship-commands)
  - [git_ship_preflight](#git_ship_preflight)
  - [git_stage_commit](#git_stage_commit)
  - [git_push](#git_push)
  - [ship_compare_url](#ship_compare_url)
- [Session Commands](#session-commands)
  - [create_session](#create_session)
  - [delete_session](#delete_session)
  - [list_sessions](#list_sessions)
  - [get_session](#get_session)
  - [session_add_worker](#session_add_worker)
- [Agent Commands](#agent-commands)
  - [agent_turn_started](#agent_turn_started)
  - [agent_spawn](#agent_spawn)
  - [agent_send_turn](#agent_send_turn)
  - [agent_cancel](#agent_cancel)
  - [agent_shutdown](#agent_shutdown)
  - [agent_probe](#agent_probe)
- [File System Commands](#file-system-commands)
  - [read_file](#read_file)
  - [write_file](#write_file)
- [Metrics Commands](#metrics-commands)
  - [get_metrics](#get_metrics)
- [Bus Commands](#bus-commands)
  - [bus_send](#bus_send)
  - [bus_subscribe](#bus_subscribe)
  - [bus_create_pipeline](#bus_create_pipeline)
  - [bus_list_channels](#bus_list_channels)
  - [bus_list_pipelines](#bus_list_pipelines)
- [Updater Commands](#updater-commands)
  - [check_for_updates](#check_for_updates)
- [Notification Commands](#notification-commands)
  - [send_notification](#send_notification)
- [Events](#events)
- [Wire Protocol (swarmd)](#wire-protocol-swarmd)
- [Built, Not Wired](#built-not-wired)

---

## Worker Commands

### `spawn_worker`

Creates a new worker process with a PTY and registers it in the worker registry.

**Parameters:**

| Name           | Type           | Required | Description                                    |
|----------------|----------------|----------|------------------------------------------------|
| `config`       | `WorkerConfig` | Yes      | Worker spawn configuration                     |
| `originWorker` | `string`       | No       | UUID of the causer (e.g. the AI turn whose `spawn_worker` tool call triggered this spawn). Omitted (not `null`) for a human-initiated spawn -- absent deserializes as unattributed, matching every pre-provenance caller. |
| `causeSeq`     | `number`       | No       | `seq` of the event this spawn is reacting to (typically an `agent_turn_started` seq). |

**`WorkerConfig` object:**

| Field      | Type                     | Default            | Description                          |
|------------|--------------------------|---------------------|--------------------------------------|
| `name`     | `string`                 | `"Worker"`         | Human-readable display name          |
| `shell`    | `string`                 | System default     | Shell executable path                |
| `cwd`      | `string`                 | `""`                | Initial working directory. Ignored when a worktree is actually created (see `isolation` below) -- the PTY's cwd becomes the new worktree path instead |
| `env`      | `Record<string, string>` | `{}`                | Additional environment variables     |
| `rows`     | `number`                 | `24`                | PTY terminal rows                    |
| `cols`     | `number`                 | `80`                | PTY terminal columns                 |
| `repoRoot` | `string \| null`         | `null`              | Root of the git repository to isolate this worker into. `null` (default) reproduces exactly the pre-worktree-isolation spawn -- no git anywhere |
| `isolation`| `"worktree" \| "none"`   | `"worktree"`        | Isolation mode, effective only when `repoRoot` is present |

**Returns:** `string` -- UUID of the newly spawned worker.

**Worktree isolation (when `repoRoot` is given and `isolation` resolves to `"worktree"`):** resolves `repoRoot`'s git toplevel and `HEAD` sha, creates `~/.swarm/worktrees/<repo>-<hash8>/w-<id8>` on a fresh branch `swarm/<slug>-<id8>` starting at that sha, locks it (`git worktree lock --reason "swarm worker <uuid>"`), and spawns the PTY there instead of at `cwd`. Any failure in that pipeline (repo discovery, `HEAD` resolution, `git worktree add`/`lock`, or the PTY spawn itself) hard-fails the whole command -- **no worker is created and no PTY is started**; there is no silent fallback to spawning unisolated at a shared `cwd`. Omitting `repoRoot` skips this entirely and reproduces exactly the pre-worktree-isolation spawn.

**Errors:**

| Error               | Condition                                |
|---------------------|------------------------------------------|
| Git error           | `repoRoot` given and repo discovery, `HEAD` resolution, or `git worktree add`/`lock` failed |
| PTY spawn failed    | Shell executable not found or PTY error  |
| Registry at capacity| Worker count exceeds max_workers (64)    |

**Example:**

```typescript
const workerId = await invoke("spawn_worker", {
  config: {
    name: "Research Agent",
    shell: "powershell.exe",
    cwd: "C:/Projects",
    env: { TERM: "xterm-256color" },
    rows: 30,
    cols: 120,
  },
});
console.log("Spawned worker:", workerId);
```

**Example (worktree isolation):**

```typescript
const workerId = await invoke("spawn_worker", {
  config: {
    name: "Research Agent",
    repoRoot: "C:/Projects/swarm-orchestrator",
    // isolation: "worktree" is the default when repoRoot is present
  },
});
// Spawns the PTY in a fresh worktree, e.g.
// C:/Users/you/.swarm/worktrees/swarm-orchestrator-a1b2c3d4/w-e5f6a7b8
// on branch swarm/research-agent-e5f6a7b8.
```

**Emits:** `worker_spawned` envelope on `swarm://events` with payload `{ workerId, name, pid, isolation }`. When isolated, also emits `worktree_created` -- see [Events](#events) below. Both envelopes carry `originWorker`/`causeSeq` when given -- the new worker's own id is the payload's `workerId` (the SUBJECT); `originWorker` is the CAUSER, and for a tool-driven spawn the two differ.

---

### `pause_worker`

Pauses a running worker by transitioning its state to `paused`.

**Parameters:**

| Name           | Type     | Required | Description              |
|----------------|----------|----------|--------------------------|
| `id`           | `string` | Yes      | UUID of the worker       |
| `originWorker` | `string` | No       | UUID of the causer. Omitted for a human-initiated pause. |
| `causeSeq`     | `number` | No       | `seq` this action is reacting to. |

**Returns:** `void`

**Errors:**

| Error            | Condition                       |
|------------------|---------------------------------|
| Invalid UUID     | `id` is not a valid UUID string |
| Worker not found | No worker with the given ID     |

**Example:**

```typescript
await invoke("pause_worker", { id: "550e8400-e29b-41d4-a716-446655440000" });
```

**Emits:** `worker_state` envelope on `swarm://events` with payload `{ workerId, state: "paused" }`.

**Note:** On Windows, this only updates the internal state. Process-level suspension via `SIGSTOP` is not supported.

---

### `resume_worker`

Resumes a paused worker by transitioning its state back to `running`.

**Parameters:**

| Name           | Type     | Required | Description              |
|----------------|----------|----------|--------------------------|
| `id`           | `string` | Yes      | UUID of the worker       |
| `originWorker` | `string` | No       | UUID of the causer. Omitted for a human-initiated resume. |
| `causeSeq`     | `number` | No       | `seq` this action is reacting to. |

**Returns:** `void`

**Errors:**

| Error            | Condition                       |
|------------------|---------------------------------|
| Invalid UUID     | `id` is not a valid UUID string |
| Worker not found | No worker with the given ID     |

**Example:**

```typescript
await invoke("resume_worker", { id: "550e8400-e29b-41d4-a716-446655440000" });
```

**Emits:** `worker_state` envelope on `swarm://events` with payload `{ workerId, state: "running" }`.

---

### `kill_worker`

Terminates a worker process and removes it from the registry.

Drops the PTY writer (closes master fd), kills the child process, waits for exit to prevent zombie processes (and, on Windows, to release any OS handle the child held on the worktree directory as its cwd), and emits a killed event.

If the worker was isolated into a git worktree, also unlocks and `git worktree remove`s it -- **never** with `--force`. git's own refusal on a dirty/untracked worktree is treated as a successful preserve, not an error: SWARM never deletes uncommitted work.

**Phase 3:** if this worker also has a live agent session attached ([`agent_spawn`](#agent_spawn)), it is removed from the `AgentSessionRegistry` and shut down too -- best-effort: a failure here is logged, not propagated, so an agent-session teardown hiccup never blocks the PTY worker's own kill.

**Parameters:**

| Name           | Type     | Required | Description              |
|----------------|----------|----------|--------------------------|
| `id`           | `string` | Yes      | UUID of the worker       |
| `originWorker` | `string` | No       | UUID of the causer (e.g. the AI turn whose `kill_worker` tool call triggered this). Omitted for a human-initiated kill. |
| `causeSeq`     | `number` | No       | `seq` this action is reacting to. |

**Returns:** `void`

**Errors:**

| Error            | Condition                       |
|------------------|---------------------------------|
| Invalid UUID     | `id` is not a valid UUID string |
| Worker not found | No worker with the given ID     |

**Example:**

```typescript
await invoke("kill_worker", { id: "550e8400-e29b-41d4-a716-446655440000" });
```

**Emits:** `worker_killed` envelope on `swarm://events` with payload `{ workerId }`. When the worker was isolated, also emits `worktree_removed` first -- see [Events](#events) below. Both carry `originWorker`/`causeSeq` when given.

---

### `list_workers`

Returns a list of all active workers as serializable info snapshots.

**Parameters:** None

**Returns:** `WorkerInfo[]`

**`WorkerInfo` object:**

| Field          | Type             | Description                        |
|----------------|------------------|------------------------------------|
| `id`           | `string` (UUID)  | Unique worker identifier           |
| `state`        | `string`         | `"idle"`, `"running"`, `"paused"`, or `"error"` |
| `name`         | `string`         | Human-readable display name        |
| `pid`          | `number \| null` | OS process ID, if available        |
| `startedAt`    | `number`         | Unix timestamp (seconds)           |
| `worktreePath` | `string \| null` | Absolute path of this worker's git worktree, if it was spawned with isolation |
| `branch`       | `string \| null` | Branch checked out in `worktreePath` (`swarm/<slug>-<id8>`), if isolated |

**Example:**

```typescript
const workers = await invoke("list_workers");
// [{ id: "...", state: "running", name: "Agent 1", pid: 1234, startedAt: 1700000000 }]
```

---

### `worker_input`

Sends input text to a worker's PTY stdin, then emits a stamped `worker_input` event recording that it happened.

**Contract fix (provenance Phase 5c):** `data` is a `string`, not `number[]`/bytes. Every real caller (the terminal, the `run_command` AI tool, the workspace watcher's auto-injection) sends a JS string; a prior `Vec<u8>` Rust-side signature could not deserialize that (`serde_json` expects a JSON array of byte numbers for `Vec<u8>`, not a string) and failed IPC deserialization for every caller before this was fixed. The example below is what every real caller has always actually sent.

**Parameters:**

| Name           | Type     | Required | Description                     |
|----------------|----------|----------|----------------------------------|
| `id`           | `string` | Yes      | UUID of the target worker       |
| `data`         | `string` | Yes      | Text to write to the PTY (UTF-8 encoded before the write) |
| `source`       | `string` | Yes      | `"terminal"` (human keystrokes), `"tool"` (an AI tool call), or `"automation"` (e.g. workspace-watcher auto-injection) |
| `originWorker` | `string` | No       | UUID of the causer. Omitted for `source: "terminal"` (the causer is a human, not a worker's turn). |
| `causeSeq`     | `number` | No       | `seq` this input is reacting to (typically an `agent_turn_started` seq). |

**Returns:** `void`

**Errors:**

| Error            | Condition                          |
|------------------|------------------------------------|
| Invalid UUID     | `id` or `originWorker` is not a valid UUID string |
| Worker not found | No worker with the given ID        |
| IPC error        | Worker has no PTY writer or write failed |

**Example:**

```typescript
// Terminal keystrokes (see src/hooks/useTerminal.ts)
await invoke("worker_input", { id: workerId, data: "ls\n", source: "terminal" });

// An AI tool call (see src/lib/tools.ts's run_command)
await invoke("worker_input", {
  id: workerId,
  data: "pnpm build\n",
  source: "tool",
  originWorker: callingWorkerId,
  causeSeq: turnSeq,
});
```

**Emits:** `worker_input` envelope on `swarm://events` with payload `{ workerId, bytes, source, preview? }` -- emitted only AFTER a successful PTY write. `preview` (first ~120 characters, control characters stripped) is present only for `source ∈ {tool, automation}`; `source == "terminal"` never carries a preview and the row is excluded from persistence entirely (see [Persistence Policy](#persistence-policy)) -- raw human keystrokes, and any secrets typed into a shell, are never archived.

---

### Worktree Isolation Lifecycle

Giving a worker its own `git worktree` is opt-in per spawn, via [`spawn_worker`](#spawn_worker)'s `repoRoot`/`isolation` fields -- no `repoRoot` reproduces exactly the pre-worktree-isolation behavior.

**Lifecycle:**

1. **Spawn** (`repoRoot` present, `isolation` resolves to `"worktree"`): resolve `repoRoot`'s git toplevel and `HEAD` sha -> `git worktree add -b swarm/<slug>-<id8> <path> <sha>` -> `git worktree lock --reason "swarm worker <uuid>"` -> spawn the PTY with `cwd = <path>`. Emits `worktree_created`.
2. **Kill**: wait for the PTY child to fully exit -> `git worktree unlock` -> `git worktree remove` (**never** `--force`). Emits `worktree_removed` with the resulting `disposition`. On a `"removed"` disposition only, also attempts to delete the isolation branch -- see **Branch Cleanup** below.

**Disposition is classified honestly, not optimistically.** `worktree_removed.disposition` is one of:

| Disposition | Meaning |
|---|---|
| `"removed"` | `git worktree remove` succeeded -- the directory is gone. |
| `"preserved_dirty"` | git refused *specifically* because the worktree has uncommitted changes or untracked files (`"contains modified or untracked files"`). This is the **only** refusal classified as preserved -- see the guarantee below. |
| `"failed"` | Anything else went wrong: the worktree was still locked (an unlock failure is treated as a failure in its own right and `remove` is never even attempted), a permission error killed the delete partway through, the path was already gone, or an unrecognized git error. `reason` carries the stderr excerpt. |

Earlier drafts of this classification lumped every non-dirty refusal into `"preserved_dirty"`, which is a lie in at least two real scenarios: a still-locked worktree isn't dirty at all, and a permission error can strike *after* git has already started deleting tracked files -- reporting "preserved" there claims safety that doesn't exist. `"failed"` is the honest signal that something needs a human to look at it; `"preserved_dirty"` is reserved strictly for the one refusal that means "your uncommitted work is intact, untouched, right where it was."

**The Preserve-On-Dirty Guarantee:** `git worktree remove` is invoked without `--force`, which is the entire mechanism -- git itself refuses to remove a worktree that has uncommitted changes or untracked files. SWARM never deletes a worktree's contents itself, and no code path anywhere in the git module can construct a `--force`/`-f` argument for `worktree remove` (enforced by a unit test on the argv builder, `git::worktree::tests::test_remove_args_never_contains_force`).

**A surviving child process can produce `"failed"`.** The PTY layer (`portable-pty` 0.9) does not use a Windows job object or a Unix process group -- killing a worker's shell does not kill any grandchild it spawned (e.g. a long-running build). A grandchild that outlives the kill can hold the worktree directory open as its own cwd, which makes `git worktree remove` fail with a permission error. That is correctly reported as `disposition: "failed"` (never laundered into "preserved"), but the worktree is then stuck on disk until the surviving process exits, at which point a retry or manual cleanup is needed. Fixing this at the source (a job object / process-group kill) is out of Phase 1's scope; if it surfaces, the Title Case-appropriate framing is "Worktree Removal Failed -- A Process May Still Be Using It."

**Branch Cleanup:** after a `"removed"` disposition (never any other), the isolation branch's tip is compared against the commit it was created from. If unchanged (the agent made no commits), the branch is deleted with `git branch -d` -- **never** `-D` (enforced the same way as the no-`--force` guarantee: `git::worktree::tests::test_branch_delete_args_never_contains_capital_d`). If the tip diverged (the agent committed real work), the branch is left in place -- deleting it would be data loss with extra steps. Either outcome is logged (`tracing`, not a `SwarmEvent` -- this is bookkeeping, not history) and never fails the kill itself.

**Failure policy:** no `repoRoot` -> today's unisolated spawn, unconditionally. `repoRoot` present and the worktree-creation pipeline fails at any step -> the whole [`spawn_worker`](#spawn_worker) call fails -- no worker is registered and no PTY is started. There is no silent fallback to sharing a cwd across workers.

**Location:** worktrees live under `~/.swarm/worktrees/<repo>-<hash8>/w-<id8>` (`<repo>` a sanitized repo directory name, `<hash8>` an 8-hex-character tag derived from the repo's absolute path, `<id8>` the worker UUID's first 8 hex characters) -- already inside SWARM's reserved writable scope (`$HOME/.swarm/**` in `src-tauri/capabilities/default.json`).

**Startup probe:** on launch, the shell runs `git --version` and requires >= 2.17 (the version `git worktree remove` was added in). A missing or too-old git is never silently degraded -- it logs a warning and emits a `system_log` envelope (`level: "warn"`, message "Git Unavailable -- Isolated Spawns Will Fail Until Git Is Installed Or Upgraded") consumed by `useSystemLogEvents` into the existing Logs page. It does not mean workers spawn unisolated -- a `repoRoot`-bearing spawn still hard-fails per the failure policy above; this only makes that fact visible before the user hits it as a spawn error.

**Startup prune:** the shell also runs `git worktree prune` against the persisted `default_repo_root` config key (see the Project Root picker on the Workers page), logging the pruned count.

---

### `validate_repo_root`

Validates that a directory is inside a git repository -- used by the Workers page's Project Root picker to confirm a chosen directory *before* persisting it as `default_repo_root` config, instead of letting every subsequent isolated spawn hard-fail with a raw git error. Also used to revalidate the persisted value on load (a repo can be deleted or moved between sessions).

**Parameters:**

| Name   | Type     | Required | Description                          |
|--------|----------|----------|---------------------------------------|
| `path` | `string` | Yes      | Candidate directory (e.g. from a directory picker) |

**Returns:** `string` -- the repo's canonical toplevel absolute path (may differ from `path` if it was a subdirectory of the repo).

**Errors:**

| Error     | Condition                                    |
|-----------|-----------------------------------------------|
| Git error | `path` is not inside a git repository, `git` could not be spawned, or the operation timed out |

**Example:**

```typescript
try {
  const toplevel = await invoke("validate_repo_root", { path: "C:/Projects/swarm-orchestrator/src" });
  // toplevel === "C:/Projects/swarm-orchestrator"
} catch {
  // not a git repository -- show a Title Case toast, don't persist it
}
```

---

## Ship Commands

The ship chain turns a worker's finished work into a real commit, a real upstream push, and a browser open on a prefilled GitHub compare page -- **Phase 1 (MVP)**: commit -> push -> compare page, zero AI dependency. All git mutation logic lives in `swarm_core::git::ship` (tauri-free); these commands are thin IPC wrappers that add `spawn_blocking`, per-repo `RepoLocks::run_serialized` (inside `stage_and_commit`/`push` themselves -- see the module doc), and `ship_progress`/`ship_settled`/`commit_created` event emission.

**Ownership split** (frozen Phase 0 contract): the worktree feature (`git::worktree`, `worker::lifecycle`) owns worktree creation/branch-naming/removal; ship owns commit/push and is the *only* writer of `WorkerHandle.lastShippedSeq`/`lastShippedCommit` (via `WorkerRegistry::set_last_shipped`, called only after a successful `git_push`). There is no separate `WorktreeRegistry` -- `swarm_core::git::ship::worktree_info_for_worker` is the thin, frozen accessor ship consumes instead of reaching into `WorkerHandle`'s fields directly. See [docs/architecture.md#ship-chain](architecture.md#ship-chain) for the full design.

**Typed errors, not strings.** Every command below rejects with a structured `ShipError` object -- `{ kind, message, remedy }` -- instead of the plain-string convention every other command in this file uses. This is a **documented divergence**: the Ship tab UI must branch on `kind` for the right second-click remedy (e.g. `pushRejected` -> "Fetch And Rebase, Then Ship Again", never an automatic force-push), which a bare string can't carry.

**`ShipErrorKind` values:** `workerNotFound`, `noWorktree`, `primaryCheckout`, `invalidBranch`, `noRemote`, `nonGitHubHost`, `nothingToCommit`, `identityMissing`, `hookFailed`, `pushRejected`, `authExpired`, `timeout`, `unknown`. `noUpstream` is deliberately absent -- a fresh isolation branch having no upstream yet is a normal *preflight state* (`ShipPreflight.upstream: null`), never an error.

**`ShipRemedy` values:** `fetchAndRebase`, `reAuthenticate`, `configureIdentity` -- a suggested next action, or `null` when there isn't one.

---

### `git_ship_preflight`

Computes the full ship preflight for a worker's worktree, evaluated for `mode` (defaults to `"all"` when omitted): branch/remote/tracking state, working-tree status, the deny-list preview (mode-aware -- a `"staged"` preview reflects only the index, matching what `git_stage_commit` would actually commit for that mode), and the `canShip`/`blockers` verdict. Read-only -- never mutates the working tree, emits no events.

**Refuses (via non-fatal `blockers`, `canShip: false` when any is present) rather than erroring:** toplevel mismatch (the worktree path no longer resolves to itself), primary checkout (`--git-common-dir == --git-dir`), detached `HEAD`, `branch == baseBranch`, a protected branch (`main`/`master`/`develop`/`release/*`), missing `origin` remote, or nothing to ship at all (clean working tree **and** `ahead == 0`).

**Parameters:**

| Name       | Type     | Required | Description         |
|------------|----------|----------|----------------------|
| `workerId` | `string` | Yes      | UUID of the worker    |
| `mode`     | `"all" \| "staged"` | No | Staging mode to evaluate the preview for. Defaults to `"all"` |

**Returns:** `ShipPreflight`

**`ShipPreflight` object:**

| Field                 | Type               | Description                                                          |
|-----------------------|--------------------|--------------------------------------------------------------------------|
| `workerId`            | `string` (UUID)    | The worker this preflight was computed for                                |
| `branch`              | `string`           | Current branch checked out in the worktree                                |
| `baseBranch`          | `string`           | The remote's default branch (`origin/HEAD`, stripped of the `origin/` prefix) -> falls back to the repo's `init.defaultBranch` config -> falls back to `"main"`. **Never** the primary checkout's current `HEAD` -- a human can have any branch checked out there at any time |
| `remote`              | `string \| null`   | `origin`'s URL, redacted (see `swarm_core::git::redact`)                   |
| `host`                | `string \| null`   | Host parsed from `remote` (e.g. `"github.com"`)                           |
| `hostSupportsCompare` | `boolean`          | Whether `host` looks like GitHub/GHES -- the frontend disables *only* the "Open Compare Page" action when `false`, Commit Only / Commit + Push stay available |
| `upstream`            | `string \| null`   | Tracking ref (e.g. `"origin/swarm/x"`) -- `null` means no upstream yet, not an error |
| `ahead`               | `number`           | Commits ahead of `upstream`; when there's no upstream yet, a fallback count of commits reachable from `HEAD` but not from the worktree's recorded base commit |
| `behind`              | `number`           | Commits behind `upstream` (`0` when there's no upstream -- there's nothing to be behind) |
| `staged`              | `string[]`         | Paths with staged changes                                                 |
| `unstaged`            | `string[]`         | Paths with unstaged changes                                               |
| `untracked`           | `string[]`         | Untracked paths                                                           |
| `skipped`             | `SkippedFile[]`    | Deny-list preview for `mode` -- see below                                 |
| `diffStat`            | `DiffStat`         | `{ filesChanged, insertions, deletions }` estimate over the deny-filtered survivor set for `mode` |
| `canShip`             | `boolean`          | `true` only when `blockers` is empty                                      |
| `blockers`            | `string[]`         | Title Case reasons `canShip` is `false`                                   |

**`SkippedFile` object:** `{ path: string, reason: string }` -- `reason` is one of `"Skipped — Looks Like A Credential"` or `"Skipped — Larger Than 5 MB"`, from the secret/size deny list: `.env*`, `*.pem`, `*.key`, `id_rsa*` (matched against the filename), or a `secret` substring anywhere in the full relative path (case-insensitive -- catches a nested `config/secrets/api.yaml` even though its own filename doesn't mention "secret"), or any file larger than 5MB.

**Errors:** `ShipError` with kind `workerNotFound` (no worker with `workerId`) or `noWorktree` (the worker exists but was spawned without worktree isolation).

**Example:**

```typescript
const preflight = await invoke("git_ship_preflight", { workerId, mode: "all" });
if (!preflight.canShip) {
  console.warn("Ship blocked:", preflight.blockers);
}
```

---

### `git_stage_commit`

Stages changed files (per `mode`) and commits, appending a `Swarm-Seq-Range: <seqFrom>..<seqTo>` trailer -- **omitted entirely** when the range is unknown (`seqFrom == 0 && seqTo == 0`) or degenerate (`seqTo < seqFrom`), never emitted as a lying `0..0` -- and, when the `shipCoAuthoredBy` config key is set to a trimmed, single-line (no embedded `\n`/`\r`) value, a `Co-Authored-By:` trailer. `--no-verify` is not constructible anywhere in the argv builder -- hooks always run.

In `mode: "staged"`, the deny list is **enforced**, not just previewed: any denied path already in the index is unstaged via `git restore --staged` (under the same per-repo serialization as every other mutation) before the commit runs; if the unstage itself fails, the commit is hard-aborted with a truthful error rather than risk committing the secret anyway.

Emits `ship_progress` for the `"staging"` then `"commit"` step, `commit_created` on success, and the terminal `ship_settled` receipt -- **except** when the failure is `nothingToCommit`, which is not automatically terminal (see [`git_push`](#git_push) below): the frontend may recover by pushing an already-committed, unpushed change instead of treating this as the end of the ship attempt.

**Parameters:**

| Name        | Type            | Required | Description                                            |
|-------------|-----------------|----------|----------------------------------------------------------|
| `workerId`  | `string`        | Yes      | UUID of the worker                                        |
| `shipId`    | `string`        | Yes      | Correlation ID for this ship attempt (client-generated, e.g. `crypto.randomUUID()`) |
| `message`   | `string`        | Yes      | Commit message (before trailers are appended)              |
| `mode`      | `"all" \| "staged"` | Yes | `"all"`: stage every changed file minus the deny list (`git add -- <survivors>`, never `-A`). `"staged"`: commit the index, with denied paths actively unstaged first (see above) |
| `finalStep` | `boolean`       | Yes      | `true` for "Commit Only" (no push/compare follows)          |

**Returns:** `CommitOutcome`

**`CommitOutcome` object:**

| Field         | Type            | Description                                    |
|---------------|-----------------|--------------------------------------------------|
| `sha`         | `string`        | The new commit's sha                              |
| `filesChanged`| `number`        | From `git show --numstat` on the actual commit    |
| `insertions`  | `number`        |                                                    |
| `deletions`   | `number`        |                                                    |
| `seqFrom`     | `number`        | Start of the `Swarm-Seq-Range` trailer (the values used even when the trailer itself was omitted) |
| `seqTo`       | `number`        | End of the `Swarm-Seq-Range` trailer               |
| `skipped`     | `SkippedFile[]` | Files the deny list caught (and, in `"staged"` mode, actively unstaged)  |

**`seqFrom`/`seqTo` resolution:** `seqFrom` is the worker's `lastShippedSeq` if it has shipped before (session-scoped -- see the note below), else its `worktree_created` event's own `seq` (an indexed lookup against the event log), else `0`. `seqTo` is the log's current max `seq`, snapshotted *before* the commit -- the `commit_created` event's own `seq` is always `> seqTo`, correctly excluding "the record of shipping" from the range it describes.

**`lastShippedSeq` is session-scoped in Phase 1.** It lives only on the in-memory `WorkerHandle`, never persisted to disk -- an app restart loses it. The next ship after a restart falls back to the (indexed, cheap) `worktree_created` lookup instead, which re-covers the worktree's *entire* lifetime in the new commit's `Swarm-Seq-Range` trailer rather than just the range since the last real ship. This is harmless: the trailer is provenance metadata for a future causal query, not something Phase 1 itself reads back. Durable `lastShippedSeq` persistence is deferred to the provenance phase.

**Errors:**

| Error kind          | Condition                                                                   |
|----------------------|------------------------------------------------------------------------------|
| `primaryCheckout`    | The pre-mutation guard fired -- see [Ship Commands](#ship-commands)'s ownership-split note |
| `nothingToCommit`    | Every candidate file was skipped by the deny list, or (mode `"staged"`) the index is empty after unstaging denied paths -- **not automatically terminal**, see above |
| `identityMissing`    | `git commit` failed because `user.name`/`user.email` aren't set (remedy `configureIdentity`) |
| `hookFailed`         | `git commit` was rejected -- most plausibly a pre-commit/commit-msg hook, since `--no-verify` is never constructible |

**Example:**

```typescript
const outcome = await invoke("git_stage_commit", {
  workerId,
  shipId: crypto.randomUUID(),
  message: "feat: add feature file",
  mode: "all",
  finalStep: true, // "Commit Only" -- no push follows
});
console.log("Committed:", outcome.sha, "skipped:", outcome.skipped);
```

**Emits:** `ship_progress` (`step: "staging"`, then `step: "commit"`), `commit_created` with payload `{ workerId, sha, branch, seqFrom, seqTo }`, and (conditionally, see above) `ship_settled`.

---

### `git_push`

Pushes the worker's branch: `git push --set-upstream origin <branch>` -- **fixed argv**, no force token constructible anywhere in the argv builder (`--force`/`-f`/`--force-with-lease` cannot be reached). Both the branch and the sha pushed are resolved **live**, server-side, at push time -- this command takes **no** commit sha from the caller at all. On success, records `lastShippedSeq`/`lastShippedCommit` for the worker via `WorkerRegistry::set_last_shipped` -- the ship chain is the only writer of those two fields.

**This is what lets a worker with already-committed, unpushed work go straight to `git_push`.** If `git_stage_commit` fails with `nothingToCommit` but `ShipPreflight.ahead > 0` (e.g. an earlier "Commit Only" already committed real work that was never pushed), the frontend calls `git_push` directly -- no fresh commit is required, because this command resolves whatever `HEAD` already is, live, rather than trusting a value from a preceding `git_stage_commit` call.

Emits `ship_progress` for the `"push"` step, and -- when `finalStep` is `true` (the "Commit + Push" action) or the push failed -- the terminal `ship_settled` receipt.

**Parameters:**

| Name        | Type      | Required | Description                                                      |
|-------------|-----------|----------|--------------------------------------------------------------------|
| `workerId`  | `string`  | Yes      | UUID of the worker                                                   |
| `shipId`    | `string`  | Yes      | Correlation ID matching the preceding `git_stage_commit` call (if any) |
| `finalStep` | `boolean` | Yes      | `true` for "Commit + Push" (no compare-page step follows)             |

**Returns:** `PushOutcome` -- `{ pushedRef: string, sha: string }` (e.g. `{ pushedRef: "origin/swarm/agent-abcd1234", sha: "..." }`). `sha` is `HEAD` at push time, resolved server-side.

**Errors:**

| Error kind       | Condition                                                              | Remedy            |
|-------------------|--------------------------------------------------------------------------|--------------------|
| `primaryCheckout` | The pre-mutation guard fired                                              | --                 |
| `invalidBranch`   | Detached `HEAD` -- resolved live, the same check `git_ship_preflight` uses | --                 |
| `noRemote`        | No `origin` remote configured                                             | --                 |
| `pushRejected`    | Non-fast-forward rejection -- `origin` has commits the local branch doesn't | `fetchAndRebase` (`git pull --rebase`, re-preview, ship again -- **never** an automatic force-push) |
| `authExpired`     | Authentication failed (expired/missing credentials, `GIT_TERMINAL_PROMPT=0` surfacing what would have been an interactive prompt) | `reAuthenticate`  |
| `timeout`         | The underlying git invocation exceeded its timeout budget                 | --                 |

**Example:**

```typescript
try {
  const push = await invoke("git_push", { workerId, shipId, finalStep: true });
  console.log("Pushed:", push.pushedRef, push.sha);
} catch (err) {
  // err is a ShipError object: { kind, message, remedy }
  if (err.kind === "pushRejected") {
    // surface err.remedy ("fetchAndRebase") as the second-click action
  }
}
```

**Emits:** `ship_progress` (`step: "push"`), and (conditionally) `ship_settled` with `commitSha`/`pushedRef` set.

**Client-side timeout discipline:** the frontend's own receipt wait (`waitFor("ship_settled", ...)` in `useShip.ts`) must use an explicit budget of at least 30 seconds -- the backend's own git timeout for a mutating call (`CREATE_TIMEOUT` in `git/cli.rs`) is 20 seconds, and `waitFor`'s library default (5 seconds) is well short of that. A push that legitimately takes 5-20s (a slow remote, a large object) must never be reported as "failed" by a frontend timeout that fires before the backend's own.

---

### `ship_compare_url`

Builds the GitHub-style compare URL for a worker's worktree, prefilled with a PR title/body via `quick_pull=1` query parameters, capped at 6000 total characters. If the untruncated URL would exceed the cap, `body` is shortened first (with a visible truncation marker); if even an *empty* body still doesn't fit, `title` is clamped too as a last resort -- only the compare path itself (host/owner/repo/base/branch) is never truncated. The branch is resolved **live** (same as [`git_push`](#git_push), never a stale stored value). Supports `https`/`ssh`/GHES remote URL shapes; a non-GitHub-shaped host (`gitlab.com`, `bitbucket.org`, etc.) is rejected rather than producing a broken URL.

The frontend is expected to pre-check `ShipPreflight.hostSupportsCompare` and disable the "Open Compare Page" action entirely for a non-GitHub remote -- this command's own `nonGitHubHost` error is the defensive fallback for a stale preflight, not the primary UX. Its message never references a "Copy Push Command" control, since no such control exists in Phase 1.

Always the true final step of the "Commit + Push + Open Compare Page" action -- emits the terminal `ship_settled` receipt on both success and failure.

**Parameters:**

| Name        | Type      | Required | Description                                             |
|-------------|-----------|----------|-------------------------------------------------------------|
| `workerId`  | `string`  | Yes      | UUID of the worker                                            |
| `shipId`    | `string`  | Yes      | Correlation ID matching the preceding `git_stage_commit`/`git_push` calls |
| `commitSha` | `string`  | Yes      | Carried through into the `ship_settled` receipt only          |
| `pushedRef` | `string`  | Yes      | Carried through into the `ship_settled` receipt only          |
| `title`     | `string`  | Yes      | PR title (URL query value; only clamped if even an empty body doesn't fit the cap) |
| `body`      | `string`  | Yes      | PR body (URL query value, truncated first if the URL would exceed the cap) |

**Returns:** `string` -- the compare URL.

**Errors:**

| Error kind      | Condition                                                       |
|------------------|--------------------------------------------------------------------|
| `invalidBranch`  | Detached `HEAD`                                                     |
| `noRemote`       | No `origin` remote configured                                       |
| `nonGitHubHost`  | The remote's host isn't one a GitHub-style compare URL applies to (e.g. GitLab, Bitbucket) |

**Example:**

```typescript
const url = await invoke("ship_compare_url", {
  workerId,
  shipId,
  commitSha: outcome.sha,
  pushedRef: push.pushedRef,
  title: "Add Feature File",
  body: "Adds feature.txt.",
});
await open(url); // @tauri-apps/plugin-shell
```

**Emits:** `ship_progress` (`step: "compare"`), then `ship_settled` with `prUrl` set.

---

## Session Commands

### `create_session`

Creates a new session with the given name and configuration.

**Parameters:**

| Name           | Type     | Required | Description                        |
|----------------|----------|----------|-------------------------------------|
| `name`         | `string` | Yes      | Human-readable session name        |
| `config`       | `object` | Yes      | Arbitrary JSON configuration       |
| `originWorker` | `string` | No       | UUID of the causer. `None` in practice today -- no caller passes it yet (session CRUD is exclusively user-initiated in the shipped app). |
| `causeSeq`     | `number` | No       | `seq` this action is reacting to.  |

**Returns:** `Session`

**`Session` object:**

| Field       | Type            | Description                        |
|-------------|------------------|------------------------------------|
| `id`        | `string` (UUID) | Unique session identifier          |
| `name`      | `string`        | Session name                       |
| `workerIds` | `string[]`      | UUIDs of workers in this session   |
| `createdAt` | `number`        | Unix timestamp (seconds)           |
| `config`    | `object`        | Arbitrary JSON configuration       |

**Example:**

```typescript
const session = await invoke("create_session", {
  name: "Research Session",
  config: { model: "claude-sonnet-4-20250514", maxTokens: 4096 },
});
console.log("Created session:", session.id);
```

**Emits:** `session_created` envelope on `swarm://events` with payload `{ sessionId, name }`.

**Side effect:** Auto-saves all sessions to `sessions.json`.

---

### `delete_session`

Deletes a session by ID.

**Parameters:**

| Name           | Type     | Required | Description              |
|----------------|----------|----------|--------------------------|
| `id`           | `string` | Yes      | UUID of the session      |
| `originWorker` | `string` | No       | UUID of the causer. `None` in practice today, same as `create_session`. |
| `causeSeq`     | `number` | No       | `seq` this action is reacting to. |

**Returns:** `void`

**Errors:**

| Error             | Condition                        |
|-------------------|----------------------------------|
| Invalid UUID      | `id` is not a valid UUID string  |
| Session not found | No session with the given ID     |

**Example:**

```typescript
await invoke("delete_session", { id: session.id });
```

**Emits:** `session_deleted` envelope on `swarm://events` with payload `{ sessionId }`.

**Side effect:** Auto-saves remaining sessions to `sessions.json`.

---

### `list_sessions`

Returns a list of all active sessions.

**Parameters:** None

**Returns:** `Session[]`

**Example:**

```typescript
const sessions = await invoke("list_sessions");
```

---

### `get_session`

Gets a single session by ID.

**Parameters:**

| Name | Type     | Required | Description              |
|------|----------|----------|--------------------------|
| `id` | `string` | Yes      | UUID of the session      |

**Returns:** `Session`

**Errors:**

| Error             | Condition                        |
|-------------------|----------------------------------|
| Invalid UUID      | `id` is not a valid UUID string  |
| Session not found | No session with the given ID     |

**Example:**

```typescript
const session = await invoke("get_session", { id: "550e8400-..." });
```

---

### `session_add_worker`

Registers a worker against a session's `workerIds` list.

**Parameters:**

| Name         | Type     | Required | Description                        |
|--------------|----------|----------|-------------------------------------|
| `sessionId`  | `string` | Yes      | UUID of the target session          |
| `workerId`   | `string` | Yes      | UUID of the worker to add           |

**Returns:** `void`

**Errors:**

| Error             | Condition                                |
|-------------------|-------------------------------------------|
| Invalid UUID      | `sessionId` or `workerId` is not a valid UUID |
| Session not found | No session with the given ID exists       |

**Example:**

```typescript
await invoke("session_add_worker", {
  sessionId: session.id,
  workerId,
});
```

**Side effect:** Auto-saves the updated session list to `sessions.json`.

---

## Agent Commands

> **`ai_request` was removed in Phase 2 of the multi-provider agent-execution rework.** It enqueued raw Anthropic Messages API requests through a Rust-side priority queue (`AiQueue`) that no shipped frontend code ever called -- the chat flow you get by running the app streams `@anthropic-ai/sdk` directly from the webview to `api.anthropic.com` (`src/lib/anthropic.ts`) and never reached this command. Its tested queueing machinery (BinaryHeap priority + Semaphore concurrency gate + bounded mpsc backpressure) was **absorbed, not deleted** -- it now lives as `swarm_core::agent::scheduler::AgentScheduler`, retyped to schedule provider-adapter turns instead of raw API requests. See `docs/architecture.md`'s adapter-layer section for the trait pair (`AgentAdapter`/`AgentSession`) Phase 3's concrete adapters will implement, and the [`agent_*` event family](#type-tags) below for the normalized events those adapters will emit in place of `ai_stream_delta`/`ai_stream_settled`.

### `agent_turn_started`

A narrow webview intake, **actively used** by the shipped chat flow. `AIChat.tsx`'s `doSend` calls this once per turn, before the first streaming round, and stores the returned seq (`turnSeq`) in that turn's closure. Every tool-driven side effect the turn executes afterward (`spawn_worker`, `kill_worker`, `worker_input`, `write_file`) cites `turnSeq` as its `causeSeq`.

This is the mechanism behind the "the engine records provenance, it never infers it" invariant for AI turns specifically: the frontend cannot cite a cause that does not exist in the log, so this command's job is to make one exist deterministically -- no polling, no timeout-bound `waitFor` correlation. It uses the same ack-oneshot the writer thread resolves to the real assigned seq (`EventSink::emit_awaiting_seq`).

**Parameters:**

| Name        | Type     | Required | Description                                     |
|-------------|----------|----------|--------------------------------------------------|
| `workerId`  | `string` | Yes      | UUID of the worker whose chat panel started this turn |
| `model`     | `string` | Yes      | Model identifier for this turn                  |
| `requestId` | `string` | Yes      | Client-generated correlation ID (the chat item id) |

**Returns:** `number` -- the `seq` the writer thread assigned the `agent_turn_started` event.

**Errors:**

| Error                  | Condition                                  |
|------------------------|---------------------------------------------|
| Invalid UUID           | `workerId` is not a valid UUID string      |
| Event Writer Unavailable | The writer thread is gone (ack channel closed without a value) -- effectively unreachable in practice |

**Example:**

```typescript
// AIChat.tsx's doSend, before round 0:
const turnSeq = await invoke<number>("agent_turn_started", {
  workerId,
  model: modelId,
  requestId: itemId,
});
// turnSeq now lives in this turn's closure, cited as causeSeq below:
await invoke("worker_input", {
  id: workerId,
  data: "pnpm build\n",
  source: "tool",
  originWorker: workerId,
  causeSeq: turnSeq,
});
```

**Emits:** `agent_turn_started` envelope on `swarm://events` with payload `{ workerId, model, requestId }`. Unattributed (`originWorker`/`causeSeq` both absent) -- the turn's own start is caused by a human (or an injected instruction acting on the user's behalf), same as every other user-initiated action.

---

### `agent_spawn`

Phase 3. Spawns a new worker via the existing worktree-isolation path (`do_spawn_worker` -- the same machinery [`spawn_worker`](#spawn_worker) uses) and attaches a Claude Code provider-adapter session to it in one call. The PTY worker and the attached agent session are independent resources sharing only the worker id and cwd (see `docs/architecture.md`'s "Session state -- three owners, no mirroring" table): the PTY continues to back the plain terminal view, while the agent session drives the AI conversation via [`agent_send_turn`](#agent_send_turn) et al.

**Parameters:**

| Name        | Type                                    | Required | Description |
|-------------|------------------------------------------|----------|--------------|
| `config`    | `WorkerConfig`                           | Yes      | Same shape [`spawn_worker`](#spawn_worker) takes (`name`/`shell`/`cwd`/`env`/`repoRoot`/`isolation`) |
| `provider`  | `string`                                 | Yes      | Wire provider id -- only `"claude_code"` is supported today |
| `model`     | `string`                                 | No       | Model alias (e.g. `"sonnet"`); omitted defers to the adapter's default |
| `trustTier` | `"restricted" \| "standard" \| "write_enabled"` | No | Spawn-time trust dial (see `docs/architecture.md`'s adapter-layer section); omitted defers to `"standard"` |
| `originWorker` | `string` | No | Causal attribution, same convention as `spawn_worker` |
| `causeSeq`     | `number` | No | Causal attribution, same convention as `spawn_worker` |

**Returns:** `string` -- the UUID of the newly spawned worker (same contract as `spawn_worker`). The attached session's `sessionKey`/`capabilities`/model arrive via the `agent_session_started` event, not this return value.

**Errors:**

| Error | Condition |
|-------|-----------|
| Same as `spawn_worker` | The PTY worker spawn itself fails (registry full, worktree creation failed, etc.) |
| `Unknown Provider: ...` / `Provider Not Yet Supported: ...` | `provider` is not `"claude_code"` |
| The agent adapter's own error, verbatim | The Claude Code session failed to attach (binary missing, `system/init` timeout, ...) -- **the PTY worker still exists and is usable as a plain terminal** in this case; this is not rolled back |

**Emits:** `worker_spawned` (+ `worktree_created` if isolated) from the underlying `do_spawn_worker` call, then `agent_session_started` once the adapter's `spawn()` resolves.

---

### `agent_send_turn`

Phase 3. Enqueues one turn for `workerId`'s attached agent session through the `AgentScheduler` (concurrency-gated across every session's turns -- see `docs/architecture.md`'s adapter-layer section). **Fire-and-forget by design:** resolves once the turn is admitted to the scheduler, not once it completes or even starts. The frontend transcript (`AgentChat.tsx`) renders from the live `agent_*` event stream (`agent_block`/`agent_tool_call`/`agent_tool_result`/`agent_turn_settled`, all carrying `workerId`), not from this call's return value -- there is no synchronous `turnId` handed back the way `spawn_worker` hands back a worker id.

**Parameters:**

| Name       | Type     | Required | Description |
|------------|----------|----------|--------------|
| `workerId` | `string` | Yes      | UUID of the worker whose attached session should receive this turn |
| `prompt`   | `string` | Yes      | The turn's prompt text |

**Returns:** `void`.

**Errors:**

| Error | Condition |
|-------|-----------|
| Invalid UUID | `workerId` is not a valid UUID string |
| `AppError::QueueFull` | The scheduler's bounded admission queue (256) is full |

A session already mid-turn does **not** surface as an error here -- the underlying `send_turn` rejects with `AgentSessionBusy` inside the scheduler's executor, logged server-side, not propagated to this IPC call (a session never queues internally; see the `AgentSession` concurrency contract in `docs/architecture.md`).

---

### `agent_cancel`

Phase 3. Cancels `workerId`'s in-flight turn. `turnId` comes from that turn's own `agent_block`/`agent_tool_call` events' `turnId` field. `ClaudeCodeAdapter`'s `cancel_granularity` is `KillOnly` -- this kills the whole child process (43ms measured in the Phase 1 spike), then synthesizes the terminal receipt (Condition B). A stale or already-settled `turnId` is a benign no-op.

**Parameters:**

| Name       | Type     | Required | Description |
|------------|----------|----------|--------------|
| `workerId` | `string` | Yes      | UUID of the worker whose session should cancel |
| `turnId`   | `string` | Yes      | The turn to cancel |

**Returns:** `void`.

**Errors:** Invalid UUID, or no attached agent session for `workerId`.

**Emits:** `agent_turn_settled` (`status: "error"`, `error: "Process Exited Without A Receipt"`) + `agent_session_exited`, if `turnId` was genuinely in flight.

---

### `agent_shutdown`

Phase 3. Shuts down `workerId`'s attached agent session (idempotent) and removes it from the registry. Does **not** kill the underlying PTY worker -- see [`kill_worker`](#kill_worker), which also tears down any attached agent session as part of its own cleanup. A worker with no attached session is a benign no-op, not an error.

**Parameters:**

| Name       | Type     | Required | Description |
|------------|----------|----------|--------------|
| `workerId` | `string` | Yes      | UUID of the worker whose session should shut down |

**Returns:** `void`.

**Errors:** Invalid UUID only.

**Emits:** `agent_session_exited` (and a synthesized `agent_turn_settled` if a turn was in flight).

---

### `agent_probe`

Phase 3. Checks whether the Claude Code CLI is installed and responds to `--version`, bounded by a 5-second timeout -- never a hang. Never touches or reports a credential.

**Parameters:** none.

**Returns:** `ProbeReport`:

```typescript
{ available: boolean; version?: string | null; detail?: string | null }
```

An unusable provider is reported as `{ available: false, detail: "..." }`, never an `Err` -- `detail` is always human-readable (e.g. `"Claude Code CLI Not Found On PATH: ..."`), never a credential or raw auth error. `detail` is also `Some("Signed-In State Unknown Until First Spawn")` on a successful probe -- this command never makes a network call, so "authenticated or not" is only actually observable at the first real spawn.

**Errors:** This command itself never fails (see above) -- the `Result` wrapper exists only for Tauri's IPC error-transport convention.

---

## File System Commands

Real Rust commands for the `read_file`/`write_file` AI tools (`src/lib/tools.ts`) -- previously (Phase 0) both tools ran over `tauri-plugin-fs`'s capability-scoped helpers (`src/lib/fs.ts`) because these commands didn't exist yet. Path validation mirrors the same scopes the plugin-fs capability config (`src-tauri/capabilities/default.json`) declares -- reads permitted under `$APPDATA/**` and `$HOME/**`, writes permitted under `$APPDATA/**` and `$HOME/.swarm/**` -- enforced by hand in `commands/fs.rs::FsScopes` (that capability scope doesn't apply here; these are plain custom commands, not plugin-fs calls), with the identical truthful, Title Case error wording as the plugin-fs path. `src/lib/fs.ts` and its other (non-tool) UI consumers are unaffected by this migration.

### `read_file`

Reads a file at an absolute path.

**Parameters:**

| Name   | Type     | Required | Description             |
|--------|----------|----------|---------------------------|
| `path` | `string` | Yes      | Absolute path to read   |

**Returns:** `string` -- the file's full text content.

**Errors:**

| Error                        | Condition                                    |
|-------------------------------|-----------------------------------------------|
| Read Requires An Absolute Path | `path` is not absolute                       |
| Read Access Is Limited To The App Data And Home Directories | `path` falls outside `$APPDATA/**`/`$HOME/**` |
| File Not Found                | The file does not exist                      |
| The Operating System Denied Access | The OS itself refused (in-scope path, OS-level permission error) |

**Example:**

```typescript
const content = await invoke<string>("read_file", { path: "/home/user/notes.txt" });
```

**Emits:** Nothing -- a read is not a causally interesting side effect.

---

### `write_file`

Writes a file at an absolute path, creating or overwriting it. Emits a stamped, persisted `file_written` event on success.

**Parameters:**

| Name           | Type     | Required | Description                        |
|----------------|----------|----------|-------------------------------------|
| `path`         | `string` | Yes      | Absolute path to write             |
| `content`      | `string` | Yes      | Text content to write              |
| `originWorker` | `string` | No       | UUID of the causer (e.g. the AI turn whose `write_file` tool call triggered this write). |
| `causeSeq`     | `number` | No       | `seq` this write is reacting to.   |

**Returns:** `void`

**Errors:**

| Error                         | Condition                                    |
|--------------------------------|-----------------------------------------------|
| Write Requires An Absolute Path | `path` is not absolute                       |
| Write Access Is Limited To The App Data And .swarm Directories | `path` falls outside `$APPDATA/**`/`$HOME/.swarm/**` |
| Invalid UUID                   | `originWorker` is present but not a valid UUID |
| Cannot Write ... Parent Directory Does Not Exist | The parent directory doesn't exist |
| The Operating System Denied Access | The OS itself refused the write             |

**Example:**

```typescript
await invoke("write_file", {
  path: "/home/user/.swarm/notes.txt",
  content: "Hello, SWARM.",
  originWorker: callingWorkerId,
  causeSeq: turnSeq,
});
```

**Emits:** `file_written` envelope on `swarm://events` with payload `{ path, bytes }`, carrying `originWorker`/`causeSeq` when given.

---

## Metrics Commands

### `get_metrics`

Returns a snapshot of the current aggregate worker metrics.

**Parameters:** None

**Returns:** JSON object combining system, aggregate worker, and per-worker metrics.

| Field          | Type            | Description                              |
|----------------|-----------------|-------------------------------------------|
| `cpuPercent`   | `number`        | Global CPU usage percentage, via `sysinfo` |
| `memoryMb`     | `number`        | Used system memory in megabytes, via `sysinfo` |
| `totalWorkers` | `number`        | Total registered workers                 |
| `running`      | `number`        | Workers in `running` state               |
| `paused`       | `number`        | Workers in `paused` state                |
| `idle`         | `number`        | Workers in `idle` state                  |
| `errored`      | `number`        | Workers in `error` state                 |
| `perWorker`    | `PerWorkerMetric[]` | Per-worker process metrics (see below) |

**`PerWorkerMetric` object:**

| Field         | Type             | Description                                         |
|---------------|------------------|------------------------------------------------------|
| `workerId`    | `string` (UUID)  | UUID of the worker                                  |
| `pid`         | `number \| null` | OS process ID, if the worker has one                |
| `cpuPercent`  | `number`         | Process-level CPU usage percentage (`0` if no PID or process not found) |
| `memoryBytes` | `number`         | Process-level resident memory in bytes (`0` if no PID or process not found) |

**Example:**

```typescript
const metrics = await invoke("get_metrics");
console.log(`${metrics.running}/${metrics.totalWorkers} workers running`);
for (const w of metrics.perWorker) {
  console.log(`${w.workerId}: ${w.cpuPercent.toFixed(1)}% CPU, ${w.memoryBytes} bytes`);
}
```

**Note:** This is the pull-based complement to the push-based `system_metrics` envelope (emitted every 500ms on `swarm://events`; ephemeral -- consumes a seq but is never persisted). Both `get_metrics` and the background loop read from the same `SharedSystem` (managed state wrapping one `sysinfo::System` behind a `parking_lot::Mutex`), so CPU usage deltas are computed from a single source of truth instead of two independently-refreshing `System` instances.

---

## Bus Commands

> **Built, not wired.** No shipped UI surface calls any of the five commands below -- see [Built, Not Wired](#built-not-wired). They are fully implemented and tested; inter-agent messaging just is not exposed to a user in the app today.

The message bus enables direct, broadcast, and pipeline-routed communication between workers. It is composed of a `MessageBus` (per-topic `tokio::sync::broadcast` channels) and a `Router` (direct/broadcast send + pipeline orchestration), both held as Tauri managed state.

### `bus_send`

Sends a message from one worker to another (or broadcasts it) on a topic.

**Parameters:**

| Name           | Type                | Required | Description                                          |
|----------------|---------------------|----------|--------------------------------------------------------|
| `fromWorkerId` | `string`            | Yes      | UUID of the sending worker                              |
| `toWorkerId`   | `string \| null`    | No       | UUID of the target worker. Omit/`null` to broadcast     |
| `topic`        | `string`            | Yes      | Topic channel to send on                                |
| `payload`      | `unknown` (JSON)    | Yes      | Arbitrary JSON payload                                  |

**Returns:** `number` -- the count of receivers that received the message. `0` means no [`bus_subscribe`](#bus_subscribe) caller is currently listening on this topic.

**Errors:**

| Error         | Condition                                    |
|---------------|------------------------------------------------|
| Invalid UUID  | `fromWorkerId` or `toWorkerId` is not a valid UUID |

**Example:**

```typescript
const receiverCount = await invoke("bus_send", {
  fromWorkerId: workerA,
  toWorkerId: workerB, // omit for broadcast
  topic: "task:result",
  payload: { status: "done", output: "..." },
});
```

**Important:** `bus_send` only publishes to the internal bus -- it does **not** emit a frontend event itself. Delivery to the frontend happens exclusively via [`bus_subscribe`](#bus_subscribe)'s forwarding task (see [Unified Bus Event Contract](#unified-bus-event-contract) below).

---

### `bus_subscribe`

Subscribes to a topic and streams matching messages to the frontend as `bus_message` envelopes on `swarm://events`.

**Parameters:**

| Name    | Type     | Required | Description         |
|---------|----------|----------|----------------------|
| `topic` | `string` | Yes      | Topic to subscribe to |

**Returns:** `void` -- resolves once the background forwarding task is spawned; messages arrive later as events.

**Errors:**

| Error              | Condition                          |
|--------------------|--------------------------------------|
| Subscription failed | Failed to create/attach to the broadcast channel |

**Example:**

```typescript
import { onEvent } from "#lib/event-bus";

await invoke("bus_subscribe", { topic: "task:result" });

const off = onEvent("bus_message", (e) => {
  const { messageId, fromWorker, toWorker, topic, payload } = e.payload as {
    messageId: string;
    fromWorker: string;
    toWorker: string | null;
    topic: string;
    payload: unknown;
  };
  console.log(`[${topic}] ${fromWorker} -> ${toWorker ?? "*"}:`, payload);
});
```

**Emits:** `bus_message` envelope on `swarm://events` with payload `{ messageId, fromWorker, toWorker, topic, payload }` for every message received on the subscribed topic, for the lifetime of the subscription task. The envelope's `originWorker` is stamped from `fromWorker` -- real attribution for every bus message with no extra plumbing on the sending side (`causeSeq` stays absent; the sender would need to thread its own turn's seq through `bus_send` to populate that, deferred to v2).

---

### `bus_create_pipeline`

Creates a new multi-stage message processing pipeline. Each stage names a worker and an optional jq-like dot-notation transform (e.g., `".result"`, `".data.items"`) applied to the payload before it is forwarded to the next stage.

**Parameters:**

| Name     | Type              | Required | Description                              |
|----------|-------------------|----------|--------------------------------------------|
| `stages` | `PipelineStage[]` | Yes      | Ordered list of pipeline stages            |

**`PipelineStage` object:**

| Field       | Type              | Description                                            |
|-------------|-------------------|-----------------------------------------------------------|
| `workerId`  | `string` (UUID)   | Worker that processes this stage                          |
| `transform` | `string \| null`  | Optional dot-notation field selector applied to the payload |

**Returns:** `string` -- UUID of the newly created pipeline.

**Example:**

```typescript
const pipelineId = await invoke("bus_create_pipeline", {
  stages: [
    { workerId: workerA, transform: null },
    { workerId: workerB, transform: ".result" },
  ],
});
```

---

### `bus_list_channels`

Lists all active message bus topic channels.

**Parameters:** None

**Returns:** `string[]`

**Example:**

```typescript
const topics = await invoke("bus_list_channels");
```

---

### `bus_list_pipelines`

Lists all registered pipelines.

**Parameters:** None

**Returns:** `PipelineInfo[]`

**`PipelineInfo` object:**

| Field        | Type             | Description                        |
|--------------|------------------|--------------------------------------|
| `id`         | `string` (UUID)  | Pipeline identifier                  |
| `stageCount` | `number`         | Number of stages in the pipeline     |
| `workerIds`  | `string[]`       | Worker IDs in pipeline order         |

**Example:**

```typescript
const pipelines = await invoke("bus_list_pipelines");
```

---

## Updater Commands

### `check_for_updates`

Checks the configured update endpoint (`tauri-plugin-updater`) for an available application update.

**Parameters:** None (the `AppHandle` is injected automatically)

**Returns:** JSON object:

| Field       | Type                | Description                                  |
|-------------|---------------------|------------------------------------------------|
| `available` | `boolean`           | Whether an update is available                 |
| `version`   | `string` (optional) | Version of the available update, if any        |
| `body`      | `string` (optional) | Release notes, if any                          |
| `date`      | `string` (optional) | Release date, if any                           |

**Errors:**

| Error              | Condition                                    |
|--------------------|-------------------------------------------------|
| Update check failed | The updater plugin could not reach the update endpoint (e.g., network error) |

**Example:**

```typescript
const update = await invoke("check_for_updates");
if (update.available) {
  console.log(`Update ${update.version} available:`, update.body);
}
```

Updates are signed with an Ed25519 keypair; see [`src-tauri/UPDATER_KEYS.md`](../src-tauri/UPDATER_KEYS.md) for key setup and the `plugins.updater.pubkey` value configured in `tauri.conf.json`.

---

## Notification Commands

### `send_notification`

Sends a native OS notification via `tauri-plugin-notification`.

**Parameters:**

| Name    | Type              | Required | Description                        |
|---------|-------------------|----------|--------------------------------------|
| `title` | `string`          | Yes      | Notification title                   |
| `body`  | `string`          | Yes      | Notification body text               |
| `icon`  | `string \| null`  | No       | Optional path to a notification icon |

**Returns:** `void`

**Errors:**

| Error                | Condition                                  |
|----------------------|-----------------------------------------------|
| Notification failed  | The OS notification failed to display          |

**Example:**

```typescript
await invoke("send_notification", {
  title: "Worker finished",
  body: "Research Agent completed its task.",
  icon: null,
});
```

---

## Events

Every backend event -- worker lifecycle, session lifecycle, AI streaming, metrics, logs, bus messages -- travels on a **single** Tauri channel, `swarm://events`, as a seq-ordered envelope. There are no per-domain channels; `listen()` against anything else is not part of the contract.

### The Envelope

```json
{ "seq": 42, "ts": 1752099600123, "type": "worker_spawned", "payload": { "workerId": "...", "name": "...", "pid": 1234 } }
```

A stamped envelope additionally carries `originWorker`/`causeSeq`:

```json
{ "seq": 57, "ts": 1752099601000, "originWorker": "b2c3...", "causeSeq": 55, "type": "worker_spawned", "payload": { "workerId": "a1b2...", "name": "Sub-Agent", "pid": 5678 } }
```

| Field          | Type                | Description                                                          |
|----------------|---------------------|------------------------------------------------------------------------|
| `seq`          | `number`            | Monotonic sequence number assigned by the single-writer engine. Wire order == seq order; never reused, never reordered. |
| `ts`           | `number`            | Unix timestamp in milliseconds, assigned by the writer thread.        |
| `originWorker` | `string` (optional) | UUID of the worker whose action **caused** this event, when known. Absent (not `null`) when unattributed -- present only when the engine was given an explicit causer to record. |
| `causeSeq`     | `number` (optional) | `seq` of the event this one is causally reacting to, when known. Typically an `agent_turn_started` seq. |
| `type`         | `string`            | Event type tag, `snake_case` (e.g. `"worker_spawned"`).               |
| `payload`      | `object`            | The event's data, `camelCase` fields -- shape depends on `type`.       |

`seq` is assigned by one dedicated writer thread (the `OrchestrationEngine`) that every backend call routes through via `EventSink`, so there is a single, total order across every event type -- a `worker_spawned` and a `session_created` racing in the backend still land on the wire (and in the log) in a well-defined, non-interleaved order.

**The subject-vs-causer rule:** a payload's own `workerId` field is the **SUBJECT** of the event -- whose worker spawned, whose PTY got input, whose file was written. `originWorker` on the envelope is the **CAUSER** -- who made it happen. For a human-driven action (clicking Spawn on the Workers page, typing into a terminal) the two are typically unrelated or `originWorker` is simply absent; for a tool-driven action (an AI turn's `spawn_worker`/`kill_worker`/`worker_input`/`write_file` tool call) `originWorker` is the panel worker whose turn issued the call, while the payload's `workerId` is the worker that got spawned/killed/written-to -- **and that difference is the causal edge** the provenance graph is built from. The engine records this attribution; it never infers it (see `EventSink::emit_with`'s invariant doc in `src-tauri/crates/swarm-core/src/events/emitter.rs`) -- there is no "the last AI turn probably caused this" heuristic anywhere in this codebase.

### Type Tags

| Type                  | Payload                                                        | Persisted |
|-----------------------|-----------------------------------------------------------------|-----------|
| `worker_spawned`      | `{ workerId, name, pid, isolation }`                             | Yes       |
| `worker_killed`       | `{ workerId }`                                                   | Yes       |
| `worker_output`       | `{ workerId, data }`                                             | No (ephemeral) |
| `worker_state`        | `{ workerId, state }`                                            | Yes       |
| `worker_input`        | `{ workerId, bytes, source, preview? }` -- `source` is `"terminal"`, `"tool"`, or `"automation"`; `preview` (first ~120 chars, control-stripped) is present only for `source ∈ {tool, automation}` -- see [Persistence Policy](#persistence-policy) | Only when `source != "terminal"` |
| `session_created`     | `{ sessionId, name }`                                            | Yes       |
| `session_deleted`     | `{ sessionId }`                                                  | Yes       |
| `system_metrics`      | `{ cpuPercent, memoryMb, workerCount, aiReqPerSec, timestamp }`  | No (ephemeral) |
| `ai_stream_delta`     | `{ requestId, delta, done }` -- webview-path SwarmEvent variant, kept (unused) after `ai_request`'s Phase 2 removal; retired alongside the webview path itself in Phase 5 | Yes |
| `ai_stream_settled`   | `{ requestId, status, error }` -- terminal receipt, exactly once per request; same kept-but-unused status as above | Yes |
| `agent_turn_started`  | `{ workerId, model, requestId }` -- the causal root a turn's tool-driven side effects cite as `causeSeq` (see [`agent_turn_started`](#agent_turn_started)) | Yes |
| `agent_session_started` | `{ workerId, provider, sessionKey, model, cwd, capabilities }` -- emitted once a Phase 3+ provider adapter's session starts; `capabilities` mirrors `Capabilities` (see `docs/architecture.md`'s adapter-layer section) | Yes |
| `agent_turn_delta`    | `{ workerId, turnId, blockIndex, kind, text }` -- one streamed sub-message chunk within a turn | **No (ephemeral)** |
| `agent_block`         | `{ workerId, turnId, blockIndex, kind, content }` -- durable counterpart to `agent_turn_delta`; replay reconstructs full turns from these rows, only the typing animation is lost | Yes |
| `agent_tool_call`     | `{ workerId, turnId, toolUseId, name, input }`                   | Yes |
| `agent_tool_result`   | `{ workerId, turnId, toolUseId, isError, content }` -- `toolUseId` correlates with the originating `agent_tool_call` | Yes |
| `agent_permission_request` | `{ workerId, turnId, requestId, tool, input, suggestedDecision?, denialSubclass?, message? }` -- the ONLY legitimate permission-gating surface; never `allowedTools` (Condition C). **For `ClaudeCodeAdapter` (Phase 3), this is a REPORT of an already-decided denial, not a pending request** -- `suggestedDecision` is always `"deny"`, `denialSubclass` is one of `"mode"` / `"ungranted_write"` / `"redirection_guard"`, and `message` is the provider's raw denial text. See `docs/architecture.md`'s adapter-layer section for the semantics shift. | Yes |
| `agent_turn_settled`  | `{ workerId, turnId, status, error, costUsd, usage, durationMs, numTurns }` -- terminal receipt, exactly once per turn, synthesized on ungraceful child exit too (Condition B) | Yes |
| `agent_session_exited` | `{ workerId, exitCode, signal }`                                | Yes |
| `system_log`          | `{ level, message, target, timestamp }`                          | No (ephemeral) |
| `bus_message`         | `{ messageId, fromWorker, toWorker, topic, payload }` -- `originWorker` on the envelope is stamped from `fromWorker` for every message, free (no extra caller plumbing) | Yes |
| `worktree_created`    | `{ workerId, sessionId, repoRoot, worktreePath, branch, baseCommit }` -- its own `seq` is the range start for "what changed" queries | Yes |
| `worktree_removed`    | `{ workerId, worktreePath, branch, disposition, headCommit, reason }` -- `disposition` is `"removed"`, `"preserved_dirty"`, or `"failed"` | Yes |
| `ship_progress`       | `{ shipId, workerId, step, status, detail }` -- `step` is free-form (`"staging"`, `"commit"`, `"push"`, `"compare"`); `status` is `"running"`, `"ok"`, or `"error"` | Yes |
| `ship_settled`        | `{ shipId, workerId, commitSha, pushedRef, prUrl, status, error }` -- terminal receipt, exactly once per `shipId`; `error` is a `ShipError` object when `status == "error"` | Yes |
| `commit_created`      | `{ workerId, sha, branch, seqFrom, seqTo }` -- mirrors the commit's own `Swarm-Seq-Range` trailer | Yes |
| `file_written`        | `{ path, bytes }` -- emitted by [`write_file`](#write_file) only; a read is not a causally interesting side effect and emits nothing | Yes |

### Unified Bus Event Contract

`bus_message` envelopes are delivered through exactly one path: the background task spawned by [`bus_subscribe`](#bus_subscribe). `bus_send` never emits directly. This guarantees each message reaches the frontend **at most once**, in one consistent shape, regardless of how many (if any) `bus_subscribe` calls are active for a topic -- there is no double-delivery and no risk of the emit-on-send and emit-on-subscribe paths drifting out of sync.

### Persistence Policy

`worker_output`, `system_metrics`, and `system_log` are high-frequency telemetry: they still flow through the ordered stream and each consumes a `seq`, but they are **never written to the log**. They cannot be backfilled after a gap and will not appear in [`events_since`](#events_since) -- treat them as best-effort, live-only.

**`worker_input` has a field-level carve-out on top of the variant-level rule above:** `source == "terminal"` rows (raw human keystrokes) are also excluded from persistence, even though the `worker_input` type itself persists for `source ∈ {tool, automation}`. A per-keystroke durable row would both flood the log and archive whatever the user typed into a shell -- including secrets -- so terminal input is deliberately ephemeral: it reaches the wire (and consumes a `seq`) but is never written to `swarm-events.db`.

Every other type persists to the SQLite event log (`<app-data>/swarm-events.db`, WAL mode) before being emitted, so it survives a gap or a restart and can be replayed via `events_since`. Persisted rows carry `originWorker`/`causeSeq` columns (`origin_worker TEXT`, `cause_seq INTEGER`, both nullable) added via a `PRAGMA user_version` migration ladder -- rows written before this migration have both columns `NULL`, the truthful historical value, not a fabricated `None`.

### Receipts

Some request/response flows use a dedicated terminal event (a "receipt") instead of a boolean flag buried in a stream event, so callers have one unambiguous signal to await:

- **`ai_stream_settled`** -- the webview-path receipt; `ai_request` (the only command that ever emitted it) was removed in Phase 2 -- see [Agent Commands](#agent-commands). Kept as a `SwarmEvent` variant (unused) until the webview path itself is retired in Phase 5; see [Built, Not Wired](#built-not-wired).
- **`agent_turn_settled`** -- the provider-adapter receipt Phase 3's adapters emit in its place: exactly once per turn, on success AND on ungraceful child exit (Condition B, `docs/architecture.md`'s adapter-layer section) -- a caller mid-turn when the provider process is killed still gets a terminal event, with `costUsd`/`usage` honestly `None` rather than fabricated.
- **`ship_settled`** -- emitted exactly once per `shipId`, after the last `ship_progress` row, on both success and failure. `src/hooks/useShip.ts`'s state machine awaits this from `git_push`/`ship_compare_url` (the two commands that can be a chosen action's true final step), registering its `waitFor` listener *before* triggering the call that might emit it -- event delivery and the IPC response are two independent transport paths with no ordering guarantee between them, so the listener must already be armed when the event fires.

The frontend's `waitFor(predicate, timeoutMs?)` (in `src/lib/event-bus.ts`) is the general consumption primitive for receipts: it resolves the first envelope matching `predicate`, or rejects on timeout (default 5000ms).

### `events_since`

```typescript
const events = await invoke("events_since", { afterSeq: 100 });
```

Returns **persisted** envelopes with `seq > afterSeq`, ascending, capped at 5000 rows per call by default. Used by the frontend to backfill after a detected sequence gap (see `src/lib/event-bus.ts`'s gap-detection in `connectEventBus`) and as the foundation for replay. Ephemeral types (`worker_output`, `system_metrics`, `system_log`, and `worker_input` rows with `source == "terminal"`) never appear in the result, by construction.

**`limit`** (optional `number`, default and max 5000): caps the page size. A caller-supplied value above 5000 is silently clamped, not rejected. Exists primarily for a future causality inspector's single-row backward hops (`events_since({ afterSeq: causeSeq - 1, limit: 1 })`) rather than the bulk backfill path above, which always wants the largest page it can get.

```typescript
// A single-row backward hop
const [priorEvent] = await invoke("events_since", { afterSeq: causeSeq - 1, limit: 1 });
```

Callers page by re-invoking with the last-seen `seq` as the new `afterSeq` while a full (5000-row) page keeps coming back:

```typescript
let cursor = afterSeq;
for (;;) {
  const page = await invoke<DomainEvent[]>("events_since", { afterSeq: cursor });
  for (const e of page) handle(e);
  if (page.length < 5000) break;
  cursor = page[page.length - 1].seq;
}
```

### Subscribing

Application code does not call `listen()` directly -- it goes through `src/lib/event-bus.ts`, which validates every envelope with zod, tracks `lastSeq`, triggers `events_since` backfill on a detected gap (buffering live events that arrive mid-backfill and flushing them seq-sorted afterward), and exposes:

```typescript
import { connectEventBus, onEvent, waitFor } from "#lib/event-bus";

// Once, at app bootstrap:
await connectEventBus();

// Worker output (high frequency -- PTY data)
onEvent("worker_output", (e) => {
  const { workerId, data } = e.payload as { workerId: string; data: string };
  terminal.write(data);
});

// System metrics (every 500ms)
onEvent("system_metrics", (e) => {
  const { cpuPercent, memoryMb, workerCount, timestamp } = e.payload as {
    cpuPercent: number;
    memoryMb: number;
    workerCount: number;
    timestamp: number;
  };
  updateMetricsChart({ cpuPercent, memoryMb, workerCount, timestamp });
});

// Bus messages (requires an active bus_subscribe call for the topic)
await invoke("bus_subscribe", { topic: "task:result" });
onEvent("bus_message", (e) => {
  const { topic, payload } = e.payload as { topic: string; payload: unknown };
  console.log(`[${topic}]`, payload);
});

// A receipt: await a specific ship_settled instead of polling
const settled = await waitFor((e) => e.type === "ship_settled");
```

---

## Wire Protocol (swarmd)

Everything above describes the Tauri IPC transport (`invoke`/`listen` over `@tauri-apps/api`). `swarmd`, the headless daemon, exposes the SAME command surface (every command in this document except [Updater Commands](#updater-commands) and [Notification Commands](#notification-commands) -- `swarm_core::commands::NATIVE_ONLY`) and the SAME `swarm://events` envelope shape, over one authenticated WebSocket at `/ws` instead. Frame types are defined once, serde-only, in `swarm_core::protocol` (`src-tauri/crates/swarm-core/src/protocol.rs`); the browser-side client is `src/lib/transport.ts`'s `wsTransport`.

### Connecting

```text
1. Open a WebSocket to  ws://<host>:<port>/ws  (wss:// if the page is https://)
2. Send  hello  as the FIRST frame, within 5 seconds, or the server closes the socket
3. Receive  ready  (handshake ack)
4. If hello.lastSeq was non-null: receive zero or more  event  frames (replay), then  replayEnd
   If hello.lastSeq was null (cold attach): receive  replayEnd  immediately, no replay
5. Live: event frames continue arriving; send  rpc  at any time, receive matching  rpcResult
```

Reconnects are just a new socket, from step 1 -- the client's own gap-detection (`event-bus.ts`) treats every reattach identically to the original connection.

### Frames

Every frame is one JSON text WebSocket message. Five carry a `"frame"` tag; the sixth (`event`) is deliberately BARE:

| Frame | Direction | Wrapped? | Shape |
|-------|-----------|----------|-------|
| `hello` | client -> server | `{"frame":"hello", ...}` | `{ lastSeq: number \| null, token?: string }` |
| `ready` | server -> client | `{"frame":"ready", ...}` | `{ serverSeq: number, version: number, caps: { maxFrameBytes, maxConnections, replayPageSize } }` |
| `event` | server -> client | **bare** -- no `"frame"` key | The exact `DomainEvent` envelope shape from [Events](#events) (`{ seq, ts, originWorker?, causeSeq?, type, payload }`) |
| `replayEnd` | server -> client | `{"frame":"replayEnd", ...}` | `{ seq: number }` -- the replay burst (possibly empty) for THIS hello is over |
| `rpc` | client -> server | `{"frame":"rpc", ...}` | `{ id: string, cmd: string, args: object }` -- `cmd` is any command name from this document (minus the two NATIVE_ONLY ones) |
| `rpcResult` | server -> client | `{"frame":"rpcResult", ...}` | `{ id: string, ok: boolean, result?: unknown, error?: unknown }` -- correlated to the `rpc` frame by `id`; exactly one of `result`/`error` is present |

A receiver distinguishes an `event` frame from every control frame by the ABSENCE of a `"frame"` key -- a `DomainEvent` never has one, and every control frame always does. This is the exact demux `wsTransport`'s `message` handler performs.

### Auth

`hello.token` (or an `Authorization: Bearer <token>` header at the HTTP-upgrade request, checked before the WS handshake even starts) must match the daemon's 256-bit token, constant-time compared. The token is minted once per data directory (`getrandom`, hex-encoded) and persists at `<data_dir>/daemon-token` across restarts. The daemon prints its connect URL at startup with the token ONLY in the fragment:

```text
SWARM Daemon Listening On http://127.0.0.1:8787/#t=<token>
```

The browser client reads the fragment on first load, persists it to `sessionStorage`, and scrubs it from the URL immediately (`history.replaceState`) -- it never survives as part of a bookmarkable, shareable, or screenshot-visible URL, and (being a fragment, not a query param) is never sent to the server or logged by an intermediary proxy.

`Host` (always) and `Origin` (when present) are validated against the daemon's own bind address on every WS upgrade -- WebSocket upgrades are exempt from CORS, so without this a malicious web page open in the same browser could reach a localhost daemon, and DNS rebinding could reach it from off-box.

`read_config` denies any secret-shaped key (`anthropic_api_key`, or any key ending `_key`/`_token`/`_secret`) at this layer, before the request ever reaches the shared command registry -- see `docs/architecture.md`'s [Runtime Modes](architecture.md#runtime-modes) section. This is one instance of a broader per-command policy: every registry entry declares a `RemotePolicy` (`Allowed`/`Denied`/`SecretFiltered`), and `swarmd`'s `rpc` handler dispatches every command through `Registry::dispatch_remote`, which consults it -- `read_file`/`write_file` are `Denied` outright (arbitrary daemon-host filesystem access is never on the MVP remote surface), `read_config`/`write_config` are `SecretFiltered` as above, and everything else defaults to `Allowed`. See `docs/architecture.md`'s [Runtime Modes](architecture.md#runtime-modes) section for the full policy table and the contract test that pins it.

**The trust boundary this does NOT close:** an authenticated remote client gets arbitrary command execution on the daemon's host. [`spawn_worker`](#spawn_worker) takes `shell`/`env`/`cwd` and starts a real process; [`worker_input`](#worker_input) writes raw bytes to that process's stdin. This is not an oversight -- running commands on the host IS the product (a worker is a PTY-backed shell the whole point of SWARM is to drive remotely). The token is the ONLY thing standing between "an authenticated SWARM user" and "root on this machine, effectively, as this user" -- treat it exactly like an SSH private key: never commit it, never paste it into a chat, and assume anyone who has it can do anything the `$USER` running `swarmd` can do. `RemotePolicy` narrows WHICH commands are reachable at all (no filesystem browsing, no secret-key access) but does not, and cannot, sandbox what an *allowed* command can do once invoked.

### Replay and backpressure

`lastSeq` in `hello` resumes exactly where a disconnected client left off: the server pages `events_since(lastSeq, 5000)` (same pagination as the [`events_since`](#events_since) command) until a short page arrives, sending each row as an `event` frame, then sends `replayEnd`. `lastSeq: null` is a cold attach -- no replay at all; the client hydrates via the normal snapshot commands (`list_workers`, `list_sessions`, etc.), exactly like a fresh Tauri app launch.

`ready`, `replayEnd`, and every `event` frame (replayed or live) share ONE bounded (4096), FIFO channel per connection -- this is what guarantees wire order matches seq order; an earlier design split these across separate lanes and could let a live event race a replay page across a `biased select!`, delivering frames out of seq order. Persistent frames (everything durable) always enqueue onto this one lane, blocking the CONNECTION (never the engine) if it's momentarily full. Ephemeral frames (`worker_output`, `system_metrics`, `system_log`, `agent_turn_delta`, terminal-source `worker_input`) are dropped newest-first once the lane's occupied length reaches a watermark well below its full capacity, so an ephemeral flood can never starve a persistent frame's blocking send -- but anything that DOES get enqueued keeps its FIFO position, so wire order among delivered frames is always seq order. A slow link degrades to a choppy terminal and sparse metrics, never a stale or wrong application state.

`rpcResult` frames (no seq, no ordering relationship to the event stream) ride a separate bounded (256) control lane. Concurrently in-flight `rpc` tasks are capped per connection (8) -- above the cap, a new `rpc` frame gets an immediate typed busy `rpcResult` rather than spawning an unbounded number of handler tasks; the client-side `wsTransport.invoke` additionally gives every outstanding `rpc` a 30-second timeout, rejecting with a typed error if no `rpcResult` ever arrives (a dropped busy response, a wedged connection, etc. fail loud instead of hanging forever).

A connection that falls behind the server's broadcast fanout (`tokio::sync::broadcast`'s own bounded capacity) sees `RecvError::Lagged` internally -- the server heals this by re-running the identical `events_since` paging routine from its own last-sent cursor, transparently to the client (no special "lag" frame exists; it looks like an ordinary, possibly-larger replay burst). Healing is repeatable: a connection that lags again after healing simply heals again, with no wedged state.

---

## Built, Not Wired

This reference document also covers commands and events that are fully implemented and tested in Rust, but have no frontend caller in the shipped app today. They are not stubs -- they are the backend half of a feature that has not been connected to the frontend yet, built ahead of the multi-provider agent-execution rework that is expected to route AI traffic (and possibly agent-to-agent bus traffic) through Rust instead of the webview.

| Piece | No caller because... |
|-------|------------------------|
| `ai_request` | **Removed** (Phase 2 of the multi-provider plan) -- absorbed into the agent scheduler. The shipped AI flow runs `@anthropic-ai/sdk` directly in the webview (`src/lib/anthropic.ts`, `dangerouslyAllowBrowser: true`) and streams straight to `api.anthropic.com`; it never invoked this command, and its tested queueing machinery now lives as `swarm_core::agent::scheduler::AgentScheduler`. See [Agent Commands](#agent-commands) and `docs/architecture.md`'s adapter-layer section. |
| `agent_*` (Phase 3+ family) | **No longer built-not-wired for Claude Code** -- [`agent_spawn`](#agent_spawn)/[`agent_send_turn`](#agent_send_turn)/etc. emit the full family, consumed by `useAgentSessionEvents` + `AgentChat.tsx` as of Phase 3. Still true for Codex/OpenCode/Gemini -- the `AgentAdapter`/`AgentSession` traits are provider-agnostic and tested via `MockAdapter`, but only `ClaudeCodeAdapter` exists. See `docs/architecture.md`'s adapter-layer section. |
| [`bus_send`](#bus_send), [`bus_subscribe`](#bus_subscribe), [`bus_create_pipeline`](#bus_create_pipeline), [`bus_list_channels`](#bus_list_channels), [`bus_list_pipelines`](#bus_list_pipelines) | No UI surface invokes any of them -- inter-agent messaging is implemented but not exposed to a user today. |
| The `ai_stream_settled` receipt | Downstream of the removed `ai_request` -- kept as a `SwarmEvent` variant (unused) until the webview path is retired in Phase 5; never emitted in the app as shipped. |
| The interactive `agent_permission_request` -> `respond_permission` round-trip | `ClaudeCodeSession::respond_permission` is a documented no-op (`Ok(())` always) -- `--permission-mode manual` is a silent no-op on the real CLI (verified empirically), so there is nothing on the provider side to answer. The event fires only as a post-hoc REPORT of an already-decided denial. See `docs/architecture.md`'s adapter-layer section. |
| The full spawn-dialog / polished `WorkerAIPanel` redesign | Phase 3 ships the minimal command surface + a basic provider picker only (see [`agent_spawn`](#agent_spawn) and `docs/architecture.md`'s adapter-layer section) -- the richer UI (auth-health dot, tool-call cards, permission timeline, capability-driven "Queue Next Turn" labeling) is an explicitly deferred follow-up branch. |

Read every code example and contract above involving these commands and events as documentation of what the Rust side does *if* called -- not necessarily as a description of what the shipped app's default (webview Anthropic) path does when a user sends a chat message; Claude Code workers ARE live via `agent_spawn` as of Phase 3.
