import { isTauri } from "@tauri-apps/api/core";
import type { UnlistenFn } from "@tauri-apps/api/event";
import * as z from "zod";
import type {
  ClaudeCodeTrustTier,
  PermissionDecision,
  ProbeReport,
  ProviderId,
} from "#lib/agent-events";
import { ProbeReportSchema } from "#lib/agent-events";
import { transport } from "#lib/transport";
import type {
  CommitOutcome,
  PushOutcome,
  Session,
  ShipContext,
  ShipError,
  ShipPreflight,
  StagingMode,
  Worker,
  WorkerProcessOptions,
} from "#store/types";
import {
  CommitOutcomeSchema,
  PushOutcomeSchema,
  SessionSchema,
  ShipContextSchema,
  ShipErrorSchema,
  ShipPreflightSchema,
  WorkerStateSchema,
} from "#store/types";

// ── Transport ────────────────────────────────────────
//
// Every backend command goes through the transport `#lib/transport`
// selects once at load: Tauri IPC in the desktop shell, a swarmd
// WebSocket `rpc` round trip in the `pnpm build:web` page. Both reject
// with the command's own error value (a string, or a structured object
// for ship and `agent_spawn` errors) and with an `Error` for transport
// failures. The typed wrappers below validate every response with zod
// before handing it on, and keep the original failure as the `cause`.

/**
 * `true` inside the Tauri desktop webview: `@tauri-apps/api/core`'s
 * `isTauri()`, which reads the `globalThis.isTauri` flag the shell
 * injects. Call sites that need something only the desktop shell
 * provides (`tauri-plugin-fs`/`-dialog`/`-opener`/`-notification`/
 * `-updater`, the webview-direct AI chat path) gate on this. A
 * `wsTransport` connection is a real backend but not a Tauri bridge, so
 * this is `false` there; see {@link hasTransport} and
 * `#lib/transport`'s `TransportCapabilities`.
 */
export { isTauri };

/**
 * `true` when some backend is reachable: the Tauri bridge or a swarmd
 * `wsTransport` connection. Commands that work over either transport
 * degrade on this instead of {@link isTauri}, so they work on a
 * swarmd-served page and still degrade in a plain `pnpm dev` browser
 * preview, where `tauriTransport` has no bridge.
 */
export function hasTransport(): boolean {
  return transport.capabilities.kind === "ws" || isTauri();
}

/**
 * Runs one backend command on the active transport. `T` is not checked:
 * validate the result (the typed wrappers below do) unless it is
 * `void`. Under `tauriTransport` without a bridge it resolves
 * `undefined`.
 */
export async function invoke<T = unknown>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  return transport.invoke<T>(cmd, args);
}

/**
 * Subscribes to a backend event channel on the active transport. A
 * no-op (with a no-op unlisten) when no transport can deliver events.
 */
export async function listen<T>(event: string, handler: (payload: T) => void): Promise<UnlistenFn> {
  return transport.listen<T>(event, handler);
}

/** Validates a command response, throwing `message` (with the zod error as `cause`) on a mismatch. */
function parseResponse<S extends z.ZodType>(schema: S, raw: unknown, message: string): z.output<S> {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new Error(message, { cause: parsed.error });
  return parsed.data;
}

/** Wraps a rejection value that is not already an `Error`, keeping it as the `cause`. */
function asError(err: unknown): Error {
  return Error.isError(err) ? err : new Error(String(err), { cause: err });
}

// ── Worker commands ──────────────────────────────────

/**
 * Causal attribution for an IPC call: the causer (`originWorker`,
 * distinct from a payload's own subject `workerId`) and the seq of the
 * event it's reacting to (`causeSeq`, typically an `agent_turn_started`
 * seq). Both optional and independently omittable — absent on the wire
 * (not `null`), matching Rust's `Provenance` fields exactly.
 */
export interface ProvenanceArgs {
  readonly originWorker?: string;
  readonly causeSeq?: number;
}

