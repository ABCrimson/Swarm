// Regression: memory (thousands of MB) and the worker count (single
// digits) shared one Y axis, flattening the Workers line to ~0. Memory is
// now a percentage on the CPU axis.

import { describe, expect, it } from "vitest";
import { systemChartData } from "#components/metrics/MetricsChart";
import type { MetricPoint } from "#store/types";

describe("systemChartData", () => {
  it("expresses memory as a percentage of the total", () => {
    const history: MetricPoint[] = [{ time: 1, cpu: 12, memory: 4096, workerCount: 3 }];
    expect(systemChartData(history, 16_384)).toEqual([
      { time: 1, cpu: 12, memoryPercent: 25, workerCount: 3 },
    ]);
  });

  it("leaves a gap (null), not 0% or a fabricated figure, while the total is unknown", () => {
    const history: MetricPoint[] = [{ time: 1, cpu: 12, memory: 4096, workerCount: 3 }];
    expect(systemChartData(history, 0)[0]?.memoryPercent).toBeNull();
  });
});
