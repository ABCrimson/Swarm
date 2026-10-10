// ── ThroughputChart ─────────────────────────────────
// Tokens/sec per Claude model family, sampled once a second from the AI
// store's token-usage records and kept to the trailing MAX_CHART_POINTS
// samples. Families come from the model catalog (`#lib/models`), so a
// newly catalogued model gets its own series without touching this file;
// usage from a model outside the catalog is plotted as "Other", never
// dropped.

import { useEffect, useState } from "react";
import { CartesianGrid, Legend, Line, LineChart, Tooltip, XAxis, YAxis } from "recharts";
import { CHART_FILL_STYLE, ChartPanel } from "#components/metrics/ChartPanel";
import { formatTime, formatTokens } from "#lib/chart-theme";
import { lastN, MAX_CHART_POINTS } from "#lib/chart-window";
import { tokensPerSecond } from "#lib/metrics-aggregation";
import type { ModelKey } from "#lib/models";
import { CLAUDE_MODELS, MODEL_KEYS } from "#lib/models";
import { useAiStore } from "#store/ai";
import type { TokenUsageRecord } from "#store/types";

/** A series: one catalogued model family, or everything else. */
export type ThroughputSeries = ModelKey | "other";

const SAMPLE_MS = 1000;

/** OKLCH colour per series. */
const SERIES_COLOR: Readonly<Record<ThroughputSeries, string>> = {
  fable: "oklch(0.8 0.15 70)",
  mythos: "oklch(0.72 0.19 330)",
  opus: "oklch(0.68 0.22 290)",
  sonnet: "oklch(0.72 0.18 205)",
  haiku: "oklch(0.78 0.18 130)",
  other: "oklch(0.6 0.03 220)",
};

/** Legend name per series: the catalog's model label. */
function seriesLabel(series: ThroughputSeries): string {
  return series === "other" ? "Other" : CLAUDE_MODELS[series].label;
}

const ALL_SERIES: readonly ThroughputSeries[] = [...MODEL_KEYS, "other"];

/**
 * The series a usage record belongs to: the catalog family whose key its
 * model id names (`claude-sonnet-5-5`, a dated `claude-sonnet-5-5-2026…` or a
 * `…-latest` alias all resolve to `sonnet`), else `"other"`.
 */
export function seriesOf(model: string): ThroughputSeries {
  const id = model.toLowerCase();
  return MODEL_KEYS.find((key) => id.includes(key)) ?? "other";
}

/** One sampled row: time plus tokens/sec per series. */
export type ThroughputPoint = { readonly time: number } & Readonly<
  Record<ThroughputSeries, number>
>;

/** Samples tokens/sec per series at `now` over the shared trailing rate window. */
export function sampleThroughput(
  records: readonly TokenUsageRecord[],
  now: number,
): ThroughputPoint {
  const rates = ALL_SERIES.map((series) => [
    series,
    tokensPerSecond(records, now, undefined, (r) => seriesOf(r.model) === series),
  ]);
  return { time: now, ...Object.fromEntries(rates) } as ThroughputPoint;
}

/**
 * Real AI throughput (tokens/sec) per model family over the trailing
 * `MAX_CHART_POINTS` samples. Only families with usage in the window get
 * a line, so the legend never lists models that were not used.
 */
export function ThroughputChart(): React.ReactElement {
  const [data, setData] = useState<ThroughputPoint[]>([]);

  useEffect(() => {
    const id = setInterval(() => {
      const point = sampleThroughput(useAiStore.getState().cumulativeUsage.history, Date.now());
      setData((prev) => lastN([...prev, point]));
    }, SAMPLE_MS);
    return () => clearInterval(id);
  }, []);

  const activeSeries = ALL_SERIES.filter((series) => data.some((p) => p[series] > 0));

  return (
    <ChartPanel title="AI Throughput" caption={`Tokens/Sec · Last ${MAX_CHART_POINTS}`}>
      <LineChart
        responsive
        style={CHART_FILL_STYLE}
        data={data}
        margin={{ top: 4, right: 16, left: 0, bottom: 0 }}
        title="Tokens Per Second By Model"
      >
        <CartesianGrid />
        <XAxis dataKey="time" tickFormatter={formatTime} />
        <YAxis tickFormatter={formatTokens} />
        <Tooltip
          labelFormatter={(label) => formatTime(Number(label))}
          formatter={(value) => `${Number(value).toFixed(1)} tok/s`}
        />
        <Legend />
        {activeSeries.map((series) => (
          <Line
            key={series}
            type="monotone"
            dataKey={series}
            name={seriesLabel(series)}
            stroke={SERIES_COLOR[series]}
            strokeWidth={2}
            dot={false}
            isAnimationActive={false}
          />
        ))}
      </LineChart>
    </ChartPanel>
  );
}
