// ── CPUChart ────────────────────────────────────────
// Line chart of real aggregate CPU usage over the trailing
// MAX_CHART_POINTS samples of the system store's history.

import { CartesianGrid, Legend, Line, LineChart, Tooltip, XAxis, YAxis } from "recharts";
import { CHART_FILL_STYLE, ChartPanel } from "#components/metrics/ChartPanel";
import { formatTime, METRIC_COLOR } from "#lib/chart-theme";
import { lastN } from "#lib/chart-window";
import { useSystemStore } from "#store/system";

/**
 * Aggregate CPU usage over the trailing sample window (see
 * `MAX_CHART_POINTS`), from the system store's measured history.
 */
export function CPUChart(): React.ReactElement {
  const history = useSystemStore((s) => s.metrics.history);
  const data = lastN(history);

  return (
    <ChartPanel title="CPU Usage">
      <LineChart
        responsive
        style={CHART_FILL_STYLE}
        data={data}
        margin={{ top: 4, right: 16, left: 0, bottom: 0 }}
        title="CPU Usage Over Time"
      >
        <CartesianGrid />
        <XAxis dataKey="time" tickFormatter={formatTime} />
        <YAxis domain={[0, 100]} tickFormatter={(v: number) => `${v}%`} />
        <Tooltip labelFormatter={(label) => formatTime(Number(label))} />
        <Legend />
        <Line
          type="monotone"
          dataKey="cpu"
          name="CPU"
          stroke={METRIC_COLOR.cpu}
          strokeWidth={1.5}
          dot={false}
          isAnimationActive={false}
        />
      </LineChart>
    </ChartPanel>
  );
}
