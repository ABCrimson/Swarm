import { create } from "zustand";
import { subscribeWithSelector } from "zustand/middleware";
import { appendCapped } from "#lib/metrics-aggregation";
import type { MetricPoint, SystemMetrics } from "#store/types";

/** Point-in-time values carried by one `system_metrics` sample. */
export type MetricsSample = Omit<SystemMetrics, "history">;

/** Reactive state slice for system-level metrics. */
interface SystemStoreState {
  readonly metrics: SystemMetrics;
}

/** Mutation actions for updating system metrics and history. */
interface SystemStoreActions {
  /**
   * Records one sample: replaces the current values and appends a history
   * point stamped `time`, in a single store update (one notification per
   * tick for every subscriber).
   */
  readonly recordSample: (sample: MetricsSample, time: number) => void;
}

/**
 * History retained for the Sessions page's CSV export: 3600 samples is
 * 30 minutes at the backend's 500ms cadence. The charts render only the
 * trailing `MAX_CHART_POINTS` of it.
 */
export const MAX_HISTORY = 3600;

/**
 * Zustand store for system performance metrics (CPU, memory, worker
 * count, AI throughput) plus a capped sample history for charts and CSV
 * export.
 *
 * Plain immutable updates, deliberately without immer: a draft would
 * copy and re-freeze the 3600-element history on every tick, where
 * appending to a capped array is one shallow copy.
 */
export const useSystemStore = create<SystemStoreState & SystemStoreActions>()(
  subscribeWithSelector((set) => ({
    metrics: {
      cpuPercent: 0,
      memoryMb: 0,
      memoryTotalMb: 0,
      workerCount: 0,
      tokensPerSec: 0,
      history: [],
    },

    recordSample(sample, time) {
      set(({ metrics }) => {
        const point: MetricPoint = {
          time,
          cpu: sample.cpuPercent,
          memory: sample.memoryMb,
          workerCount: sample.workerCount,
        };
        return {
          metrics: { ...sample, history: appendCapped(metrics.history, point, MAX_HISTORY) },
        };
      });
    },
  })),
);