/**
 * The IPC `config` for a spawn: exactly the process options Rust's
 * `WorkerConfig` (`crates/swarm-core/src/worker/handle.rs`) reads, each
 * omitted when unset so Rust's `#[serde(default)]` applies.
 */
function workerConfig(options: WorkerProcessOptions): Record<string, unknown> {
  const { name, shell, cwd, env, repoRoot, isolation } = options;
  return Object.fromEntries(
    Object.entries({ name, shell, cwd, env, repoRoot, isolation }).filter(
      ([, value]) => value !== undefined,
    ),
  );
}

/**
 * Spawns a worker process from process options only: `name`, and
 * optionally `shell`/`cwd`/`env`/`repoRoot`/`isolation`, which map 1:1
 * onto Rust's `WorkerConfig`. Agent metadata (role/model/systemPrompt)
 * never belongs here: `spawnWorkerFromSpec` (`#lib/worker-spawn`) splits
 * a `WorkerSpawnSpec` (`#store/types`) and keeps that part client-side.
 *
 * Without `repoRoot` no git is touched. With it, a failed worktree
 * creation fails the whole spawn (see `spawn_worker`'s Errors in
 * `docs/api.md`) instead of falling back to a shared cwd, and this
 * promise rejects.
 *
 * Resolves the new worker's UUID (zod-validated), or `null` when there
 * is no backend transport at all (a plain `pnpm dev` browser preview),
 * so callers can skip their store writes. `prov` attributes the spawn
 * to its cause, e.g. the AI turn whose `spawn_worker` tool call made it.
 */
export async function spawnWorker(
  options: WorkerProcessOptions,
  prov?: ProvenanceArgs,
): Promise<string | null> {
  if (!hasTransport()) return null;
  const raw = await invoke("spawn_worker", {
    config: workerConfig(options),
    originWorker: prov?.originWorker,
    causeSeq: prov?.causeSeq,
  });
  return parseResponse(z.uuid(), raw, "Spawn Worker Returned An Invalid Worker ID.");
}

/**
 * An `agent_spawn` error value: `{ workerId, message }` (built by
 * `agent_spawn_error` in `crates/swarm-core/src/commands/agent.rs`; the
 * desktop forwarder in `src-tauri/src/commands/mod.rs` passes it over IPC
 * untouched).
 */
const AgentSpawnErrorSchema = z.object({
  workerId: z.uuid().nullish(),
  message: z.string(),
});

/**
 * An `agent_spawn` failure, carrying the worker id when the PTY worker
 * was already created before the agent-session attach step failed, so
 * a caller can still find and show that worker. Thrown by
 * {@link agentSpawn} in place of the raw rejection value (kept as the
 * `cause`), like {@link ShipCommandError}.
 */
export class AgentSpawnCommandError extends Error {
  readonly workerId: string | null;

  constructor(workerId: string | null, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AgentSpawnCommandError";
    this.workerId = workerId;
  }
}

function toAgentSpawnCommandError(err: unknown): Error {
  const parsed = AgentSpawnErrorSchema.safeParse(err);
  return parsed.success
    ? new AgentSpawnCommandError(parsed.data.workerId ?? null, parsed.data.message, { cause: err })
    : asError(err);
}

/**
 * Spawns a worker (through the same worktree-isolation path as
 * {@link spawnWorker}) and attaches a provider-adapter session to it in
 * one call: Rust's `agent_spawn`, routed by `provider` to
 * `ClaudeCodeAdapter` or `CodexAdapter`.
 *
 * `options` maps to `WorkerConfig` exactly like {@link spawnWorker}.
 * `model`/`trustTier` use the same trust-tier vocabulary for either
 * provider (see `#lib/agent-events`' `CodexTrustTierSchema`); the
 * backend defaults `trustTier` to `"standard"`. The session's
 * `sessionKey`/`capabilities` arrive with the `agent_session_started`
 * event (`#hooks/useAgentSessionEvents`), not in this call's result.
 *
 * If the PTY worker spawns but the session fails to attach (provider
 * CLI missing or signed out), the worker still exists as a plain
 * terminal and this rejects with an {@link AgentSpawnCommandError}
 * carrying its id: "spawned, but Not Signed In", not "nothing happened".
 */
