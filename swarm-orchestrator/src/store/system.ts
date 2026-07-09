import { create } from "zustand";
import { subscribeWithSelector } from "zustand/middleware";
import { immer } from "zustand/middleware/immer";
import type { RingBuffer } from "#lib/metrics-aggregation";
import {
  createRingBuffer,
  downsampleLTTB,
  ringBufferPush,
  ringBufferToArray,
} from "#lib/metrics-aggregation";
import type { MetricPoint, SystemMetrics } from "./types";

/** Reactive state slice for system-level metrics. */
interface SystemStoreState {
  readonly metrics: SystemMetrics;
  /** Ring buffer for efficient fixed-size history storage. */
  readonly historyBuffer: RingBuffer<MetricPoint>;
}

/** Mutation actions for updating system metrics and history. */
interface SystemStoreActions {
  readonly updateMetrics: (metrics: Partial<SystemMetrics>) => void;
  readonly pushHistory: (point: MetricPoint) => void;
  readonly clearHistory: () => void;
}

/** 3600 samples = 30 min at 500ms intervals. */
const MAX_HISTORY = 3600;

/**
 * Zustand store for system performance metrics.
 *
 * Tracks CPU, memory, worker count, and AI throughput with a
 * ring-buffered history for time-series chart rendering.
 */
export const useSystemStore = create<SystemStoreState & SystemStoreActions>()(
  subscribeWithSelector(
    immer((set) => ({
      metrics: {
        cpuPercent: 0,
        memoryMb: 0,
        workerCount: 0,
        aiReqPerSec: 0,
        tokensPerSec: 0,
        history: [],
      },

      historyBuffer: createRingBuffer<MetricPoint>(MAX_HISTORY),

      updateMetrics(updates) {
        set((s) => {
          Object.assign(s.metrics, updates);
        });
      },

      pushHistory(point) {
        set((s) => {
          s.historyBuffer = ringBufferPush(s.historyBuffer, point);
          // Keep the flat history array synced for backward compatibility
          s.metrics.history = ringBufferToArray(s.historyBuffer);
        });
      },

      clearHistory() {
        set((s) => {
          s.historyBuffer = createRingBuffer<MetricPoint>(MAX_HISTORY);
          s.metrics.history = [];
        });
      },
    })),
  ),
);

/**
 * Selector: returns downsampled history for chart rendering.
 * Uses LTTB algorithm to reduce to at most `maxPoints` data points.
 */
export function downsampledHistory(maxPoints = 60): MetricPoint[] {
  const history = useSystemStore.getState().metrics.history;
  return downsampleLTTB(history, maxPoints);
}
