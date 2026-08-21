/**
 * Shared Recharts 3.x theme using OKLCH colours.
 *
 * All chart components import these prop objects for consistent styling
 * across grid, tooltip, axis, and legend elements.
 *
 * @module chart-theme
 */

import type { CSSProperties } from "react";

// ── CartesianGrid ──────────────────────────────────

/** Shared props for `<CartesianGrid>` with dashed OKLCH stroke. */
export const gridProps = {
  strokeDasharray: "3 3",
  stroke: "oklch(0.3 0.05 220 / 0.3)",
} as const;

// ── Tooltip ────────────────────────────────────────

/** Inline style for Recharts tooltip content panel (glass morphism). */
export const tooltipContentStyle: CSSProperties = {
  background: "oklch(0.1 0.02 220)",
  border: "1px solid oklch(0.22 0.04 220)",
  borderRadius: 6,
  color: "oklch(0.82 0.04 220)",
  fontSize: 12,
  fontFamily: "var(--font-mono)",
  backdropFilter: "blur(8px)",
};

/** Shared props for `<Tooltip>` with glass-morphism content style. */
export const tooltipProps = {
  contentStyle: tooltipContentStyle,
} as const;

// ── Axis ticks ─────────────────────────────────────

/** Tick label style for `<XAxis>` and `<YAxis>`. */
export const axisTick = {
  fill: "oklch(0.6 0.05 220)",
  fontSize: 11,
  fontFamily: "var(--font-mono)",
} as const;

/** Axis line stroke style. */
export const axisLine = {
  stroke: "oklch(0.22 0.04 220)",
} as const;

/** Composite axis props combining tick, axisLine, and tickLine styles. */
export const axisProps = {
  tick: axisTick,
  axisLine: axisLine,
  tickLine: { stroke: "oklch(0.22 0.04 220)" },
} as const;

// ── Legend ──────────────────────────────────────────

/** Wrapper style for Recharts `<Legend>`. */
export const legendStyle: CSSProperties = {
  color: "oklch(0.6 0.05 220)",
  fontSize: 11,
  fontFamily: "var(--font-mono)",
};

// ── Glass panel (for containing chart components) ──

/** Glass-morphism panel style for chart containers. */
export const glassPanelStyle: CSSProperties = {
  background: "oklch(0.08 0.02 220 / 0.7)",
  border: "1px solid oklch(0.22 0.04 220)",
  borderRadius: 8,
  backdropFilter: "blur(12px) saturate(1.5)",
};

// ── Time formatter ─────────────────────────────────

/**
 * Formats a unix timestamp to `MM:SS` for chart axis labels.
 *
 * @param time - Unix timestamp in milliseconds.
 * @returns Formatted string in `MM:SS` format.
 */
export function formatTime(time: number): string {
  const date = new Date(time);
  return `${date.getMinutes().toString().padStart(2, "0")}:${date.getSeconds().toString().padStart(2, "0")}`;
}

// ── Value formatters ───────────────────────────────

/**
 * Formats a number as a percentage string with one decimal place.
 *
 * @param v - Value between 0 and 100.
 * @returns Formatted string, e.g. `"72.3%"`.
 */
export function formatPercent(v: number): string {
  return `${v.toFixed(1)}%`;
}

/**
 * Formats a memory value in MB, upgrading to GB when >= 1024.
 *
 * @param v - Value in megabytes.
 * @returns Formatted string, e.g. `"512 MB"` or `"1.5 GB"`.
 */
export function formatMb(v: number): string {
  if (v >= 1024) return `${(v / 1024).toFixed(1)} GB`;
  return `${v.toFixed(0)} MB`;
}

/**
 * Formats a token count, using `k` suffix when >= 1000.
 *
 * @param v - Raw token count.
 * @returns Formatted string, e.g. `"450"` or `"2.3k"`.
 */
export function formatTokens(v: number): string {
  if (v >= 1000) return `${(v / 1000).toFixed(1)}k`;
  return `${v.toFixed(0)}`;
}
