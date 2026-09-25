import { enableMapSet } from "immer";
import { create } from "zustand";
import { subscribeWithSelector } from "zustand/middleware";
import { immer } from "zustand/middleware/immer";
import type { Worker, WorkerState } from "#store/types";

// Required for immer producers that mutate native Map instances (below).
enableMapSet();

/** Characters of PTY output kept per worker; older output is dropped first. */
export const OUTPUT_BUFFER_CHARS = 10_000;

/** Reactive state slice for the worker registry. */
interface WorkerStoreState {
  readonly workers: Map<string, Worker>;
}

/** Mutation actions for managing workers in the store. */
interface WorkerStoreActions {
  readonly addWorker: (worker: Worker) => void;
  /**
   * Adds each worker the store does not hold yet and leaves the others
   * untouched. For records older than the live events: the
   * `list_workers` snapshot taken at startup, and the placeholder
   * `spawnWorkerFromSpec` adds once `spawn_worker` returns (by then
   * `worker_spawned`/`worktree_created` may already have stored the
   * real record).
   */
  readonly addMissingWorkers: (workers: readonly Worker[]) => void;
  readonly updateState: (id: string, state: WorkerState) => void;
  readonly removeWorker: (id: string) => void;
  readonly appendOutput: (id: string, data: string) => void;
  /**
   * Mirrors a worker's `worktreePath`/`branch` from the backend
   * `worktree_created` event (see `#hooks/useWorkerEvents`). A no-op
   * if the worker isn't (yet) in the store; `worker_spawned` is
   * emitted before `worktree_created`, so it normally is.
   */
  readonly setWorktreeInfo: (id: string, worktreePath: string, branch: string) => void;
}

/**
 * Zustand store for SWARM worker processes.
 *
 * Uses immer for immutable updates and `subscribeWithSelector` for
 * fine-grained subscriptions. Output is ring-buffered to
 * {@link OUTPUT_BUFFER_CHARS} characters per worker. Selection lives in
 * `selectedWorkerIdAtom` (`#store/ui`), not here.
 */
export const useWorkerStore = create<WorkerStoreState & WorkerStoreActions>()(
  subscribeWithSelector(
    immer((set) => ({
      workers: new Map(),

      addWorker(worker) {
        set((s) => {
          s.workers.set(worker.id, worker);
        });
      },

      addMissingWorkers(workers) {
        set((s) => {
          for (const worker of workers) {
            if (!s.workers.has(worker.id)) s.workers.set(worker.id, worker);
          }
        });
      },

      updateState(id, state) {
        set((s) => {
          const w = s.workers.get(id);
          if (w) w.state = state;
        });
      },

      removeWorker(id) {
        set((s) => {
          s.workers.delete(id);
        });
      },

      appendOutput(id, data) {
        set((s) => {
          const w = s.workers.get(id);
          if (w) w.output = ((w.output ?? "") + data).slice(-OUTPUT_BUFFER_CHARS);
        });
      },

      setWorktreeInfo(id, worktreePath, branch) {
        set((s) => {
          const w = s.workers.get(id);
          if (w) {
            w.worktreePath = worktreePath;
            w.branch = branch;
          }
        });
      },
    })),
  ),
);
