// ── OKLCH Theme Utilities ───────────────────────────
// Dark-only theme system for SWARM Orchestrator.
// All colors produced in OKLCH color space.

/** Base hue for the plasma accent color. */
const BASE_HUE = 205;
/** Base lightness for worker colors. */
const BASE_LIGHTNESS = 0.78;
/** Base chroma for worker colors. */
const BASE_CHROMA = 0.18;
/** Hue rotation step per worker index. */
const HUE_STEP = 36;
/** Lightness reduction per worker index. */
const LIGHTNESS_STEP = 0.04;

/**
 * Returns an OKLCH color string for a given worker index,
 * rotating hue by 36deg per step and slightly reducing lightness.
 */
export function workerColor(idx: number): string {
  const lightness = Math.max(0.4, BASE_LIGHTNESS - idx * LIGHTNESS_STEP);
  const hue = (BASE_HUE + idx * HUE_STEP) % 360;
  return `oklch(${lightness.toFixed(2)} ${BASE_CHROMA} ${hue})`;
}

/**
 * Adds an alpha channel to an OKLCH color string.
 *
 * Handles both `oklch(L C H)` and `oklch(L C H / A)` formats.
 * If the color already contains an alpha, it is replaced.
 */
export function withAlpha(color: string, alpha: number): string {
  const clamped = Math.max(0, Math.min(1, alpha));
  // Strip existing alpha if present
  const base = color.replace(/\s*\/\s*[\d.]+\s*\)/, ")");
  // Insert alpha before closing paren
  return base.replace(")", ` / ${clamped})`);
}

/**
 * Detects whether the user prefers reduced motion.
 * Returns `true` if `prefers-reduced-motion: reduce` matches.
 */
export function prefersReducedMotion(): boolean {
  if (typeof globalThis.matchMedia !== "function") return false;
  return globalThis.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** Palette of OKLCH worker colors for up to 10 workers. */
export const WORKER_PALETTE = Array.from({ length: 10 }, (_, i) => workerColor(i));
