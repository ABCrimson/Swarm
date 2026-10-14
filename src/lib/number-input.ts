/**
 * Parses typed numeric input and clamps it to `[min, max]`. Blank or
 * non-numeric input keeps `fallback`: `Number("")` is 0, which must never
 * be committed as if the user had typed it.
 */
export function clampNumberInput(raw: string, min: number, max: number, fallback: number): number {
  const n = raw.trim() === "" ? Number.NaN : Number(raw);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}
