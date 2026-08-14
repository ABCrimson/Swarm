import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { listen as tauriListen } from "@tauri-apps/api/event";
import * as z from "zod";
import type {
  CommitOutcome,
  PushOutcome,
  Session,
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
  ShipErrorSchema,
  ShipPreflightSchema,
} from "#store/types";

/** Returns `true` when running inside a Tauri webview (IPC bridge is available). */
export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

const noop: UnlistenFn = () => {};

/**
 * Type-safe wrapper around Tauri's invoke command.
 * Returns `undefined` as `T` when Tauri is not available.
 */
export async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauri()) return undefined as T;
  return tauriInvoke<T>(cmd, args);
}

/**
 * Type-safe wrapper around Tauri's event listener.
 * Returns a no-op unlisten function when Tauri is not available.
 */
export async function listen<T>(event: string, handler: (payload: T) => void): Promise<UnlistenFn> {
  if (!isTauri()) return noop;
  return tauriListen<T>(event, (e) => handler(e.payload));
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

/** Validates the raw `spawn_worker` IPC response is a worker UUID before trusting it. */
const SpawnWorkerResponseSchema = z.uuid();

/**
 * Spawn a new worker process from process options only — `name`,
 * optionally `shell`/`cwd`/`env`/`repoRoot`/`isolation` — which map
 * 1:1 onto Rust's `WorkerConfig`
 * (`src-tauri/crates/swarm-core/src/worker/handle.rs`) and are the
 * only fields sent over IPC. Agent metadata (role/model/systemPrompt)
 * never belongs here — see `WorkerSpawnSpec` (`#store/types`) and
 * `spawnWorkerFromSpec` (`#lib/worker-spawn`), which splits the two and
 * stores agent metadata client-side instead.
 *
 * `repoRoot`/`isolation` are additive and optional. Omitting `repoRoot`
 * reproduces exactly the pre-worktree-isolation spawn — no git touched
 * server-side. When `repoRoot` is given and worktree creation fails,
 * Rust hard-fails the whole spawn (see `spawn_worker`'s `Errors`
 * section in `docs/api.md`) rather than silently falling back to a
 * shared cwd, so this function's promise rejects in that case exactly
 * like any other spawn failure.
 *
 * The response is Zod-validated (a bare worker UUID) rather than cast,
 * matching the event-bus's `safeParse`-at-the-seam discipline
 * (`#lib/event-bus`) — an unexpected shape throws instead of handing
 * callers an untrusted value typed as `string`.
 *
 * Returns `null` (rather than throwing) when there is no Tauri IPC
 * bridge at all (e.g. `pnpm dev` in a plain browser) — `invoke()`
 * degrades to a no-op there, and a `null` return lets callers (see
 * `spawnWorkerFromSpec`) skip their store writes gracefully instead of
 * this function synthesizing a fake failure from an absent response.
 *
 * `prov` is optional causal attribution (e.g. the AI turn whose
 * `spawn_worker` tool call triggered this spawn) — omitted for a
 * human-initiated spawn from the Workers page.
 */
export async function spawnWorker(
  options: WorkerProcessOptions,
  prov?: ProvenanceArgs,
): Promise<string | null> {
  if (!isTauri()) return null;

  const config: Record<string, unknown> = { name: options.name };
  if (options.shell !== undefined) config.shell = options.shell;
  if (options.cwd !== undefined) config.cwd = options.cwd;
  if (options.env !== undefined) config.env = options.env;
  if (options.repoRoot !== undefined) config.repoRoot = options.repoRoot;
  if (options.isolation !== undefined) config.isolation = options.isolation;

  const raw = await invoke<unknown>("spawn_worker", {
    config,
    originWorker: prov?.originWorker,
    causeSeq: prov?.causeSeq,
  });
  const parsed = SpawnWorkerResponseSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error("Spawn Worker Returned An Invalid Worker ID.");
  }
  return parsed.data;
}

/** Pause a running worker, suspending its PTY process. */
export async function pauseWorker(id: string): Promise<void> {
  return invoke<void>("pause_worker", { id });
}

/** Resume a previously paused worker. */
export async function resumeWorker(id: string): Promise<void> {
  return invoke<void>("resume_worker", { id });
}

/** Terminate a worker process by UUID. */
export async function killWorker(id: string): Promise<void> {
  return invoke<void>("kill_worker", { id });
}

