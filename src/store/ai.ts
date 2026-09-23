import { create } from "zustand";
import { subscribeWithSelector } from "zustand/middleware";
import { immer } from "zustand/middleware/immer";
import { CLAUDE_MODELS } from "#lib/models";
import type { AiQueueItem, CumulativeUsage, ProviderConfig, TokenUsageRecord } from "#store/types";

/** Reactive state slice for the AI request queue, provider selection, and cost tracking. */
interface AiStoreState {
  readonly queue: AiQueueItem[];
  readonly concurrentLimit: number;
  readonly activeStreams: number;
  readonly selectedProvider: ProviderConfig;
  readonly cumulativeUsage: CumulativeUsage;
}

/** Mutation actions for managing the AI request queue and provider state. */
interface AiStoreActions {
  readonly enqueue: (item: AiQueueItem) => void;
  readonly dequeue: (id: string) => void;
  readonly updateItemStatus: (id: string, status: AiQueueItem["status"]) => void;
  readonly setConcurrentLimit: (limit: number) => void;
  readonly setActiveStreams: (count: number) => void;
  readonly setSelectedProvider: (config: ProviderConfig) => void;
  readonly addTokenUsage: (record: TokenUsageRecord) => void;
  readonly resetUsage: () => void;
}

/** Default provider configuration (Anthropic Claude Sonnet 5). */
const DEFAULT_PROVIDER: ProviderConfig = {
  providerId: "anthropic",
  modelId: CLAUDE_MODELS.sonnet.id,
};

/** Empty cumulative usage state. */
const EMPTY_USAGE: CumulativeUsage = {
  totalInputTokens: 0,
  totalOutputTokens: 0,
  totalCostUsd: 0,
  history: [],
};

/**
 * How long token-usage records are retained in `cumulativeUsage.history`.
 * Records only feed trailing-rate computations (AIMetricsChart's 60s
 * tokens/min window, ThroughputChart's 10s tokens/sec window), so anything
 * older than the widest window is dead weight — without pruning, the pool
 * grows unboundedly for the lifetime of the app. The cumulative totals are
 * separate counters and keep accumulating regardless.
 */
const USAGE_HISTORY_RETENTION_MS = 60_000;

/**
 * Zustand store for the priority-based AI request queue,
 * provider selection, and cumulative token cost tracking.
 *
 * Items are inserted in priority order (critical > high > normal > low).
 * Concurrent streaming is bounded by `concurrentLimit`.
 */
export const useAiStore = create<AiStoreState & AiStoreActions>()(
  subscribeWithSelector(
    immer((set) => ({
      queue: [],
      concurrentLimit: 3,
      activeStreams: 0,
      selectedProvider: DEFAULT_PROVIDER,
      cumulativeUsage: EMPTY_USAGE,

      enqueue(item) {
        set((s) => {
          // Insert by priority: critical > high > normal > low
          const priorityOrder: Record<string, number> = { critical: 0, high: 1, normal: 2, low: 3 };
          const idx = s.queue.findIndex(
            (q) => (priorityOrder[q.priority] ?? 3) > (priorityOrder[item.priority] ?? 3),
          );
          if (idx === -1) {
            s.queue.push(item);
          } else {
            s.queue.splice(idx, 0, item);
          }
        });
      },

      dequeue(id) {
        set((s) => {
          s.queue = s.queue.filter((q) => q.id !== id);
        });
      },

      updateItemStatus(id, status) {
        set((s) => {
          const item = s.queue.find((q) => q.id === id);
          if (item) item.status = status;
        });
      },

      setConcurrentLimit(limit) {
        set((s) => {
          s.concurrentLimit = limit;
        });
      },

      setActiveStreams(count) {
        set((s) => {
          s.activeStreams = count;
        });
      },

      setSelectedProvider(config) {
        set((s) => {
          s.selectedProvider = config;
        });
      },

      addTokenUsage(record) {
        set((s) => {
          s.cumulativeUsage.totalInputTokens += record.inputTokens;
          s.cumulativeUsage.totalOutputTokens += record.outputTokens;
          s.cumulativeUsage.totalCostUsd += record.costUsd;
          const horizon = record.timestamp - USAGE_HISTORY_RETENTION_MS;
          s.cumulativeUsage.history = s.cumulativeUsage.history.filter(
            (r) => r.timestamp > horizon,
          );
          s.cumulativeUsage.history.push(record);
        });
      },

      resetUsage() {
        set((s) => {
          s.cumulativeUsage = EMPTY_USAGE;
        });
      },
    })),
  ),
);