export async function agentSpawn(
  options: WorkerProcessOptions,
  provider: Extract<ProviderId, "claude_code" | "codex">,
  model: string | undefined,
  trustTier: ClaudeCodeTrustTier | undefined,
  prov?: ProvenanceArgs,
): Promise<string | null> {
  if (!hasTransport()) return null;
  let raw: unknown;
  try {
    raw = await invoke("agent_spawn", {
      config: workerConfig(options),
      provider,
      model,
      trustTier,
      originWorker: prov?.originWorker,
      causeSeq: prov?.causeSeq,
    });
  } catch (err) {
    throw toAgentSpawnCommandError(err);
  }
  return parseResponse(z.uuid(), raw, "Agent Spawn Returned An Invalid Worker ID.");
}

/**
 * Sends one turn to `workerId`'s attached agent session (Claude Code or
 * Codex; Rust's `agent_send_turn`). Resolves once the backend scheduler
 * admits the turn, not when it completes: the transcript renders from
 * the `agent_*` event stream. Rejects when `workerId` has no attached
 * session or the admission queue is full.
 */
export async function agentSendTurn(workerId: string, prompt: string): Promise<void> {
  return invoke<void>("agent_send_turn", { workerId, prompt });
}

/**
 * Cancels `workerId`'s in-flight turn (Rust's `agent_cancel`). `turnId`
 * comes from that turn's own `agent_block`/`agent_tool_call` events. A
 * stale or already-settled `turnId` is a benign no-op.
 */
export async function agentCancel(workerId: string, turnId: string): Promise<void> {
  return invoke<void>("agent_cancel", { workerId, turnId });
}

/**
 * Shuts down `workerId`'s attached agent session (Claude Code or Codex;
 * Rust's `agent_shutdown`) without killing the PTY worker, which
 * {@link killWorker} does. Idempotent; a worker with no attached session
 * is a benign no-op.
 */
export async function agentShutdown(workerId: string): Promise<void> {
  return invoke<void>("agent_shutdown", { workerId });
}

/**
 * Checks whether `provider`'s CLI is installed and answers `--version`
 * (Rust's `agent_probe`, bounded, never hangs). Resolves
 * `{ available: false, detail }` rather than throwing when the provider
 * is unusable or there is no backend transport; `detail` is a
 * human-readable reason, never a credential.
 */
export async function agentProbe(
  provider: Extract<ProviderId, "claude_code" | "codex"> = "claude_code",
): Promise<ProbeReport> {
  if (!hasTransport()) {
    return { available: false, detail: "No Backend Transport Available." };
  }
  const raw = await invoke("agent_probe", { provider });
  return parseResponse(ProbeReportSchema, raw, "Agent Probe Returned An Unexpected Shape.");
}

/**
 * Answers a pending `agent_permission_request` (Rust's
 * `agent_permission_respond`). A real round trip for a `CodexAdapter`
 * session (`CodexSession::respond_permission` answers the child's
 * JSON-RPC request); a documented no-op for a `ClaudeCodeAdapter`
 * session (see `AgentPermissionRequestPayloadSchema`). Render an
 * Allow/Deny affordance only when the session's
 * `capabilities.interactivePermissions` is `true`.
 */
export async function agentPermissionRespond(
  workerId: string,
  requestId: string,
  decision: PermissionDecision,
): Promise<void> {
  return invoke<void>("agent_permission_respond", { workerId, requestId, decision });
}

/** Pauses a running worker (`pause_worker`). */
export async function pauseWorker(id: string): Promise<void> {
  return invoke<void>("pause_worker", { id });
}

