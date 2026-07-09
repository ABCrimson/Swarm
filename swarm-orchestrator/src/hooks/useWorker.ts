import { useOptimistic } from "react";
import { killWorker, pauseWorker, resumeWorker, spawnWorker } from "#lib/tauri";
import type { Worker, WorkerState } from "#store/types";
import { useWorkerStore } from "#store/workers";

interface UseWorkerReturn {
  /** The current worker data (with optimistic state applied). */
  readonly worker: Worker | undefined;
  /** Optimistic state — reflects the UI intent before backend confirms. */
  readonly optimisticState: WorkerState | undefined;
  readonly pause: () => Promise<void>;
  readonly resume: () => Promise<void>;
  readonly kill: () => Promise<void>;
}

/**
 * Provides worker data and IPC-backed actions for a single worker.
 *
 * Uses React 19 `useOptimistic` for instant UI feedback before
 * the Tauri backend confirms the state change.
 */
export function useWorker(id: string): UseWorkerReturn {
  const worker = useWorkerStore((s) => s.workers.get(id));
  const updateState = useWorkerStore((s) => s.updateState);
  const removeWorker = useWorkerStore((s) => s.removeWorker);

  const [optimisticState, setOptimisticState] = useOptimistic<WorkerState | undefined, WorkerState>(
    worker?.state,
    (_current, next) => next,
  );

  const pause = async () => {
    const previousState = worker?.state;
    setOptimisticState("paused");
    try {
      await pauseWorker(id);
      updateState(id, "paused");
    } catch {
      setOptimisticState(previousState ?? "idle");
    }
  };

  const resume = async () => {
    const previousState = worker?.state;
    setOptimisticState("running");
    try {
      await resumeWorker(id);
      updateState(id, "running");
    } catch {
      setOptimisticState(previousState ?? "idle");
    }
  };

  const kill = async () => {
    const previousState = worker?.state;
    setOptimisticState("idle");
    try {
      await killWorker(id);
      removeWorker(id);
    } catch {
      setOptimisticState(previousState ?? "idle");
    }
  };

  const optimisticWorker = worker
    ? { ...worker, state: optimisticState ?? worker.state }
    : undefined;

  return { worker: optimisticWorker, optimisticState, pause, resume, kill };
}

/**
 * Hook to spawn a new worker. Returns the UUID of the spawned worker.
 *
 * The full Worker record is populated by the `worker:spawned` event listener;
 * this hook adds a minimal placeholder to the store immediately.
 */
export function useSpawnWorker(): (name?: string) => Promise<string> {
  const addWorker = useWorkerStore((s) => s.addWorker);

  return async (name?: string) => {
    const workerId = await spawnWorker(name);
    addWorker({
      id: workerId,
      state: "running",
      name: name ?? "Worker",
      startedAt: new Date().toISOString(),
    });
    return workerId;
  };
}
