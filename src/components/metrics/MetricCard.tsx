// ── MetricCard ──────────────────────────────────────
// One stat tile: label, current value and, only when the caller measured
// one, a trend arrow. The value is coloured by severity in OKLCH (green =
// good, amber = warning, rose = critical) on a glass panel, and a warning
// or critical value also shows its name, so severity never rests on colour
// alone.
//
// Semantics: a tile is one term/description pair of the enclosing
// `<dl>` (see `MetricCardList`), so assistive tech reads "CPU Usage,
// 42.0%" as a labelled value rather than a form group.

import type { CSSProperties } from "react";
import type { Severity } from "#lib/severity";

/** Direction of a measured change over the recent samples. */
export type Trend = "up" | "down" | "stable";

interface MetricCardProps {
  readonly label: string;
  readonly value: string;
  readonly severity?: Severity;
  /** Omit when there is no real series behind the value — no arrow is invented. */
  readonly trend?: Trend;
}

/** Value colour per severity. */
export const SEVERITY_COLOR: Readonly<Record<Severity, string>> = {
  good: "oklch(0.78 0.18 140)",
  warning: "oklch(0.78 0.18 70)",
  critical: "oklch(0.68 0.22 15)",
};

/** Visible name for a non-good severity, so the state never rests on colour alone. */
const SEVERITY_LABEL: Readonly<Record<Exclude<Severity, "good">, string>> = {
  warning: "Warning",
  critical: "Critical",
};

const TREND: Readonly<Record<Trend, { readonly symbol: string; readonly label: string }>> = {
  up: { symbol: "↑", label: "Trending Up" },
  down: { symbol: "↓", label: "Trending Down" },
  stable: { symbol: "→", label: "Stable" },
};

const cardStyle: CSSProperties = {
  background: "oklch(0.08 0.02 220 / 0.7)",
  border: "1px solid oklch(0.22 0.04 220)",
  borderRadius: 8,
  backdropFilter: "blur(12px) saturate(1.5)",
  padding: "12px 16px",
  display: "flex",
  flexDirection: "column",
  gap: 4,
  minWidth: 140,
};

const labelStyle: CSSProperties = {
  fontFamily: "var(--font-body)",
  fontSize: 11,
  color: "var(--color-fg-dim)",
  textTransform: "uppercase",
  letterSpacing: "0.05em",
};

const cardListStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))",
  gap: 12,
  margin: 0,
};

/**
 * Compact metric tile with label, severity-coloured value and an optional
 * trend arrow. Must be rendered inside a {@link MetricCardList}.
 */
export function MetricCard({
  label,
  value,
  severity = "good",
  trend,
}: MetricCardProps): React.ReactElement {
  const accentColor = SEVERITY_COLOR[severity];

  return (
    <div style={cardStyle} data-severity={severity}>
      <dt style={labelStyle}>{label}</dt>
      <dd className="m-0 flex items-end gap-2">
        <span
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: 22,
            fontWeight: 700,
            color: accentColor,
            lineHeight: 1,
          }}
        >
          {value}
        </span>
        {severity !== "good" && (
          <span
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: 11,
              fontWeight: 600,
              color: accentColor,
              textTransform: "uppercase",
              letterSpacing: "0.05em",
              lineHeight: 1.4,
            }}
          >
            {SEVERITY_LABEL[severity]}
          </span>
        )}
        {trend && (
          <span
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: 14,
              color: accentColor,
              opacity: 0.7,
              lineHeight: 1.4,
            }}
          >
            <span aria-hidden="true">{TREND[trend].symbol}</span>
            <span className="sr-only">{TREND[trend].label}</span>
          </span>
        )}
      </dd>
    </div>
  );
}

/** The `<dl>` grid that {@link MetricCard} tiles live in. */
export function MetricCardList({
  children,
}: {
  readonly children: React.ReactNode;
}): React.ReactElement {
  return <dl style={cardListStyle}>{children}</dl>;
}
