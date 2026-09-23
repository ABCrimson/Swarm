import { enableMapSet } from "immer";
import { create } from "zustand";
import { subscribeWithSelector } from "zustand/middleware";
import { immer } from "zustand/middleware/immer";
import type { Worker, WorkerState } from "#store/types";

// Required for immer producers that mutate native Map instances (below).
enableMapSet();

/** Reactive state slice for the worker registry. */
interface WorkerStoreState {
  readonly workers: Map<string, Worker>;
  readonly selectedId: string | null;
}

/** Mutation actions for managing workers in the store. */
interface WorkerStoreActions {
  readonly addWorker: (worker: Worker) => void;
  readonly updateState: (id: string, state: WorkerState) => void;
  readonly removeWorker: (id: string) => void;
  readonly selectWorker: (id: string | null) => void;
  readonly appendOutput: (id: string, data: string) => void;
  /**
   * Mirrors a worker's `worktreePath`/`branch` from the backend
   * `worktree_created` event (see `#hooks/useWorkerEvents`). A no-op
   * if the worker isn't (yet) in the store — the optimistic
   * `addWorker` placeholder from `spawnWorkerFromSpec` normally lands
   * first, but this guards the ordering either way.
   */
  readonly setWorktreeInfo: (id: string, worktreePath: string, branch: string) => void;
}

/**
 * Zustand store for SWARM worker processes.
 *
 * Uses immer for immutable updates and `subscribeWithSelector`
 * for fine-grained subscriptions. Output is ring-buffered to 10 000 chars.
 */
export const useWorkerStore = create<WorkerStoreState & WorkerStoreActions>()(
  subscribeWithSelector(
    immer((set) => ({
      workers: new Map(),
      selectedId: null,

      addWorker(worker) {
        set((s) => {
          s.workers.set(worker.id, worker);
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
          if (s.selectedId === id) s.selectedId = null;
        });
      },

      selectWorker(id) {
        set((s) => {
          s.selectedId = id;
        });
      },

      appendOutput(id, data) {
        set((s) => {
          const w = s.workers.get(id);
          if (w) {
            w.output = (w.output ?? "") + data;
            // Ring buffer: keep last 10k characters
            if (w.output.length > 10_000) {
              w.output = w.output.slice(-10_000);
            }
          }
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
