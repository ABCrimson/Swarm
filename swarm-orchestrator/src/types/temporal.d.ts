// ── Temporal Global (Ambient) ───────────────────────
// TC39 Temporal is available as a global in the target runtime (Node
// 26.5.0 / Chromium 146+) but is not yet part of TypeScript's built-in
// lib types. Previously declared twice, independently, and out of sync
// (#components/command/CommandPalette and #store/frecency each carried
// their own subset of the shape they used) — this is the single shared
// declaration; every file under `src/` sees `Temporal` as a global with
// no import needed.
//
// Covers only the members actually used in this codebase today
// (`Temporal.Now.instant()`, `.since()`, `.toString()`, and
// `Temporal.Instant.from()`) — extend as more of the Temporal API gets
// used, not speculatively ahead of that.

declare const Temporal: {
  readonly Now: {
    instant(): {
      since(other: unknown): { total(unit: string): number };
      toString(): string;
    };
  };
  readonly Instant: {
    from(s: string): unknown;
  };
};
