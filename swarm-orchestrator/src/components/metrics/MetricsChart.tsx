// ── MetricsChart ────────────────────────────────────
// Real-time metrics chart: CPU%, memory usage, worker count.
// Recharts 3.8.0 with isAnimationActive={false} for 60fps.
// Uses shared chart theme for OKLCH styling.

import type { CSSProperties } from "react";
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  axisProps,
  formatTime,
  glassPanelStyle,
  gridProps,
  legendStyle,
  tooltipProps,
} from "#lib/chart-theme";
import { workerColor } from "#lib/theme";
import { useSystemStore } from "#store/system";

const containerStyle: CSSProperties = {
  ...glassPanelStyle,
  padding: 12,
  width: "100%",
  height: "100%",
  minHeight: 200,
};

const headerStyle: CSSProperties = {
  fontFamily: "var(--font-display)",
  fontSize: 14,
  fontWeight: 600,
  color: "oklch(0.85 0.04 220)",
  marginBottom: 8,
};

/**
 * Real-time metrics chart displaying CPU%, memory usage, and worker count.
 *
 * Uses Recharts with animation disabled for smooth 60fps rendering.
 * Stroke colors use OKLCH via `workerColor()` from the theme system.
 */
export function MetricsChart(): React.ReactElement {
  const history = useSystemStore((s) => s.metrics.history);

  return (
    <div style={containerStyle}>
      <div style={headerStyle}>System Metrics</div>
      <ResponsiveContainer width="100%" height="85%">
        <LineChart data={history} margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
          <CartesianGrid {...gridProps} />
          <XAxis dataKey="time" tickFormatter={formatTime} {...axisProps} />
          <YAxis
            yAxisId="percent"
            domain={[0, 100]}
            tickFormatter={(v: number) => `${v}%`}
            {...axisProps}
          />
          <YAxis yAxisId="count" orientation="right" {...axisProps} />
          <Tooltip {...tooltipProps} labelFormatter={(label) => formatTime(Number(label))} />
          <Legend wrapperStyle={legendStyle} />
          <Line
            yAxisId="percent"
            type="monotone"
            dataKey="cpu"
            name="CPU %"
            stroke={workerColor(0)}
            strokeWidth={2}
            dot={false}
            isAnimationActive={false}
          />
          <Line
            yAxisId="count"
            type="monotone"
            dataKey="memory"
            name="Memory (MB)"
            stroke={workerColor(1)}
            strokeWidth={2}
            dot={false}
            isAnimationActive={false}
          />
          <Line
            yAxisId="count"
            type="stepAfter"
            dataKey="workerCount"
            name="Workers"
            stroke={workerColor(2)}
            strokeWidth={2}
            dot={false}
            isAnimationActive={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
