import { enableMapSet } from "immer";
import { create } from "zustand";
import { subscribeWithSelector } from "zustand/middleware";
import { immer } from "zustand/middleware/immer";
import type { WorkerAgentMetadata } from "./types";

// Required for immer producers that mutate native Map instances (below).
enableMapSet();

/**
 * Reactive state slice for per-worker agent metadata (role/model/system
 * prompt) — the half of a `WorkerSpawnSpec` (`#store/types`) that never
 * travels over IPC to Rust's `WorkerConfig`. Populated at spawn time
 * (see `#lib/worker-spawn`'s `spawnWorkerFromSpec`) for workers spawned
 * from a session template, keyed by worker id. `WorkerAIPanel`/`AIChat`
 * read it to preselect that worker's model and inject its system
 * prompt — this is what makes a template's role/model/systemPrompt
 * real instead of decorative.
 */
interface WorkerAgentStoreState {
  readonly metadata: Map<string, WorkerAgentMetadata>;
}

/** Mutation actions for managing per-worker agent metadata. */
interface WorkerAgentStoreActions {
  readonly setAgentMetadata: (workerId: string, metadata: WorkerAgentMetadata) => void;
  readonly removeAgentMetadata: (workerId: string) => void;
}

/**
 * Zustand store mapping worker id -> agent metadata.
 *
 * Uses immer for immutable updates and `subscribeWithSelector` for
 * fine-grained subscriptions, matching `useWorkerStore`/`useSessionStore`.
 */
export const useWorkerAgentStore = create<WorkerAgentStoreState & WorkerAgentStoreActions>()(
  subscribeWithSelector(
    immer((set) => ({
      metadata: new Map(),

      setAgentMetadata(workerId, metadata) {
        set((s) => {
          s.metadata.set(workerId, metadata);
        });
      },

      removeAgentMetadata(workerId) {
        set((s) => {
          s.metadata.delete(workerId);
        });
      },
    })),
  ),
);