/** Retrieve the list of all known workers from the backend. */
export async function listWorkers(): Promise<Worker[]> {
  return invoke<Worker[]>("list_workers");
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
 * Send raw input data to a worker's PTY stdin.
 *
 * `data` is a plain string (not bytes) — matches every caller and what
 * the Rust `worker_input` command's `data: String` parameter expects
 * (see its doc for the `Vec<u8>` contract bug this replaced).
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

/** Validates the raw `agent_turn_started` IPC response is a non-negative integer seq. */
const AgentTurnStartedResponseSchema = z.number().int().nonnegative();

/**
 * Records the start of one AI/agent turn and returns the real,
 * persisted seq the engine assigned it — the `causeSeq` every
 * tool-driven side effect in that turn then cites (see
 * `AIChat.tsx`'s `doSend`).
 */
export async function agentTurnStarted(
  workerId: string,
  model: string,
  requestId: string,
): Promise<number> {
  const raw = await invoke<unknown>("agent_turn_started", { workerId, model, requestId });
  const parsed = AgentTurnStartedResponseSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error("Agent Turn Started Returned An Invalid Seq.");
  }
  return parsed.data;
}

/**
 * Update the backend worker-registry cap. Applies immediately to new
 * spawns and persists across restarts (see `set_max_workers` in src-tauri).
 */
export async function setMaxWorkers(max: number): Promise<void> {
  return invoke<void>("set_max_workers", { max });
}

/** Validates the raw `validate_repo_root` IPC response is a non-empty path string. */
const ValidateRepoRootResponseSchema = z.string().min(1);

/**
 * Validates that `path` is inside a git repository (via
 * `swarm_core::git::repo::discover_toplevel` on the Rust side),
 * returning the repo's canonical toplevel path on success. Used by
 * the Workers page's Project Root picker to confirm a chosen directory
 * *before* persisting it as `default_repo_root` config, instead of
 * letting every subsequent isolated spawn hard-fail with a raw git
 * error the user never asked to see.
 *
 * Throws (does not return `null`) on an invalid path or a missing
 * Tauri bridge — callers are expected to catch and show a truthful
 * Title Case toast, not treat this like the graceful-degradation
 * commands above.
 */
export async function validateRepoRoot(path: string): Promise<string> {
  const raw = await invoke<unknown>("validate_repo_root", { path });
  const parsed = ValidateRepoRootResponseSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error("Validate Repo Root Returned An Invalid Response.");
  }
  return parsed.data;
}

// ── Session commands ─────────────────────────────────

/**
 * Raw shape of a Session exactly as Rust returns it — shared by every
 * command that hands back a `Session` (`create_session`,
 * `list_sessions`, `get_session` all serialize the same struct).
 * Mirrors Rust's `Session` struct (`src-tauri/src/session/manager.rs`)
 * exactly: `createdAt` is Unix seconds, and there is no `updatedAt`
 * field at all — Rust never tracks one.
 */
const RawSessionResponseSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  workerIds: z.array(z.uuid()),
  createdAt: z.number(),
  config: z.record(z.string(), z.unknown()).optional(),
});

/**
 * Normalizes one raw Session IPC response into a validated frontend
 * `Session`: converts `createdAt` from Unix seconds to an ISO-8601
 * string and seeds `updatedAt` with that same value (Rust has no
 * `updatedAt` field at all — a session is "updated" the instant it's
 * created), then validates the result against `SessionSchema`. Shared
 * by `createSession`/`listSessions`/`getSession` so none of them can
 * hand a caller a value that fails `SessionSchema` downstream — an
 * unexpected shape throws here instead of poisoning the session store
 * with a value whose `updatedAt` is `undefined`, which throws a
 * `RangeError` inside `date-fns`' `formatDistanceToNow` in
 * `SessionCard` and sorts as `NaN` in `SessionList`.
 */
function normalizeSession(raw: unknown): Session {
  const parsedRaw = RawSessionResponseSchema.safeParse(raw);
  if (!parsedRaw.success) {
    throw new Error("The Session Backend Returned An Unexpected Shape.");
  }

  const createdAtIso = new Date(parsedRaw.data.createdAt * 1000).toISOString();
  const parsed = SessionSchema.safeParse({
    ...parsedRaw.data,
    createdAt: createdAtIso,
    updatedAt: createdAtIso,
  });
  if (!parsed.success) {
    throw new Error("The Session Backend Returned An Unexpected Shape.");
  }

  return parsed.data;
}

/**
 * Create a new orchestration session with the given name.
 *
 * Sends `config: {}` — Rust's `create_session` command requires this
 * argument (`config: serde_json::Value`, no `#[serde(default)]`); a
 * call that omits it fails IPC deserialization outright ("missing
 * required key config") before any handler code runs.
 */
