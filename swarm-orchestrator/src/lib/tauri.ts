import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { listen as tauriListen } from "@tauri-apps/api/event";
import * as z from "zod";
import type { Session, Worker, WorkerProcessOptions } from "#store/types";
import { SessionSchema } from "#store/types";

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
 */
export async function spawnWorker(options: WorkerProcessOptions): Promise<string | null> {
  if (!isTauri()) return null;

  const config: Record<string, unknown> = { name: options.name };
  if (options.shell !== undefined) config.shell = options.shell;
  if (options.cwd !== undefined) config.cwd = options.cwd;
  if (options.env !== undefined) config.env = options.env;
  if (options.repoRoot !== undefined) config.repoRoot = options.repoRoot;
  if (options.isolation !== undefined) config.isolation = options.isolation;

  const raw = await invoke<unknown>("spawn_worker", { config });
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

/** Send raw input data to a worker's PTY stdin. */
export async function workerInput(id: string, data: string): Promise<void> {
  return invoke<void>("worker_input", { id, data });
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
