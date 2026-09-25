// ── Metrics Aggregation ─────────────────────────────
// Pure helpers behind the live metrics: the capped sample history and the
// trailing token-rate computation shared by the Tokens/s tile (through
// `useMetrics`), the throughput chart and the AI metrics chart.

import type { TokenUsageRecord } from "#store/types";

/**
 * Appends `item`, keeping at most the newest `capacity` items. Returns a
 * new array (store state stays immutable); the copy is one pass over at
 * most `capacity` references.
 */
export function appendCapped<T>(items: readonly T[], item: T, capacity: number): T[] {
  if (capacity <= 0) return [];
  const keep = Math.min(items.length, capacity - 1);
  return [...items.slice(items.length - keep), item];
}

/** Trailing window, in ms, that the tokens/sec figures are averaged over. */
export const TOKEN_RATE_WINDOW_MS = 10_000;

/**
 * Average tokens per second (input + output) over the `windowMs` before
 * `now`, counting only records that pass `include`. Records at or before
 * the window's start are outside it.
 */
export function tokensPerSecond(
  records: readonly TokenUsageRecord[],
  now: number,
  windowMs: number = TOKEN_RATE_WINDOW_MS,
  include: (record: TokenUsageRecord) => boolean = () => true,
): number {
  const cutoff = now - windowMs;
  const tokens = records
    .values()
    .filter((r) => r.timestamp > cutoff && include(r))
    .reduce((sum, r) => sum + r.inputTokens + r.outputTokens, 0);
  return tokens / (windowMs / 1000);
}
