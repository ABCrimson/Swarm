import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { listen as tauriListen } from "@tauri-apps/api/event";
import type { Session, SystemMetrics, Worker, WorkerState } from "#store/types";

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

/** Spawn a new worker process, optionally assigning a human-readable name. */
export async function spawnWorker(name?: string): Promise<string> {
  return invoke<string>("spawn_worker", {
    config: {
      name: name ?? "Worker",
    },
  });
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

// ── Session commands ─────────────────────────────────

/** Create a new orchestration session with the given name. */
export async function createSession(name: string): Promise<Session> {
  return invoke<Session>("create_session", { name });
}

/** Delete a session by UUID and remove its associated data. */
export async function deleteSession(id: string): Promise<void> {
  return invoke<void>("delete_session", { id });
}

/** Retrieve all sessions from the backend store. */
export async function listSessions(): Promise<Session[]> {
  return invoke<Session[]>("list_sessions");
}

/** Retrieve a single session by UUID. */
export async function getSession(id: string): Promise<Session> {
  return invoke<Session>("get_session", { id });
}

// ── AI commands ──────────────────────────────────────

/** Start an AI streaming session for a worker, returning the stream ID. */
export async function startAiStream(params: {
  workerId: string;
  messages: Array<{ role: string; content: string }>;
  model?: string;
}): Promise<string> {
  return invoke<string>("start_ai_stream", params);
}

/** Cancel an active AI stream by its stream ID. */
export async function cancelAiStream(streamId: string): Promise<void> {
  return invoke<void>("cancel_ai_stream", { streamId });
}

// ── Session search ──────────────────────────────────

/** Full-text search across session history with optional date range filter. */
export async function searchHistory(
  query: string,
  dateRange?: { from?: string; to?: string },
): Promise<Session[]> {
  return invoke<Session[]>("search_history", { query, dateRange });
}

// ── FS utilities ─────────────────────────────────────

/** Read a typed configuration value from plugin-store by key. */
export async function readConfig<T>(key: string): Promise<T | null> {
  return invoke<T | null>("read_config", { key });
}

/** Write a typed configuration value to plugin-store. */
export async function writeConfig<T>(key: string, value: T): Promise<void> {
  return invoke<void>("write_config", { key, value });
}

// ── Event listeners (typed) ──────────────────────────

/** Fires when a new worker process is spawned by the backend. */
export function onWorkerSpawned(handler: (worker: Worker) => void): Promise<UnlistenFn> {
  return listen<Worker>("worker:spawned", handler);
}

/** Fires when a worker emits output (stdout/stderr). */
export function onWorkerOutput(
  handler: (payload: { workerId: string; data: string }) => void,
): Promise<UnlistenFn> {
  return listen<{ workerId: string; data: string }>("worker:output", handler);
}

/** Fires when a worker's state changes. */
export function onWorkerState(
  handler: (payload: { workerId: string; state: WorkerState }) => void,
): Promise<UnlistenFn> {
  return listen<{ workerId: string; state: WorkerState }>("worker:state", handler);
}

/** Fires when system metrics are updated (CPU, memory, etc.). */
export function onSystemMetrics(handler: (metrics: SystemMetrics) => void): Promise<UnlistenFn> {
  return listen<SystemMetrics>("system:metrics", handler);
}

/** Fires when a new session is created. */
export function onSessionCreated(handler: (session: Session) => void): Promise<UnlistenFn> {
  return listen<Session>("session:created", handler);
}

/** Fires when a session is deleted. */
export function onSessionDeleted(handler: (payload: { id: string }) => void): Promise<UnlistenFn> {
  return listen<{ id: string }>("session:deleted", handler);
}

/** Fires when the AI stream emits a delta. */
export function onAiStreamDelta(
  handler: (payload: { streamId: string; delta: string; done: boolean }) => void,
): Promise<UnlistenFn> {
  return listen<{ streamId: string; delta: string; done: boolean }>("ai:stream:delta", handler);
}

/** Fires when the system emits a log entry. */
export function onSystemLog(
  handler: (payload: { level: string; message: string; timestamp: string }) => void,
): Promise<UnlistenFn> {
  return listen<{ level: string; message: string; timestamp: string }>("system:log", handler);
}
