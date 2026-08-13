import { useOptimistic } from "react";
import { killWorker, pauseWorker, resumeWorker } from "#lib/tauri";
import type { Worker, WorkerState } from "#store/types";
import { useWorkerAgentStore } from "#store/worker-agents";
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
      useWorkerAgentStore.getState().removeAgentMetadata(id);
    } catch {
      setOptimisticState(previousState ?? "idle");
    }
  };

  const optimisticWorker = worker
    ? { ...worker, state: optimisticState ?? worker.state }
    : undefined;

  return { worker: optimisticWorker, optimisticState, pause, resume, kill };
}
