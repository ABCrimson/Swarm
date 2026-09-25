/**
 * The webview AI path's shared runtime state: the priority queue of chat
 * turns, the concurrency gate they wait on, and cumulative token/cost
 * accounting.
 *
 * Every chat turn (`#lib/ai-chat`) enqueues one item, waits in
 * {@link acquireStreamSlot} until fewer than `concurrentLimit` turns are
 * running and no higher-priority item is waiting ahead of it, holds that
 * slot for the whole turn, and releases it when the turn settles.
 * {@link AiStoreActions.cancelItem} aborts a turn from anywhere (AIQueue's
 * Cancel), not just from its own chat.
 *
 * @module ai-store
 */

import { create } from "zustand";
import { subscribeWithSelector } from "zustand/middleware";
import type { AiQueueItem, CumulativeUsage, TokenUsageRecord } from "#store/types";
import { DEFAULT_APP_SETTINGS } from "#store/ui";

/** Reactive state for the AI request queue and cost tracking. */
interface AiStoreState {
  /** Queued and running turns, highest priority first, FIFO within a priority. */
  readonly queue: readonly AiQueueItem[];
  /** Maximum turns that may hold a stream slot at once (the "AI Concurrent Limit" setting). */
  readonly concurrentLimit: number;
  /** Turns currently holding a stream slot. */
  readonly activeStreams: number;
  readonly cumulativeUsage: CumulativeUsage;
}

/** Mutation actions for the AI request queue and usage totals. */
interface AiStoreActions {
  readonly enqueue: (item: AiQueueItem) => void;
  readonly dequeue: (id: string) => void;
  readonly updateItemStatus: (id: string, status: AiQueueItem["status"]) => void;
  readonly setConcurrentLimit: (limit: number) => void;
  readonly addTokenUsage: (record: TokenUsageRecord) => void;
  /** Aborts the item's turn (if it registered an abort controller), marks it failed and drops it. */
  readonly cancelItem: (id: string) => void;
}

/** Queue order: lower sorts first. */
const PRIORITY_ORDER = {
  critical: 0,
  high: 1,
  normal: 2,
  low: 3,
} as const satisfies Record<AiQueueItem["priority"], number>;

/**
 * How long token-usage records are retained in `cumulativeUsage.history`.
 * Records only feed trailing-rate computations (AIMetricsChart's 60s
 * tokens/min window, ThroughputChart's 10s tokens/sec window), so anything
 * older than the widest window is dead weight. The cumulative totals are
 * separate counters and keep accumulating regardless.
 */
const USAGE_HISTORY_RETENTION_MS = 60_000;

const EMPTY_USAGE: CumulativeUsage = {
  totalInputTokens: 0,
  totalOutputTokens: 0,
  totalCostUsd: 0,
  history: [],
};

/** Abort handles for running turns, keyed by queue item id (non-serializable, so outside the state). */
const abortControllers = new Map<string, AbortController>();
/** Items currently holding a stream slot — makes {@link releaseStreamSlot} idempotent. */
const slotHolders = new Set<string>();

export const useAiStore = create<AiStoreState & AiStoreActions>()(
  subscribeWithSelector((set, get) => ({
    queue: [],
    concurrentLimit: DEFAULT_APP_SETTINGS.aiConcurrentLimit,
    activeStreams: 0,
    cumulativeUsage: EMPTY_USAGE,

    enqueue(item) {
      set((s) => {
        const rank = PRIORITY_ORDER[item.priority];
        const index = s.queue.findIndex((q) => PRIORITY_ORDER[q.priority] > rank);
        return { queue: index === -1 ? [...s.queue, item] : s.queue.toSpliced(index, 0, item) };
      });
    },

    dequeue(id) {
      set((s) => ({ queue: s.queue.filter((q) => q.id !== id) }));
    },

    updateItemStatus(id, status) {
      set((s) => ({ queue: s.queue.map((q) => (q.id === id ? { ...q, status } : q)) }));
    },

    setConcurrentLimit(limit) {
      set({ concurrentLimit: limit });
    },

    addTokenUsage(record) {
      set((s) => {
        const horizon = record.timestamp - USAGE_HISTORY_RETENTION_MS;
        return {
          cumulativeUsage: {
            totalInputTokens: s.cumulativeUsage.totalInputTokens + record.inputTokens,
            totalOutputTokens: s.cumulativeUsage.totalOutputTokens + record.outputTokens,
            totalCostUsd: s.cumulativeUsage.totalCostUsd + record.costUsd,
            history: [...s.cumulativeUsage.history.filter((r) => r.timestamp > horizon), record],
          },
        };
      });
    },

    cancelItem(id) {
      abortControllers.get(id)?.abort();
      get().updateItemStatus(id, "error");
      releaseStreamSlot(id);
      get().dequeue(id);
    },
  })),
);

/** Registers the abort handle {@link AiStoreActions.cancelItem} fires for `itemId`; returns the unregister function. */
export function registerQueueAbort(itemId: string, controller: AbortController): () => void {
  abortControllers.set(itemId, controller);
  return () => {
    if (abortControllers.get(itemId) === controller) abortControllers.delete(itemId);
  };
}

/** Whether `itemId` may take a slot now: capacity is free and no pending item is queued ahead of it. */
function mayStart(itemId: string): boolean {
  const { queue, activeStreams, concurrentLimit } = useAiStore.getState();
  if (activeStreams >= concurrentLimit) return false;
  const firstPending = queue.find((q) => q.status === "pending");
  return firstPending?.id === itemId;
}

/**
 * Waits until `itemId` (already enqueued as `pending`) may run, then
 * takes a stream slot and marks the item `streaming`. Rejects with the
 * signal's reason if `signal` aborts while waiting.
 */
export async function acquireStreamSlot(itemId: string, signal: AbortSignal): Promise<void> {
  while (!mayStart(itemId)) {
    signal.throwIfAborted();
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    const unsubscribe = useAiStore.subscribe(() => resolve());
    try {
      await promise;
    } finally {
      unsubscribe();
      signal.removeEventListener("abort", onAbort);
    }
  }
  slotHolders.add(itemId);
  useAiStore.setState((s) => ({ activeStreams: s.activeStreams + 1 }));
  useAiStore.getState().updateItemStatus(itemId, "streaming");
}

/** Returns `itemId`'s stream slot, if it holds one. Safe to call more than once. */
export function releaseStreamSlot(itemId: string): void {
  if (!slotHolders.delete(itemId)) return;
  useAiStore.setState((s) => ({ activeStreams: Math.max(0, s.activeStreams - 1) }));
}
