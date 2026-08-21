// ── Memory Percent Helper ───────────────────────────
// Single source of truth for turning (used, total) memory in MB into a
// percentage, a severity classification, and an "available" figure for
// charting. Every consumer (useAlerts, Dashboard, Metrics, MemoryChart)
// must go through this module — no local 16GB-style assumptions.
//
// Divide-by-zero guard: `memoryTotalMb` starts at 0 in the store until
// the first `system_metrics` payload arrives from the real hardware. All
// functions here treat a zero/negative/non-finite total as "unknown" and
// degrade to a safe, non-alerting result rather than fabricating a ceiling.

/** Severity bucket for a memory reading, mirroring MetricCard's Severity type. */
export type MemorySeverity = "good" | "warning" | "critical";

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
 * Classify a memory reading into a severity bucket.
 *
 * When the total is unknown (see {@link memPercent}), always returns
 * `"good"` — a 0-total must never produce a critical (or warning) alert.
 */
export function memSeverity(
  usedMb: number,
  totalMb: number,
  warningThreshold = 70,
  criticalThreshold = 90,
): MemorySeverity {
  const pct = memPercent(usedMb, totalMb);
  if (pct === undefined) return "good";
  if (pct > criticalThreshold) return "critical";
  if (pct > warningThreshold) return "warning";
  return "good";
}

/**
 * Compute the "available" memory band for the stacked area chart:
 * total minus used minus an estimated cached slice of used memory.
 *
 * Clamped to 0 (never negative), and returns 0 when the total is unknown
 * rather than measuring against a fabricated ceiling.
 */
export function memoryAvailableMb(usedMb: number, totalMb: number, cachedFraction = 0.15): number {
  if (!Number.isFinite(totalMb) || totalMb <= 0) return 0;
  if (!Number.isFinite(usedMb) || usedMb < 0) return 0;
  return Math.max(0, totalMb - usedMb - usedMb * cachedFraction);
}
