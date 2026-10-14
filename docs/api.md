# API Reference

> The command, event and wire-protocol contract of the SWARM Orchestrator backend: 38 commands, one ordered event stream, two transports.

The backend is one Rust library, `swarm-core`, behind two shells. Both expose the same command surface and the same event stream:

| Transport | Shell | Commands | Events |
|---|---|---|---|
| Tauri IPC | `swarm-desktop` (`src-tauri/`) | `invoke("command_name", { ...args })` from `@tauri-apps/api/core` | the single channel `swarm://events` |
| Authenticated WebSocket | `swarmd` (`crates/swarmd/`) | `rpc` frames on `/ws` | bare `event` frames on the same socket |

```typescript
import { invoke } from "@tauri-apps/api/core";
const result = await invoke("command_name", { arg1: value1 });
```

Application code never calls `invoke` or `listen` directly: `src/lib/transport.ts` picks the Tauri or the WebSocket transport at build time (`__SWARM_TRANSPORT__`), `src/lib/tauri.ts` holds the typed command wrappers, and `src/lib/event-bus.ts` is the only place that listens for events (application code subscribes through `onEvent()` and `waitFor()`). See [Events](#events) for the envelope contract and [Wire Protocol (swarmd)](#wire-protocol-swarmd) for the socket.

---

## Table of Contents

- [Command Surface](#command-surface)
  - [Conventions](#conventions)
  - [Index](#index)
  - [Who Can Call What](#who-can-call-what)
- [Worker Commands](#worker-commands)
  - [spawn_worker](#spawn_worker)
  - [pause_worker](#pause_worker)
  - [resume_worker](#resume_worker)
  - [kill_worker](#kill_worker)
  - [list_workers](#list_workers)
  - [worker_input](#worker_input)
  - [resize_worker](#resize_worker)
  - [set_max_workers](#set_max_workers)
  - [Worktree Isolation Lifecycle](#worktree-isolation-lifecycle)
  - [validate_repo_root](#validate_repo_root)
- [Ship Commands](#ship-commands)
  - [git_ship_preflight](#git_ship_preflight)
  - [git_stage_commit](#git_stage_commit)
  - [git_push](#git_push)
  - [ship_compare_url](#ship_compare_url)
  - [ship_context](#ship_context)
- [Session Commands](#session-commands)
  - [create_session](#create_session)
  - [delete_session](#delete_session)
  - [list_sessions](#list_sessions)
  - [get_session](#get_session)
  - [session_add_worker](#session_add_worker)
  - [session_remove_worker](#session_remove_worker)
- [Agent Commands](#agent-commands)
  - [agent_turn_started](#agent_turn_started)
  - [agent_spawn](#agent_spawn)
  - [agent_send_turn](#agent_send_turn)
  - [agent_cancel](#agent_cancel)
  - [agent_shutdown](#agent_shutdown)
  - [agent_probe](#agent_probe)
  - [agent_permission_respond](#agent_permission_respond)
  - [set_agent_concurrency](#set_agent_concurrency)
- [File System Commands](#file-system-commands)
  - [read_file](#read_file)
  - [write_file](#write_file)
- [Config Commands](#config-commands)
  - [read_config](#read_config)
  - [write_config](#write_config)
- [Metrics Commands](#metrics-commands)
  - [get_metrics](#get_metrics)
- [Bus Commands](#bus-commands)
  - [bus_send](#bus_send)
  - [bus_list_channels](#bus_list_channels)
- [Native Commands (Desktop Only)](#native-commands-desktop-only)
  - [check_for_updates](#check_for_updates)
  - [send_notification](#send_notification)
- [Events](#events)
  - [The Envelope](#the-envelope)
  - [Type Tags](#type-tags)
  - [Unified Bus Event Contract](#unified-bus-event-contract)
  - [Persistence Policy](#persistence-policy)
  - [Failing Closed](#failing-closed)
  - [Receipts](#receipts)
  - [events_since](#events_since)
  - [Subscribing](#subscribing)
- [Wire Protocol (swarmd)](#wire-protocol-swarmd)
  - [Connecting](#connecting)
  - [Frames](#frames)
  - [Auth](#auth)
  - [Limits](#limits)
  - [Replay and backpressure](#replay-and-backpressure)
- [Built, Not Wired](#built-not-wired)

---

## Command Surface

### Conventions

- **One table.** `swarm_core::commands::Registry` maps each command name to an `async fn(Ctx, serde_json::Value) -> Result<Value, Value>` and a `RemotePolicy`. It holds **36** commands. Two more, `check_for_updates` and `send_notification` (`swarm_core::commands::NATIVE_ONLY`), exist only as `#[tauri::command]` wrappers in `swarm-desktop` because they need the webview or the OS; they are not reachable through `swarmd`. That makes **38** commands on the desktop and 36 on the daemon.
- **One macro on the desktop side.** `src-tauri/src/commands/mod.rs` declares a forwarder per command with the `commands!` macro. The name list lives once in `src-tauri/src/commands/command_list.rs`, which `commands!` and `build.rs` (the ACL manifest, see [Who Can Call What](#who-can-call-what)) both `include!`, so a command cannot exist without its permission. Contract tests compare that list with `Registry::keys()` and `NATIVE_ONLY`, so a command added on one side only fails CI.
- **Arguments are one JSON object.** Both dispatchers normalize them first: omitted or `null` becomes `{}`, and anything other than an object (a positional array, a bare string) is rejected before any policy check or handler runs with `Invalid Arguments: Expected A JSON Object.` Field names are `camelCase`. A missing required field is reported as ``Invalid Arguments: missing field `name` ``.
- **Errors are values, mostly strings.** A failed command rejects with the registry's error `Value`. Almost always that is a plain string, the `Display` text of `swarm_core::error::AppError` (for example ``Worker `<uuid>` not found``, ``Registry at capacity (64)``, ``Session `<uuid>` not found``, `AI queue full (256 capacity)`). Two families carry structure instead: the ship commands reject with a [`ShipError`](#ship-commands) object, and `agent_spawn` rejects with `{ workerId, message }`. An unknown command is the string ``Unknown Command: "<name>".``
- **Provenance arguments.** Commands that cause a side effect accept an optional `originWorker` (UUID of the causer) and `causeSeq` (the `seq` being reacted to). They are stamped onto the resulting event envelopes; the engine records them and never infers them. A malformed `originWorker` is rejected, never silently dropped.
- **Nothing blocks the runtime.** Every handler that touches a PTY, git, the filesystem or SQLite runs it on Tokio's blocking pool.

### Index

`Remote` is the command's `RemotePolicy` over `swarmd` (`Allowed`, `SecretFiltered` or `Denied`); see [Who Can Call What](#who-can-call-what).

| Command | Arguments | Result | Remote |
|---|---|---|---|
| [`spawn_worker`](#spawn_worker) | `config`, `originWorker?`, `causeSeq?` | worker id | Allowed |
| [`pause_worker`](#pause_worker) | `id`, provenance | `void` | Allowed |
| [`resume_worker`](#resume_worker) | `id`, provenance | `void` | Allowed |
| [`kill_worker`](#kill_worker) | `id`, provenance | `void` | Allowed |
| [`list_workers`](#list_workers) | none | `WorkerInfo[]` | Allowed |
| [`worker_input`](#worker_input) | `id`, `data`, `source`, provenance | `void` | Allowed |
| [`resize_worker`](#resize_worker) | `id`, `rows`, `cols` | `void` | Allowed |
| [`set_max_workers`](#set_max_workers) | `max` | `void` | Allowed |
| [`validate_repo_root`](#validate_repo_root) | `path` | toplevel path | Allowed |
| [`git_ship_preflight`](#git_ship_preflight) | `workerId`, `mode?` | `ShipPreflight` | Allowed |
| [`git_stage_commit`](#git_stage_commit) | `workerId`, `shipId`, `message`, `mode`, `finalStep` | `CommitOutcome` | Allowed |
| [`git_push`](#git_push) | `workerId`, `shipId`, `finalStep` | `PushOutcome` | Allowed |
| [`ship_compare_url`](#ship_compare_url) | `workerId`, `shipId`, `commitSha`, `pushedRef`, `title`, `body` | URL | Allowed |
| [`ship_context`](#ship_context) | `workerId` | `ShipContext` | Allowed |
| [`create_session`](#create_session) | `name`, `config`, provenance | `Session` | Allowed |
| [`delete_session`](#delete_session) | `id`, provenance | `void` | Allowed |
| [`list_sessions`](#list_sessions) | none | `Session[]` | Allowed |
| [`get_session`](#get_session) | `id` | `Session` | Allowed |
| [`session_add_worker`](#session_add_worker) | `sessionId`, `workerId`, provenance | `void` | Allowed |
| [`session_remove_worker`](#session_remove_worker) | `sessionId`, `workerId`, provenance | `void` | Allowed |
| [`agent_turn_started`](#agent_turn_started) | `workerId`, `model`, `requestId` | `seq` | Allowed |
| [`agent_spawn`](#agent_spawn) | `config`, `provider`, `model?`, `trustTier?`, provenance | worker id | Allowed |
| [`agent_send_turn`](#agent_send_turn) | `workerId`, `prompt` | `void` | Allowed |
| [`agent_cancel`](#agent_cancel) | `workerId`, `turnId` | `void` | Allowed |
| [`agent_shutdown`](#agent_shutdown) | `workerId` | `void` | Allowed |
| [`agent_probe`](#agent_probe) | `provider?` | `ProbeReport` | Allowed |
| [`agent_permission_respond`](#agent_permission_respond) | `workerId`, `requestId`, `decision` | `void` | Allowed |
| [`set_agent_concurrency`](#set_agent_concurrency) | `limit` | `void` | Allowed |
| [`read_config`](#read_config) | `key` | value or `null` | SecretFiltered |
| [`write_config`](#write_config) | `key`, `value` | `void` | SecretFiltered |
| [`read_file`](#read_file) | `path` | text | **Denied** |
| [`write_file`](#write_file) | `path`, `content`, provenance | `void` | **Denied** |
| [`get_metrics`](#get_metrics) | none | `MetricsSnapshot` | Allowed |
| [`events_since`](#events_since) | `afterSeq`, `limit?` | `StoredEvent[]` | Allowed |
| [`bus_send`](#bus_send) | `fromWorkerId`, `toWorkerId?`, `topic`, `payload`, `causeSeq?` | `0` | Allowed |
| [`bus_list_channels`](#bus_list_channels) | none | `string[]` | Allowed |
| [`check_for_updates`](#check_for_updates) | none | `UpdateCheckResult` | native, desktop only |
| [`send_notification`](#send_notification) | `title`, `body` | `void` | native, desktop only |

### Who Can Call What

Three independent layers decide whether a command call runs. Each is enforced in code and pinned by a test; the webview chat's tools add a fourth, described below.

1. **The Tauri ACL (desktop webview).** `src-tauri/build.rs` hands the command-name list to `tauri_build::AppManifest::commands`, which generates an `allow-<name>` / `deny-<name>` permission for every one of the 38 commands. `src-tauri/capabilities/default.json` grants exactly those `allow-*` entries to the `main` window (plus `core:default`, the `fs`, `dialog`, `opener` and `store` plugin permissions it needs). A command with no `allow-*` entry cannot be invoked by the webview at all. `capability_contract.rs` fails the build when the capability names a command that does not exist, omits one that does, or grants a bare non-`allow-` app permission.
2. **`RemotePolicy` (swarmd).** Every registry entry declares a policy, and `swarmd` dispatches every `rpc` through `Registry::dispatch_remote`, never `dispatch`. `Allowed` commands are reachable by any authenticated client (including `spawn_worker` and `worker_input`: running commands as the daemon's user is the product). `SecretFiltered` commands (`read_config`, `write_config`) are refused when the `key` argument looks like a credential (`is_secret_key`: split into words at `_`, `-`, `:`, `.`, spaces and camelCase; secret-shaped when the last word (skipping trailing version words such as `2` or `v2`, and ignoring trailing digits) is `key`, `apikey`, `token`, `secret`, `password`, `passwd`, `pat`, `credential` or `credentials`, or any word (trailing digits ignored) is `apikey`, `secret`, `password`, `passwd`, `credential` or `credentials`) with ``Remote Access To Secret-Shaped Config Keys Is Denied.``. `Denied` commands (`read_file`, `write_file`) never reach their handler: `"read_file" Is Not Available Over A Remote Connection.` The local `dispatch` path ignores the policy, because the desktop user is not the boundary it defends.
3. **The file scope (`read_file` / `write_file`).** Both commands canonicalize the path against the real filesystem (symlinks resolved), confine it to fixed scopes and refuse a deny list of credential files for every caller that reaches them (a remote call never does: layer 2 denies it first). See [File System Commands](#file-system-commands).

The webview chat's built-in tools in `src/lib/tools.ts` are a fourth gate in front of these commands. Every tool that acts on the machine (`run_command`, `spawn_worker`, `kill_worker`, `write_file`, `read_file`) waits for the user's answer inside its own `execute`, so no caller, the registry included, can run one unapproved; `get_metrics` and the user's custom tools (sandboxed Blob Workers with no backend side effect) are not gated. The prompt (`ToolApprovalPrompt`) offers **Allow Once**, **Allow For Session** and **Deny**:

- A session grant covers exactly one call shape, keyed by tool, the worker whose turn made the call, and the exact argument (`run_command`: worker and command string; `read_file` and `write_file`: the path as given; `kill_worker`: the worker id; `spawn_worker`: the name). It lasts until the app reloads. Answering one pending call never releases another, and `write_file` never gets a session grant (the button is absent; each write is answered on its own).
- The prompt renders the tool name and every field of the validated input, not a sentence built from model text. Each value is escaped for display: backslashes are doubled, newline, carriage return and tab are spelled `\n`, `\r` and `\t`, and any other control, format, line/paragraph separator or default-ignorable character (bidi, zero-width, tag, variation selector, soft hyphen) shows as `\uXXXX`, or `\u{XXXXX}` above U+FFFF. Non-string values print as canonical JSON, and `write_file` also shows the content size in bytes.
- A value over 500 characters is cut (on the raw value, before escaping) with a "N more characters" count, and Allow Once and Allow For Session stay disabled until each cut value has been expanded with Show All. Commands and file paths are never cut. Deny is always available.
- Stopping a turn or killing its worker denies the turn's pending tool calls (aborting the turn is what denies them, so the Stop button, a queue Cancel and `worker_killed` all do), and a denial returns to the model as an error result (`The User Denied <tool>. It Was Not Run.`).

---

## Worker Commands

### `spawn_worker`

Creates a new worker process with a PTY and registers it in the worker registry.

**Parameters:**

| Name           | Type           | Required | Description                                    |
|----------------|----------------|----------|------------------------------------------------|
| `config`       | `WorkerConfig` | Yes      | Worker spawn configuration                     |
| `originWorker` | `string`       | No       | UUID of the causer (e.g. the AI turn whose `spawn_worker` tool call triggered this spawn). Omitted (not `null`) for a human-initiated spawn -- absent deserializes as unattributed. |
| `causeSeq`     | `number`       | No       | `seq` of the event this spawn is reacting to (typically an `agent_turn_started` seq). |

**`WorkerConfig` object:**

| Field      | Type                     | Default            | Description                          |
|------------|--------------------------|---------------------|--------------------------------------|
| `name`     | `string`                 | `"Worker"`         | Human-readable display name          |
| `shell`    | `string`                 | `""`               | Shell program (path or name on `PATH`, no arguments). Empty selects the platform default: the user's login shell on Unix (`$SHELL`, else the passwd entry, else `/bin/sh`); `pwsh.exe` when on `PATH`, else `powershell.exe`, on Windows |
| `cwd`      | `string`                 | `""`                | Initial working directory. Ignored when a worktree is actually created (see `isolation` below) -- the PTY's cwd becomes the new worktree path instead |
| `env`      | `Record<string, string>` | `{}`                | Additional environment variables     |
| `rows`     | `number`                 | `24`                | Initial PTY rows; see [`resize_worker`](#resize_worker) |
| `cols`     | `number`                 | `80`                | Initial PTY columns; see [`resize_worker`](#resize_worker) |
| `repoRoot` | `string \| null`         | `null`              | Root of the git repository to isolate this worker into. `null` (default) spawns a plain shell at `cwd` -- no git anywhere |
| `isolation`| `"worktree" \| "none"`   | `"worktree"`        | Isolation mode, effective only when `repoRoot` is present |

**Returns:** `string` -- UUID of the newly spawned worker.

**Worktree isolation (when `repoRoot` is given and `isolation` resolves to `"worktree"`):** resolves `repoRoot`'s git toplevel and `HEAD` sha, creates `~/.swarm/worktrees/<repo>-<hash8>/w-<id8>` on a fresh branch `swarm/<slug>-<id8>` starting at that sha, locks it (`git worktree lock --reason "swarm worker <uuid>"`), and spawns the PTY there instead of at `cwd`. Any failure in that pipeline (repo discovery, `HEAD` resolution, `git worktree add`/`lock`) hard-fails the whole command -- **no worker is created and no PTY is started**; there is no silent fallback to spawning unisolated at a shared `cwd`. If the shell itself then fails to start, the new worktree is removed and its branch deleted before the error is returned. Omitting `repoRoot` skips this entirely: the shell starts at `cwd`.

**Errors:**

| Error (string)                  | Condition                                |
|---------------------------------|------------------------------------------|
| `Git error: ...`                | `repoRoot` given and repo discovery, `HEAD` resolution, or `git worktree add`/`lock` failed, or `git` is missing or older than the supported floor |
| `PTY spawn failed: ...`         | Shell executable not found or PTY error  |
| `Registry at capacity (N)`      | `max_workers` workers (default 64) already exist. Checked before anything is created: no worktree, branch or shell is left behind |

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

Pauses a running worker by transitioning its state from `running` to `paused`. The check and the write are one atomic registry update, and the `worker_state` event is emitted after the entry is released.

**Parameters:**

| Name           | Type     | Required | Description              |
|----------------|----------|----------|--------------------------|
| `id`           | `string` | Yes      | UUID of the worker       |
| `originWorker` | `string` | No       | UUID of the causer. Omitted for a human-initiated pause. |
| `causeSeq`     | `number` | No       | `seq` this action is reacting to. |

**Returns:** `void`

**Errors:**

| Error (string)                                   | Condition                       |
|--------------------------------------------------|---------------------------------|
| ``Invalid UUID "<id>": ...``                     | `id` is not a valid UUID string |
| ``Worker `<id>` not found``                      | No worker with the given ID     |
| `IPC error: cannot transition worker <id> from <state> to paused (expected running)` | The worker is not `running` (already paused, or its shell exited) |

**Example:**

```typescript
await invoke("pause_worker", { id: "550e8400-e29b-41d4-a716-446655440000" });
```

**Emits:** `worker_state` envelope on `swarm://events` with payload `{ workerId, state: "paused" }`.

**Note:** Pausing is state-only on every platform. No `SIGSTOP`/`SIGCONT` (or Windows equivalent) reaches the shell or anything it started; the process keeps running and its output keeps flowing.

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

| Error (string)                                   | Condition                       |
|--------------------------------------------------|---------------------------------|
| ``Invalid UUID "<id>": ...``                     | `id` is not a valid UUID string |
| ``Worker `<id>` not found``                      | No worker with the given ID     |
| `IPC error: cannot transition worker <id> from <state> to running (expected paused)` | The worker is not `paused` |

**Example:**

```typescript
await invoke("resume_worker", { id: "550e8400-e29b-41d4-a716-446655440000" });
```

**Emits:** `worker_state` envelope on `swarm://events` with payload `{ workerId, state: "running" }`.

---

### `kill_worker`

Terminates a worker process and removes it from the registry.

Removes the worker, kills its shell (unless the shell already exited) and waits for it to exit to prevent zombie processes (and, on Windows, to release any OS handle the shell held on the worktree directory as its cwd), then releases the PTY, and emits a killed event. A worker whose shell exited on its own (state `"error"`) is killed the same way.

Before killing, `try_wait` checks whether the shell already exited, so a reaped pid is never signalled. Otherwise `kill` is called, but its result is advisory: `portable-pty` 0.9.0's Windows `kill` always reports success and its Unix `kill` errors only when a signal cannot be delivered, so a failure is only logged and `try_wait` (polled for about 200 ms) decides whether the shell is gone; `wait` then reaps it either way. Only the shell is killed; a grandchild it started is not, because the PTY layer uses no job object or process group.

If the worker was isolated into a git worktree, also unlocks and `git worktree remove`s it -- **never** with `--force`. git's own refusal on a dirty/untracked worktree is treated as a successful preserve, not an error: SWARM never deletes uncommitted work.

**Agent sessions come first:** before the worker is touched, it is marked closing in the `AgentSessionRegistry` -- from then on a new attach ([`agent_spawn`](#agent_spawn)), [`agent_send_turn`](#agent_send_turn), [`agent_cancel`](#agent_cancel) and [`agent_permission_respond`](#agent_permission_respond) for it fail with ``Worker `<id>` Is Closing`` -- and any attach still in its handshake is awaited (bounded by the adapter's 30 s handshake plus that attach's own session teardown). Then any attached session, including one such an attach registered, is removed and shut down, so the provider process is stopped and reaped. That shutdown is best-effort: a failure is logged, not propagated, so an agent-session teardown hiccup never blocks the PTY worker's own kill. Only then are the shell and worktree torn down as above, and the closing mark is cleared (later calls get ``Worker `<id>` not found``). When the command resolves, no agent session of the worker is registered or still handshaking ([ADR-0038](adr/0038-kill-stops-the-session-first.md)).

**Parameters:**

| Name           | Type     | Required | Description              |
|----------------|----------|----------|--------------------------|
| `id`           | `string` | Yes      | UUID of the worker       |
| `originWorker` | `string` | No       | UUID of the causer (e.g. the AI turn whose `kill_worker` tool call triggered this). Omitted for a human-initiated kill. |
| `causeSeq`     | `number` | No       | `seq` this action is reacting to. |

**Returns:** `void`

**Errors:**

| Error (string)                                   | Condition                       |
|--------------------------------------------------|---------------------------------|
| ``Invalid UUID "<id>": ...``                     | `id` is not a valid UUID string |
| ``Worker `<id>` not found``                      | No worker with the given ID     |

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
| `state`        | `string`         | `"running"`, `"paused"` or `"error"` (the shell exited on its own; the worker stays registered with its output and worktree until it is killed). `"idle"` is part of the wire enum for older persisted rows, but the backend never produces it |
| `name`         | `string`         | Human-readable display name        |
| `pid`          | `number \| null` | OS process ID, if available        |
| `startedAt`    | `number`         | Unix timestamp (seconds)           |
| `worktreePath` | `string \| null` | Absolute path of this worker's git worktree, if it was spawned with isolation |
| `branch`       | `string \| null` | Branch checked out in `worktreePath` (`swarm/<slug>-<id8>`), if isolated |
| `lastShippedSeq` | `number \| null` | Log `seq` the most recent successful ship pushed through; `null` until the first successful `git_push` for this worker (in-memory only, see [`git_stage_commit`](#git_stage_commit)) |
| `lastShippedCommit` | `string \| null` | Commit sha of that ship |

**Example:**

```typescript
const workers = await invoke("list_workers");
// [{ id: "...", state: "running", name: "Agent 1", pid: 1234, startedAt: 1700000000 }]
```

---

### `worker_input`

Sends input text to a worker's PTY stdin, then emits a stamped `worker_input` event recording that it happened.

`data` is a `string` (UTF-8 encoded before the write), not an array of bytes. The callers are the terminal (`src/hooks/useTerminal.ts`) and the `run_command` AI tool (`src/lib/tools.ts`).

**Parameters:**

| Name           | Type     | Required | Description                     |
|----------------|----------|----------|----------------------------------|
| `id`           | `string` | Yes      | UUID of the target worker       |
| `data`         | `string` | Yes      | Text to write to the PTY (UTF-8 encoded before the write) |
| `source`       | `string` | Yes      | `"terminal"` (human keystrokes), `"tool"` (an AI tool call), or `"automation"` (machine-issued input from app automation; the wire value is accepted and recorded, but nothing in the shipped app sends it today) |
| `originWorker` | `string` | No       | UUID of the causer. Omitted for `source: "terminal"` (the causer is a human, not a worker's turn). |
| `causeSeq`     | `number` | No       | `seq` this input is reacting to (typically an `agent_turn_started` seq). |

**Returns:** `void`

**Errors:**

| Error (string)                  | Condition                          |
|---------------------------------|------------------------------------|
| ``Invalid UUID "<id>": ...``    | `id` or `originWorker` is not a valid UUID string |
| ``Worker `<id>` not found``     | No worker with the given ID        |
| `IPC error: ...`                | The worker's shell has exited (state `"error"`: `worker <id> has exited and accepts no input`), the worker has no PTY writer, or the write failed |
| `Invalid Arguments: ...`        | `source` is not one of the three values |

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

**Emits:** `worker_input` envelope on `swarm://events` with payload `{ workerId, bytes, source, preview? }` -- emitted only AFTER a successful PTY write. `preview` (at most 120 characters of the redacted text: recognized credentials masked, invisible code points dropped, CR and LF read as spaces; the literal `[preview withheld: line editing]` instead when the input contains any control other than CR or LF (BS, DEL, TAB, ESC, C1 controls), which the shell would read as an edited line) is present only for `source ∈ {tool, automation}`; `source == "terminal"` never carries a preview and the row is excluded from persistence entirely (see [Persistence Policy](#persistence-policy)) -- raw human keystrokes, and any secrets typed into a shell, are never archived.

---

### `resize_worker`

Resizes a worker's terminal. The shell sees the new size at once (`SIGWINCH` on Unix, a pseudoconsole resize on Windows); `useTerminal` calls this whenever xterm.js fits itself to its container, and once when the terminal mounts. Allowed in every state. Emits no event: the size is terminal state, not history.

**Parameters:**

| Name   | Type     | Required | Description                       |
|--------|----------|----------|-----------------------------------|
| `id`   | `string` | Yes      | UUID of the worker                |
| `rows` | `number` | Yes      | Terminal height in rows (1-65535) |
| `cols` | `number` | Yes      | Terminal width in columns (1-65535) |

**Returns:** `void`

**Errors:**

| Error (string)                  | Condition                                             |
|---------------------------------|-------------------------------------------------------|
| ``Invalid UUID "<id>": ...``    | `id` is not a valid UUID string                       |
| ``Worker `<id>` not found``     | No worker with the given ID                           |
| `IPC error: ...`                | `rows` or `cols` is 0, the worker has no PTY, or the OS refused the resize |
| `Invalid Arguments: ...`        | `rows` or `cols` does not fit in 16 bits              |

**Example:**

```typescript
await invoke("resize_worker", { id: workerId, rows: 40, cols: 120 });
```

---

### `set_max_workers`

Sets how many workers may exist at once. The value is validated, persisted to `swarm-config.json` as `max_workers` (re-applied at startup), then applied to the live registry. Lowering it below the current worker count does not kill anyone; it only refuses further spawns.

**Parameters:**

| Name  | Type     | Required | Description                              |
|-------|----------|----------|--------------------------------------------|
| `max` | `number` | Yes      | New ceiling, `1..=256` (the default is 64) |

**Returns:** `void`

**Errors:** ``Max Workers Must Be Between 1 And 256, Got <n>.`` for an out-of-range value (nothing is persisted), or `Config error: ...` when the config file cannot be written.

---

### Worktree Isolation Lifecycle

Giving a worker its own `git worktree` is opt-in per spawn, via [`spawn_worker`](#spawn_worker)'s `repoRoot`/`isolation` fields. Without a `repoRoot`, git is never touched and the shell starts at `cwd`.

**Lifecycle:**

1. **Spawn** (`repoRoot` present, `isolation` resolves to `"worktree"`): resolve `repoRoot`'s git toplevel and `HEAD` sha -> `git worktree add -b swarm/<slug>-<id8> <path> <sha>` -> `git worktree lock --reason "swarm worker <uuid>"` -> spawn the PTY with `cwd = <path>`. Emits `worktree_created`.
2. **Kill**: wait for the PTY child to fully exit -> `git worktree unlock` -> `git worktree remove` (**never** `--force`). Emits `worktree_removed` with the resulting `disposition`. On a `"removed"` disposition only, also attempts to delete the isolation branch -- see **Branch Cleanup** below.

**Disposition is classified honestly, not optimistically.** `worktree_removed.disposition` is one of:

| Disposition | Meaning |
|---|---|
| `"removed"` | `git worktree remove` succeeded -- the directory is gone. |
| `"preserved_dirty"` | git refused *specifically* because the worktree has uncommitted changes or untracked files (`"contains modified or untracked files"`). This is the **only** refusal classified as preserved -- see the guarantee below. |
| `"failed"` | Anything else went wrong: the worktree was still locked (an unlock failure is treated as a failure in its own right and `remove` is never even attempted), a permission error killed the delete partway through, the path was already gone, or an unrecognized git error. `reason` carries the stderr excerpt. |

A still-locked worktree is not dirty, and a permission error can strike *after* git has already started deleting tracked files, so neither is reported as preserved. `"failed"` is the signal that something needs a human to look at it; `"preserved_dirty"` is reserved strictly for the one refusal that means "your uncommitted work is intact, untouched, right where it was."

**The Preserve-On-Dirty Guarantee:** `git worktree remove` is invoked without `--force`, which is the entire mechanism -- git itself refuses to remove a worktree that has uncommitted changes or untracked files. SWARM never deletes a worktree's contents itself, and no code path anywhere in the git module can construct a `--force`/`-f` argument for `worktree remove` (enforced by a unit test on the argv builder, `git::worktree::tests::test_remove_args_never_contains_force`).

**A surviving child process can produce `"failed"`.** The PTY layer (`portable-pty` 0.9) does not use a Windows job object or a Unix process group -- killing a worker's shell does not kill any grandchild it spawned (e.g. a long-running build). A grandchild that outlives the kill can hold the worktree directory open as its own cwd, which makes `git worktree remove` fail with a permission error. That is correctly reported as `disposition: "failed"` (never laundered into "preserved"), but the worktree is then stuck on disk until the surviving process exits, at which point a retry or manual cleanup is needed. Killing the whole process tree (a job object on Windows, a process group on Unix) is not implemented.

**Branch Cleanup:** after a `"removed"` disposition (never any other), the isolation branch's tip is compared against the commit it was created from. If unchanged (the agent made no commits), the branch is deleted with `git branch -d` -- **never** `-D` (enforced the same way as the no-`--force` guarantee: `git::worktree::tests::test_branch_delete_args_never_contains_capital_d`). If the tip diverged (the agent committed real work), the branch is left in place -- deleting it would be data loss with extra steps. Either outcome is logged (`tracing`, not a `SwarmEvent` -- this is bookkeeping, not history) and never fails the kill itself.

**Failure policy:** no `repoRoot` -> an unisolated spawn at `cwd`, unconditionally. `repoRoot` present and the worktree-creation pipeline fails at any step -> the whole [`spawn_worker`](#spawn_worker) call fails -- no worker is registered and no PTY is started. There is no silent fallback to sharing a cwd across workers.

**Location:** worktrees live under `~/.swarm/worktrees/<repo>-<hash8>/w-<id8>` (`<repo>` a sanitized repo directory name, `<hash8>` an 8-hex-character tag derived from the repo's absolute path, `<id8>` the worker UUID's first 8 hex characters) -- already inside the [`write_file`](#write_file) scope (`~/.swarm`).

**Startup probe:** on launch, `Runtime::start` (so the desktop app and `swarmd` alike) runs `git --version` off the startup path and requires >= 2.32 (`swarm_core::git::cli::MIN_GIT_VERSION`; the floor is the newest git feature the ship chain uses, `git commit --trailer`). A missing or too-old git is never silently degraded -- it logs a warning and emits a `system_log` envelope (`level: "warn"`, message "Git Unavailable — Isolated Spawns Will Fail Until Git Is Installed Or Upgraded: <reason>") consumed by `useSystemLogEvents` into the existing Logs page. It does not mean workers spawn unisolated -- a `repoRoot`-bearing spawn still hard-fails per the failure policy above; this only makes that fact visible before the user hits it as a spawn error.

**Startup prune:** the same task also runs `git worktree prune` against the persisted `default_repo_root` config key (see the Project Root picker on the Workers page), logging the pruned count.

---

### `validate_repo_root`

Validates that a directory is inside a git repository -- used by the Workers page's Project Root picker to confirm a chosen directory *before* persisting it as `default_repo_root` config, instead of letting every subsequent isolated spawn hard-fail with a raw git error. Also used to revalidate the persisted value on load (a repo can be deleted or moved between sessions).

**Parameters:**

| Name   | Type     | Required | Description                          |
|--------|----------|----------|---------------------------------------|
| `path` | `string` | Yes      | Candidate directory (e.g. from a directory picker) |

**Returns:** `string` -- the repo's canonical toplevel absolute path (may differ from `path` if it was a subdirectory of the repo).

**Errors:**

| Error (string)  | Condition                                    |
|-----------------|-----------------------------------------------|
| `Git error: ...` | `path` is not absolute (``Git error: repository path must be absolute: "<path>"``), is not inside a git repository, `git` could not be spawned, or the operation timed out (``Git error: `git <subcommand>` timed out after <n>s``) |

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

The ship chain turns a worker's finished work into a real commit, a real upstream push, and a browser open on a prefilled GitHub compare page: commit -> push -> compare page, with no AI in the loop. All git mutation logic lives in `swarm_core::git::ship` (tauri-free); these commands are thin IPC wrappers that add `spawn_blocking`, per-repo `RepoLocks::run_serialized` (inside `stage_and_commit`/`push` themselves -- see the module doc), and `ship_progress`/`ship_settled`/`commit_created` event emission.

**Ownership split:** the worktree feature (`git::worktree`, `worker::lifecycle`) owns worktree creation/branch-naming/removal; ship owns commit/push and is the *only* writer of `WorkerHandle.lastShippedSeq`/`lastShippedCommit` (via `WorkerRegistry::set_last_shipped`, called only after a successful `git_push`). There is no separate `WorktreeRegistry` -- `swarm_core::git::ship::worktree_info_for_worker` is the thin accessor ship consumes instead of reaching into `WorkerHandle`'s fields directly. See [architecture.md](architecture.md) for the design.

**Typed errors, not strings.** The mutating and preflight commands below reject with a structured `ShipError` object -- `{ kind, message, remedy }` -- instead of the plain-string convention the other commands use (`ship_context` and `validate_repo_root` can also reject with a plain string). This is a **documented divergence**: the Ship tab UI must branch on `kind` for the right second-click remedy (e.g. `pushRejected` -> "Fetch And Rebase, Then Ship Again", never an automatic force-push), which a bare string can't carry.

**`ShipErrorKind` values:** `workerNotFound`, `noWorktree`, `primaryCheckout`, `invalidBranch`, `noRemote`, `nonGitHubHost`, `nothingToCommit`, `identityMissing`, `hookFailed`, `pushRejected`, `authExpired`, `timeout`, `unknown`. `noUpstream` is deliberately absent -- a fresh isolation branch having no upstream yet is a normal *preflight state* (`ShipPreflight.upstream: null`), never an error.

**`ShipRemedy` values:** `fetchAndRebase`, `reAuthenticate`, `configureIdentity` -- a suggested next action, or `null` when there isn't one.

---

### `git_ship_preflight`

Computes the full ship preflight for a worker's worktree, evaluated for `mode` (defaults to `"all"` when omitted): branch/remote/tracking state, working-tree status, the deny-list preview (mode-aware -- a `"staged"` preview reflects only the index, matching what `git_stage_commit` would actually commit for that mode), and the `canShip`/`blockers` verdict. Read-only -- never mutates the working tree, emits no events.

**Refuses (via non-fatal `blockers`, `canShip: false` when any is present) rather than erroring:** toplevel mismatch (the worktree path no longer resolves to itself), primary checkout (`--git-common-dir == --git-dir`), detached `HEAD`, `branch == baseBranch`, a protected branch (`main`/`master`/`develop`/`release/*`), missing `origin` remote, unresolved merge conflicts, or nothing to ship at all (clean working tree **and** `ahead == 0`).

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

**`SkippedFile` object:** `{ path: string, reason: string }` -- `reason` is one of `"Skipped — Looks Like A Credential"`, `"Skipped — Larger Than 5 MB"` or `"Skipped — SWARM Configuration File"`. Credential-shaped means a basename (case-insensitive) starting with `.env` or `id_rsa` or ending in `.pem` or `.key`, or `secret` anywhere in the full relative path (case-insensitive -- catches a nested `config/secrets/api.yaml` even though its own filename does not mention it); the size rule is any working-tree file over 5 MiB; the configuration-file rule is an *untracked* `.claude/settings.json` (a leftover of an older build; a tracked or already-staged copy is the user's own file and ships like any other).

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

**`seqFrom`/`seqTo` resolution:** `seqFrom` is the worker's `lastShippedSeq` if it has shipped before (in-memory only -- see the note below), else its `worktree_created` event's own `seq` (an indexed lookup against the event log), else `0`. `seqTo` is the log's current max `seq`, snapshotted *before* the commit -- the `commit_created` event's own `seq` is always `> seqTo`, correctly excluding "the record of shipping" from the range it describes.

**`lastShippedSeq` is in-memory only.** It lives on the `WorkerHandle` and is never persisted to disk. Workers do not outlive the process either, so there is no restart in which a worker keeps its worktree but loses the marker; a worker without one falls back to the (indexed, cheap) `worktree_created` lookup, which covers the worktree's whole lifetime in the commit's `Swarm-Seq-Range` trailer.

**Errors:**

| Error kind          | Condition                                                                   |
|----------------------|------------------------------------------------------------------------------|
| `workerNotFound` / `noWorktree` | `workerId` is malformed or names no worker, or the worker was spawned without worktree isolation |
| `primaryCheckout`    | The pre-mutation guard fired: the worker's path is the repository's primary checkout, not a linked worktree |
| `nothingToCommit`    | Every candidate file was skipped by the deny list, or (mode `"staged"`) the index is empty after unstaging denied paths -- **not automatically terminal**, see above |
| `identityMissing`    | `git commit` failed because `user.name`/`user.email` aren't set (remedy `configureIdentity`) |
| `hookFailed`         | `git commit` was rejected -- most plausibly a pre-commit/commit-msg hook, since `--no-verify` is never constructible |
| `timeout`            | A git invocation exceeded its budget (`MUTATE_TIMEOUT`, 600 s) |
| `unknown`            | `shipId` is not a UUID, or any other failure |

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

Pushes the worker's branch: `git push --set-upstream --end-of-options origin refs/heads/<branch>:refs/heads/<branch>` -- **fixed argv** (`--end-of-options` keeps an option-shaped branch an operand, and the fully qualified refspec makes a leading `+` part of the literal ref name, so a branch named `+main` cannot force-update `main`), no force token constructible anywhere in the argv builder (`--force`/`-f`/`--force-with-lease` cannot be reached). Both the branch and the sha pushed are resolved **live**, server-side, at push time -- this command takes **no** commit sha from the caller at all. On success, records `lastShippedSeq`/`lastShippedCommit` for the worker via `WorkerRegistry::set_last_shipped` -- the ship chain is the only writer of those two fields.

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
| `workerNotFound` / `noWorktree` | `workerId` is malformed or names no worker, or the worker was spawned without worktree isolation | -- |
| `primaryCheckout` | The pre-mutation guard fired                                              | --                 |
| `invalidBranch`   | Detached `HEAD`, a protected branch (`main`, `master`, `develop`, `release/*`) or the base branch -- resolved live | -- |
| `noRemote`        | No `origin` remote configured                                             | --                 |
| `pushRejected`    | Non-fast-forward rejection -- `origin` has commits the local branch doesn't | `fetchAndRebase` (`git pull --rebase`, re-preview, ship again -- **never** an automatic force-push) |
| `authExpired`     | Authentication failed (expired/missing credentials, `GIT_TERMINAL_PROMPT=0` surfacing what would have been an interactive prompt) | `reAuthenticate`  |
| `timeout`         | The underlying git invocation exceeded its timeout budget                 | --                 |
| `unknown` | `shipId` is not a UUID, or any other failure, including reading the live branch or the `origin` remote | -- |

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

**Client-side timeout discipline:** before the final step's invoke, `useShip.ts`'s `armSettledWait` starts listening for that attempt's `ship_settled`, because the receipt can arrive before the invoke resolves. The 30 s budget (`SHIP_SETTLED_TIMEOUT_MS`, passed explicitly instead of `waitFor`'s 5 s default) starts only after that invoke has resolved, and covers the receipt landing after the response. The backend's git budgets cover the git work itself: `MUTATE_TIMEOUT` (`add`, `restore --staged`, `commit`, which runs the user's hooks) and `PUSH_TIMEOUT` (network transfer plus the `pre-push` hook) are 600 s each, `SCAN_TIMEOUT` 60 s, `READ_TIMEOUT` 15 s, `CREATE_TIMEOUT` (`git worktree add`) 120 s and `REMOVE_TIMEOUT` 600 s. A git step that runs out of budget rejects the invoke with a `timeout` ShipError, so a slow but successful commit or push is never reported as a timeout.

---

### `ship_compare_url`

Builds the GitHub-style compare URL for a worker's worktree, prefilled with a PR title/body via `quick_pull=1` query parameters, capped at 6000 total characters. If the untruncated URL would exceed the cap, `body` is shortened first (with a visible truncation marker); if even an *empty* body still doesn't fit, `title` is clamped too as a last resort -- only the compare path itself (host/owner/repo/base/branch) is never truncated. The branch is resolved **live** (same as [`git_push`](#git_push), never a stale stored value). Supports `https`/`ssh`/GHES remote URL shapes; a non-GitHub-shaped host (`gitlab.com`, `bitbucket.org`, etc.) is rejected rather than producing a broken URL.

The frontend is expected to pre-check `ShipPreflight.hostSupportsCompare` and disable the "Open Compare Page" action entirely for a non-GitHub remote -- this command's own `nonGitHubHost` error is the defensive fallback for a stale preflight, not the primary UX.

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
| `workerNotFound` / `noWorktree` | `workerId` is malformed or names no worker, or the worker was spawned without worktree isolation |
| `invalidBranch`  | Detached `HEAD`                                                     |
| `noRemote`       | No `origin` remote configured                                       |
| `nonGitHubHost`  | The remote's host isn't one a GitHub-style compare URL applies to (e.g. GitLab, Bitbucket) |
| `timeout` | Reading the live branch or the `origin` remote exceeded its timeout budget |
| `unknown` | `shipId` is not a UUID, or any other failure, including reading the live branch or the `origin` remote |

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
await openUrl(url); // import { openUrl } from "@tauri-apps/plugin-opener"
```

**Emits:** `ship_progress` (`step: "compare"`), then `ship_settled` with `prUrl` set.

---

### `ship_context`

Read-only: the causal record for a worker's current ship range — the evidence half of the PR body `src/lib/ship-causal.ts` composes (see [architecture.md](architecture.md) for the design). Resolves `(seqFrom, seqTo]` via the exact same algorithm `git_stage_commit` uses (`lastShippedSeq ?? worktree_created seq .. current max`), then fetches that worker's `agent_block`/`agent_tool_call`/`agent_tool_result`/`agent_turn_settled`/`commit_created`/`agent_turn_started` rows in range via `EventLog::events_for_worker_between` — filtered by `workerId` AND type IN the SQL itself (not a range-wide fetch filtered afterward — see `eventsTruncated` below for why that distinction is load-bearing), newest-first with the oldest rows dropped on overflow. Emits no events (a query, not a mutation).

**Parameters:**

| Name       | Type     | Required | Description         |
|------------|----------|----------|----------------------|
| `workerId` | `string` | Yes      | UUID of the worker    |

**Returns:** `ShipContext`

**`ShipContext` object:**

| Field                          | Type              | Description                                                          |
|--------------------------------|-------------------|------------------------------------------------------------------------|
| `workerId`                     | `string` (UUID)   | The worker this context was computed for                                |
| `seqFrom`                      | `number`          | Start of the resolved range (exclusive)                                 |
| `seqTo`                        | `number`          | End of the resolved range (inclusive)                                   |
| `turns`                        | `CausalTurn[]`    | Turns in range, oldest first, capped at 200 (newest kept on overflow — see `omittedTurnCount`) |
| `commits`                      | `CausalCommit[]`  | `commit_created` rows for this worker in range — ordinarily empty at preview time, populated on a re-preview after an earlier "Commit Only" step |
| `omittedTurnCount`             | `number`          | How many turns were dropped to respect the 200-turn cap — `0` when nothing was dropped |
| `eventsTruncated`              | `boolean`         | `true` when the underlying SQL row fetch itself hit its cap — turns older than what's visible may exist beyond what `omittedTurnCount` alone can count. Folded into the same disclosure `omittedTurnCount` renders (`src/lib/ship-causal.ts`'s `renderTruncationNote`) — never a second, easy-to-miss signal |
| `hasUncapturedWebviewActivity` | `boolean`         | `true` when this worker had `agent_turn_started` (webview chat) activity in range that produced no `CausalTurn` — distinguishes "genuinely no activity" from "activity this query structurally cannot see" (see `emptyRecordMessage`) |

**`CausalTurn` object:** `{ turnId: string, status: "ok" | "error" | null, toolCalls: CausalToolCall[] }` — `status` is `null` when no `agent_turn_settled` was observed in range (the turn was still open at `seqTo`, or settled outside the window).

**`CausalToolCall` object:** `{ seq: number, name: string, target: string | null, ok: boolean | null }` — `target` is a best-effort extraction from the call's `input`, via an allowlist of path/command-shaped fields (`path`, `file_path`, `filePath`, `command`, `cmd`, `pattern`, `url`, `query`, `name`) capped at 200 characters — **never** a raw `input`/`content` field, which can legitimately carry file contents. `ok` is `null` until a matching `agent_tool_result` is seen in range — never defaulted to `true`.

**`CausalCommit` object:** `{ sha: string, branch: string, seqFrom: number, seqTo: number }` — mirrors the commit's own `Swarm-Seq-Range` trailer.

**Errors:** `ShipError` with kind `workerNotFound` when `workerId` is not a valid UUID. A well-formed id that names no live worker is not an error: the range falls back to that id's `worktree_created` row (or `0`), and the record is whatever the log holds for it, usually empty. An unreadable event log or a task panic rejects with a plain string (it is never papered over with an empty record).

**Example:**

```typescript
const context = await invoke("ship_context", { workerId });
if (context.turns.length === 0) {
  // emptyRecordMessage(context) — render one of two honest messages,
  // depending on context.hasUncapturedWebviewActivity.
}
```

**Emits:** nothing.

---

## Session Commands

Sessions are named groups of workers. The set lives in memory and is saved to `<data-dir>/sessions.json` after every mutation (`session::persist`). Unlike the event log, this save is best effort: a failed write is logged and never turns an already-applied, already-emitted mutation into an error.

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
  config: { label: "research", maxTokens: 4096 },
});
console.log("Created session:", session.id);
```

**Emits:** `session_created` envelope on `swarm://events` with payload `{ sessionId, name }`.

**Side effect:** saves the session set to `sessions.json` (best effort, see [Session Commands](#session-commands)).

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

| Error (string)                 | Condition                        |
|--------------------------------|----------------------------------|
| ``Invalid UUID "<id>": ...``    | `id` is not a valid UUID string  |
| ``Session `<id>` not found``   | No session with the given ID     |

**Example:**

```typescript
await invoke("delete_session", { id: session.id });
```

**Emits:** `session_deleted` envelope on `swarm://events` with payload `{ sessionId }`.

**Side effect:** saves the remaining sessions to `sessions.json`.

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

| Error (string)                 | Condition                        |
|--------------------------------|----------------------------------|
| ``Invalid UUID "<id>": ...``    | `id` is not a valid UUID string  |
| ``Session `<id>` not found``   | No session with the given ID     |

**Example:**

```typescript
const session = await invoke("get_session", { id: "550e8400-..." });
```

**Wiring:** no frontend caller; the app lists sessions with `list_sessions` (see [Built, Not Wired](#built-not-wired)).

---

### `session_add_worker`

Registers a worker against a session's `workerIds` list.

**Parameters:**

| Name           | Type     | Required | Description                        |
|----------------|----------|----------|-------------------------------------|
| `sessionId`    | `string` | Yes      | UUID of the target session          |
| `workerId`     | `string` | Yes      | UUID of the worker to add           |
| `originWorker` | `string` | No       | UUID of the causer                  |
| `causeSeq`     | `number` | No       | `seq` this action is reacting to    |

**Returns:** `void`

**Errors:**

| Error (string)                 | Condition                                |
|--------------------------------|-------------------------------------------|
| ``Invalid UUID "<id>": ...``    | `sessionId`, `workerId` or `originWorker` is not a valid UUID |
| ``Session `<id>` not found``   | No session with the given ID exists       |

**Example:**

```typescript
await invoke("session_add_worker", {
  sessionId: session.id,
  workerId,
});
```

The worker is not checked against the worker registry; the session just records the id. Re-adding a current member is a no-op: it emits nothing and saves nothing.

**Emits:** `session_worker_added` envelope with payload `{ sessionId, workerId }`, only when membership actually changed (carrying `originWorker`/`causeSeq` when given).

**Side effect:** saves the updated session list to `sessions.json`.

---

### `session_remove_worker`

Removes a worker from a session's `workerIds`. The app calls it when a member worker goes away, so the list does not grow forever. Removing a worker that is not a member still succeeds and still emits, so a listener that believes the worker is a member converges either way; only a missing session errors.

**Parameters:**

| Name           | Type     | Required | Description                        |
|----------------|----------|----------|-------------------------------------|
| `sessionId`    | `string` | Yes      | UUID of the session                 |
| `workerId`     | `string` | Yes      | UUID of the worker to remove        |
| `originWorker` | `string` | No       | UUID of the causer                  |
| `causeSeq`     | `number` | No       | `seq` this action is reacting to    |

**Returns:** `void`

**Errors:** as [`session_add_worker`](#session_add_worker).

**Emits:** `session_worker_removed` envelope with payload `{ sessionId, workerId }`.

**Side effect:** saves the updated session list to `sessions.json`.

---

## Agent Commands

Two kinds of AI conversation exist side by side:

- **Provider agents** (Claude Code and Codex): the backend spawns the provider's CLI (`claude -p --input-format stream-json`, `codex app-server`) next to a PTY worker, drives it over piped stdio and normalizes its protocol into the `agent_*` events. `agent_spawn`, `agent_send_turn`, `agent_cancel`, `agent_shutdown`, `agent_probe`, `agent_permission_respond` and `set_agent_concurrency` serve these. Adapters are chosen by provider id in one place (`with_adapter!` in `commands/agent.rs`); every command after `agent_spawn` reaches the live session through the `AgentSessionRegistry`, keyed by worker id.
- **The webview chat** (`src/lib/anthropic.ts`): `@anthropic-ai/sdk` streams directly from the webview to the Anthropic API, and its machine-acting tools call the commands in this document. The backend only learns of a turn through `agent_turn_started`.

Provider ids on the wire are `snake_case`: `claude_code` and `codex` have adapters; `opencode`, `gemini` and `webview_anthropic` are reserved names that parse but have none (`Provider Not Supported By The Backend: <name>.`); any other string fails argument parsing.

### `agent_turn_started`

A narrow intake for the webview chat path. `runTurn` in `src/lib/ai-chat.ts` calls it once per turn, before the first streaming round, and keeps the returned seq in the turn's `ToolProvenance`. Every tool-driven side effect the turn runs afterwards (`spawn_worker`, `kill_worker`, `worker_input`, `write_file`) cites that seq as its `causeSeq`.

This is how the "the engine records provenance, it never infers it" invariant holds for AI turns: the frontend cannot cite a cause that does not exist in the log, so this command makes one exist deterministically, with no polling and no timeout-bound `waitFor` correlation. It waits for the writer's acknowledgement (`EventSink::emit_awaiting_seq`) for at most 5 seconds.

**Parameters:**

| Name        | Type     | Required | Description                                     |
|-------------|----------|----------|--------------------------------------------------|
| `workerId`  | `string` | Yes      | UUID of the worker whose chat panel started this turn |
| `model`     | `string` | Yes      | Model identifier for this turn                  |
| `requestId` | `string` | Yes      | Client-generated correlation ID (the chat item id) |

**Returns:** `number` -- the `seq` the writer assigned the `agent_turn_started` event, which is a persisted seq by construction.

**Errors:**

| Error (string)                  | Condition                                  |
|---------------------------------|---------------------------------------------|
| ``Invalid UUID "<id>": ...``    | `workerId` is not a valid UUID string      |
| `Event Writer Unavailable.`     | The acknowledgement channel closed without a seq: the engine is shutting down, the writer thread is gone, or the event could not be saved ([Failing Closed](#failing-closed)) |
| `Agent Turn Started Timed Out.` | No acknowledgement within 5 seconds        |

**Example:**

```typescript
// The raw IPC calls behind runTurn (src/lib/ai-chat.ts), which goes through agentTurnStarted in src/lib/tauri.ts, before round 0:
const turnSeq = await invoke<number>("agent_turn_started", {
  workerId,
  model: modelId,
  requestId: itemId,
});
// runTurn keeps the seq in the turn's ToolProvenance; every tool call cites it as causeSeq:
await invoke("worker_input", {
  id: workerId,
  data: "pnpm build\n",
  source: "tool",
  originWorker: workerId,
  causeSeq: turnSeq,
});
```

**Emits:** `agent_turn_started` envelope with payload `{ workerId, model, requestId }`. Unattributed (`originWorker`/`causeSeq` both absent): the turn's own start is caused by a human, like every other user-initiated action.

---

### `agent_spawn`

Spawns a worker through the same path as [`spawn_worker`](#spawn_worker) (`do_spawn_worker`, worktree isolation included) and attaches a provider session to it in one call. The PTY worker and the agent session are independent resources that share only the worker id and the working directory: the PTY keeps backing the plain terminal view, while the session drives the AI conversation through [`agent_send_turn`](#agent_send_turn). The provider is refused before any side effect when it has no adapter.

**Parameters:**

| Name        | Type                                    | Required | Description |
|-------------|------------------------------------------|----------|--------------|
| `config`    | `WorkerConfig`                           | Yes      | Same shape [`spawn_worker`](#spawn_worker) takes. For an isolated worker the session runs in the new worktree, not in `cwd` |
| `provider`  | `string`                                 | Yes      | `"claude_code"` or `"codex"` |
| `model`     | `string`                                 | No       | Model alias or id; omitted defers to the adapter's default |
| `trustTier` | `"restricted" \| "standard" \| "write_enabled"` | No | Spawn-time trust dial, the same three tokens for both providers, mapped onto each one's own mechanism (below). Omitted means `"standard"`; any other string fails the spawn closed, so a provider's raw mode names (`bypassPermissions`, `acceptEdits`) and Codex's `never` / `danger-full-access` cannot be requested |
| `originWorker` | `string` | No | Causal attribution, same convention as `spawn_worker` |
| `causeSeq`     | `number` | No | Causal attribution, same convention as `spawn_worker` |

**Trust tiers:**

| Tier | Claude Code | Codex |
|---|---|---|
| `restricted` | `--restricted`, `--permission-mode dontAsk`, writing tools on the deny list: read-only exploration | `untrusted` approvals + `read-only` sandbox |
| `standard` | `--permission-mode manual`: reads run, anything needing approval is asked of the human, destructive Bash patterns always denied | `untrusted` approvals + `workspace-write` sandbox |
| `write_enabled` | `--permission-mode acceptEdits`: edits in the working directory run unasked, commands are asked, the same patterns stay denied | `on-request` approvals + `workspace-write` sandbox |

Permission gating never rests on `allowedTools` (it widens what runs unasked rather than narrowing it).

**Returns:** `string` -- the UUID of the new worker. The session's `sessionKey`, resolved model and capabilities arrive in the `agent_session_started` event, not in this result.

**Errors:** on failure the rejection is an object `{ workerId: string | null, message: string }`.

| `workerId` | `message` | Condition |
|---|---|---|
| `null` | `Provider Not Supported By The Backend: <name>.` | `provider` is a reserved name with no adapter. Nothing was spawned |
| `null` | the `spawn_worker` error text | The PTY worker spawn itself failed (registry full, worktree creation failed, ...) |
| `null` | ``Worker `<id>` not found`` | The worker was killed before or during its session's attach. A session that did attach is shut down, and no worker remains |
| `null` | ``Worker `<id>` Is Closing`` | A [`kill_worker`](#kill_worker) was in progress when the attach started or finished its handshake. A session that did attach is shut down before the kill proceeds, and no worker remains |
| the new worker's id | the adapter's own error, verbatim | The session failed to attach (binary missing, handshake timeout, an unknown `trustTier`, Codex refusing a policy more permissive than requested, ...). **The PTY worker still exists and is usable as a plain terminal**; it is not rolled back |

**Emits:** `worker_spawned` (and `worktree_created` if isolated) from the underlying spawn, then `agent_session_started` once the adapter's `spawn()` resolves. `payload.capabilities` tells the frontend what the session can honestly do (see [`agent_permission_respond`](#agent_permission_respond) and [`agent_cancel`](#agent_cancel)).

---

### `agent_send_turn`

Enqueues one turn for `workerId`'s attached session through the `AgentScheduler`, which gates concurrent turns across every session ([`set_agent_concurrency`](#set_agent_concurrency)). **Fire-and-forget by design:** it resolves once the turn is admitted to the scheduler, not once it completes or even starts. The transcript renders from the live `agent_*` stream (`agent_block`, `agent_tool_call`, `agent_tool_result`, `agent_turn_settled`, all carrying `workerId`), so no `turnId` is handed back.

**Parameters:**

| Name       | Type     | Required | Description |
|------------|----------|----------|--------------|
| `workerId` | `string` | Yes      | UUID of the worker whose attached session should receive this turn |
| `prompt`   | `string` | Yes      | The turn's prompt text |

**Returns:** `void`

**Errors:**

| Error (string)                  | Condition |
|---------------------------------|-----------|
| ``Invalid UUID "<id>": ...``    | `workerId` is not a valid UUID string |
| `AI queue full (256 capacity)`  | The scheduler's bounded admission queue (`AGENT_TURN_QUEUE_CAPACITY`) is full |
| ``Worker `<id>` Is Closing``    | A [`kill_worker`](#kill_worker) for this worker is in progress; nothing is queued |

A worker with no attached session is **not** an error here: the turn is admitted, and when it runs it settles at once with a synthesized `agent_turn_settled` (`status: "error"`, `error: "No Live Session For This Worker: ..."`) -- which is also how a turn queued before a kill settles, since by dispatch its worker is closing or its session is gone; a session that rejects the turn settles the same way with `Turn Rejected: ...`. The scheduler runs at most one turn per worker at a time, so a second turn for a busy worker waits in the queue instead of reaching the session.

---

### `agent_cancel`

Cancels `workerId`'s in-flight turn. `turnId` comes from that turn's own `agent_block` / `agent_tool_call` events. Both adapters report `cancelGranularity: "graceful"`: the provider's own in-band cancel stops the turn and **keeps the session**.

- **Claude Code** sends an `interrupt` control request and withdraws the turn's pending permission asks. The CLI aborts the turn and writes its result, which settles as `agent_turn_settled { status: "error", error: "Turn Cancelled" }`. Only if the CLI does not acknowledge within 5 s, or the turn does not settle within 10 s after that, is the process killed (a synthesized settlement and `agent_session_exited` follow).
- **Codex** sends `turn/interrupt`; the turn settles with the `interrupted` status as an `error` settlement and the thread stays open. A refused interrupt races a turn finishing on its own, so the turn still gets 10 s to settle; only a turn that never settles, or an unanswered interrupt, shuts the session down.

A stale, already-settled or already-cancelling `turnId` is a benign no-op.

**Parameters:**

| Name       | Type     | Required | Description |
|------------|----------|----------|--------------|
| `workerId` | `string` | Yes      | UUID of the worker whose session should cancel |
| `turnId`   | `string` | Yes      | The turn to cancel |

**Returns:** `void`

**Errors:** an invalid UUID, no attached agent session for `workerId`, or ``Worker `<id>` Is Closing`` while a [`kill_worker`](#kill_worker) for it is in progress (the kill's session shutdown settles the turn).

**Emits:** exactly one `agent_turn_settled` for the turn (`status: "error"`), and `agent_session_exited` only if the session itself had to be torn down.

---

### `agent_shutdown`

Shuts down `workerId`'s attached agent session (idempotent) and removes it from the registry. An idle Claude Code session closes stdin and lets the CLI exit (killed after a 3 s grace); a busy one is killed. Does **not** kill the PTY worker; [`kill_worker`](#kill_worker) does the reverse and also tears down any attached session. A worker with no attached session is a benign no-op.

**Parameters:**

| Name       | Type     | Required | Description |
|------------|----------|----------|--------------|
| `workerId` | `string` | Yes      | UUID of the worker whose session should shut down |

**Returns:** `void`

**Errors:** an invalid UUID only.

**Emits:** `agent_session_exited`, preceded by a synthesized `agent_turn_settled` (`status: "error"`, `costUsd` and `usage` `null`) if a turn was in flight.

**Wiring:** no frontend caller; `kill_worker` shuts a session's agent down (see [Built, Not Wired](#built-not-wired)).

---

### `agent_probe`

Checks whether `provider`'s CLI is installed, new enough and signed in, without starting a session. Claude Code: a throwaway `initialize` handshake in the temp directory, bounded by 15 s, requiring `claude` 2.1.259 or newer. Codex: `codex --version` and `codex login status`, each bounded by 5 s. Never touches or reports a credential.

**Parameters:**

| Name       | Type     | Required | Description |
|------------|----------|----------|--------------|
| `provider` | `string` | No       | `"claude_code"` or `"codex"`. Omitted (or `null`) means `"claude_code"`, so the argument-less `{}` call stays valid |

**Returns:** `ProbeReport`

```typescript
{ available: boolean; version?: string | null; detail?: string | null }
```

An unusable provider is reported as `{ available: false, detail }`, never as an error; `detail` is human-readable (`Claude Code CLI Not Found On PATH: ...`, `Claude Code 2.1.259 Or Newer Required`, `Claude Code CLI Not Signed In`, `Not Signed In — Run \`codex login\` In A Terminal`, `... Probe Timed Out`). A usable one reports the sign-in as it observed it (`Signed In (Max)`, `Using An API Key (...)`, Codex's own `login status` line, or `Sign-In State Unknown: ...` when Codex's status call does not answer).

**Errors:** a provider with no adapter rejects with `Provider Not Supported By The Backend: <name>.`; an unknown provider string fails argument parsing.

---

### `agent_permission_respond`

Answers a pending [`agent_permission_request`](#type-tags) by `requestId`. **Both** adapters report `interactivePermissions: true`, and both are real round-trips:

- **Claude Code**: the session starts the CLI with `--permission-prompt-tool stdio`, so anything the trust tier neither allows nor denies arrives as a `can_use_tool` control request that blocks the CLI until this command answers it. An ask nobody answers within 10 minutes is denied, as is one flagged as needing the user's own interaction (such as `AskUserQuestion`), which is reported as a denial at once.
- **Codex**: the `item/commandExecution/requestApproval`, `item/fileChange/requestApproval` and `item/permissions/requestApproval` server requests are answered with a JSON-RPC response; every other server request gets `-32601`.

Not every `agent_permission_request` is a question. One with `suggestedDecision: "deny"` **reports a decision the provider already made** (a deny-list hit, `dontAsk`, the redirection guard) and needs no answer; answering it is a no-op. Branch on `suggestedDecision`, and on `capabilities.interactivePermissions`, before offering Allow/Deny buttons.

**Parameters:**

| Name        | Type                    | Required | Description |
|-------------|--------------------------|----------|--------------|
| `workerId`  | `string`                 | Yes      | UUID of the worker whose session should answer |
| `requestId` | `string`                 | Yes      | The pending request's id, from `agent_permission_request.requestId` |
| `decision`  | `"allow" \| "deny"`      | Yes      | The human's (or a policy's) answer |

**Returns:** `void`

**Errors:** an invalid UUID, no attached agent session for `workerId`, or ``Worker `<id>` Is Closing`` while a [`kill_worker`](#kill_worker) for it is in progress. An unknown, already-answered, expired or report-only `requestId` is a benign no-op, so a double click or a late answer cannot fail.

**Example:**

```typescript
await invoke("agent_permission_respond", {
  workerId,
  requestId: "100", // from the agent_permission_request event
  decision: "deny",
});
```

---

### `set_agent_concurrency`

Sets how many agent turns may execute at the same time. Validated, persisted to `swarm-config.json` as `agent_concurrency` (re-applied at startup), then applied to the live scheduler, in that order, so a failed write never leaves the scheduler enforcing a cap the file disagrees with.

**Parameters:**

| Name    | Type     | Required | Description |
|---------|----------|----------|--------------|
| `limit` | `number` | Yes      | `1..=16` (`MIN_AGENT_CONCURRENCY..=MAX_AGENT_CONCURRENCY`) |

**Returns:** `void`

**Errors:** ``Agent Concurrency Must Be Between 1 And 16, Got <n>.`` (nothing is persisted), or `Config error: ...`.

---

## File System Commands

`read_file` and `write_file` are the Rust commands behind the `read_file` / `write_file` AI tools (`src/lib/tools.ts`, which ask the user first; see [Who Can Call What](#who-can-call-what)). They are **`Denied` over `swarmd`** (never reachable remotely) and, on the desktop, confined to fixed scopes by `FsScopes` in `crates/swarm-core/src/commands/fs.rs`. The webview's own `fs` plugin permission is a separate mechanism with no allow-list path scope: it reads, lists, stats and writes only what the user picks in an open or save dialog, minus a static deny scope that holds even inside a dialog grant: the app data directory (`$APPDATA/**`) and the usual credential stores (`~/.ssh`, `~/.gnupg`, `~/.aws`, `~/.azure`, `~/.kube`, `~/.docker`, `~/.config/gh`, `~/.claude`, `~/.codex`, `~/.git-credentials`, `~/.netrc`) (`src-tauri/capabilities/default.json`).

**Scopes.** Every path must be absolute. Reads may touch the app data directory and the home directory; writes only the app data directory and `~/.swarm`.

**How a path is checked.** The path is normalized lexically (`.` and `..` resolved without touching disk), then canonicalized against the real filesystem, and the scope and deny checks run on the real path:

- A read canonicalizes the file itself. A write canonicalizes the parent directory and, when the target already exists (any entry type), the target too, so a symlink, a Windows 8.3 short name (`SWARM-~1.JSO`) or a case variant lands on the real file the write would replace. A dangling link inside a scope is refused.
- The lexical form is only used to pick the error once canonicalization fails: a path outside every scope gets the scope error whether or not it exists, so a missing path elsewhere on disk cannot be told from an existing one.
- **Deny list**, applied to the canonical path for reads and writes alike: in the app data directory, `swarm-config.json` (it holds the Anthropic API key) and `daemon-token`, plus anything named with those as a prefix (`swarm-config.json.corrupt-<ms>` backups, the daemon's `.daemon-token.<rand>` mint-time temp file; leading dots are ignored and case does not matter), and under the home directory the credential stores `~/.ssh`, `~/.gnupg`, `~/.aws`, `~/.azure`, `~/.kube`, `~/.docker`, `~/.config/gh`, `~/.claude`, `~/.codex`, `~/.git-credentials`, `~/.netrc` (the webview's fs deny scope), plus `~/AppData/Roaming/GitHub CLI`, `~/AppData/Roaming/gcloud`, `~/.config/gcloud`, `~/.npmrc`, `~/.pypirc`, `~/.cargo/credentials.toml` and `~/.cargo/credentials`. The error is ``This Path Holds Credentials And Is Never Accessible.`` A hard link to a secret is not detected.
- **App state (writes).** A write whose canonical target is a file directly in the app data directory named with the prefix `swarm-events.db`, `sessions.json`, `daemon.lock`, `swarm-settings.json`, `swarm-snapshots.json` or `swarm-templates.json` (leading dots ignored, any case) is refused: ``This Path Holds The App's Own State And Is Never Writable.``
- **Windows file names (writes).** A write is refused when the file name contains `:` (an NTFS alternate data stream such as `swarm-config.json:x` or `::$DATA`), ends in `.` or a space (Win32 strips them, aliasing the name without them), or has a reserved device stem (`CON`, `PRN`, `AUX`, `NUL`, `COM1`-`COM9`, `LPT1`-`LPT9`, and the superscript forms `COM¹` `COM²` `COM³` `LPT¹` `LPT²` `LPT³`, with or without an extension): ``Cannot Write "<path>": The File Name Is Not Allowed.`` The helper is platform-independent and tested everywhere; only Windows applies it.

### `read_file`

Reads a UTF-8 regular file of at most 16 MiB at an absolute path.

**Parameters:**

| Name   | Type     | Required | Description             |
|--------|----------|----------|---------------------------|
| `path` | `string` | Yes      | Absolute path to read   |

**Returns:** `string` -- the file's full text content.

**Errors (strings):**

| Error                        | Condition                                    |
|-------------------------------|-----------------------------------------------|
| `Read Requires An Absolute Path.` | `path` is not absolute                    |
| `Read Access Is Limited To The App Data And Home Directories.` | The canonical path falls outside both scopes |
| ``File Not Found: "<path>".`` | The file does not exist (reported only for in-scope paths) |
| `This Path Holds Credentials And Is Never Accessible.` | The canonical path is on the deny list |
| ``The Operating System Denied Access To "<path>".`` | The OS itself refused (in-scope path, OS-level permission error) |
| ``Cannot Read "<path>": Not A Regular File.`` | The canonical path is a directory, FIFO, device or other non-regular file |
| ``Cannot Read "<path>": The File Is Larger Than 16 MiB.`` | The file exceeds 16 MiB (checked on the stat and again on the bytes read) |
| ``Failed To Read "<path>": ...`` | Any other I/O failure, including a file that is not UTF-8 |
| ``"read_file" Is Not Available Over A Remote Connection.`` | The call arrived through `swarmd` |

**Example:**

```typescript
const content = await invoke<string>("read_file", { path: "/home/user/notes.txt" });
```

**Emits:** Nothing -- a read is not a causally interesting side effect.

---

### `write_file`

Writes a file at an absolute path, creating or overwriting it, then emits a stamped, persisted `file_written` event. The file is written to the canonical path it resolves to; the event carries the normalized path as given.

**Parameters:**

| Name           | Type     | Required | Description                        |
|----------------|----------|----------|-------------------------------------|
| `path`         | `string` | Yes      | Absolute path to write             |
| `content`      | `string` | Yes      | Text content to write              |
| `originWorker` | `string` | No       | UUID of the causer (e.g. the AI turn whose `write_file` tool call triggered this write). |
| `causeSeq`     | `number` | No       | `seq` this write is reacting to.   |

**Returns:** `void`

**Errors (strings):**

| Error                         | Condition                                    |
|--------------------------------|-----------------------------------------------|
| `Write Requires An Absolute Path.` | `path` is not absolute                   |
| `Write Requires A File Path.` | The normalized path has no file name (for example `/` or `C:\`) |
| `Write Access Is Limited To The App Data And .swarm Directories.` | The canonical path falls outside both scopes |
| `This Path Holds Credentials And Is Never Accessible.` | The canonical target is on the deny list |
| `This Path Holds The App's Own State And Is Never Writable.` | The canonical target is one of the app's own state files directly in the data directory (`swarm-events.db`, `sessions.json`, `daemon.lock`, `swarm-settings.json`, `swarm-snapshots.json`, `swarm-templates.json`, or a name with one of them as a prefix; leading dots ignored, any case) |
| ``Cannot Write "<path>": The File Name Is Not Allowed.`` | Windows only: an alternate data stream, a trailing dot or space, or a device name |
| ``Cannot Write "<path>": Dangling Symbolic Link.`` | The target is a symbolic link whose destination does not exist |
| ``Cannot Write "<path>": Parent Directory Does Not Exist.`` | The parent directory doesn't exist (nothing is created) |
| ``The Operating System Denied Access To "<path>".`` | The OS itself refused the write |
| ``Failed To Write "<path>": ...`` | Any other I/O failure |
| ``Invalid UUID "<id>": ...``   | `originWorker` is present but not a valid UUID |

**Example:**

```typescript
await invoke("write_file", {
  path: "/home/user/.swarm/notes.txt",
  content: "Hello, SWARM.",
  originWorker: callingWorkerId,
  causeSeq: turnSeq,
});
```

**Emits:** `file_written` envelope with payload `{ path, bytes }`, carrying `originWorker`/`causeSeq` when given.

---

## Config Commands

Read and write the app's persisted key/value configuration, a single JSON object at `<data-dir>/swarm-config.json`. Writes are atomic and keep every other key. On a write, a malformed file is moved aside (`swarm-config.json.corrupt-<ms>`) and a fresh config started; a file that exists but cannot be read is never overwritten. Keys the backend itself reads or writes include `max_workers`, `agent_concurrency`, `default_repo_root` and `shipCoAuthoredBy`; the Anthropic API key (`anthropic_api_key`) lives here too.

Over the `swarmd` WebSocket both commands are **`SecretFiltered`**: a secret-shaped key (see [Who Can Call What](#who-can-call-what)) is refused before the handler runs, in both directions, so a remote client can neither read the API key nor plant a credential the desktop app would trust. The desktop webview is not filtered: it legitimately reads `anthropic_api_key` to call the Anthropic API itself.

### `read_config`

**Parameters:** `{ key: string }`

**Returns:** the stored value (any JSON value), or `null` if the key is unset. A missing config file, or a malformed one (logged without its contents), also reads as `null`.

**Errors:** `Config error: Failed To Read <path>: ...` when the file exists but cannot be read (locked, permission denied). The message carries path and I/O context, never a value.

---

### `write_config`

**Parameters:** `{ key: string, value: <any JSON value> }`

**Returns:** `void`

**Errors:** `Config error: ...` when the existing file cannot be read (it is left untouched), a malformed file cannot be moved aside, or the new file cannot be written. The message carries path and I/O context, never a value.

---

## Metrics Commands

### `get_metrics`

Returns a snapshot of host usage, the worker count per state, and each worker's process-tree usage.

**Parameters:** None

**Returns:** `MetricsSnapshot`, a JSON object combining system, aggregate worker, and per-worker metrics.

| Field          | Type            | Description                              |
|----------------|-----------------|-------------------------------------------|
| `cpuPercent`   | `number`        | Global CPU usage percentage, via `sysinfo` |
| `memoryMb`     | `number`        | Used system memory in megabytes, via `sysinfo` |
| `memoryTotalMb` | `number`       | Installed system memory in megabytes, via `sysinfo` |
| `totalWorkers` | `number`        | Total registered workers                 |
| `running`      | `number`        | Workers in `running` state               |
| `paused`       | `number`        | Workers in `paused` state                |
| `idle`         | `number`        | Workers in `idle` state (always `0`: the backend never produces that state) |
| `errored`      | `number`        | Workers in `error` state                 |
| `perWorker`    | `PerWorkerMetric[]` | Per-worker process metrics (see below) |

**`PerWorkerMetric` object:**

| Field         | Type             | Description                                         |
|---------------|------------------|------------------------------------------------------|
| `workerId`    | `string` (UUID)  | UUID of the worker                                  |
| `pid`         | `number \| null` | OS process ID of the worker's shell, if it has one  |
| `cpuPercent`  | `number`         | CPU usage of the shell and every process descended from it, in percent of one core (`0` if no PID or the shell is gone, and on the first call: usage is a delta between refreshes) |
| `memoryBytes` | `number`         | Resident memory of the shell and every process descended from it, in bytes (`0` if no PID or the shell is gone) |

**Example:**

```typescript
const metrics = await invoke("get_metrics");
console.log(`${metrics.running}/${metrics.totalWorkers} workers running`);
for (const w of metrics.perWorker) {
  console.log(`${w.workerId}: ${w.cpuPercent.toFixed(1)}% CPU, ${w.memoryBytes} bytes`);
}
```

**Note:** This is the pull-based complement to the push-based `system_metrics` event (emitted every 500 ms; ephemeral -- it consumes a seq but is never persisted). Both read from the same `SharedSystem` (one `sysinfo::System` behind a `parking_lot::Mutex`), so CPU deltas come from a single source of truth. `system_metrics` carries only measured values: nothing counts provider requests, so there is no request-rate field and the metrics page (`MetricsOverview.tsx`) shows no request-rate tile.

---

## Bus Commands

The message bus lets workers address each other (or everyone) by topic. It does not deliver messages itself: every `bus_send` becomes a `bus_message` event on the ordered stream, stamped with the sender as `originWorker`, so every frontend and remote client sees it live and a replay sees it again. A multi-stage hand-off is a chain of `causeSeq` links. The `MessageBus` keeps only the registry of topic names in use, bounded at 1024. No shipped UI surface calls these two commands; see [Built, Not Wired](#built-not-wired).

### `bus_send`

Records a message from one worker to another (or to every listener) on a topic.

**Parameters:**

| Name           | Type                | Required | Description                                          |
|----------------|---------------------|----------|--------------------------------------------------------|
| `fromWorkerId` | `string`            | Yes      | UUID of the sending worker                              |
| `toWorkerId`   | `string \| null`    | No       | UUID of the target worker. Omit/`null` to broadcast     |
| `topic`        | `string`            | Yes      | Topic channel to send on; a new name registers it       |
| `payload`      | `unknown` (JSON)    | Yes      | Arbitrary JSON payload                                  |
| `causeSeq`     | `number \| null`    | No       | The `seq` of the event that caused this send (e.g. an `agent_turn_started` or `agent_tool_call` a handoff is reacting to), stamped as the `bus_message` envelope's `causeSeq` |

**Returns:** `0`: the bus delivers nothing itself (every send is a `bus_message` event on the ordered stream), so there are no bus-level receivers. The number keeps the result type stable.

**Errors (strings):**

| Error         | Condition                                    |
|---------------|------------------------------------------------|
| ``Invalid UUID "<id>": ...`` | `fromWorkerId` or `toWorkerId` is not a valid UUID |
| `Too Many Bus Topics: The Limit Is 1024.` | `topic` is new and the registry is full; nothing is recorded |
| `Event Writer Unavailable.` | The event was dropped (the engine is shut down, or the writer could not persist it, see [Failing Closed](#failing-closed)); nothing is delivered |
| `Bus Send Timed Out.` | The event was not recorded within five seconds. It stays queued and may still be recorded and delivered, so a retry can duplicate the hand-off |

**Example:**

```typescript
await invoke("bus_send", {
  fromWorkerId: workerA,
  toWorkerId: workerB, // omit for broadcast
  topic: "task:result",
  payload: { status: "done", output: "..." },
  causeSeq: null,
});
```

**Emits:** `bus_message` envelope with payload `{ messageId, fromWorker, toWorker, topic, payload }`. The envelope's `originWorker` is `fromWorker`; `causeSeq` is this call's `causeSeq`, when given. The sender is not checked against the worker registry.

---

### `bus_list_channels`

Lists the bus topics in use, sorted.

**Parameters:** None

**Returns:** `string[]`

**Example:**

```typescript
const topics = await invoke("bus_list_channels");
```

---

## Native Commands (Desktop Only)

`swarm_core::commands::NATIVE_ONLY`: desktop only, no registry entry, not reachable through `swarmd`.

### `check_for_updates`

Asks the endpoint configured in `plugins.updater` (`tauri.conf.json`: the repository's `releases/latest/download/latest.json`) whether a newer release exists. **Check only:** the app tells the user an update is available and never downloads or installs it. (The plugin verifies a downloaded update's minisign signature, and with `requireSignedVersion` the version it signs; the app does not download today.)

**Parameters:** None (the `AppHandle` is injected automatically)

**Returns:** `UpdateCheckResult`, a JSON object whose absent fields are omitted entirely:

| Field       | Type                | Description                                  |
|-------------|---------------------|------------------------------------------------|
| `available` | `boolean`           | Whether the endpoint announces a newer version |
| `version`   | `string` (optional) | Version of the available update               |
| `body`      | `string` (optional) | Release notes, if any                          |
| `date`      | `string` (optional) | Publication date as the manifest states it (RFC 3339) |

**Errors (string):** the updater's message when it is not configured or the check fails (network error, malformed manifest).

**Example:**

```typescript
const update = await invoke("check_for_updates");
if (update.available) {
  console.log(`Update ${update.version} available:`, update.body);
}
```

The signing keypair, the `plugins.updater.pubkey` value and the release flow are described in [Updater Keys](updater-keys.md).

---

### `send_notification`

Shows a native OS notification through `tauri-plugin-notification`. Fire-and-forget: `Ok` means the notification was handed to the OS, not that it was displayed (the user may have muted the app).

**Parameters:**

| Name    | Type              | Required | Description                        |
|---------|-------------------|----------|--------------------------------------|
| `title` | `string`          | Yes      | Notification title                   |
| `body`  | `string`          | Yes      | Notification body text               |

**Returns:** `void`

**Errors (string):** the plugin's message when the notification cannot be built, e.g. the executable path cannot be read to derive the Windows app id.

**Example:**

```typescript
await invoke("send_notification", {
  title: "Worker finished",
  body: "Research Agent completed its task.",
});
```

---

## Events

Every backend event -- worker lifecycle, session lifecycle, agent streaming, metrics, logs, bus messages, ship receipts -- travels on a **single** channel as a seq-ordered envelope: `swarm://events` on Tauri (`swarm_core::orchestration::EVENT_CHANNEL`), and bare `event` frames on the `swarmd` WebSocket. There are no per-domain channels; `listen()` against anything else is not part of the contract. The event set is the `SwarmEvent` enum in `crates/swarm-core/src/events/emitter.rs`: **27** types.

### The Envelope

```json
{ "seq": 42, "ts": 1752099600123, "type": "worker_spawned", "payload": { "workerId": "...", "name": "...", "pid": 1234, "isolation": "worktree" } }
```

A stamped envelope additionally carries `originWorker`/`causeSeq`:

```json
{ "seq": 57, "ts": 1752099601000, "originWorker": "b2c3...", "causeSeq": 55, "type": "worker_spawned", "payload": { "workerId": "a1b2...", "name": "Sub-Agent", "pid": 5678, "isolation": "none" } }
```

| Field          | Type                | Description                                                          |
|----------------|---------------------|------------------------------------------------------------------------|
| `seq`          | `number`            | Monotonic sequence number assigned by the single-writer engine. Wire order == seq order; never reused (not even across restarts: the engine reserves blocks of seqs in the log), never reordered. |
| `ts`           | `number`            | Unix timestamp in milliseconds, assigned by the writer thread.        |
| `originWorker` | `string` (optional) | UUID of the worker whose action **caused** this event, when known. Absent (not `null`) when unattributed -- present only when the engine was given an explicit causer to record. |
| `causeSeq`     | `number` (optional) | `seq` of the event this one is causally reacting to, when known. Typically an `agent_turn_started` seq. |
| `type`         | `string`            | Event type tag, `snake_case` (e.g. `"worker_spawned"`).               |
| `payload`      | `object`            | The event's data, `camelCase` fields -- shape depends on `type`.       |

`seq` is assigned by one dedicated writer thread (`OrchestrationEngine`) that every backend call routes through via `EventSink`, so there is a single, total order across every event type.

**The subject-vs-causer rule:** a payload's own `workerId` field is the **SUBJECT** of the event -- whose worker spawned, whose PTY got input, whose file was written. `originWorker` on the envelope is the **CAUSER** -- who made it happen. For a human-driven action (clicking Spawn on the Workers page, typing into a terminal) the two are typically unrelated or `originWorker` is simply absent; for a tool-driven action (an AI turn's `spawn_worker` / `kill_worker` / `worker_input` / `write_file` tool call) `originWorker` is the panel worker whose turn issued the call, while the payload's `workerId` is the worker that got spawned, killed or written to -- **and that difference is the causal edge** the provenance graph is built from. The engine records this attribution; it never infers it (see `EventSink::emit_with` in `crates/swarm-core/src/events/emitter.rs`).

### Type Tags

| Type                  | Payload                                                        | Persisted |
|-----------------------|-----------------------------------------------------------------|-----------|
| `worker_spawned`      | `{ workerId, name, pid, isolation }` -- `isolation` is `"worktree"` or `"none"` | Yes       |
| `worker_killed`       | `{ workerId }`                                                   | Yes       |
| `worker_output`       | `{ workerId, data }`                                             | No (ephemeral) |
| `worker_state`        | `{ workerId, state }` -- `state` is `"running"`, `"paused"` or `"error"` (the shell exited on its own) | Yes       |
| `worker_input`        | `{ workerId, bytes, source, preview? }` -- `source` is `"terminal"`, `"tool"`, or `"automation"`; `preview` (at most 120 characters of the redacted text, or `[preview withheld: line editing]` when the input contains any control other than CR or LF (BS, DEL, TAB, ESC, C1 controls)) is present only for `source ∈ {tool, automation}` -- see [Persistence Policy](#persistence-policy) | Only when `source != "terminal"` |
| `session_created`     | `{ sessionId, name }`                                            | Yes       |
| `session_deleted`     | `{ sessionId }`                                                  | Yes       |
| `session_worker_added` | `{ sessionId, workerId }` -- emitted by [`session_add_worker`](#session_add_worker) only when membership actually changed | Yes |
| `session_worker_removed` | `{ sessionId, workerId }` -- emitted by [`session_remove_worker`](#session_remove_worker); persisted so a backfilling client reconstructs the same membership a live listener observed | Yes |
| `system_metrics`      | `{ cpuPercent, memoryMb, memoryTotalMb, workerCount, timestamp }` -- every 500 ms | No (ephemeral) |
| `system_log`          | `{ level, message, target, timestamp }` -- backend notices such as the git startup probe | No (ephemeral) |
| `bus_message`         | `{ messageId, fromWorker, toWorker, topic, payload }` -- `originWorker` on the envelope is stamped from `fromWorker` | Yes       |
| `worktree_created`    | `{ workerId, sessionId, repoRoot, worktreePath, branch, baseCommit }` -- its own `seq` is the range start for "what changed" queries | Yes |
| `worktree_removed`    | `{ workerId, worktreePath, branch, disposition, headCommit, reason }` -- `disposition` is `"removed"`, `"preserved_dirty"`, or `"failed"` | Yes |
| `ship_progress`       | `{ shipId, workerId, step, status, detail }` -- `step` is free-form (`"staging"`, `"commit"`, `"push"`, `"compare"`); `status` is `"running"`, `"ok"`, or `"error"` | Yes |
| `ship_settled`        | `{ shipId, workerId, commitSha, pushedRef, prUrl, status, error }` -- terminal receipt, exactly once per `shipId`; `error` is a `ShipError` object when `status == "error"` | Yes |
| `commit_created`      | `{ workerId, sha, branch, seqFrom, seqTo }` -- mirrors the commit's own `Swarm-Seq-Range` trailer | Yes |
| `file_written`        | `{ path, bytes }` -- emitted by [`write_file`](#write_file) only; a read emits nothing | Yes |
| `agent_turn_started`  | `{ workerId, model, requestId }` -- the causal root a turn's tool-driven side effects cite as `causeSeq` (see [`agent_turn_started`](#agent_turn_started)) | Yes |
| `agent_session_started` | `{ workerId, provider, sessionKey, model, cwd, capabilities }` -- `capabilities` is `{ partialDeltas, resume, nativeCost, permissionModes, cancelGranularity, interruptMidturn, worktreeAware, interactivePermissions }` | Yes |
| `agent_turn_delta`    | `{ workerId, turnId, blockIndex, kind, text }` -- one streamed sub-message chunk within a turn | **No (ephemeral)** |
| `agent_block`         | `{ workerId, turnId, blockIndex, kind, content }` -- durable counterpart to `agent_turn_delta`; replay reconstructs full turns from these rows, only the typing animation is lost | Yes |
| `agent_tool_call`     | `{ workerId, turnId, toolUseId, name, input }`                   | Yes |
| `agent_tool_result`   | `{ workerId, turnId, toolUseId, isError, content }` -- `toolUseId` correlates with the originating `agent_tool_call` | Yes |
| `agent_permission_request` | `{ workerId, turnId, requestId, tool, input, suggestedDecision?, denialSubclass?, message? }` -- two shapes. **Pending** (no `suggestedDecision`): the provider is blocked until [`agent_permission_respond`](#agent_permission_respond) answers `requestId`. **Report** (`suggestedDecision: "deny"`, Claude Code only): a denial the provider already made, with `denialSubclass` one of `"mode"` / `"ungranted_write"` / `"redirection_guard"` (absent when unclassified) and `message` the provider's text; nothing is left to answer | Yes |
| `agent_turn_settled`  | `{ workerId, turnId, status, error, costUsd, usage, durationMs, numTurns }` -- terminal receipt, exactly once per turn, synthesized on ungraceful child exit too; `status` is `"ok"` or `"error"` | Yes |
| `agent_session_exited` | `{ workerId, exitCode, signal }`                                | Yes |

### Unified Bus Event Contract

`bus_message` envelopes are delivered through exactly one path: [`bus_send`](#bus_send) records the event itself, synchronously, the moment a message is sent (`Router::send` in `crates/swarm-core/src/bus/router.rs`). Each message therefore reaches every client **exactly once**, in one consistent shape, and appears in a replay; no active subscriber is required and there is no second delivery primitive that could drift out of sync with this one.

### Persistence Policy

`worker_output`, `system_metrics`, `system_log` and `agent_turn_delta` are high-frequency telemetry: they still flow through the ordered stream and each consumes a `seq`, but they are **never written to the log**. They cannot be backfilled after a gap and will not appear in [`events_since`](#events_since) -- treat them as best-effort, live-only.

**`worker_input` has a field-level carve-out on top of the variant-level rule above:** `source == "terminal"` rows (raw human keystrokes) are also excluded from persistence, even though the `worker_input` type itself persists for `source ∈ {tool, automation}`. A per-keystroke durable row would both flood the log and archive whatever the user typed into a shell -- including secrets -- so terminal input is deliberately ephemeral: it reaches the wire (and consumes a `seq`) but is never written to `swarm-events.db`.

Every other type persists to the SQLite event log (`<data-dir>/swarm-events.db`, WAL mode) before it is emitted ([Failing Closed](#failing-closed)), so it survives a gap or a restart and can be replayed via `events_since`. Persisted rows carry nullable `origin_worker` / `cause_seq` columns added by a `PRAGMA user_version` migration ladder; rows written before that migration have both `NULL`, the truthful historical value.

### Failing Closed

A persistent event is appended to the log before anything is delivered, and a seq nobody can prove durable is never shown. The writer (`crates/swarm-core/src/orchestration/engine.rs`) fails closed on both write failures:

- **Seq reservation fails** (the writer reserves seqs in blocks; it retries once). The event is dropped whole: no delivery, no head move, and the seq counter is rolled back so the next event retries the reservation. One error line is logged per outage.
- **The append fails.** Nothing is emitted on either delivery path (not the shell's `emit` closure, not the swarmd fanout), `head_seq` does not move, and the event's `emit_awaiting_seq` receiver (what [`agent_turn_started`](#agent_turn_started) waits on for its seq) resolves to an error, the same signal as a shut-down engine. The failed seq stays a gap, and one ephemeral `system_log` error event (`Event <seq> (<type>) Could Not Be Saved And Was Dropped: ...`) takes the next seq so a client sees the gap explained. A client treats a gap as ephemeral and backfills an empty page from [`events_since`](#events_since).

So every persistent event a client has seen live is readable from the log. Ephemeral events are not appended, so they cannot fail this way. If even the explanatory `system_log` cannot get a seq, only the tracing line remains and the head is unchanged.

### Receipts

Some request/response flows use a dedicated terminal event (a "receipt") instead of a boolean flag buried in a stream event, so callers have one unambiguous signal to await:

- **`agent_turn_settled`** -- exactly once per provider-agent turn, on success AND on ungraceful child exit (a caller mid-turn when the provider process is killed still gets a terminal event, with `costUsd` and `usage` honestly `null` rather than fabricated). A turn that cannot start (no live session, rejected) gets a synthesized one too.
- **`ship_settled`** -- emitted exactly once per `shipId`, after the last `ship_progress` row, on both success and failure. `src/hooks/useShip.ts` awaits it from whichever of `git_stage_commit`, `git_push` or `ship_compare_url` is the chosen action's final step (`finalStep: true`, or the compare call), registering its listener (`armSettledWait`, an `onEvent` subscription) *before* triggering the call that might emit it and starting the 30 s `waitFor` only after that call resolves: event delivery and the IPC response are two independent transport paths with no ordering guarantee between them, so the listener must already be armed when the event fires.

The frontend's `waitFor(predicate, timeoutMs?)` (in `src/lib/event-bus.ts`) is the general primitive for receipts: it resolves the first envelope matching `predicate`, or rejects on timeout (default 5000 ms).

### `events_since`

```typescript
const events = await invoke("events_since", { afterSeq: 100 });
```

Returns **persisted** envelopes with `seq > afterSeq`, ascending, in the same shape a live envelope has. Used by the frontend to backfill after a detected sequence gap (`connectEventBus` in `src/lib/event-bus.ts`), and by `swarmd` (which reads the same log directly) to replay history to a reconnecting client. Ephemeral types (`worker_output`, `system_metrics`, `system_log`, `agent_turn_delta`, and `worker_input` rows with `source == "terminal"`) never appear in the result, by construction. An engine with no database file has no history and returns an empty page; a configured database file that is missing is an error.

**Parameters:**

| Name       | Type     | Required | Description |
|------------|----------|----------|--------------|
| `afterSeq` | `number` | Yes      | Return events with a greater `seq` |
| `limit`    | `number` | No       | Page size, default and maximum 5000 (`PAGE_LIMIT`); a larger value is silently clamped, not rejected |

`limit` exists for single-row backward hops (`events_since({ afterSeq: causeSeq - 1, limit: 1 })`) as well as bulk backfill, which always wants the largest page.

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

Application code does not call `listen()` directly -- it goes through `src/lib/event-bus.ts`, which validates every envelope with zod, drops duplicates (`seq <= lastSeq`), and on a detected gap buffers live events, backfills through `events_since`, and flushes them seq-sorted afterwards. An empty backfill page means the rest of the gap was ephemeral and is skipped; a failed backfill is retried with exponential backoff and given up on after a bounded number of attempts. It exposes:

```typescript
import { connectEventBus, onEvent, waitFor } from "#lib/event-bus";

// Once, at app bootstrap:
await connectEventBus();

// Worker output (high frequency -- PTY data)
onEvent("worker_output", (e) => {
  const { workerId, data } = e.payload;
  terminal.write(data);
});

// System metrics (every 500ms)
onEvent("system_metrics", (e) => {
  const { cpuPercent, memoryMb, memoryTotalMb, workerCount, timestamp } = e.payload;
  updateMetricsChart({ cpuPercent, memoryMb, memoryTotalMb, workerCount, timestamp });
});

// Bus messages -- delivered unconditionally, no subscription call needed
onEvent("bus_message", (e) => {
  const { topic, payload } = e.payload;
  console.log(`[${topic}]`, payload);
});

// A receipt: await a specific ship_settled instead of polling
const settled = await waitFor((e) => e.type === "ship_settled");
```

Typed handlers receive the payload parsed by the schema for its event type (`EVENT_PAYLOAD_SCHEMAS` in `src/lib/event-payloads.ts`); an envelope whose payload does not match is logged and not delivered to typed handlers.

---

## Wire Protocol (swarmd)

Everything above describes the Tauri IPC transport (`invoke` / `listen` over `@tauri-apps/api`). `swarmd`, the headless daemon, exposes the SAME registry commands (every command in this document except the [Native Commands](#native-commands-desktop-only) -- `swarm_core::commands::NATIVE_ONLY` -- so 36) and the SAME envelope shape, over one authenticated WebSocket at `/ws`. Frame types are defined once, serde-only, in `swarm_core::protocol` (`crates/swarm-core/src/protocol.rs`, `PROTOCOL_VERSION` 1); the browser-side client is `src/lib/transport.ts`'s `wsTransport`. The server side is `crates/swarmd/src/ws.rs`; running and installing the daemon is covered in [The swarmd Daemon](daemon.md).

### Connecting

```text
1. Open a WebSocket to  ws://<host>:<port>/ws  (wss:// behind a TLS proxy)
2. Send  hello  as the FIRST frame, within 5 seconds, or the server closes the socket
3. Receive  ready  (handshake ack)
4. If hello.lastSeq was non-null: receive zero or more  event  frames (replay), then  replayEnd
   If hello.lastSeq was null (cold attach): receive  replayEnd  immediately, no replay
5. Live: event frames continue arriving; send  rpc  at any time, receive matching  rpcResult
```

Reconnects are just a new socket, from step 1 -- the client's own gap detection (`event-bus.ts`) treats every reattach identically to the original connection. `lastSeq` stays valid across a daemon restart, because seqs never repeat.

The same listener serves nothing but `/ws`, plus the optional static web bundle at `/` when the daemon runs with `--serve-ui DIR` (`pnpm build:web` builds it with `__SWARM_TRANSPORT__` set to `"ws"`; responses carry a strict CSP with `connect-src 'self'` and `frame-ancestors 'none'`, and hidden path segments are 404).

### Frames

Every frame is one JSON text WebSocket message. Five carry a `"frame"` tag; the sixth (`event`) is deliberately BARE:

| Frame | Direction | Wrapped? | Shape |
|-------|-----------|----------|-------|
| `hello` | client -> server | `{"frame":"hello", ...}` | `{ lastSeq: number \| null, token?: string }` |
| `ready` | server -> client | `{"frame":"ready", ...}` | `{ serverSeq: number, version: number, caps: { maxFrameBytes, maxConnections, replayPageSize } }` -- `serverSeq` is the head seq at attach; the caps are the server's limits (below) |
| `event` | server -> client | **bare** -- no `"frame"` key | The exact `DomainEvent` envelope shape from [Events](#events) (`{ seq, ts, originWorker?, causeSeq?, type, payload }`) |
| `replayEnd` | server -> client | `{"frame":"replayEnd", ...}` | `{ seq: number }` -- the replay burst (possibly empty) for THIS hello is over; a client is live only after the `replayEnd` of its CURRENT `hello` |
| `rpc` | client -> server | `{"frame":"rpc", ...}` | `{ id: string, cmd: string, args?: object }` -- `cmd` is any registry command name; omitted or `null` `args` mean none |
| `rpcResult` | server -> client | `{"frame":"rpcResult", ...}` | `{ id: string, ok: boolean, result?: unknown, error?: unknown }` -- correlated to the `rpc` frame by `id`; exactly one of `result`/`error` is present, mirroring `Result<Value, Value>` (the error is a string, or a structured value for the commands that have one) |

A receiver distinguishes an `event` frame from every control frame by the ABSENCE of a `"frame"` key -- a `DomainEvent` never has one, and every control frame always does. This is the exact demux `wsTransport`'s `message` handler performs. A malformed `rpc` frame whose `id` is readable is answered with `Malformed RPC Frame: ...`; one whose `id` is not is ignored (logged server-side). A second `hello` on an established connection is ignored too.

### Auth

There is no unauthenticated mode and no flag that enables one. Three checks run, in this order:

1. **Host and Origin allow-list, on every request** (the `--serve-ui` routes as well as `/ws`). WebSocket upgrades are exempt from CORS, and a DNS-rebinding page can make a browser send requests to a loopback daemon under an attacker's host name, so the `Host` header (required; HTTP/2's authority counts) and an `Origin` header (when the client sends one) must each name this daemon, or the request is refused with `403` and the reason. A name is accepted when it is: the concrete local address the TCP connection arrived on, as an IP literal with the same port (what makes `--bind 0.0.0.0` usable: a LAN client's `Host: 192.168.1.5:8787` names the interface it reached); any loopback spelling (`localhost`, `127.0.0.0/8`, `::1`) with the same port, when the connection arrived on loopback; or an operator-supplied `--allow-host NAME[:PORT]` entry (a reverse proxy or MagicDNS name; an entry without a port matches any port). Every other DNS name is rejected.
2. **Admission.** A valid `Authorization: Bearer <token>` header on the upgrade takes a connection slot directly. Any other upgrade takes a slot from a separate, smaller pool of pending handshakes (at most 4 per client address, an IPv6 client counted by its `/64`; loopback peers have only the pool), so sockets that never authenticate cannot occupy an authenticated client's slot. A full daemon or pool refuses the upgrade with `503`.
3. **The token.** `hello.token` (or the Bearer header) must match the daemon's 256-bit token, constant-time compared. The token is minted once per data directory (`getrandom`, 64 hex characters) and persists at `<data_dir>/daemon-token` across restarts, created atomically and already private (mode `0600` on Unix; on Windows a DACL reduced to the current user's SID). A client authenticating through `hello` takes its slot after the token is checked, or is closed with `1013 Try Again Later` if the daemon filled up meanwhile.

Close codes: `1008 Policy Violation` (no `hello` within 5 s, or a first message that is not a valid `hello`), `4401` (wrong token), `1013` (daemon full), `1011 Internal Error` (the replay could not read the log: the client reconnects and retries rather than believing it is caught up), `1001 Going Away` (the daemon is shutting down). Messages, and single frames, are capped at 2 MiB from the first byte, authenticated or not.

The daemon prints its connect URL with the token ONLY in the fragment, and only to a terminal; under a service manager it logs the address and the command that prints the URL (`swarmd connect-url`):

```text
SWARM Daemon Listening On http://127.0.0.1:8787/#t=<token>
```

The browser client reads the fragment on first load, persists it to `sessionStorage` (with an in-memory fallback), and scrubs it from the URL immediately (`history.replaceState`) -- it never survives as part of a bookmarkable, shareable, or screenshot-visible URL, and (being a fragment, not a query param) is never sent to the server or logged by an intermediary proxy.

Past authentication, every `rpc` goes through `Registry::dispatch_remote`, which applies each command's `RemotePolicy` (see [Who Can Call What](#who-can-call-what)): `read_file` / `write_file` are `Denied` outright, `read_config` / `write_config` are `SecretFiltered`, and everything else is `Allowed`. A contract test pins both sets.

**The trust boundary this does NOT close:** an authenticated remote client gets arbitrary command execution on the daemon's host. [`spawn_worker`](#spawn_worker) takes `shell` / `env` / `cwd` and starts a real process; [`worker_input`](#worker_input) writes raw bytes to that process's stdin. This is not an oversight -- running commands on the host IS the product (a worker is a PTY-backed shell, and driving it remotely is the whole point). The token is the ONLY thing standing between "an authenticated SWARM user" and "a shell as the user running `swarmd`" -- treat it exactly like an SSH private key: never commit it, never paste it into a chat, and assume anyone who has it can do anything that user can do. `RemotePolicy` narrows WHICH commands are reachable at all (no filesystem browsing, no secret-key access) but does not, and cannot, sandbox what an *allowed* command can do once invoked.

### Limits

| Limit | Value |
|---|---|
| Authenticated connections (`maxConnections`) | 32 |
| Pending (pre-`hello`) handshakes / per client address | 16 / 4 |
| Message and frame size (`maxFrameBytes`) | 2 MiB |
| Time to send `hello` | 5 s |
| In-flight `rpc` calls per connection | 8 |
| Replay page size (`replayPageSize`) | 5000 |
| Shutdown drain | up to 5 s for requests, again up to 5 s for sockets and in-flight RPCs |

### Replay and backpressure

`lastSeq` in `hello` resumes exactly where a disconnected client left off: the server pages `events_since(lastSeq, 5000)` from the log until a short page arrives, sending each row as an `event` frame, then sends `replayEnd`. The connection subscribes to the engine's fanout BEFORE reading the head seq, so nothing published in between is missed, and a seq filter drops whatever a replay already delivered. `lastSeq: null` is a cold attach -- no replay at all; the client hydrates via the snapshot commands (`list_workers`, `list_sessions`, ...), exactly like a fresh desktop launch.

`ready`, `replayEnd`, and every `event` frame (replayed or live) share ONE bounded (4096) FIFO lane per connection -- this is what guarantees wire order matches seq order; splitting them across lanes would let a live event race a replay page and deliver frames out of seq order. Persistent events always enqueue, blocking the CONNECTION (never the engine) if the lane is momentarily full. Ephemeral events (`worker_output`, `system_metrics`, `system_log`, `agent_turn_delta`, terminal-source `worker_input`) are dropped once 512 frames are queued, so an ephemeral flood can never starve a persistent frame's send -- but anything that DOES get enqueued keeps its FIFO position. A slow link degrades to a choppy terminal and sparse metrics, never a stale or wrong application state.

`rpcResult` frames (no seq, no ordering relationship to the event stream) and close frames ride a separate bounded (256) control lane that the writer always serves first, so a PTY flood cannot delay an RPC result -- the command that would stop the flood among them. Concurrently in-flight `rpc` tasks are capped per connection (8): above the cap, a new `rpc` frame gets an immediate `rpcResult` with `ok: false` and `Too Many Concurrent RPC Calls On This Connection.` rather than spawning an unbounded number of handler tasks. The client-side `wsTransport.invoke` additionally gives every outstanding `rpc` a 30-second timeout, rejecting with a typed error if no `rpcResult` ever arrives (a wedged connection fails loud instead of hanging).

A connection that falls behind the server's broadcast fanout sees `RecvError::Lagged` internally -- the server heals it by re-running the identical `events_since` paging from its own last-sent cursor, transparently to the client (no "lag" frame exists; it looks like an ordinary, possibly-larger replay burst). Healing is repeatable.

---

## Built, Not Wired

Implemented and tested in Rust, but with no frontend caller in the shipped app (or with a placeholder value). They are the backend half of features that are not connected yet, and their examples above document what the Rust side does *if* called. `src-tauri`'s contract test `frontend_invokes_every_wired_command` pins the command list: a registry command with no frontend caller must be listed there, and one that gains a caller must be removed.

| Piece | Status |
|-------|--------|
| [`bus_send`](#bus_send), [`bus_list_channels`](#bus_list_channels) | Fully routed (`bus_message` reaches every client), but no UI surface invokes either. |
| [`get_session`](#get_session), [`agent_shutdown`](#agent_shutdown) | Registry commands with no frontend caller: the app lists sessions with `list_sessions`, and `kill_worker` shuts a session's agent down. The contract test lists both in `NOT_WIRED`. |
| Provider ids `opencode`, `gemini`, `webview_anthropic` | Reserved wire names with no Rust adapter: `agent_spawn` and `agent_probe` refuse them. The webview chat path (`webview_anthropic`) lives in TypeScript and cannot implement the session trait. |
| `WorkerState` `idle`, `worker_input` `source: "automation"` | Wire values the backend accepts but nothing produces today. |