/** Resumes a paused worker (`resume_worker`). */
export async function resumeWorker(id: string): Promise<void> {
  return invoke<void>("resume_worker", { id });
}

/** Terminates a worker process by UUID (`kill_worker`). */
export async function killWorker(id: string): Promise<void> {
  return invoke<void>("kill_worker", { id });
}

/**
 * One entry of `list_workers`: Rust's `WorkerInfo`
 * (`crates/swarm-core/src/worker/handle.rs`). `startedAt` is Unix
 * seconds; it becomes the ISO string `Worker.startedAt` holds.
 */
const WorkerInfoSchema = z
  .object({
    id: z.uuid(),
    state: WorkerStateSchema,
    name: z.string(),
    pid: z.int().nonnegative().nullish(),
    startedAt: z.int(),
    worktreePath: z.string().nullish(),
    branch: z.string().nullish(),
  })
  .transform(
    ({ id, state, name, pid, startedAt, worktreePath, branch }): Worker => ({
      id,
      state,
      name,
      startedAt: new Date(startedAt * 1000).toISOString(),
      ...(pid == null ? {} : { pid }),
      ...(worktreePath == null ? {} : { worktreePath }),
      ...(branch == null ? {} : { branch }),
    }),
  );

/**
 * Every worker the backend is running, e.g. to repopulate the worker
 * store after a reload (`#hooks/useWorkerEvents`). Resolves `[]` when
 * there is no backend transport.
 */
export async function listWorkers(): Promise<Worker[]> {
  if (!hasTransport()) return [];
  const raw = await invoke("list_workers");
  return parseResponse(
    z.array(WorkerInfoSchema),
    raw,
    "List Workers Returned An Unexpected Shape.",
  );
}

/**
 * `worker_input`'s `source` tag — required (not defaulted) so every
 * call site states deliberately where the bytes came from. Drives both
 * the backend's persistence carve-out (`terminal` input is ephemeral —
 * never archived, see `is_persistent`) and its preview policy (`tool`/
 * `automation` get a control-stripped preview; `terminal` never does).
 */
export type WorkerInputSource = "terminal" | "tool" | "automation";

/**
 * Writes `data` to a worker's PTY stdin. A string, not bytes: Rust's
 * `worker_input` takes `data: String`.
 */
export async function workerInput(
  id: string,
  data: string,
  source: WorkerInputSource,
  prov?: ProvenanceArgs,
): Promise<void> {
  return invoke<void>("worker_input", {
    id,
    data,
    source,
    originWorker: prov?.originWorker,
    causeSeq: prov?.causeSeq,
  });
}

/**
 * Resizes a worker's terminal to `rows` × `cols` character cells (Rust's
 * `resize_worker`, which rejects a zero dimension and a worker without a
 * PTY). The shell sees the new size at once: `SIGWINCH` on Unix, a
 * pseudoconsole resize on Windows. Emits no event.
 */
export async function resizeWorker(id: string, rows: number, cols: number): Promise<void> {
  return invoke<void>("resize_worker", { id, rows, cols });
}

/**
 * Records the start of one AI/agent turn and returns the persisted seq
 * the engine assigned it: the `causeSeq` every tool-driven side effect
 * of that turn then cites (see `AIChat.tsx`'s `doSend`).
 */
export async function agentTurnStarted(
  workerId: string,
  model: string,
  requestId: string,
): Promise<number> {
  const raw = await invoke("agent_turn_started", { workerId, model, requestId });
  return parseResponse(z.int().nonnegative(), raw, "Agent Turn Started Returned An Invalid Seq.");
}

/**
 * Sets the backend worker-registry cap. Applies to new spawns at once
 * and persists across restarts (config key `max_workers`).
 */
export async function setMaxWorkers(max: number): Promise<void> {
  return invoke<void>("set_max_workers", { max });
}