export async function createSession(name: string): Promise<Session> {
  const raw = await invoke<unknown>("create_session", { name, config: {} });
  return normalizeSession(raw);
}

/** Delete a session by UUID and remove its associated data. */
export async function deleteSession(id: string): Promise<void> {
  return invoke<void>("delete_session", { id });
}

/**
 * Retrieve all sessions from the backend store, each normalized the
 * same way as `createSession` (see `normalizeSession`). Currently
 * unreachable in the shipped app (`useSessionActions`, its only
 * caller, has no consumers) — but wired now rather than left to
 * detonate the instant session restore is.
 */
export async function listSessions(): Promise<Session[]> {
  if (!isTauri()) return [];
  const raw = await invoke<unknown[]>("list_sessions");
  return raw.map(normalizeSession);
}

/**
 * Retrieve a single session by UUID, normalized the same way as
 * `createSession` (see `normalizeSession`).
 */
export async function getSession(id: string): Promise<Session> {
  const raw = await invoke<unknown>("get_session", { id });
  return normalizeSession(raw);
}

/**
 * Register a worker against a session's `workerIds` list (backend
 * command `session_add_worker`, registered in `generate_handler!` but
 * previously called from nowhere in the frontend). Does not emit a
 * `swarm://events` envelope on success — callers must mirror the
 * result into `useSessionStore` themselves (see `spawnWorkerFromSpec`
 * in `#lib/worker-spawn`).
 */
export async function sessionAddWorker(sessionId: string, workerId: string): Promise<void> {
  return invoke<void>("session_add_worker", { sessionId, workerId });
}

// ── Notifications ────────────────────────────────────

/** Display a native OS notification (see `send_notification` in src-tauri). */
export async function sendNotification(title: string, body: string): Promise<void> {
  return invoke<void>("send_notification", { title, body });
}

// ── Updater ──────────────────────────────────────────

/** Result of a manual or on-launch update check (see `check_for_updates` in src-tauri). */
export interface UpdateCheckResult {
  readonly available: boolean;
  readonly version?: string;
  readonly body?: string;
  readonly date?: string;
}

/** Query the configured update endpoint for an available app update. */
export async function checkForUpdates(): Promise<UpdateCheckResult> {
  return invoke<UpdateCheckResult>("check_for_updates");
}

// ── FS utilities ─────────────────────────────────────

/** Read a typed configuration value by key from the flat `swarm-config.json` file (via the `read_config` custom command). */
export async function readConfig<T>(key: string): Promise<T | null> {
  return invoke<T | null>("read_config", { key });
}

/** Write a typed configuration value by key to the flat `swarm-config.json` file (via the `write_config` custom command). */
export async function writeConfig<T>(key: string, value: T): Promise<void> {
  return invoke<void>("write_config", { key, value });
}

// ── Ship chain ────────────────────────────────────────
//
// Every command here can reject with a typed `ShipError` object
// (`{ kind, message, remedy }`), not a bare string — a documented
// divergence from the rest of this file's `Result<T, String>`
// convention (see `swarm_core::git::ship::ShipError`'s doc). Rather
// than make every call site `safeParse` the rejection value itself,
// each wrapper below funnels it through `toShipCommandError`, which
// re-throws it as a real `Error` subclass carrying the parsed
// `ShipError` at `.shipError` — callers can `catch` normally and, when
// they need to branch on `kind`, narrow with `instanceof ShipCommandError`.

/**
 * A ship command failure, carrying the typed `ShipError` the backend
 * returned. Thrown by every `git*`/`ship*` function below in place of
 * the raw IPC rejection value (which Tauri delivers as the plain
 * `{ kind, message, remedy }` object, not an `Error` instance).
 */
export class ShipCommandError extends Error {
  readonly shipError: ShipError;

  constructor(shipError: ShipError) {
    super(shipError.message);
    this.name = "ShipCommandError";
    this.shipError = shipError;
  }
}

/**
 * Normalizes any thrown value from a ship command call into an
 * `Error`: a rejection matching `ShipErrorSchema` becomes a
 * `ShipCommandError`; anything else (a task panic, a missing Tauri
 * bridge) is coerced into a plain `Error` rather than re-thrown as an
 * unknown value.
 */
function toShipCommandError(err: unknown): Error {
  const parsed = ShipErrorSchema.safeParse(err);
  if (parsed.success) return new ShipCommandError(parsed.data);
  return err instanceof Error ? err : new Error(String(err));
}

