// ── AIMetricsChart ──────────────────────────────────
// Area chart of AI activity sampled once a second from the AI store:
// queue depth, active streams, and token/request rates over a trailing
// minute, keeping the last MAX_CHART_POINTS samples.

import { useEffect, useId, useState } from "react";
import { Area, AreaChart, CartesianGrid, Legend, Tooltip, XAxis, YAxis } from "recharts";
import { CHART_FILL_STYLE, ChartPanel } from "#components/metrics/ChartPanel";
import { formatTime, METRIC_COLOR } from "#lib/chart-theme";
import { lastN, MAX_CHART_POINTS } from "#lib/chart-window";
import { tokensPerSecond } from "#lib/metrics-aggregation";
import { useAiStore } from "#store/ai";
import type { AiQueueItem, TokenUsageRecord } from "#store/types";

/** One sampled row of AI activity. */
export interface AiMetricPoint {
  readonly time: number;
  readonly queueDepth: number;
  readonly activeStreams: number;
  readonly tokensPerMin: number;
  readonly reqPerMin: number;
}

const SAMPLE_INTERVAL_MS = 1000;
/** Trailing window the per-minute rates are measured over. */
const RATE_WINDOW_MS = 60_000;

/**
 * Samples AI activity at `now`: live queue depth and stream count, plus
 * tokens/min and requests/min from the token-usage records inside the
 * trailing {@link RATE_WINDOW_MS}.
 */
export function sampleAiMetrics(
  state: {
    readonly queue: readonly AiQueueItem[];
    readonly activeStreams: number;
    readonly usage: readonly TokenUsageRecord[];
  },
  now: number,
): AiMetricPoint {
  const cutoff = now - RATE_WINDOW_MS;
  const minutes = RATE_WINDOW_MS / 60_000;
  return {
    time: now,
    queueDepth: state.queue.length,
    activeStreams: state.activeStreams,
    tokensPerMin: tokensPerSecond(state.usage, now, RATE_WINDOW_MS) * 60,
    reqPerMin: state.usage.filter((r) => r.timestamp > cutoff).length / minutes,
  };
}

/** Series drawn, in legend order: data key, label, axis and colour index. */
const SERIES = [
  { key: "queueDepth", label: "Queue Depth", axis: "count", color: METRIC_COLOR.queueDepth },
  {
    key: "activeStreams",
    label: "Active Streams",
    axis: "count",
    color: METRIC_COLOR.activeStreams,
  },
  { key: "tokensPerMin", label: "Tokens/Min", axis: "tokens", color: METRIC_COLOR.tokensPerMin },
  { key: "reqPerMin", label: "Req/Min", axis: "count", color: METRIC_COLOR.reqPerMin },
] as const;

/**
 * AI performance over the trailing `MAX_CHART_POINTS` samples. Token
 * throughput has its own (left) axis; the small counts share the right.
 */
export function AIMetricsChart(): React.ReactElement {
  const [data, setData] = useState<AiMetricPoint[]>([]);
  // Gradient ids are document-global; useId keeps two mounted charts apart.
  const gradientId = useId();

  useEffect(() => {
    const id = setInterval(() => {
      const { queue, activeStreams, cumulativeUsage } = useAiStore.getState();
      const point = sampleAiMetrics(
        { queue, activeStreams, usage: cumulativeUsage.history },
        Date.now(),
      );
      setData((prev) => lastN([...prev, point]));
    }, SAMPLE_INTERVAL_MS);
    return () => clearInterval(id);
  }, []);

  return (
    <ChartPanel title="AI Metrics" caption={`Last ${MAX_CHART_POINTS} Samples`}>
      <AreaChart
        responsive
        style={CHART_FILL_STYLE}
        data={data}
        margin={{ top: 4, right: 16, left: 0, bottom: 0 }}
        title="AI Queue, Streams And Throughput Over Time"
      >
        <defs>
          {SERIES.map(({ key, color }) => (
            <linearGradient key={key} id={`${gradientId}-${key}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor={color} stopOpacity={0.3} />
              <stop offset="95%" stopColor={color} stopOpacity={0.02} />
            </linearGradient>
          ))}
        </defs>

        <CartesianGrid />
        <XAxis dataKey="time" tickFormatter={formatTime} />
        <YAxis yAxisId="tokens" />
        <YAxis yAxisId="count" orientation="right" allowDecimals={false} />
        <Tooltip labelFormatter={(label) => formatTime(Number(label))} />
        <Legend />

        {SERIES.map(({ key, label, axis, color }) => (
          <Area
            key={key}
            yAxisId={axis}
            type="monotone"
            dataKey={key}
            name={label}
            stroke={color}
            fill={`url(#${gradientId}-${key})`}
            strokeWidth={1.5}
            dot={false}
            isAnimationActive={false}
          />
        ))}
      </AreaChart>
    </ChartPanel>
  );
}