/**
 * Sets the backend agent-turn scheduler's concurrency cap. Applies at
 * once (resizing the scheduler's semaphore, see
 * `AgentScheduler::set_concurrency` in `crates/swarm-core`) and persists
 * across restarts (config key `agent_concurrency`). The backend
 * counterpart of `useAiStore`'s `concurrentLimit`, which only bounds the
 * webview-direct chat path; `useSettingsBridge` keeps the two in step.
 */
export async function setAgentConcurrency(limit: number): Promise<void> {
  return invoke<void>("set_agent_concurrency", { limit });
}

/**
 * Checks that `path` is inside a git repository (Rust's
 * `swarm_core::git::repo::discover_toplevel`) and resolves the repo's
 * canonical toplevel. The Project Root picker calls it before saving
 * `default_repo_root`, so an invalid root is caught up front instead of
 * failing every later isolated spawn.
 *
 * Rejects (never resolves `null`) for an invalid path or a missing
 * backend; callers show a Title Case toast.
 */
export async function validateRepoRoot(path: string): Promise<string> {
  const raw = await invoke("validate_repo_root", { path });
  return parseResponse(z.string().min(1), raw, "Validate Repo Root Returned An Invalid Response.");
}

// ── Session commands ─────────────────────────────────

/**
 * A `Session` as every session command returns it: Rust's `Session`
 * (`crates/swarm-core/src/session/manager.rs`), with `createdAt` in Unix
 * seconds and no `updatedAt` (Rust does not track one). Normalized into
 * a frontend `Session`: `createdAt` becomes an ISO string, `updatedAt`
 * starts equal to it, and the result must pass `SessionSchema`, so the
 * session store never holds an `updatedAt` that `date-fns` or a sort
 * cannot read.
 */
const SessionResponseSchema = z
  .object({
    id: z.uuid(),
    name: z.string(),
    workerIds: z.array(z.uuid()),
    createdAt: z.number(),
    config: z.record(z.string(), z.unknown()).optional(),
  })
  .transform((raw) => {
    const createdAt = new Date(raw.createdAt * 1000).toISOString();
    return { ...raw, createdAt, updatedAt: createdAt };
  })
  .pipe(SessionSchema);

const SESSION_SHAPE_ERROR = "The Session Backend Returned An Unexpected Shape.";

/**
 * Creates a session named `name`. Sends `config: {}` because Rust's
 * `create_session` requires the argument (no `#[serde(default)]`).
 */
export async function createSession(name: string): Promise<Session> {
  const raw = await invoke("create_session", { name, config: {} });
  return parseResponse(SessionResponseSchema, raw, SESSION_SHAPE_ERROR);
}

/** Deletes a session by UUID, with its associated data. */
export async function deleteSession(id: string): Promise<void> {
  return invoke<void>("delete_session", { id });
}

/** Every session in the backend store; `[]` without a backend transport. */
export async function listSessions(): Promise<Session[]> {
  if (!hasTransport()) return [];
  const raw = await invoke("list_sessions");
  return parseResponse(z.array(SessionResponseSchema), raw, SESSION_SHAPE_ERROR);
}

/** One session by UUID. */
export async function getSession(id: string): Promise<Session> {
  const raw = await invoke("get_session", { id });
  return parseResponse(SessionResponseSchema, raw, SESSION_SHAPE_ERROR);
}

/**
 * Adds a worker to a session's `workerIds` (`session_add_worker`).
 * When the membership actually changes the backend emits
 * `session_worker_added`, which `useSessionEvents` mirrors into
 * `useSessionStore`; `spawnWorkerFromSpec` (`#lib/worker-spawn`) also
 * mirrors the result itself, through the idempotent
 * `addWorkerToSession`, so either may land first.
 */
export async function sessionAddWorker(sessionId: string, workerId: string): Promise<void> {
  return invoke<void>("session_add_worker", { sessionId, workerId });
}

/**
 * Removes a worker from a session's `workerIds`
 * (`session_remove_worker`). The backend emits `session_worker_removed`,
 * which `useSessionEvents` mirrors into `useSessionStore`; callers do not
 * update the store themselves.
 */
