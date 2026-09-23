// ── OKLCH Theme Utilities ───────────────────────────
// Worker colors for SWARM Orchestrator's dark theme, all in OKLCH.

/** Hue of the plasma accent, and of worker 0. */
const BASE_HUE = 205;
/** Lightness of worker 0. */
const BASE_LIGHTNESS = 0.78;
/** Chroma of every worker color. */
const BASE_CHROMA = 0.18;
/** Hue rotation per worker index, in degrees. */
const HUE_STEP = 36;
/** Lightness reduction per worker index. */
const LIGHTNESS_STEP = 0.04;
/** Lightness floor, reached at index 10. */
const MIN_LIGHTNESS = 0.4;

/**
 * The OKLCH color of the worker at `idx`: the hue rotates 36° per index
 * and the lightness drops 0.04 per index down to 0.40.
 */
export function workerColor(idx: number): string {
  const lightness = Math.max(MIN_LIGHTNESS, BASE_LIGHTNESS - idx * LIGHTNESS_STEP);
  const hue = (BASE_HUE + idx * HUE_STEP) % 360;
  return `oklch(${lightness.toFixed(2)} ${BASE_CHROMA} ${hue})`;
}

/**
 * `color` with its alpha set to `alpha` (clamped to 0–1), as CSS
 * relative color syntax: the browser parses `color`, so any CSS color
 * works, including one that already has an alpha (it is replaced) or a
 * `var()` reference.
 */
export function withAlpha(color: string, alpha: number): string {
  const clamped = Math.min(1, Math.max(0, alpha));
  return `oklch(from ${color} l c h / ${clamped})`;
}
