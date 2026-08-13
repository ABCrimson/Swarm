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
 *   `AIChat` reads it from there to resolve this worker's effective
 *   model and inject its system prompt, which is what makes a
 *   template's agent config real instead of decorative.
 * - Adds an optimistic placeholder to `useWorkerStore` immediately; the
 *   authoritative record arrives via the `worker_spawned` event on
 *   `swarm://events` (see `useWorkerEvents`) and overwrites it.
 * - When `sessionId` is given, registers the worker against that
 *   session via `session_add_worker` and mirrors the result into
 *   `useSessionStore` (the backend does not emit an event for this
 *   mutation, so the frontend must update its own copy).
 *
 * @returns The new worker's UUID, or `null` when `spawnWorker` degraded
 * gracefully because there is no Tauri IPC bridge (e.g. `pnpm dev` in a
 * plain browser) — no store writes happen in that case, since there is
 * no worker id to key them on.
 */
export async function spawnWorkerFromSpec(
  spec: WorkerSpawnSpec,
  sessionId?: string,
): Promise<string | null> {
  const { role, model, systemPrompt, ...processOptions } = spec;
  const workerId = await spawnWorker(processOptions);
  if (workerId === null) return null;

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
      // Hazard: the read of `session.workerIds` and the `updateSession()`
      // write below must stay synchronous with each other (no `await`
      // between them). They run as one uninterrupted microtask once
      // `sessionAddWorker` resolves, which is what makes concurrent
      // spawns into the same session safe without a lock — each call's
      // get-then-set pair always reads the latest state. Inserting an
      // `await` here would reopen a lost-update race between concurrent
      // callers targeting the same `sessionId`.
      const session = useSessionStore.getState().sessions.get(sessionId);
      if (session) {
        useSessionStore
          .getState()
          .updateSession(sessionId, { workerIds: [...session.workerIds, workerId] });
      }
    } catch (err) {
      console.error(
        `spawnWorkerFromSpec: failed to register worker with session "${sessionId}"`,
        err,
      );
    }
  }

  return workerId;
}
