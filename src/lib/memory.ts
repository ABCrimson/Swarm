// ── Memory Percent Helper ───────────────────────────
// Single source of truth for turning (used, total) memory in MB into a
// percentage, a severity, and a "free" figure for charting. Every consumer
// (useAlerts, the metric cards, MetricsChart, MemoryChart) goes through
// this module — no local 16GB-style assumptions.
//
// Divide-by-zero guard: `memoryTotalMb` starts at 0 in the store until
// the first `system_metrics` payload arrives from the real hardware. All
// functions here treat a zero/negative/non-finite total as "unknown" and
// degrade to a safe, non-alerting result rather than fabricating a ceiling.

import type { Severity, SeverityBands } from "#lib/severity";
import { severityFor } from "#lib/severity";

/**
 * Compute memory usage percentage from used/total MB.
 *
 * Returns `undefined` when the total is not yet known (zero, negative, or
 * non-finite) so callers never divide by zero or fabricate a percentage
 * against a ceiling that hasn't been observed from real hardware yet.
 */
export function memPercent(usedMb: number, totalMb: number): number | undefined {
  if (!Number.isFinite(totalMb) || totalMb <= 0) return undefined;
  if (!Number.isFinite(usedMb) || usedMb < 0) return undefined;
  return (usedMb / totalMb) * 100;
}

/**
 * Classify a memory reading against percentage `bands` (the user's
 * memoryWarning/memoryCritical alert thresholds), with the same inclusive
 * edges as the alert toasts — see `#lib/severity`.
 *
 * When the total is unknown (see {@link memPercent}), always returns
 * `"good"` — a 0-total must never produce a critical (or warning) state.
 */
export function memSeverity(usedMb: number, totalMb: number, bands: SeverityBands): Severity {
  const pct = memPercent(usedMb, totalMb);
  return pct === undefined ? "good" : severityFor(pct, bands);
}

/**
 * Free memory (total minus used) for the memory chart — exactly what the
 * backend reports, with nothing estimated: `sysinfo` gives used and total,
 * so there is no cached/available split to draw.
 *
 * Clamped to 0 (never negative), and 0 while the total is still unknown
 * rather than measured against a fabricated ceiling.
 */
export function memoryFreeMb(usedMb: number, totalMb: number): number {
  if (!Number.isFinite(totalMb) || totalMb <= 0) return 0;
  if (!Number.isFinite(usedMb) || usedMb < 0) return 0;
  return Math.max(0, totalMb - usedMb);
}
