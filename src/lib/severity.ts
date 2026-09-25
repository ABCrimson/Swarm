// ── Metric Severity ─────────────────────────────────
// The one warning/critical banding rule. Alert toasts (`evaluateThresholds`)
// and the metric cards (Dashboard, Metrics) both classify through here, so
// a card can never turn amber at a value that fires no alert (or vice
// versa), and the user's Settings thresholds drive both.

/** Severity bucket for a metric reading. */
export type Severity = "good" | "warning" | "critical";

/** Warning/critical thresholds for one metric, in the metric's own unit. */
export interface SeverityBands {
  readonly warning: number;
  readonly critical: number;
}

/**
 * Classifies `value` against `bands` with inclusive (`>=`) edges: exactly
 * at a threshold already counts as that severity.
 */
export function severityFor(value: number, bands: SeverityBands): Severity {
  if (value >= bands.critical) return "critical";
  if (value >= bands.warning) return "warning";
  return "good";
}
