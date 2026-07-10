import { useEffect } from "react";
import { onEvent } from "#lib/event-bus";
import type { WorkerState } from "#store/types";
import { useWorkerStore } from "#store/workers";

/**
 * Global worker event subscription hook.
 *
 * Must be called exactly once at the app root level. Connects the
 * single ordered event bus to the Zustand worker store:
 *
 * - `worker_spawned` -> store.addWorker()
 * - `worker_output`  -> store.appendOutput()
 * - `worker_state`   -> store.updateState()
 * - `worker_killed`  -> store.removeWorker()
 *
 * All listeners are cleaned up on unmount — zero event listener leaks.
 */
export function useWorkerEvents(): void {
  useEffect(() => {
    const { addWorker, appendOutput, updateState, removeWorker } = useWorkerStore.getState();

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
      }),
    ];

    return () => {
      for (const off of offs) off();
    };
  }, []);
}
