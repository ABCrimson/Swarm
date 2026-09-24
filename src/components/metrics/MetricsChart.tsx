// ── MetricsChart ────────────────────────────────────
// Combined system chart: CPU % and memory % share the left 0-100 axis;
// the worker count gets the right axis to itself, so a single-digit
// step line is never flattened against thousands of MB.

import { CartesianGrid, Legend, Line, LineChart, Tooltip, XAxis, YAxis } from "recharts";
import { CHART_FILL_STYLE, ChartPanel } from "#components/metrics/ChartPanel";
import { formatTime, METRIC_COLOR } from "#lib/chart-theme";
import { lastN } from "#lib/chart-window";
import { memPercent } from "#lib/memory";
import { useSystemStore } from "#store/system";
import type { MetricPoint } from "#store/types";

/** One chart row. `memoryPercent` is `null` (a gap) while the memory total is unknown. */
export interface SystemChartPoint {
  readonly time: number;
  readonly cpu: number;
  readonly memoryPercent: number | null;
  readonly workerCount: number;
}

/** Maps the trailing chart window of `history` to rows with memory as a percentage of total. */
export function systemChartData(
  history: readonly MetricPoint[],
  memoryTotalMb: number,
): SystemChartPoint[] {
  return lastN(history).map((p) => ({
    time: p.time,
    cpu: p.cpu,
    memoryPercent: memPercent(p.memory, memoryTotalMb) ?? null,
    workerCount: p.workerCount,
  }));
}

const formatPercentTick = (v: number): string => `${v}%`;

/**
 * Real-time CPU %, memory % and worker count over the trailing sample
 * window, with animation off for smooth updates. Series colours are the
 * shared per-metric `METRIC_COLOR`s.
 */
export function MetricsChart(): React.ReactElement {
  const history = useSystemStore((s) => s.metrics.history);
  const memoryTotalMb = useSystemStore((s) => s.metrics.memoryTotalMb);
  const data = systemChartData(history, memoryTotalMb);

  return (
    <ChartPanel title="System Metrics">
      <LineChart
        responsive
        style={CHART_FILL_STYLE}
        data={data}
        margin={{ top: 8, right: 16, left: 0, bottom: 0 }}
        title="CPU, Memory And Worker Count Over Time"
      >
        <CartesianGrid />
        <XAxis dataKey="time" tickFormatter={formatTime} />
        <YAxis yAxisId="percent" domain={[0, 100]} tickFormatter={formatPercentTick} />
        <YAxis yAxisId="count" orientation="right" allowDecimals={false} />
        <Tooltip labelFormatter={(label) => formatTime(Number(label))} />
        <Legend />
        <Line
          yAxisId="percent"
          type="monotone"
          dataKey="cpu"
          name="CPU %"
          stroke={METRIC_COLOR.cpu}
          strokeWidth={2}
          dot={false}
          isAnimationActive={false}
        />
        <Line
          yAxisId="percent"
          type="monotone"
          dataKey="memoryPercent"
          name="Memory %"
          stroke={METRIC_COLOR.memory}
          strokeWidth={2}
          dot={false}
          isAnimationActive={false}
        />
        <Line
          yAxisId="count"
          type="stepAfter"
          dataKey="workerCount"
          name="Workers"
          stroke={METRIC_COLOR.workers}
          strokeWidth={2}
          dot={false}
          isAnimationActive={false}
        />
      </LineChart>
    </ChartPanel>
  );
}
