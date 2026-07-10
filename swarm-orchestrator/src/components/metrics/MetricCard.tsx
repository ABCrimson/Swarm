// ── MetricCard ──────────────────────────────────────
// Compact card: label, current value, trend indicator.
// OKLCH colored by severity: green=good, amber=warning, rose=critical.
// Glass-panel background.

import type { CSSProperties } from "react";

type Severity = "good" | "warning" | "critical";
type Trend = "up" | "down" | "stable";

interface MetricCardProps {
  readonly label: string;
  readonly value: string;
  readonly severity?: Severity;
  readonly trend?: Trend;
}

const SEVERITY_COLOR: Record<Severity, string> = {
  good: "oklch(0.78 0.18 140)",
  warning: "oklch(0.78 0.18 70)",
  critical: "oklch(0.68 0.22 15)",
};

const TREND_SYMBOL: Record<Trend, string> = {
  up: "\u2191",
  down: "\u2193",
  stable: "\u2192",
};

const cardStyle: CSSProperties = {
  background: "oklch(0.08 0.02 220 / 0.7)",
  border: "1px solid oklch(0.22 0.04 220)",
  borderRadius: 8,
  backdropFilter: "blur(12px) saturate(1.5)",
  padding: "12px 16px",
  margin: 0,
  display: "flex",
  flexDirection: "column",
  gap: 4,
  minWidth: 140,
};

/**
 * Compact metric card with label, value, severity colour, and trend indicator.
 *
 * OKLCH-themed: green (good), amber (warning), rose (critical).
 */
export function MetricCard({
  label,
  value,
  severity = "good",
  trend = "stable",
}: MetricCardProps): React.ReactElement {
  const accentColor = SEVERITY_COLOR[severity];

  return (
    <fieldset style={cardStyle} aria-label={`${label}: ${value}`}>
      <span
        style={{
          fontFamily: "var(--font-body)",
          fontSize: 11,
          color: "oklch(0.55 0.04 220)",
          textTransform: "uppercase" as const,
          letterSpacing: "0.05em",
        }}
      >
        {label}
      </span>
      <div className="flex items-end gap-2">
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
        <span
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: 14,
            color: accentColor,
            opacity: 0.7,
            lineHeight: 1.4,
          }}
        >
          {TREND_SYMBOL[trend]}
        </span>
      </div>
    </fieldset>
  );
}
