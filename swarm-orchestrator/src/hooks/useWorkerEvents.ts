import { useEffect } from "react";
import { onEvent } from "#lib/event-bus";
import { sessionRemoveWorker } from "#lib/tauri";
import { useSessionStore } from "#store/sessions";
import type { WorkerState } from "#store/types";
import { useWorkerAgentStore } from "#store/worker-agents";
import { useWorkerStore } from "#store/workers";

/**
 * Global worker event subscription hook.
 *
 * Must be called exactly once at the app root level. Connects the
 * single ordered event bus to the Zustand worker store:
 *
 * - `worker_spawned`    -> store.addWorker()
 * - `worker_output`     -> store.appendOutput()
 * - `worker_state`      -> store.updateState()
 * - `worker_killed`     -> store.removeWorker() + agent-store cleanup +
 *   `session_remove_worker` for every session that still lists this id
 *   (the worker was explicitly killed OR died on its own — either way
 *   this is the one path both reach, see the handler below)
 * - `worktree_created`  -> store.setWorktreeInfo() (branch/worktreePath)
 *
 * All listeners are cleaned up on unmount — zero event listener leaks.
 */
export function useWorkerEvents(): void {
  useEffect(() => {
    const { addWorker, appendOutput, updateState, removeWorker, setWorktreeInfo } =
      useWorkerStore.getState();

    const offs = [
      onEvent("worker_spawned", (e) => {
        const p = e.payload as { workerId: string; name: string; pid: number | null };
        addWorker({
          id: p.workerId,
          name: p.name,
          pid: p.pid ?? undefined,
          state: "running",
          startedAt: new Date().toISOString(),
        });
      }),
      onEvent("worker_output", (e) => {
        const p = e.payload as { workerId: string; data: string };
        appendOutput(p.workerId, p.data);
      }),
      onEvent("worker_state", (e) => {
        const p = e.payload as { workerId: string; state: WorkerState };
        updateState(p.workerId, p.state);
      }),
      onEvent("worker_killed", (e) => {
        const p = e.payload as { workerId: string };
        removeWorker(p.workerId);
        // A worker that exits on its own (crash, process exit) reaches
        // this event without ever going through useWorker's kill()
        // path, which already cleans up agent metadata — without this,
        // a self-exiting templated worker's role/model/systemPrompt
        // entry would leak in useWorkerAgentStore for the app's
        // lifetime.
        useWorkerAgentStore.getState().removeAgentMetadata(p.workerId);
        // Same "explicit kill or self-exit, either way land here" logic
        // applies to session membership: without pruning, every
        // session's `workerIds` only ever grows (see
        // `SessionCard.tsx`'s render-time live-worker-store
        // intersection, which stays in place regardless — it's still
        // the honest render-time truth even once the persisted list is
        // pruned promptly). Best-effort/fire-and-forget: the resulting
        // `session_worker_removed` event (not this call's return value)
        // is what actually updates `useSessionStore`, via
        // `useSessionEvents` — a failed IPC call here just leaves that
        // session's list one entry too long until the next successful
        // prune, never a hang or a thrown error the user sees.
        for (const session of useSessionStore.getState().sessions.values()) {
          if (session.workerIds.includes(p.workerId)) {
            sessionRemoveWorker(session.id, p.workerId).catch(() => {});
          }
        }
      }),
      onEvent("worktree_created", (e) => {
        const p = e.payload as { workerId: string; worktreePath: string; branch: string };
        setWorktreeInfo(p.workerId, p.worktreePath, p.branch);
      }),
    ];

    return () => {
      for (const off of offs) off();
    };
  }, []);
}
