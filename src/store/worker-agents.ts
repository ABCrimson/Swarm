import { enableMapSet } from "immer";
import { create } from "zustand";
import { subscribeWithSelector } from "zustand/middleware";
import { immer } from "zustand/middleware/immer";
import type { WorkerAgentMetadata } from "#store/types";

// Required for immer producers that mutate native Map instances (below).
enableMapSet();

/**
 * Reactive state slice for per-worker agent metadata (role/model/system
 * prompt) — the half of a `WorkerSpawnSpec` (`#store/types`) that never
 * travels over IPC to Rust's `WorkerConfig`. Populated at spawn time
 * (see `#lib/worker-spawn`'s `spawnWorkerFromSpec`) for workers spawned
 * from a session template, keyed by worker id.
 *
 * `AIChat` reads `model`/`systemPrompt` to resolve that worker's
 * effective model at request time and inject its system prompt.
 * `ModelSelector` (given a `workerId` prop, e.g. from `WorkerAIPanel`)
 * treats a set `model` as that worker's single source of truth for both
 * display and selection — showing the model requests actually use, and
 * writing a manual pick back into this same entry instead of the
 * global, persisted `selectedModelAtom`. Together this is what makes a
 * template's model/systemPrompt real instead of decorative, and keeps
 * the dropdown from ever lying about which model a templated worker's
 * requests use. `role` is not consumed by either yet — it is kept for
 * the upcoming multi-provider (ACP) work.
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
