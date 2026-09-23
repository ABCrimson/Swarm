// ── MemoryChart ─────────────────────────────────────
// Stacked area chart of used vs free memory — exactly the two figures the
// backend reports (sysinfo used and total), nothing estimated.
// OKLCH fills: used = plasma, free = dim.

import { useId } from "react";
import { Area, AreaChart, CartesianGrid, Legend, Tooltip, XAxis, YAxis } from "recharts";
import { CHART_FILL_STYLE, ChartPanel } from "#components/metrics/ChartPanel";
import { formatMb, formatTime } from "#lib/chart-theme";
import { lastN } from "#lib/chart-window";
import { memoryFreeMb } from "#lib/memory";
import { useSystemStore } from "#store/system";
import type { MetricPoint } from "#store/types";

const COLOR_USED = "oklch(0.72 0.18 205)";
const COLOR_FREE = "oklch(0.45 0.04 220)";

/** One chart row: used and free memory in MB at `time`. */
export interface MemoryChartPoint {
  readonly time: number;
  readonly used: number;
  readonly free: number;
}

/**
 * Maps the trailing chart window of `history` to used/free rows. Free is
 * `total - used`, and 0 while the total is still unknown (the backend has
 * not reported one yet) rather than measured against a guessed ceiling.
 */
export function memoryChartData(
  history: readonly MetricPoint[],
  memoryTotalMb: number,
): MemoryChartPoint[] {
  return lastN(history).map((p) => ({
    time: p.time,
    used: p.memory,
    free: memoryFreeMb(p.memory, memoryTotalMb),
  }));
}

/** Stacked used/free memory over the trailing sample window (see `MAX_CHART_POINTS`). */
export function MemoryChart(): React.ReactElement {
  const history = useSystemStore((s) => s.metrics.history);
  const memoryTotalMb = useSystemStore((s) => s.metrics.memoryTotalMb);
  const data = memoryChartData(history, memoryTotalMb);
  // Gradient ids are document-global; useId keeps two mounted charts apart.
  const gradientId = useId();

  return (
    <ChartPanel title="Memory Usage">
      <AreaChart
        responsive
        style={CHART_FILL_STYLE}
        data={data}
        margin={{ top: 4, right: 16, left: 0, bottom: 0 }}
        title="Used And Free Memory Over Time"
      >
        <defs>
          <linearGradient id={`${gradientId}-used`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor={COLOR_USED} stopOpacity={0.4} />
            <stop offset="95%" stopColor={COLOR_USED} stopOpacity={0.05} />
          </linearGradient>
          <linearGradient id={`${gradientId}-free`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor={COLOR_FREE} stopOpacity={0.2} />
            <stop offset="95%" stopColor={COLOR_FREE} stopOpacity={0.02} />
          </linearGradient>
        </defs>

        <CartesianGrid />
        <XAxis dataKey="time" tickFormatter={formatTime} />
        <YAxis tickFormatter={formatMb} />
        <Tooltip
          labelFormatter={(label) => formatTime(Number(label))}
          formatter={(value) => formatMb(Number(value))}
        />
        <Legend />

        <Area
          type="monotone"
          dataKey="used"
          name="Used"
          stackId="mem"
          stroke={COLOR_USED}
          fill={`url(#${gradientId}-used)`}
          strokeWidth={1.5}
          isAnimationActive={false}
        />
        <Area
          type="monotone"
          dataKey="free"
          name="Free"
          stackId="mem"
          stroke={COLOR_FREE}
          fill={`url(#${gradientId}-free)`}
          strokeWidth={1.5}
          isAnimationActive={false}
        />
      </AreaChart>
    </ChartPanel>
  );
}
