// ── Worker Spawn (process options + agent metadata split) ──
//
// `WorkerSpawnSpec` (#store/types) bundles two halves that must never
// be conflated: process options (name/shell/cwd/env/repoRoot/isolation — sent to Rust's
// WorkerConfig over IPC) and agent metadata (role/model/systemPrompt —
// client-side only). This module is the one place that spawns a worker
// from the combined spec, splitting it correctly and — when spawning
// happens in the context of a session (template application) — wiring
// the new worker into that session via `session_add_worker`.

import { toast } from "sonner";
import { escapeForDisplay } from "#lib/display-escape";
import { errorMessage } from "#lib/is-error";
import { getPersistedRepoRoot } from "#lib/project-root";
import type { ProvenanceArgs } from "#lib/tauri";
import { DESKTOP_ONLY_REASON, hasCapability, sessionAddWorker, spawnWorker } from "#lib/tauri";
import { useSessionStore } from "#store/sessions";
import type { WorkerSpawnSpec } from "#store/types";
import { useWorkerAgentStore } from "#store/worker-agents";
import { useWorkerStore } from "#store/workers";

/**
 * Spawns a worker from a full `WorkerSpawnSpec`.
 *
 * - Process options (`name`/`shell`/`cwd`/`env`/`repoRoot`/`isolation`) go to Rust via
 *   `spawnWorker` (`#lib/tauri`).
 * - Agent metadata (`role`/`model`/`systemPrompt`) is stored
 *   client-side in `useWorkerAgentStore`, keyed by the new worker id —
 *   `#lib/ai-chat` reads it from there to resolve this worker's
 *   effective model (`resolveChatModel`) and inject its system prompt
 *   (`runTurn`), which is what makes a template's agent config real
 *   instead of decorative.
 * - Adds a placeholder to `useWorkerStore` once `spawnWorker`
 *   resolves, unless the store already holds the worker: the
 *   `worker_spawned` event (see `useWorkerEvents`) can arrive before
 *   the command's response, possibly followed by `worktree_created`,
 *   and that record must not be replaced. When the event arrives later
 *   it overwrites the placeholder.
 * - When `sessionId` is given, registers the worker against that
 *   session via `session_add_worker` and mirrors the result into
 *   `useSessionStore`. The backend's `session_worker_added` event (see
 *   `useSessionEvents`) may land first; both go through the idempotent
 *   `addWorkerToSession`.
 * - If `session_add_worker` fails, the worker keeps running outside the
 *   session: the failure is logged and shown as a warning toast, and the
 *   worker id is still returned, since the worker did spawn.
 * - When `spec` doesn't specify its own `repoRoot`, falls back to the
 *   persisted `default_repo_root` (the Project Root picker in the Spawn
 *   Worker dialog), so template and tool-driven spawns get worktree
 *   isolation too, not only spawns started from that dialog.
 *
 * @throws {Error} With `DESKTOP_ONLY_REASON` when the transport lacks `localAiChat` (the swarmd
 * `--serve-ui` page): a worker spawned here is a webview worker, which that build cannot chat with,
 * so the refusal comes before `spawnWorker` and every caller shows the reason. Agent CLI workers
 * spawn through `agentSpawn` instead.
 *
 * @returns The new worker's UUID, or `null` when `spawnWorker` degraded
 * gracefully because there is no backend transport (neither Tauri IPC
 * nor a swarmd connection, e.g. `pnpm dev` in a plain browser). No
 * store writes happen then, since there is no worker id to key them on.
 *
 * `prov` is optional causal attribution (e.g. an AI turn's `spawn_worker`
 * tool call), forwarded to `spawnWorker` only when given: an
 * unattributed spawn passes the process options alone.
 */
export async function spawnWorkerFromSpec(
  spec: WorkerSpawnSpec,
  sessionId?: string,
  prov?: ProvenanceArgs,
): Promise<string | null> {
  if (!hasCapability("localAiChat")) throw new Error(DESKTOP_ONLY_REASON);
  const { role, model, systemPrompt, ...processOptions } = spec;
  if (processOptions.repoRoot === undefined) {
    const persistedRoot = await getPersistedRepoRoot();
    if (persistedRoot) processOptions.repoRoot = persistedRoot;
  }
  const workerId = prov
    ? await spawnWorker(processOptions, prov)
    : await spawnWorker(processOptions);
  if (workerId === null) return null;

  useWorkerStore.getState().addMissingWorkers([
    {
      id: workerId,
      state: "running",
      name: processOptions.name,
      startedAt: new Date().toISOString(),
    },
  ]);

  if (role !== undefined || model !== undefined || systemPrompt !== undefined) {
    useWorkerAgentStore.getState().setAgentMetadata(workerId, { role, model, systemPrompt });
  }

  if (sessionId) {
    try {
      await sessionAddWorker(sessionId, workerId);
      // Idempotent: the `session_worker_added` event (`useSessionEvents`)
      // may already have added it, and each add is one atomic store
      // update, so concurrent spawns into one session lose nothing.
      useSessionStore.getState().addWorkerToSession(sessionId, workerId);
    } catch (err) {
      console.error(
        `spawnWorkerFromSpec: failed to register worker with session "${sessionId}"`,
        err,
      );
      toast.warning(
        `Worker "${escapeForDisplay(processOptions.name)}" Spawned But Could Not Join The Session`,
        {
          description: errorMessage(err),
        },
      );
    }
  }

  return workerId;
}
