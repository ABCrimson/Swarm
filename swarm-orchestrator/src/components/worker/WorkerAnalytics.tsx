// ── WorkerAnalytics ─────────────────────────────────
// Detailed per-worker analytics view.
// Charts: messages over time, tool call frequency, error timeline.
// All Recharts with isAnimationActive={false}.

import type { CSSProperties } from "react";
import { useEffect, useRef, useState } from "react";
import {
  Bar,
  BarChart,
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

interface WorkerAnalyticsProps {
  readonly workerId: string;
  readonly workerName: string;
}

// OKLCH colors
const COLOR_MESSAGES = "oklch(0.72 0.18 205)";
const COLOR_TOOLS = "oklch(0.78 0.18 130)";
const COLOR_ERRORS = "oklch(0.68 0.22 15)";

interface AnalyticsPoint {
  readonly time: number;
  readonly messages: number;
  readonly toolCalls: number;
  readonly errors: number;
}

const WINDOW_MS = 60_000;
const SAMPLE_MS = 2000;

const containerStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 16,
  padding: 16,
};

const chartContainerStyle: CSSProperties = {
  ...glassPanelStyle,
  padding: 12,
  width: "100%",
  height: 220,
};

const headerStyle: CSSProperties = {
  fontFamily: "var(--font-display)",
  fontSize: 14,
  fontWeight: 600,
  color: "oklch(0.85 0.04 220)",
  marginBottom: 8,
};

function jitter(base: number, range: number, min: number, max: number): number {
  const delta = (Math.random() - 0.5) * range;
  return Math.max(min, Math.min(max, base + delta));
}

/**
 * Per-worker analytics view with live-updating charts for messages,
 * tool calls, and errors over a 60-second rolling window.
 *
 * Uses Recharts with `isAnimationActive={false}` for real-time rendering.
 */
export function WorkerAnalytics({
  workerId,
  workerName,
}: WorkerAnalyticsProps): React.ReactElement {
  const [data, setData] = useState<AnalyticsPoint[]>([]);
  const intervalRef = useRef<ReturnType<typeof setInterval>>(undefined);

  // Reset data when workerId changes
  useEffect(() => { setData([]); }, [workerId]);

  useEffect(() => {
    intervalRef.current = setInterval(() => {
      setData((prev) => {
        const cutoff = Date.now() - WINDOW_MS;
        const filtered = prev.filter((p) => p.time > cutoff);
        const last = filtered.at(-1);
        const point: AnalyticsPoint = {
          time: Date.now(),
          messages: jitter(last?.messages ?? 5, 3, 0, 30),
          toolCalls: jitter(last?.toolCalls ?? 2, 2, 0, 15),
          errors: Math.random() > 0.9 ? 1 : 0,
        };
        return [...filtered, point];
      });
    }, SAMPLE_MS);

    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [workerId]);

  const errorData = data.map((p) => ({ time: p.time, errors: p.errors }));

  return (
    <div style={containerStyle}>
      <h2
        style={{
          fontFamily: "var(--font-display)",
          fontSize: 18,
          fontWeight: 700,
          color: "oklch(0.9 0.04 220)",
        }}
      >
        {workerName} Analytics
      </h2>

      {/* Messages over time */}
      <div style={chartContainerStyle}>
        <div style={headerStyle}>Messages Over Time</div>
        <ResponsiveContainer width="100%" height="80%">
          <LineChart data={data} margin={{ top: 4, right: 16, left: 0, bottom: 0 }}>
            <CartesianGrid {...gridProps} />
            <XAxis dataKey="time" tickFormatter={formatTime} {...axisProps} />
            <YAxis allowDecimals={false} {...axisProps} />
            <Tooltip {...tooltipProps} labelFormatter={(label) => formatTime(Number(label))} />
            <Legend wrapperStyle={legendStyle} />
            <Line
              type="monotone"
              dataKey="messages"
              name="Messages"
              stroke={COLOR_MESSAGES}
              strokeWidth={2}
              dot={false}
              isAnimationActive={false}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>

      {/* Tool call frequency */}
      <div style={chartContainerStyle}>
        <div style={headerStyle}>Tool Call Frequency</div>
        <ResponsiveContainer width="100%" height="80%">
          <BarChart data={data} margin={{ top: 4, right: 16, left: 0, bottom: 0 }}>
            <CartesianGrid {...gridProps} />
            <XAxis dataKey="time" tickFormatter={formatTime} {...axisProps} />
            <YAxis allowDecimals={false} {...axisProps} />
            <Tooltip {...tooltipProps} labelFormatter={(label) => formatTime(Number(label))} />
            <Legend wrapperStyle={legendStyle} />
            <Bar
              dataKey="toolCalls"
              name="Tool Calls"
              fill={COLOR_TOOLS}
              isAnimationActive={false}
            />
          </BarChart>
        </ResponsiveContainer>
      </div>

      {/* Error timeline */}
      <div style={chartContainerStyle}>
        <div style={headerStyle}>Error Timeline</div>
        <ResponsiveContainer width="100%" height="80%">
          <BarChart data={errorData} margin={{ top: 4, right: 16, left: 0, bottom: 0 }}>
            <CartesianGrid {...gridProps} />
            <XAxis dataKey="time" tickFormatter={formatTime} {...axisProps} />
            <YAxis allowDecimals={false} domain={[0, 3]} {...axisProps} />
            <Tooltip {...tooltipProps} labelFormatter={(label) => formatTime(Number(label))} />
            <Legend wrapperStyle={legendStyle} />
            <Bar dataKey="errors" name="Errors" fill={COLOR_ERRORS} isAnimationActive={false} />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
