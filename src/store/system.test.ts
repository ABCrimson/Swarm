import { beforeEach, describe, expect, it } from "vitest";
import type { MetricsSample } from "#store/system";
import { MAX_HISTORY, useSystemStore } from "#store/system";
import type { MetricPoint } from "#store/types";

function sample(overrides: Partial<MetricsSample> = {}): MetricsSample {
  return {
    cpuPercent: 50,
    memoryMb: 1024,
    memoryTotalMb: 16_384,
    workerCount: 2,
    aiReqPerSec: 0,
    tokensPerSec: 0,
    ...overrides,
  };
}

function point(time: number): MetricPoint {
  return { time, cpu: 1, memory: 1, workerCount: 1 };
}

describe("SystemStore", () => {
  beforeEach(() => {
    useSystemStore.setState(useSystemStore.getInitialState(), true);
  });

  describe("recordSample", () => {
    it("replaces every current value, including tokensPerSec", () => {
      useSystemStore
        .getState()
        .recordSample(sample({ cpuPercent: 42, memoryMb: 2048, tokensPerSec: 12.5 }), 1);

      const { metrics } = useSystemStore.getState();
      expect(metrics).toMatchObject({ cpuPercent: 42, memoryMb: 2048, tokensPerSec: 12.5 });
    });

    it("appends a history point stamped with the given time", () => {
      useSystemStore.getState().recordSample(sample({ cpuPercent: 7, workerCount: 3 }), 123);

      expect(useSystemStore.getState().metrics.history).toEqual([
        { time: 123, cpu: 7, memory: 1024, workerCount: 3 },
      ]);
    });

    it("keeps history in insertion order", () => {
      const { recordSample } = useSystemStore.getState();
      recordSample(sample(), 1);
      recordSample(sample(), 2);
      recordSample(sample(), 3);

      expect(useSystemStore.getState().metrics.history.map((p) => p.time)).toEqual([1, 2, 3]);
    });

    it("notifies subscribers once per sample (values and history in one update)", () => {
      let notifications = 0;
      const unsubscribe = useSystemStore.subscribe(() => {
        notifications += 1;
      });
      useSystemStore.getState().recordSample(sample(), 1);
      unsubscribe();

      expect(notifications).toBe(1);
    });

    it(`caps history at MAX_HISTORY (${MAX_HISTORY}), dropping the oldest`, () => {
      // Seed a full history directly; the append/cap arithmetic itself is
      // covered by appendCapped's tests in metrics-aggregation.test.ts.
      const full = Array.from({ length: MAX_HISTORY }, (_, i) => point(i));
      useSystemStore.setState({ metrics: { ...useSystemStore.getState().metrics, history: full } });

      useSystemStore.getState().recordSample(sample(), MAX_HISTORY);

      const { history } = useSystemStore.getState().metrics;
      expect(history).toHaveLength(MAX_HISTORY);
      expect(history.at(0)?.time).toBe(1);
      expect(history.at(-1)?.time).toBe(MAX_HISTORY);
    });

    it("never mutates the previous history array", () => {
      useSystemStore.getState().recordSample(sample(), 1);
      const before = useSystemStore.getState().metrics.history;

      useSystemStore.getState().recordSample(sample(), 2);

      expect(before.map((p) => p.time)).toEqual([1]);
    });
  });
});
