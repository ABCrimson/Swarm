import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { downsampledHistory, useSystemStore } from "#store/system";
import type { MetricPoint } from "#store/types";

function resetStore(): void {
  useSystemStore.getState().clearHistory();
  useSystemStore.getState().updateMetrics({
    cpuPercent: 0,
    memoryMb: 0,
    workerCount: 0,
    aiReqPerSec: 0,
    tokensPerSec: 0,
  });
}

function makePoint(time: number, cpu = 50, memory = 60, workerCount = 2): MetricPoint {
  return { time, cpu, memory, workerCount };
}

describe("SystemStore", () => {
  beforeEach(resetStore);
  afterEach(resetStore);

  describe("updateMetrics", () => {
    it("updates CPU metrics", () => {
      useSystemStore.getState().updateMetrics({ cpuPercent: 75 });

      expect(useSystemStore.getState().metrics.cpuPercent).toBe(75);
    });

    it("updates multiple metrics at once", () => {
      useSystemStore.getState().updateMetrics({
        cpuPercent: 42,
        memoryMb: 1024,
        workerCount: 5,
      });

      const { metrics } = useSystemStore.getState();
      expect(metrics.cpuPercent).toBe(42);
      expect(metrics.memoryMb).toBe(1024);
      expect(metrics.workerCount).toBe(5);
    });

    it("preserves fields not in the update", () => {
      useSystemStore.getState().updateMetrics({ tokensPerSec: 100 });
      useSystemStore.getState().updateMetrics({ cpuPercent: 55 });

      expect(useSystemStore.getState().metrics.tokensPerSec).toBe(100);
    });
  });

  describe("pushHistory (ring buffer)", () => {
    it("pushes a metric point to the history", () => {
      const point = makePoint(1000);
      useSystemStore.getState().pushHistory(point);

      const { history } = useSystemStore.getState().metrics;
      expect(history).toHaveLength(1);
      expect(history[0]).toEqual(point);
    });

    it("maintains insertion order for multiple points", () => {
      const { pushHistory } = useSystemStore.getState();
      pushHistory(makePoint(1));
      pushHistory(makePoint(2));
      pushHistory(makePoint(3));

      const { history } = useSystemStore.getState().metrics;
      expect(history).toHaveLength(3);
      expect(history[0].time).toBe(1);
      expect(history[1].time).toBe(2);
      expect(history[2].time).toBe(3);
    });

    it("caps at MAX_HISTORY (3600) and wraps around", () => {
      const { pushHistory } = useSystemStore.getState();

      // Push 3610 points (10 over the limit)
      for (let i = 0; i < 3610; i++) {
        pushHistory(makePoint(i));
      }

      const { history } = useSystemStore.getState().metrics;
      expect(history).toHaveLength(3600);
      // Oldest should be index 10 (first 10 were evicted)
      expect(history[0].time).toBe(10);
      // Last should be 3609
      expect(history[history.length - 1].time).toBe(3609);
    });
  });

  describe("clearHistory", () => {
    it("clears all history and resets the buffer", () => {
      const { pushHistory, clearHistory } = useSystemStore.getState();
      pushHistory(makePoint(1));
      pushHistory(makePoint(2));

      clearHistory();

      expect(useSystemStore.getState().metrics.history).toHaveLength(0);
    });

    it("allows pushing new data after clearing", () => {
      const { pushHistory, clearHistory } = useSystemStore.getState();
      pushHistory(makePoint(1));
      clearHistory();
      pushHistory(makePoint(100));

      expect(useSystemStore.getState().metrics.history).toHaveLength(1);
      expect(useSystemStore.getState().metrics.history[0].time).toBe(100);
    });
  });

  describe("downsampledHistory", () => {
    it("returns all points when count is below maxPoints", () => {
      const { pushHistory } = useSystemStore.getState();
      for (let i = 0; i < 10; i++) {
        pushHistory(makePoint(i, i * 10));
      }

      const result = downsampledHistory(60);
      expect(result).toHaveLength(10);
    });

    it("downsamples to maxPoints when history exceeds threshold", () => {
      const { pushHistory } = useSystemStore.getState();
      for (let i = 0; i < 200; i++) {
        pushHistory(makePoint(i, Math.sin(i / 10) * 50 + 50));
      }

      const result = downsampledHistory(20);
      expect(result.length).toBeLessThanOrEqual(20);
      // First and last points are always preserved by LTTB
      expect(result[0].time).toBe(0);
      expect(result[result.length - 1].time).toBe(199);
    });
  });
});
