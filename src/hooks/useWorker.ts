import { useOptimistic, useTransition } from "react";
import { toast } from "#components/ui/Toast";
import { errorMessage } from "#lib/is-error";
import { killWorker, pauseWorker, resumeWorker } from "#lib/tauri";
import type { Worker, WorkerState } from "#store/types";
import { useWorkerAgentStore } from "#store/worker-agents";
import { useWorkerStore } from "#store/workers";

interface UseWorkerReturn {
  /** The worker, with {@link UseWorkerReturn.optimisticState} applied. */
  readonly worker: Worker | undefined;
  /** The state a pending action is heading to, or the store's state when none is pending. */
  readonly optimisticState: WorkerState | undefined;
  /** `true` while a pause/resume/kill call is in flight. */
  readonly isPending: boolean;
  readonly pause: () => void;
  readonly resume: () => void;
  readonly kill: () => void;
}

/**
 * One worker's data and its pause/resume/kill actions.
 *
 * Each action is a React transition: the button shows the target state
 * at once (`useOptimistic`) while the backend call is in flight, and
 * React drops the optimistic value when the action settles. On success
 * the store already holds the new state; on failure the worker shows
 * its real state again and a toast says what failed.
 */
export function useWorker(id: string): UseWorkerReturn {
  const worker = useWorkerStore((s) => s.workers.get(id));
  const [isPending, startTransition] = useTransition();
  const [optimisticState, setOptimisticState] = useOptimistic(worker?.state);

  const run = (
    target: WorkerState,
    command: (id: string) => Promise<void>,
    failure: string,
    onSuccess: () => void,
  ): void => {
    startTransition(async () => {
      setOptimisticState(target);
      try {
        await command(id);
        onSuccess();
      } catch (err) {
        toast.error(failure, { description: errorMessage(err) });
      }
    });
  };

  const pause = (): void => {
    run("paused", pauseWorker, "Could Not Pause Worker", () => {
      useWorkerStore.getState().updateState(id, "paused");
    });
  };

  const resume = (): void => {
    run("running", resumeWorker, "Could Not Resume Worker", () => {
      useWorkerStore.getState().updateState(id, "running");
    });
  };

  const kill = (): void => {
    run("idle", killWorker, "Could Not Kill Worker", () => {
      useWorkerStore.getState().removeWorker(id);
      useWorkerAgentStore.getState().removeAgentMetadata(id);
    });
  };

  return {
    worker: worker && { ...worker, state: optimisticState ?? worker.state },
    optimisticState,
    isPending,
    pause,
    resume,
    kill,
  };
}
