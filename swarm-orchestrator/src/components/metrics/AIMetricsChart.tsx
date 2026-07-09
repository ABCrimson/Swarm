// ── AIMetricsChart ──────────────────────────────────
// Recharts 3.8.0 AreaChart for AI performance metrics.
// Metrics: tokens/min, req/min, avg latency, tool calls/session.
// 30s rolling window with OKLCH fills.
// Uses shared chart theme.

import type { CSSProperties } from "react";
import { useEffect, useRef, useState } from "react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { axisProps, formatTime, gridProps, legendStyle, tooltipProps } from "#lib/chart-theme";
import { workerColor } from "#lib/theme";

// ── Types ───────────────────────────────────────────

interface AiMetricPoint {
  readonly time: number;
  readonly tokensPerMin: number;
  readonly reqPerMin: number;
  readonly avgLatencyMs: number;
  readonly toolCallsPerSession: number;
}

// ── Styles (OKLCH) ──────────────────────────────────

const containerStyle: CSSProperties = {
  width: "100%",
  height: "100%",
  minHeight: 240,
  background: "oklch(0.08 0.02 220)",
  borderRadius: 8,
  border: "1px solid oklch(0.22 0.04 220)",
  padding: 8,
};

const headerStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  padding: "4px 8px 8px",
  fontSize: 13,
  fontWeight: 600,
  color: "oklch(0.78 0.04 220)",
};

// ── Rolling Window Store ────────────────────────────

const WINDOW_MS = 30_000;
const SAMPLE_INTERVAL_MS = 1000;

/**
 * Generates simulated metric data points for the rolling window.
 * In production, this would subscribe to actual AI stream metrics
 * via the system store or an event listener.
 */
function generateSample(existing: AiMetricPoint[]): AiMetricPoint {
  const last = existing.at(-1);
  const now = Date.now();

  // Smooth random walk from previous values
  const jitter = (base: number, range: number, min: number, max: number) => {
    const delta = (Math.random() - 0.5) * range;
    return Math.max(min, Math.min(max, base + delta));
  };

  return {
    time: now,
    tokensPerMin: jitter(last?.tokensPerMin ?? 1200, 200, 0, 5000),
    reqPerMin: jitter(last?.reqPerMin ?? 8, 3, 0, 60),
    avgLatencyMs: jitter(last?.avgLatencyMs ?? 450, 100, 50, 2000),
    toolCallsPerSession: jitter(last?.toolCallsPerSession ?? 3, 1, 0, 20),
  };
}

// ── Component ───────────────────────────────────────

/**
 * AI performance metrics chart with 30s rolling window.
 *
 * - Tokens/min, req/min, avg latency, tool calls/session
 * - Recharts 3.8.0 `<AreaChart>` with `<ResponsiveContainer>`
 * - OKLCH fills via `workerColor()` + `withAlpha()`
 * - `isAnimationActive={false}` for 60fps performance
 */
export function AIMetricsChart(): React.ReactElement {
  const [data, setData] = useState<AiMetricPoint[]>([]);
  const intervalRef = useRef<ReturnType<typeof setInterval>>(undefined);

  // Collect samples on an interval
  useEffect(() => {
    intervalRef.current = setInterval(() => {
      setData((prev) => {
        const cutoff = Date.now() - WINDOW_MS;
        const filtered = prev.filter((p) => p.time > cutoff);
        const sample = generateSample(filtered);
        return [...filtered, sample];
      });
    }, SAMPLE_INTERVAL_MS);

    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, []);

  // OKLCH color assignments
  const color0 = workerColor(0); // Tokens/min
  const color1 = workerColor(1); // Req/min
  const color2 = workerColor(2); // Latency
  const color3 = workerColor(3); // Tool calls

  return (
    <div style={containerStyle}>
      <div style={headerStyle}>
        <span>AI Metrics</span>
        <span style={{ fontSize: 11, fontWeight: 400, color: "oklch(0.55 0.03 220)" }}>
          30s window
        </span>
      </div>

      <ResponsiveContainer width="100%" height="85%">
        <AreaChart data={data} margin={{ top: 4, right: 16, left: 0, bottom: 0 }}>
          <defs>
            <linearGradient id="grad-tokens" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor={color0} stopOpacity={0.3} />
              <stop offset="95%" stopColor={color0} stopOpacity={0.02} />
            </linearGradient>
            <linearGradient id="grad-req" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor={color1} stopOpacity={0.3} />
              <stop offset="95%" stopColor={color1} stopOpacity={0.02} />
            </linearGradient>
            <linearGradient id="grad-latency" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor={color2} stopOpacity={0.3} />
              <stop offset="95%" stopColor={color2} stopOpacity={0.02} />
            </linearGradient>
            <linearGradient id="grad-tools" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor={color3} stopOpacity={0.3} />
              <stop offset="95%" stopColor={color3} stopOpacity={0.02} />
            </linearGradient>
          </defs>

          <CartesianGrid {...gridProps} />

          <XAxis dataKey="time" tickFormatter={formatTime} {...axisProps} />
          <YAxis yAxisId="primary" {...axisProps} />
          <YAxis yAxisId="secondary" orientation="right" {...axisProps} />

          <Tooltip {...tooltipProps} labelFormatter={(label) => formatTime(Number(label))} />

          <Legend wrapperStyle={legendStyle} />

          <Area
            yAxisId="primary"
            type="monotone"
            dataKey="tokensPerMin"
            name="Tokens/min"
            stroke={color0}
            fill="url(#grad-tokens)"
            strokeWidth={1.5}
            dot={false}
            isAnimationActive={false}
          />
          <Area
            yAxisId="secondary"
            type="monotone"
            dataKey="reqPerMin"
            name="Req/min"
            stroke={color1}
            fill="url(#grad-req)"
            strokeWidth={1.5}
            dot={false}
            isAnimationActive={false}
          />
          <Area
            yAxisId="primary"
            type="monotone"
            dataKey="avgLatencyMs"
            name="Latency (ms)"
            stroke={color2}
            fill="url(#grad-latency)"
            strokeWidth={1.5}
            dot={false}
            isAnimationActive={false}
          />
          <Area
            yAxisId="secondary"
            type="monotone"
            dataKey="toolCallsPerSession"
            name="Tool calls"
            stroke={color3}
            fill="url(#grad-tools)"
            strokeWidth={1.5}
            dot={false}
            isAnimationActive={false}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
