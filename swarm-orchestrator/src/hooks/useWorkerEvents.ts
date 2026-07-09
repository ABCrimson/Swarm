import { useEffect } from "react";
import { onWorkerOutput, onWorkerSpawned, onWorkerState } from "#lib/tauri";
import { useWorkerStore } from "#store/workers";

/**
 * Global worker event subscription hook.
 *
 * Must be called exactly once at the app root level. Connects Tauri
 * backend events to the Zustand worker store:
 *
 * - `worker:spawned` -> store.addWorker()
 * - `worker:output`  -> store.appendOutput()
 * - `worker:state`   -> store.updateState()
 *
 * All listeners are cleaned up on unmount — zero event listener leaks.
 */
export function useWorkerEvents(): void {
  useEffect(() => {
    let cancelled = false;
    const cleanups: Array<() => void> = [];

    const setupListeners = async (): Promise<void> => {
      const { addWorker, appendOutput, updateState } = useWorkerStore.getState();

      const unlistenSpawned = await onWorkerSpawned((worker) => {
        addWorker(worker);
      });
      if (cancelled) {
        unlistenSpawned();
        return;
      }
      cleanups.push(unlistenSpawned);

      const unlistenOutput = await onWorkerOutput(({ workerId, data }) => {
        appendOutput(workerId, data);
      });
      if (cancelled) {
        unlistenOutput();
        return;
      }
      cleanups.push(unlistenOutput);

      const unlistenState = await onWorkerState(({ workerId, state }) => {
        updateState(workerId, state);
      });
      if (cancelled) {
        unlistenState();
        return;
      }
      cleanups.push(unlistenState);
    };

    void setupListeners();

    return () => {
      cancelled = true;
      for (const cleanup of cleanups) {
        cleanup();
      }
    };
  }, []);
}