export async function sessionRemoveWorker(sessionId: string, workerId: string): Promise<void> {
  return invoke<void>("session_remove_worker", { sessionId, workerId });
}

// ── Notifications ────────────────────────────────────

/**
 * Shows a native OS notification (`send_notification`). Desktop-only:
 * swarmd has no such command (`swarm_core::commands::NATIVE_ONLY`), so
 * this gates on {@link isTauri} and is a no-op on a swarmd-served page
 * and in a browser preview.
 */
export async function sendNotification(title: string, body: string): Promise<void> {
  if (!isTauri()) return;
  return invoke<void>("send_notification", { title, body });
}

// ── Updater ──────────────────────────────────────────

/** `check_for_updates`' result (`src-tauri/src/commands/native.rs`). */
const UpdateCheckResultSchema = z.object({
  available: z.boolean(),
  version: z.string().optional(),
  body: z.string().nullish(),
  date: z.string().nullish(),
});

/** Result of a manual or on-launch update check. */
export type UpdateCheckResult = z.output<typeof UpdateCheckResultSchema>;

/**
 * Asks the configured update endpoint for a newer version.
 * Desktop-only, like {@link sendNotification}: resolves
 * `{ available: false }` outside the Tauri shell.
 */
export async function checkForUpdates(): Promise<UpdateCheckResult> {
  if (!isTauri()) return { available: false };
  const raw = await invoke("check_for_updates");
  return parseResponse(UpdateCheckResultSchema, raw, "Update Check Returned An Unexpected Shape.");
}

// ── Config ───────────────────────────────────────────

/**
 * Reads `key` from the Rust-owned flat `swarm-config.json`
 * (`read_config`), validated with `schema`. Resolves `null` when the
 * key is unset, the value does not match `schema`, or there is no
 * backend.
 */
export async function readConfig<S extends z.ZodType>(
  key: string,
  schema: S,
): Promise<z.output<S> | null>;
/**
 * Reads `key` from `swarm-config.json` without validation; `T` is not
 * checked.
 *
 * @deprecated Pass a zod schema as the second argument.
 */
