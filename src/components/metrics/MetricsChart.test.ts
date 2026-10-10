// Memory is charted as a percentage of the total on the CPU (0-100) axis; the worker count
// (single digits) keeps the right axis to itself, so raw MB (thousands) never flattens it.

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
