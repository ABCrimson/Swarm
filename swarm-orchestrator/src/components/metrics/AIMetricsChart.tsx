// ── AIMetricsChart ──────────────────────────────────
// Recharts 3.8.0 AreaChart for AI performance metrics.
// Metrics: queue depth, active streams, tokens/min, req/min — all sampled
// from the real AI store (useAiStore) on a rolling 30s window.
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
import { useAiStore } from "#store/ai";

// ── Types ───────────────────────────────────────────

interface AiMetricPoint {
  readonly time: number;
  readonly queueDepth: number;
  readonly activeStreams: number;
  readonly tokensPerMin: number;
  readonly reqPerMin: number;
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

// ── Rolling Window Sampling ──────────────────────────

const WINDOW_MS = 30_000;
const SAMPLE_INTERVAL_MS = 1000;
const RATE_WINDOW_MS = 60_000;

/**
 * Samples the real AI store state, computing tokens/min and req/min from
 * `cumulativeUsage.history` (real token usage records) over the trailing
 * {@link RATE_WINDOW_MS} window.
 */
function sampleAiStore(now: number): AiMetricPoint {
  const state = useAiStore.getState();
  const rateCutoff = now - RATE_WINDOW_MS;
  const recent = state.cumulativeUsage.history.filter((r) => r.timestamp > rateCutoff);
  const tokensInWindow = recent.reduce((sum, r) => sum + r.inputTokens + r.outputTokens, 0);
  const minutesInWindow = RATE_WINDOW_MS / 60_000;

  return {
    time: now,
    queueDepth: state.queue.length,
    activeStreams: state.activeStreams,
    tokensPerMin: tokensInWindow / minutesInWindow,
    reqPerMin: recent.length / minutesInWindow,
  };
}

// ── Component ───────────────────────────────────────

/**
 * AI performance metrics chart with 30s rolling window, sourced from
 * `useAiStore` (queue depth, active streams, and real token-usage rates).
 *
 * - Recharts 3.8.0 `<AreaChart>` with `<ResponsiveContainer>`
 * - OKLCH fills via `workerColor()`
 * - `isAnimationActive={false}` for 60fps performance
 */
export function AIMetricsChart(): React.ReactElement {
  const [data, setData] = useState<AiMetricPoint[]>([]);
  const intervalRef = useRef<ReturnType<typeof setInterval>>(undefined);

  // Collect real samples on an interval
  useEffect(() => {
    intervalRef.current = setInterval(() => {
      setData((prev) => {
        const now = Date.now();
        const cutoff = now - WINDOW_MS;
        const filtered = prev.filter((p) => p.time > cutoff);
        return [...filtered, sampleAiStore(now)];
      });
    }, SAMPLE_INTERVAL_MS);

    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, []);

  // OKLCH color assignments
  const color0 = workerColor(0); // Queue depth
  const color1 = workerColor(1); // Active streams
  const color2 = workerColor(2); // Tokens/min
  const color3 = workerColor(3); // Req/min

  return (
    <div style={containerStyle}>
      <div style={headerStyle}>
        <span>AI Metrics</span>
        <span style={{ fontSize: 11, fontWeight: 400, color: "oklch(0.55 0.03 220)" }}>
          30s Window
        </span>
      </div>

      <ResponsiveContainer width="100%" height="85%">
        <AreaChart data={data} margin={{ top: 4, right: 16, left: 0, bottom: 0 }}>
          <defs>
            <linearGradient id="grad-queue" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor={color0} stopOpacity={0.3} />
              <stop offset="95%" stopColor={color0} stopOpacity={0.02} />
            </linearGradient>
            <linearGradient id="grad-streams" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor={color1} stopOpacity={0.3} />
              <stop offset="95%" stopColor={color1} stopOpacity={0.02} />
            </linearGradient>
            <linearGradient id="grad-tokens-min" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor={color2} stopOpacity={0.3} />
              <stop offset="95%" stopColor={color2} stopOpacity={0.02} />
            </linearGradient>
            <linearGradient id="grad-req-min" x1="0" y1="0" x2="0" y2="1">
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
            yAxisId="secondary"
            type="monotone"
            dataKey="queueDepth"
            name="Queue Depth"
            stroke={color0}
            fill="url(#grad-queue)"
            strokeWidth={1.5}
            dot={false}
            isAnimationActive={false}
          />
          <Area
            yAxisId="secondary"
            type="monotone"
            dataKey="activeStreams"
            name="Active Streams"
            stroke={color1}
            fill="url(#grad-streams)"
            strokeWidth={1.5}
            dot={false}
            isAnimationActive={false}
          />
          <Area
            yAxisId="primary"
            type="monotone"
            dataKey="tokensPerMin"
            name="Tokens/min"
            stroke={color2}
            fill="url(#grad-tokens-min)"
            strokeWidth={1.5}
            dot={false}
            isAnimationActive={false}
          />
          <Area
            yAxisId="secondary"
            type="monotone"
            dataKey="reqPerMin"
            name="Req/min"
            stroke={color3}
            fill="url(#grad-req-min)"
            strokeWidth={1.5}
            dot={false}
            isAnimationActive={false}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
