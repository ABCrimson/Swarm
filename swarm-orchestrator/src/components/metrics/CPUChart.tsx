// ── CPUChart ────────────────────────────────────────
// 60s rolling window LineChart of real aggregate CPU usage.
// Recharts 3.8.0 with ResponsiveContainer, isAnimationActive={false}.

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
import { lastN } from "#lib/chart-window";
import { useSystemStore } from "#store/system";

const containerStyle: CSSProperties = {
  ...glassPanelStyle,
  padding: 12,
  width: "100%",
  height: "100%",
  minHeight: 240,
};

const headerStyle: CSSProperties = {
  fontFamily: "var(--font-display)",
  fontSize: 14,
  fontWeight: 600,
  color: "oklch(0.85 0.04 220)",
  marginBottom: 8,
};

/**
 * Aggregate CPU usage line chart over the trailing sample window
 * (see `MAX_CHART_POINTS`), sourced from real system-store telemetry
 * (`metrics.history`).
 */
export function CPUChart(): React.ReactElement {
  const history = useSystemStore((s) => s.metrics.history);

  const data = lastN(history).map((p) => ({ time: p.time, cpu: p.cpu }));

  return (
    <div style={containerStyle}>
      <div style={headerStyle}>CPU Usage</div>
      <ResponsiveContainer width="100%" height="85%">
        <LineChart data={data} margin={{ top: 4, right: 16, left: 0, bottom: 0 }}>
          <CartesianGrid {...gridProps} />
          <XAxis dataKey="time" tickFormatter={formatTime} {...axisProps} />
          <YAxis domain={[0, 100]} tickFormatter={(v: number) => `${v}%`} {...axisProps} />
          <Tooltip {...tooltipProps} labelFormatter={(label) => formatTime(Number(label))} />
          <Legend wrapperStyle={legendStyle} />
          <Line
            type="monotone"
            dataKey="cpu"
            name="CPU"
            stroke="oklch(0.78 0.18 205)"
            strokeWidth={1.5}
            dot={false}
            isAnimationActive={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
