/**
 * Shared Recharts 3 theme and value formatters for the metrics charts.
 *
 * `CHART_THEME` is handed to Recharts' `RechartsThemeProvider` once, by
 * `ChartPanel`, so grid, axes, tick text, cursor, tooltip and legend are
 * styled in one place instead of per-component prop spreads. Series
 * colours stay explicit on each `<Line>`/`<Area>`/`<Bar>`, because they
 * carry meaning (a model, a priority) that a positional palette would not.
 *
 * Colours are OKLCH literals, not `var(--…)` tokens: most of them land in
 * SVG presentation attributes, where custom properties do not resolve.
 *
 * @module chart-theme
 */

import type { RechartsTheme } from "recharts";

/** Default series colour (plasma) — Recharts' fallback for a series with no explicit colour. */
const SERIES_DEFAULT = "oklch(0.78 0.18 205)";

/**
 * One colour per system/AI metric, the same on every chart it appears
 * in, with hues far enough apart (205 / 290 / 140 / 70) to tell the
 * lines of a shared chart apart.
 */
export const METRIC_COLOR = {
  cpu: SERIES_DEFAULT,
  memory: "oklch(0.72 0.2 290)",
  workers: "oklch(0.82 0.18 140)",
  queueDepth: "oklch(0.82 0.19 70)",
  activeStreams: SERIES_DEFAULT,
  tokensPerMin: "oklch(0.72 0.2 290)",
  reqPerMin: "oklch(0.82 0.18 140)",
} as const;

/**
 * Theme for every metrics chart. Recharts marks the theme API experimental;
 * it is pinned with the rest of the stack and covered by the chart tests.
 */
export const CHART_THEME: RechartsTheme = {
  typography: {
    color: "oklch(0.6 0.05 220)",
    fontSize: 11,
    fontFamily: "var(--font-mono)",
  },
  graphicalItems: [{ stroke: SERIES_DEFAULT, fill: SERIES_DEFAULT }],
  grid: { stroke: "oklch(0.3 0.05 220 / 0.3)", strokeDasharray: "3 3" },
  axis: { stroke: "oklch(0.22 0.04 220)" },
  cursor: { stroke: "oklch(0.35 0.06 220)", fill: "oklch(0.35 0.06 220 / 0.15)" },
  tooltip: {
    contentStyle: {
      background: "oklch(0.1 0.02 220)",
      border: "1px solid oklch(0.22 0.04 220)",
      borderRadius: 6,
      color: "oklch(0.82 0.04 220)",
      fontSize: 12,
      fontFamily: "var(--font-mono)",
      backdropFilter: "blur(8px)",
    },
  },
  legend: {
    wrapperStyle: {
      color: "oklch(0.6 0.05 220)",
      fontSize: 11,
      fontFamily: "var(--font-mono)",
    },
  },
};

/**
 * Formats a Unix timestamp (ms) as local `MM:SS` for chart axis labels.
 *
 * @param time - Unix timestamp in milliseconds.
 */
export function formatTime(time: number): string {
  const { minute, second } = Temporal.Instant.fromEpochMilliseconds(time).toZonedDateTimeISO(
    Temporal.Now.timeZoneId(),
  );
  return `${String(minute).padStart(2, "0")}:${String(second).padStart(2, "0")}`;
}

/**
 * Formats a memory value in MB, switching to GB at 1024 MB.
 *
 * @param v - Value in megabytes.
 * @returns e.g. `"512 MB"` or `"1.5 GB"`.
 */
export function formatMb(v: number): string {
  if (v >= 1024) return `${(v / 1024).toFixed(1)} GB`;
  return `${v.toFixed(0)} MB`;
}

/**
 * Formats a token count with a `k` suffix from 1000 up.
 *
 * @param v - Raw token count.
 * @returns e.g. `"450"` or `"2.3k"`.
 */
export function formatTokens(v: number): string {
  if (v >= 1000) return `${(v / 1000).toFixed(1)}k`;
  return v.toFixed(0);
}
