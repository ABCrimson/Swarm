import { create } from "zustand";
import { subscribeWithSelector } from "zustand/middleware";
import { immer } from "zustand/middleware/immer";
import type { Worker, WorkerState } from "./types";

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
    })),
  ),
);