/**
 * Computes the ship preflight for `workerId`, evaluated for `mode`
 * (defaults to `"all"` — the app default, and what the first preflight
 * of a session is computed for before the user has picked anything):
 * branch/remote/tracking state, working-tree status, the secret/size
 * deny-list preview (accurate for the given `mode` — a `"staged"`
 * preview reflects only what's already indexed, matching what
 * `gitStageCommit` would actually commit), and the `canShip`/
 * `blockers` verdict — read-only, no mutation.
 */
export async function gitShipPreflight(
  workerId: string,
  mode?: StagingMode,
): Promise<ShipPreflight> {
  try {
    const raw = await invoke<unknown>("git_ship_preflight", { workerId, mode });
    const parsed = ShipPreflightSchema.safeParse(raw);
    if (!parsed.success) {
      throw new Error("Ship Preflight Returned An Unexpected Shape.");
    }
    return parsed.data;
  } catch (err) {
    throw toShipCommandError(err);
  }
}

/**
 * Stages (per `mode`) and commits `workerId`'s worktree, appending the
 * `Swarm-Seq-Range` trailer server-side. `shipId` correlates the
 * `ship_progress`/`ship_settled` events this call emits with the
 * caller's own progress UI — generate a fresh one (`crypto.randomUUID()`)
 * per ship attempt. `finalStep` should be `true` only for the "Commit
 * Only" action (no push/compare follows) — it controls whether this
 * call also emits the terminal `ship_settled` receipt on success (a
 * failure always emits it regardless).
 */
export async function gitStageCommit(
  workerId: string,
  shipId: string,
  message: string,
  mode: StagingMode,
  finalStep: boolean,
): Promise<CommitOutcome> {
  try {
    const raw = await invoke<unknown>("git_stage_commit", {
      workerId,
      shipId,
      message,
      mode,
      finalStep,
    });
    const parsed = CommitOutcomeSchema.safeParse(raw);
    if (!parsed.success) {
      throw new Error("Git Stage Commit Returned An Unexpected Shape.");
    }
    return parsed.data;
  } catch (err) {
    throw toShipCommandError(err);
  }
}

/**
 * Pushes `workerId`'s branch (`origin <branch> --set-upstream`, fixed
 * argv, never force). Takes no commit sha from the caller — the
 * backend resolves `HEAD` itself, live, at push time (see
 * `swarm_core::git::ship::push`'s doc). This is what lets a worker
 * with already-committed, unpushed work (`ShipPreflight.ahead > 0`,
 * e.g. from an earlier "Commit Only") go straight to `gitPush` without
 * a preceding `gitStageCommit` call in the same ship attempt. On
 * success, the backend records `lastShippedSeq`/`lastShippedCommit`
 * for this worker. `finalStep` should be `true` for the "Commit +
 * Push" action (no compare-page step follows); `false` when a
 * `shipCompareUrl` call is coming next.
 */
export async function gitPush(
  workerId: string,
  shipId: string,
  finalStep: boolean,
): Promise<PushOutcome> {
  try {
    const raw = await invoke<unknown>("git_push", {
      workerId,
      shipId,
      finalStep,
    });
    const parsed = PushOutcomeSchema.safeParse(raw);
    if (!parsed.success) {
      throw new Error("Git Push Returned An Unexpected Shape.");
    }
    return parsed.data;
  } catch (err) {
    throw toShipCommandError(err);
  }
}

/** Validates the raw `ship_compare_url` IPC response is a non-empty URL string. */
const ShipCompareUrlResponseSchema = z.string().min(1);

/**
 * Builds the GitHub-style compare URL for `workerId`'s worktree,
 * prefilled with `title`/`body` via `quick_pull=1` query params
 * (server-side capped at 6000 characters total, truncating `body`
 * first). Always the true final step of the "Commit + Push + Open
 * Compare Page" action — emits the terminal `ship_settled` receipt on
 * both success and failure.
 */
export async function shipCompareUrl(
  workerId: string,
  shipId: string,
  commitSha: string,
  pushedRef: string,
  title: string,
  body: string,
): Promise<string> {
  try {
    const raw = await invoke<unknown>("ship_compare_url", {
      workerId,
      shipId,
      commitSha,
      pushedRef,
      title,
      body,
    });
    const parsed = ShipCompareUrlResponseSchema.safeParse(raw);
    if (!parsed.success) {
      throw new Error("Ship Compare URL Returned An Unexpected Shape.");
    }
    return parsed.data;
  } catch (err) {
    throw toShipCommandError(err);
  }
}
