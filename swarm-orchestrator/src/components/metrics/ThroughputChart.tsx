// ── ThroughputChart ─────────────────────────────────
// Tokens/sec per model line chart, 30s window, sampled from real
// token-usage records in useAiStore's cumulativeUsage.history.
// OKLCH colors: opus=violet, sonnet=plasma, haiku=lime.
// Recharts LineChart with ResponsiveContainer, isAnimationActive={false}.

import type { CSSProperties } from "react";
import { useEffect, useRef, useState } from "react";
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
  formatTokens,
  glassPanelStyle,
  gridProps,
  legendStyle,
  tooltipProps,
} from "#lib/chart-theme";
import { useAiStore } from "#store/ai";

// OKLCH model colors
const COLOR_OPUS = "oklch(0.68 0.22 290)";
const COLOR_SONNET = "oklch(0.72 0.18 205)";
const COLOR_HAIKU = "oklch(0.78 0.18 130)";

const WINDOW_MS = 30_000;
const SAMPLE_MS = 1000;
/** Trailing window used to compute a tokens/sec rate for each sample. */
const RATE_WINDOW_MS = 10_000;

interface ThroughputPoint {
  readonly time: number;
  readonly opus: number;
  readonly sonnet: number;
  readonly haiku: number;
}

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
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
};

/** Sums input+output tokens for records matching `keyword` within the trailing rate window. */
function tokensPerSecFor(
  history: { model: string; inputTokens: number; outputTokens: number; timestamp: number }[],
  keyword: string,
  now: number,
): number {
  const cutoff = now - RATE_WINDOW_MS;
  const tokens = history
    .filter((r) => r.timestamp > cutoff && r.model.toLowerCase().includes(keyword))
    .reduce((sum, r) => sum + r.inputTokens + r.outputTokens, 0);
  return tokens / (RATE_WINDOW_MS / 1000);
}

/**
 * Line chart showing real AI throughput (tokens/sec) per model over a 30-second window,
 * derived from `useAiStore().cumulativeUsage.history` token-usage records.
 *
 * Colours: Opus (violet), Sonnet (plasma blue), Haiku (lime green).
 */
export function ThroughputChart(): React.ReactElement {
  const [data, setData] = useState<ThroughputPoint[]>([]);
  const intervalRef = useRef<ReturnType<typeof setInterval>>(undefined);

  useEffect(() => {
    intervalRef.current = setInterval(() => {
      setData((prev) => {
        const now = Date.now();
        const cutoff = now - WINDOW_MS;
        const filtered = prev.filter((p) => p.time > cutoff);
        const history = useAiStore.getState().cumulativeUsage.history;
        const point: ThroughputPoint = {
          time: now,
          opus: tokensPerSecFor(history, "opus", now),
          sonnet: tokensPerSecFor(history, "sonnet", now),
          haiku: tokensPerSecFor(history, "haiku", now),
        };
        return [...filtered, point];
      });
    }, SAMPLE_MS);

    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, []);

  return (
    <div style={containerStyle}>
      <div style={headerStyle}>
        <span>AI Throughput</span>
        <span
          style={{
            fontSize: 11,
            fontWeight: 400,
            fontFamily: "var(--font-mono)",
            color: "oklch(0.55 0.03 220)",
          }}
        >
          tokens/sec &middot; 30s
        </span>
      </div>
      <ResponsiveContainer width="100%" height="85%">
        <LineChart data={data} margin={{ top: 4, right: 16, left: 0, bottom: 0 }}>
          <CartesianGrid {...gridProps} />
          <XAxis dataKey="time" tickFormatter={formatTime} {...axisProps} />
          <YAxis tickFormatter={formatTokens} {...axisProps} />
          <Tooltip
            {...tooltipProps}
            labelFormatter={(label) => formatTime(Number(label))}
            formatter={(value) => `${Number(value).toFixed(1)} tok/s`}
          />
          <Legend wrapperStyle={legendStyle} />

          <Line
            type="monotone"
            dataKey="opus"
            name="Opus"
            stroke={COLOR_OPUS}
            strokeWidth={2}
            dot={false}
            isAnimationActive={false}
          />
          <Line
            type="monotone"
            dataKey="sonnet"
            name="Sonnet"
            stroke={COLOR_SONNET}
            strokeWidth={2}
            dot={false}
            isAnimationActive={false}
          />
          <Line
            type="monotone"
            dataKey="haiku"
            name="Haiku"
            stroke={COLOR_HAIKU}
            strokeWidth={2}
            dot={false}
            isAnimationActive={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
