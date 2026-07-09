// ── AIQueueChart ────────────────────────────────────
// Pending requests by priority: stacked bar chart.
// Colors: critical=rose, high=amber, normal=plasma, low=dim.
// Recharts BarChart with ResponsiveContainer, isAnimationActive={false}.

import type { CSSProperties } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { axisProps, glassPanelStyle, gridProps, legendStyle, tooltipProps } from "#lib/chart-theme";
import { useAiStore } from "#store/ai";

// OKLCH priority colors
const COLOR_CRITICAL = "oklch(0.68 0.22 15)";
const COLOR_HIGH = "oklch(0.78 0.18 70)";
const COLOR_NORMAL = "oklch(0.72 0.18 205)";
const COLOR_LOW = "oklch(0.45 0.04 220)";

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
 * Stacked bar chart showing pending AI requests by priority level.
 *
 * Colours: critical (rose), high (amber), normal (plasma blue), low (dim grey).
 */
export function AIQueueChart(): React.ReactElement {
  const queue = useAiStore((s) => s.queue);

  const pending = queue.filter((q) => q.status === "pending");
  const counts = {
    critical: 0,
    high: 0,
    normal: 0,
    low: 0,
  };

  for (const item of pending) {
    counts[item.priority] = (counts[item.priority] ?? 0) + 1;
  }

  const data = [{ name: "Queue", ...counts }];

  return (
    <div style={containerStyle}>
      <div style={headerStyle}>AI Queue by Priority</div>
      <ResponsiveContainer width="100%" height="80%">
        <BarChart data={data} margin={{ top: 4, right: 16, left: 0, bottom: 0 }}>
          <CartesianGrid {...gridProps} />
          <XAxis dataKey="name" {...axisProps} />
          <YAxis allowDecimals={false} {...axisProps} />
          <Tooltip {...tooltipProps} />
          <Legend wrapperStyle={legendStyle} />

          <Bar
            dataKey="critical"
            name="Critical"
            stackId="queue"
            fill={COLOR_CRITICAL}
            isAnimationActive={false}
          />
          <Bar
            dataKey="high"
            name="High"
            stackId="queue"
            fill={COLOR_HIGH}
            isAnimationActive={false}
          />
          <Bar
            dataKey="normal"
            name="Normal"
            stackId="queue"
            fill={COLOR_NORMAL}
            isAnimationActive={false}
          />
          <Bar
            dataKey="low"
            name="Low"
            stackId="queue"
            fill={COLOR_LOW}
            isAnimationActive={false}
          />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
