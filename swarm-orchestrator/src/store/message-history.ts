/**
 * Per-worker AI conversation history store with LRU eviction.
 *
 * Caps at {@link MAX_MESSAGES_PER_WORKER} messages per worker and
 * {@link MAX_WORKERS} total workers. Least-recently-used workers
 * are evicted when the cap is exceeded.
 *
 * @module message-history
 */

import { enableMapSet } from "immer";
import { create } from "zustand";
import { subscribeWithSelector } from "zustand/middleware";
import { immer } from "zustand/middleware/immer";
import type { AiMessage } from "./types";

// Required for immer producers that mutate native Map instances (below).
enableMapSet();

/** Maximum messages stored per worker. */
const MAX_MESSAGES_PER_WORKER = 100;
/** Maximum number of workers to keep history for. */
const MAX_WORKERS = 50;

interface MessageHistoryState {
  /** Per-worker message history. */
  readonly history: Map<string, AiMessage[]>;
  /** LRU order: most recently accessed worker IDs. */
  readonly lruOrder: string[];
}

interface MessageHistoryActions {
  /** Add a message to a worker's history. */
  readonly addMessage: (workerId: string, message: AiMessage) => void;
  /** Add multiple messages to a worker's history. */
  readonly addMessages: (workerId: string, messages: AiMessage[]) => void;
  /** Get messages for a worker. */
  readonly getMessages: (workerId: string) => AiMessage[];
  /** Clear history for a specific worker. */
  readonly clearWorker: (workerId: string) => void;
  /** Clear all history. */
  readonly clearAll: () => void;
  /** Touch a worker to move it to the front of the LRU. */
  readonly touch: (workerId: string) => void;
}

/**
 * Moves a worker ID to the front of the LRU list.
 * Evicts the least recently used worker if we exceed MAX_WORKERS.
 */
function touchLru(lruOrder: string[], workerId: string, history: Map<string, AiMessage[]>): void {
  const idx = lruOrder.indexOf(workerId);
  if (idx !== -1) {
    lruOrder.splice(idx, 1);
  }
  lruOrder.unshift(workerId);

  // Evict LRU workers beyond max
  while (lruOrder.length > MAX_WORKERS) {
    const evicted = lruOrder.pop();
    if (evicted) {
      history.delete(evicted);
    }
  }
}

/**
 * Zustand store for per-worker AI message history.
 *
 * Messages are capped per worker and workers are LRU-evicted
 * when the total exceeds {@link MAX_WORKERS}.
 */
/**
 * Standalone selector for retrieving messages for a specific worker.
 * Prefer this over the store action `getMessages` for reactive usage in components.
 */
export const selectMessages = (workerId: string) => (state: MessageHistoryState) =>
  state.history.get(workerId) ?? [];

export const useMessageHistoryStore = create<MessageHistoryState & MessageHistoryActions>()(
  subscribeWithSelector(
    immer((set, get) => ({
      history: new Map(),
      lruOrder: [],

      addMessage(workerId, message) {
        set((s) => {
          if (!s.history.has(workerId)) {
            s.history.set(workerId, []);
          }
          const workerMessages = s.history.get(workerId);
          if (!workerMessages) return;
          workerMessages.push(message);

          // LRU eviction within worker
          if (workerMessages.length > MAX_MESSAGES_PER_WORKER) {
            const excess = workerMessages.length - MAX_MESSAGES_PER_WORKER;
            workerMessages.splice(0, excess);
          }

          touchLru(s.lruOrder, workerId, s.history);
        });
      },

      addMessages(workerId, messages) {
        set((s) => {
          if (!s.history.has(workerId)) {
            s.history.set(workerId, []);
          }
          const workerMessages = s.history.get(workerId);
          if (!workerMessages) return;
          workerMessages.push(...messages);

          // LRU eviction within worker
          if (workerMessages.length > MAX_MESSAGES_PER_WORKER) {
            const excess = workerMessages.length - MAX_MESSAGES_PER_WORKER;
            workerMessages.splice(0, excess);
          }

          touchLru(s.lruOrder, workerId, s.history);
        });
      },

      getMessages(workerId) {
        return get().history.get(workerId) ?? [];
      },

      clearWorker(workerId) {
        set((s) => {
          s.history.delete(workerId);
          const idx = s.lruOrder.indexOf(workerId);
          if (idx !== -1) s.lruOrder.splice(idx, 1);
        });
      },

      clearAll() {
        set((s) => {
          s.history.clear();
          s.lruOrder.length = 0;
        });
      },

      touch(workerId) {
        set((s) => {
          touchLru(s.lruOrder, workerId, s.history);
        });
      },
    })),
  ),
);
