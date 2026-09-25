// Regression: the chart drew an invented "Cached" band (15% of used) and
// understated "Available" by the same amount; the backend reports only
// used and total.

import { describe, expect, it } from "vitest";
import { memoryChartData } from "#components/metrics/MemoryChart";
import { MAX_CHART_POINTS } from "#lib/chart-window";
import type { MetricPoint } from "#store/types";

const point = (time: number, memory: number): MetricPoint => ({
  time,
  cpu: 0,
  memory,
  workerCount: 0,
});

describe("memoryChartData", () => {
  it("plots exactly used and free (total - used) — no estimated series", () => {
    expect(memoryChartData([point(1, 4000)], 16_000)).toEqual([
      { time: 1, used: 4000, free: 12_000 },
    ]);
  });

  it("reads free as 0 while the total is still unknown", () => {
    expect(memoryChartData([point(1, 4000)], 0)).toEqual([{ time: 1, used: 4000, free: 0 }]);
  });

  it("keeps only the trailing chart window", () => {
    const history = Array.from({ length: MAX_CHART_POINTS + 5 }, (_, i) => point(i, 1));
    const rows = memoryChartData(history, 10);
    expect(rows).toHaveLength(MAX_CHART_POINTS);
    expect(rows.at(0)?.time).toBe(5);
  });
});
