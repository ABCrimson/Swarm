import { enableMapSet } from "immer";
import { create } from "zustand";
import { immer } from "zustand/middleware/immer";
import type { WorkerAgentMetadata } from "#store/types";

// Required for immer producers that mutate native Map instances (below).
enableMapSet();

/**
 * Per-worker agent metadata (role, model, system prompt) — the half of a
 * template's `WorkerSpawnSpec` (`#store/types`) that never crosses IPC
 * to Rust's `WorkerConfig`. Written at spawn time by
 * `#lib/worker-spawn`'s `spawnWorkerFromSpec`, removed when the worker
 * goes away (`#hooks/useWorker`, `#hooks/useWorkerEvents`).
 *
 * - `model`: the worker's pinned model. The chat engine
 *   (`#lib/ai-chat`) uses it instead of the global `selectedModelAtom`,
 *   and `ModelSelector` shows it and writes a manual pick for that
 *   worker back here.
 * - `systemPrompt`: sent as the `system` prompt of the worker's chat.
 * - `role`: descriptive only; nothing consumes it yet.
 */
interface WorkerAgentStoreState {
  readonly metadata: Map<string, WorkerAgentMetadata>;
}

/** Mutation actions for managing per-worker agent metadata. */
interface WorkerAgentStoreActions {
  readonly setAgentMetadata: (workerId: string, metadata: WorkerAgentMetadata) => void;
  readonly removeAgentMetadata: (workerId: string) => void;
}

/** Worker id → agent metadata. */
export const useWorkerAgentStore = create<WorkerAgentStoreState & WorkerAgentStoreActions>()(
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
);
