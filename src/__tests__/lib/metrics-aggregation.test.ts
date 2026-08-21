import { describe, expect, it } from "vitest";
import type { WorkerMetricSnapshot } from "#lib/metrics-aggregation";
import {
  aggregateWorkerMetrics,
  createRingBuffer,
  downsampleLTTB,
  downsampleNth,
  ringBufferPush,
  ringBufferToArray,
} from "#lib/metrics-aggregation";
import type { MetricPoint } from "#store/types";

// ── RingBuffer ────────────────────────────────────────

describe("RingBuffer", () => {
  describe("createRingBuffer", () => {
    it("creates an empty buffer with given capacity", () => {
      const buf = createRingBuffer<number>(10);
      expect(buf.capacity).toBe(10);
      expect(buf.size).toBe(0);
      expect(buf.head).toBe(0);
    });

    it("toArray returns empty array for new buffer", () => {
      const buf = createRingBuffer<number>(5);
      expect(ringBufferToArray(buf)).toEqual([]);
    });
  });

  describe("ringBufferPush", () => {
    it("pushes items and increments size", () => {
      let buf = createRingBuffer<number>(5);
      buf = ringBufferPush(buf, 10);

      expect(buf.size).toBe(1);
      expect(ringBufferToArray(buf)).toEqual([10]);
    });

    it("pushes multiple items in order", () => {
      let buf = createRingBuffer<number>(5);
      buf = ringBufferPush(buf, 1);
      buf = ringBufferPush(buf, 2);
      buf = ringBufferPush(buf, 3);

      expect(buf.size).toBe(3);
      expect(ringBufferToArray(buf)).toEqual([1, 2, 3]);
    });

    it("size caps at capacity", () => {
      let buf = createRingBuffer<number>(3);
      buf = ringBufferPush(buf, 1);
      buf = ringBufferPush(buf, 2);
      buf = ringBufferPush(buf, 3);
      buf = ringBufferPush(buf, 4);

      expect(buf.size).toBe(3);
    });
  });

  describe("ringBufferToArray with overflow", () => {
    it("returns items in correct order after overflow", () => {
      let buf = createRingBuffer<number>(3);
      buf = ringBufferPush(buf, 1);
      buf = ringBufferPush(buf, 2);
      buf = ringBufferPush(buf, 3);
      buf = ringBufferPush(buf, 4); // Evicts 1

      const result = ringBufferToArray(buf);
      expect(result).toEqual([2, 3, 4]);
    });

    it("returns correct order after multiple overflows", () => {
      let buf = createRingBuffer<number>(3);
      for (let i = 1; i <= 10; i++) {
        buf = ringBufferPush(buf, i);
      }

      expect(ringBufferToArray(buf)).toEqual([8, 9, 10]);
    });

    it("handles capacity of 1", () => {
      let buf = createRingBuffer<number>(1);
      buf = ringBufferPush(buf, 42);
      buf = ringBufferPush(buf, 99);

      expect(ringBufferToArray(buf)).toEqual([99]);
    });
  });
});

// ── LTTB Downsampling ────────────────────────────────

describe("downsampleLTTB", () => {
  function makePoints(count: number): MetricPoint[] {
    return Array.from({ length: count }, (_, i) => ({
      time: i,
      cpu: Math.sin(i / 10) * 50 + 50,
      memory: 60,
      workerCount: 2,
    }));
  }

  it("returns original data when length is less than or equal to maxPoints", () => {
    const data = makePoints(5);
    const result = downsampleLTTB(data, 10);
    expect(result).toBe(data); // Same reference
  });

  it("returns original data when maxPoints is less than 3", () => {
    const data = makePoints(100);
    const result = downsampleLTTB(data, 2);
    expect(result).toBe(data);
  });

  it("downsamples to approximately maxPoints", () => {
    const data = makePoints(200);
    const result = downsampleLTTB(data, 20);
    expect(result).toHaveLength(20);
  });

  it("always preserves the first and last data points", () => {
    const data = makePoints(100);
    const result = downsampleLTTB(data, 10);

    expect(result[0]).toEqual(data[0]);
    expect(result[result.length - 1]).toEqual(data[data.length - 1]);
  });

  it("produces fewer or equal points than the original", () => {
    const data = makePoints(500);
    const result = downsampleLTTB(data, 50);
    expect(result.length).toBeLessThanOrEqual(data.length);
  });
});

// ── Nth-point Sampling ───────────────────────────────

describe("downsampleNth", () => {
  function makePoints(count: number): MetricPoint[] {
    return Array.from({ length: count }, (_, i) => ({
      time: i,
      cpu: i * 2,
      memory: 50,
      workerCount: 1,
    }));
  }

  it("returns original data when length is within maxPoints", () => {
    const data = makePoints(5);
    const result = downsampleNth(data, 10);
    expect(result).toBe(data);
  });

  it("downsamples to maxPoints entries", () => {
    const data = makePoints(100);
    const result = downsampleNth(data, 10);
    expect(result).toHaveLength(10);
  });

  it("always includes the last data point", () => {
    const data = makePoints(100);
    const result = downsampleNth(data, 10);
    expect(result[result.length - 1]).toEqual(data[data.length - 1]);
  });
});

// ── aggregateWorkerMetrics ───────────────────────────

describe("aggregateWorkerMetrics", () => {
  it("sums up metrics across workers", () => {
    const snapshots: WorkerMetricSnapshot[] = [
      { workerId: "w1", cpu: 30, memory: 200, messagesSent: 5, toolCalls: 2, errors: 0 },
      { workerId: "w2", cpu: 40, memory: 300, messagesSent: 10, toolCalls: 3, errors: 1 },
    ];

    const result = aggregateWorkerMetrics(snapshots);

    expect(result.totalCpu).toBe(70);
    expect(result.totalMemory).toBe(500);
    expect(result.totalMessages).toBe(15);
    expect(result.totalToolCalls).toBe(5);
    expect(result.totalErrors).toBe(1);
    expect(result.workerCount).toBe(2);
  });

  it("returns zeros for empty snapshot array", () => {
    const result = aggregateWorkerMetrics([]);

    expect(result.totalCpu).toBe(0);
    expect(result.totalMemory).toBe(0);
    expect(result.totalMessages).toBe(0);
    expect(result.totalToolCalls).toBe(0);
    expect(result.totalErrors).toBe(0);
    expect(result.workerCount).toBe(0);
  });

  it("handles a single worker snapshot", () => {
    const snapshots: WorkerMetricSnapshot[] = [
      { workerId: "w1", cpu: 55, memory: 128, messagesSent: 3, toolCalls: 1, errors: 0 },
    ];

    const result = aggregateWorkerMetrics(snapshots);
    expect(result.totalCpu).toBe(55);
    expect(result.workerCount).toBe(1);
  });
});
