// ── MetricCard ──────────────────────────────────────
// One stat tile: label, current value and, only when the caller measured
// one, a trend arrow. The value is fg-bright when good and coloured only
// when a threshold speaks (amber = warning, rose = critical); the tiles
// share one divided glass strip, and a warning or critical value also
// shows its name, so severity never rests on colour alone.
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

/** Value colour per severity: fg-bright at rest, the amber and rose tokens (as on the warning/danger pills) when a threshold speaks. */
export const SEVERITY_COLOR: Readonly<Record<Severity, string>> = {
  good: "var(--color-fg-bright)",
  warning: "var(--color-amber)",
  critical: "var(--color-rose)",
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
  padding: "12px 16px",
  display: "flex",
  flexDirection: "column",
  gap: 4,
  minWidth: 140,
};

const labelStyle: CSSProperties = {
  fontFamily: "var(--font-body)",
  fontSize: 12,
  fontWeight: 500,
  color: "var(--color-fg-muted)",
};

const cardListStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))",
  margin: 0,
  border: "1px solid var(--color-border)",
  borderRadius: "var(--radius-lg)",
  background: "oklch(from var(--color-surface-0) l c h / 0.7)",
  backdropFilter: "blur(12px) saturate(1.5)",
  overflow: "hidden",
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
  return (
    <dl style={cardListStyle} className="*:shadow-[-1px_-1px_0_var(--color-border)]">
      {children}
    </dl>
  );
}
