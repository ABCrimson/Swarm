// ── Worker Spawn (process options + agent metadata split) ──
//
// `WorkerSpawnSpec` (#store/types) bundles two halves that must never
// be conflated: process options (name/shell/cwd/env — sent to Rust's
// WorkerConfig over IPC) and agent metadata (role/model/systemPrompt —
// client-side only). This module is the one place that spawns a worker
// from the combined spec, splitting it correctly and — when spawning
// happens in the context of a session (template application) — wiring
// the new worker into that session via `session_add_worker`.

import { sessionAddWorker, spawnWorker } from "#lib/tauri";
import { useSessionStore } from "#store/sessions";
import type { WorkerSpawnSpec } from "#store/types";
import { useWorkerAgentStore } from "#store/worker-agents";
import { useWorkerStore } from "#store/workers";

/**
 * Spawns a worker from a full `WorkerSpawnSpec`.
 *
 * - Process options (`name`/`shell`/`cwd`/`env`) go to Rust via
 *   `spawnWorker` (`#lib/tauri`).
 * - Agent metadata (`role`/`model`/`systemPrompt`) is stored
 *   client-side in `useWorkerAgentStore`, keyed by the new worker id —
 *   `WorkerAIPanel`/`AIChat` read it from there to preselect the model
 *   and inject the system prompt, which is what makes a template's
 *   agent config real instead of decorative.
 * - Adds an optimistic placeholder to `useWorkerStore` immediately; the
 *   authoritative record arrives via the `worker_spawned` event on
 *   `swarm://events` (see `useWorkerEvents`) and overwrites it.
 * - When `sessionId` is given, registers the worker against that
 *   session via `session_add_worker` and mirrors the result into
 *   `useSessionStore` (the backend does not emit an event for this
 *   mutation, so the frontend must update its own copy).
 *
 * @returns The new worker's UUID.
 */
export async function spawnWorkerFromSpec(
  spec: WorkerSpawnSpec,
  sessionId?: string,
): Promise<string> {
  const { role, model, systemPrompt, ...processOptions } = spec;
  const workerId = await spawnWorker(processOptions);

  useWorkerStore.getState().addWorker({
    id: workerId,
    state: "running",
    name: processOptions.name,
    startedAt: new Date().toISOString(),
  });

  if (role !== undefined || model !== undefined || systemPrompt !== undefined) {
    useWorkerAgentStore.getState().setAgentMetadata(workerId, { role, model, systemPrompt });
  }

  if (sessionId) {
    try {
      await sessionAddWorker(sessionId, workerId);
      const session = useSessionStore.getState().sessions.get(sessionId);
      if (session) {
        useSessionStore
          .getState()
          .updateSession(sessionId, { workerIds: [...session.workerIds, workerId] });
      }
    } catch (err) {
      console.error(`spawnWorkerFromSpec: failed to register worker with session "${sessionId}"`, err);
    }
  }

  return workerId;
}
