// ── Copy Formatting Helpers ─────────────────────────
// The one "{count} {Word}" formatter for UI counters, so every counter
// gets the Title Case noun and the plural right. Call sites use
// `pluralize`/`pluralizeWorkers` instead of their own
// `count === 1 ? "s" : ""` ternary.

/**
 * Formats a count with a Title Case singular/plural noun, e.g.
 * `pluralize("Worker", 1)` -> "1 Worker", `pluralize("Worker", 3)` -> "3 Workers".
 *
 * Pass `pluralWord` for irregular plurals that don't just append "s".
 */
export function pluralize(word: string, count: number, pluralWord?: string): string {
  const label = count === 1 ? word : (pluralWord ?? `${word}s`);
  return `${count} ${label}`;
}

/** Formats a worker count as Title Case, e.g. "1 Worker" / "3 Workers". */
export function pluralizeWorkers(count: number): string {
  return pluralize("Worker", count);
}
