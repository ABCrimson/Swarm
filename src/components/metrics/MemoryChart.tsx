// ── MemoryChart ─────────────────────────────────────
// Stacked area chart of used vs free memory — exactly the two figures the
// backend reports (sysinfo used and total), nothing estimated.
// OKLCH fills: used = METRIC_COLOR.memory (violet, as in MetricsChart), free = neutral grey.

import {
  Area,
  AreaChart,
  CartesianGrid,
  Legend,
  linearGradient,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { CHART_FILL_STYLE, ChartPanel } from "#components/metrics/ChartPanel";
import { formatMb, formatTime, METRIC_COLOR } from "#lib/chart-theme";
import { lastN } from "#lib/chart-window";
import { memoryFreeMb } from "#lib/memory";
import { useSystemStore } from "#store/system";
import type { MetricPoint } from "#store/types";

const COLOR_USED = METRIC_COLOR.memory;
const COLOR_FREE = "oklch(0.6 0.03 220)";

/** Top-to-bottom fades; stops without a colour take the area's own. */
const FADE_USED = linearGradient({
  stops: [
    { offset: 0.05, opacity: 0.4 },
    { offset: 0.95, opacity: 0.05 },
  ],
});
const FADE_FREE = linearGradient({
  stops: [
    { offset: 0.05, opacity: 0.2 },
    { offset: 0.95, opacity: 0.02 },
  ],
});

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

  return (
    <ChartPanel title="Memory Usage" sampleCount={data.length}>
      <AreaChart
        responsive
        style={CHART_FILL_STYLE}
        data={data}
        margin={{ top: 4, right: 16, left: 0, bottom: 0 }}
        title="Used And Free Memory Over Time"
      >
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
          fill={{ color: COLOR_USED, definition: FADE_USED }}
          strokeWidth={1.5}
          isAnimationActive={false}
        />
        <Area
          type="monotone"
          dataKey="free"
          name="Free"
          stackId="mem"
          stroke={COLOR_FREE}
          fill={{ color: COLOR_FREE, definition: FADE_FREE }}
          strokeWidth={1.5}
          isAnimationActive={false}
        />
      </AreaChart>
    </ChartPanel>
  );
}