export async function readConfig<T = unknown>(key: string): Promise<T | null>;
export async function readConfig(key: string, schema?: z.ZodType): Promise<unknown> {
  const raw = (await invoke("read_config", { key })) ?? null;
  if (schema === undefined || raw === null) return raw;
  const parsed = schema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/** Writes `key` to the Rust-owned `swarm-config.json` (`write_config`). */
export async function writeConfig<T>(key: string, value: T): Promise<void> {
  return invoke<void>("write_config", { key, value });
}

// ── Ship chain ────────────────────────────────────────
//
// Every ship command can reject with a typed `ShipError`
// (`{ kind, message, remedy }`, see `swarm_core::git::ship::ShipError`)
// instead of a string. Each wrapper re-throws that as a
// `ShipCommandError`, so callers catch a real `Error` and narrow with
// `instanceof ShipCommandError` when they need `kind`/`remedy`.

/**
 * A ship command failure carrying the typed `ShipError` the backend
 * returned (Tauri and swarmd both deliver it as the plain object, kept
 * here as the `cause`).
 */
export class ShipCommandError extends Error {
  readonly shipError: ShipError;

  constructor(shipError: ShipError, options?: ErrorOptions) {
    super(shipError.message, options);
    this.name = "ShipCommandError";
    this.shipError = shipError;
  }
}

/**
 * Runs a ship command: a rejection matching `ShipErrorSchema` becomes a
 * {@link ShipCommandError}, any other one (a task panic, a missing
 * backend) an `Error`; the result is validated with `schema`.
 */
async function shipCommand<S extends z.ZodType>(
  cmd: string,
  args: Record<string, unknown>,
  schema: S,
  shapeError: string,
): Promise<z.output<S>> {
  let raw: unknown;
  try {
    raw = await invoke(cmd, args);
  } catch (err) {
    const parsed = ShipErrorSchema.safeParse(err);
    throw parsed.success ? new ShipCommandError(parsed.data, { cause: err }) : asError(err);
  }
  return parseResponse(schema, raw, shapeError);
}

/**
 * Computes the read-only ship preflight for `workerId`, evaluated for
 * `mode` (the backend defaults to `"all"`): branch/remote/tracking
 * state, working-tree status, the secret/size deny-list preview (a
 * `"staged"` preview covers only what is already indexed, exactly what
 * `gitStageCommit` would commit) and the `canShip`/`blockers` verdict.
 */
export async function gitShipPreflight(
  workerId: string,
  mode?: StagingMode,
): Promise<ShipPreflight> {
  return shipCommand(
    "git_ship_preflight",
    { workerId, mode },
    ShipPreflightSchema,
    "Ship Preflight Returned An Unexpected Shape.",
  );
}

/**
 * Stages (per `mode`) and commits `workerId`'s worktree; the backend
 * appends the `Swarm-Seq-Range` trailer. `shipId` (a fresh
 * `crypto.randomUUID()` per ship attempt) correlates the
 * `ship_progress`/`ship_settled` events with the caller's progress UI.
 * `finalStep` is `true` only for "Commit Only": it makes a success also
 * emit the terminal `ship_settled` receipt (a failure always does).
 */
export async function gitStageCommit(
  workerId: string,
  shipId: string,
  message: string,
  mode: StagingMode,
  finalStep: boolean,
): Promise<CommitOutcome> {
  return shipCommand(
    "git_stage_commit",
    { workerId, shipId, message, mode, finalStep },
    CommitOutcomeSchema,
    "Git Stage Commit Returned An Unexpected Shape.",
  );
}

/**
 * Pushes `workerId`'s branch (`origin <branch> --set-upstream`, fixed
 * argv, never forced). The backend resolves `HEAD` itself at push time
 * (see `swarm_core::git::ship::push`), so already-committed, unpushed
 * work (`ShipPreflight.ahead > 0`) can be pushed without a
 * `gitStageCommit` in the same attempt. On success the backend records
 * `lastShippedSeq`/`lastShippedCommit`. `finalStep` is `true` for
 * "Commit + Push" and `false` when a {@link shipCompareUrl} call follows.
 */
export async function gitPush(
  workerId: string,
  shipId: string,
  finalStep: boolean,
): Promise<PushOutcome> {
  return shipCommand(
    "git_push",
    { workerId, shipId, finalStep },
    PushOutcomeSchema,
    "Git Push Returned An Unexpected Shape.",
  );
}

/**
 * Builds the GitHub compare URL for `workerId`'s worktree, prefilled
 * with `title`/`body` through `quick_pull=1` (capped server-side at 6000
 * characters, `body` truncated first). Always the final step of "Commit
 * + Push + Open Compare Page": emits the terminal `ship_settled` receipt
 * on success and failure.
 */
export async function shipCompareUrl(
  workerId: string,
  shipId: string,
  commitSha: string,
  pushedRef: string,
  title: string,
  body: string,
): Promise<string> {
  return shipCommand(
    "ship_compare_url",
    { workerId, shipId, commitSha, pushedRef, title, body },
    z.string().min(1),
    "Ship Compare URL Returned An Unexpected Shape.",
  );
}

/**
 * The causal record of `workerId`'s current ship range: turns, tool
 * calls and any commits already made in the range the next
 * `gitStageCommit` would cite. Read-only; the range is resolved
 * server-side with the same algorithm `git_stage_commit` uses. See
 * `#lib/ship-causal`'s `renderCausalRecordSection` for its rendering.
 */
export async function shipContext(workerId: string): Promise<ShipContext> {
  return shipCommand(
    "ship_context",
    { workerId },
    ShipContextSchema,
    "Ship Context Returned An Unexpected Shape.",
  );
}
