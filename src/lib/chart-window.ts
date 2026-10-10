// ── Chart Window ────────────────────────────────────
// Shared sliding-window rule for every metrics chart box.
//
// Owner rule (Albert, 2026-07-11): a chart tracks at most 20 pings — pings
// 1-20 all show, and as soon as ping 21 arrives, ping 1 drops (2-21, 3-22,
// …). Without this, long-lived sessions accumulate points until every
// chart compresses into unreadable noise and re-renders get progressively
// heavier.

/** Maximum samples a chart box may track/render at once. */
export const MAX_CHART_POINTS = 20;

/**
 * Returns the trailing `max` items of `items` — the sliding-window rule:
 * the oldest items drop first. Always a fresh mutable array, as chart `data` props want.
 * A `max` of 0 (or less) keeps nothing — never `slice(-0)`, which is the whole array.
 */
export function lastN<T>(items: readonly T[], max: number = MAX_CHART_POINTS): T[] {
  return items.slice(Math.max(0, items.length - max));
}
