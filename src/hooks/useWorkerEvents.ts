import { useSetAtom } from "jotai";
import { useEffect } from "react";
import { onEvent } from "#lib/event-bus";
import { listWorkers, sessionRemoveWorker } from "#lib/tauri";
import { useSessionStore } from "#store/sessions";
import { selectedWorkerIdAtom } from "#store/ui";
import { useWorkerAgentStore } from "#store/worker-agents";
import { useWorkerStore } from "#store/workers";

/**
 * Keeps the worker store in step with the backend. Call once, at the
 * app root.
 *
 * On mount it subscribes to the worker events, then loads the workers
 * the backend is already running (`list_workers`), so a reload, a new
 * swarmd tab or a relaunch of the webview shows them instead of an
 * empty list. A worker killed while that list was in flight is not
 * brought back, and a worker live events already added is kept as is.
 *
 * - `worker_spawned`   → `addWorker`
 * - `worker_output`    → `appendOutput`
 * - `worker_state`     → `updateState`
 * - `worktree_created` → `setWorktreeInfo`
 * - `worker_killed`    → `removeWorker`, plus everything else keyed on
 *   the worker (explicit kill and self-exit both end here): its agent
 *   metadata, the worker selection, and its id in every session's
 *   `workerIds`
 */
export function useWorkerEvents(): void {
  const setSelectedWorkerId = useSetAtom(selectedWorkerIdAtom);

  useEffect(() => {
    const { addWorker, appendOutput, updateState, removeWorker, setWorktreeInfo, hydrateWorkers } =
      useWorkerStore.getState();
    let hydrating = true;
    const killedWhileHydrating = new Set<string>();

    const offs = [
      onEvent("worker_spawned", ({ payload }) => {
        addWorker({
          id: payload.workerId,
          name: payload.name,
          ...(payload.pid == null ? {} : { pid: payload.pid }),
          state: "running",
          startedAt: new Date().toISOString(),
        });
      }),
      onEvent("worker_output", ({ payload }) => appendOutput(payload.workerId, payload.data)),
      onEvent("worker_state", ({ payload }) => updateState(payload.workerId, payload.state)),
      onEvent("worktree_created", ({ payload }) =>
        setWorktreeInfo(payload.workerId, payload.worktreePath, payload.branch),
      ),
      onEvent("worker_killed", ({ payload: { workerId } }) => {
        if (hydrating) killedWhileHydrating.add(workerId);
        removeWorker(workerId);
        useWorkerAgentStore.getState().removeAgentMetadata(workerId);
        setSelectedWorkerId((selected) => (selected === workerId ? null : selected));
        // Without pruning, a session's `workerIds` only ever grows.
        // Best effort: the resulting `session_worker_removed` event
        // (handled by `useSessionEvents`) updates the session store; a
        // failed call leaves one stale id until the next prune.
        for (const session of useSessionStore.getState().sessions.values()) {
          if (session.workerIds.includes(workerId)) {
            sessionRemoveWorker(session.id, workerId).catch(() => {});
          }
        }
      }),
    ];

    let unmounted = false;
    listWorkers()
      .then((workers) => {
        if (!unmounted) hydrateWorkers(workers.filter((w) => !killedWhileHydrating.has(w.id)));
      })
      .catch((err: unknown) => console.error("useWorkerEvents: could not load workers", err))
      .finally(() => {
        hydrating = false;
      });

    return () => {
      unmounted = true;
      for (const off of offs) off();
    };
  }, [setSelectedWorkerId]);
}
