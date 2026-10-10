import { describe, expect, it } from "vitest";
import { memoryFreeMb, memPercent, memSeverity } from "#lib/memory";

/** The alert system's default memory bands (see DEFAULT_THRESHOLDS in #lib/alerts). */
const BANDS = { warning: 80, critical: 90 };

// ── memPercent ──────────────────────────────────────

describe("memPercent", () => {
  it("computes percentage from used/total MB", () => {
    expect(memPercent(1024, 16_384)).toBeCloseTo(6.25, 5);
  });

  it("computes the real-hardware regression case (256GB machine)", () => {
    // 35,389 MB used on a 256GB (262,144 MB) machine reads ~13.5%: the
    // total comes from the hardware, never a fixed 16GB (which gives 216%).
    expect(memPercent(35_389, 262_144)).toBeCloseTo(13.5, 1);
  });

  it("returns undefined when total is zero (divide-by-zero guard)", () => {
    expect(memPercent(1024, 0)).toBeUndefined();
  });

  it("returns undefined when total is negative", () => {
    expect(memPercent(1024, -1)).toBeUndefined();
  });

  it("returns undefined when total is not finite", () => {
    expect(memPercent(1024, Number.NaN)).toBeUndefined();
    expect(memPercent(1024, Number.POSITIVE_INFINITY)).toBeUndefined();
  });

  it("returns undefined when used is negative or non-finite", () => {
    expect(memPercent(-1, 16_384)).toBeUndefined();
    expect(memPercent(Number.NaN, 16_384)).toBeUndefined();
  });

  it("returns 0 when used is 0 and total is positive", () => {
    expect(memPercent(0, 16_384)).toBe(0);
  });
});

// ── memSeverity ─────────────────────────────────────

describe("memSeverity", () => {
  it("returns 'good' below the warning band", () => {
    expect(memSeverity(79.9, 100, BANDS)).toBe("good");
  });

  it("returns 'warning' exactly at the warning band (inclusive, like the alert toasts)", () => {
    expect(memSeverity(80, 100, BANDS)).toBe("warning");
  });

  it("returns 'critical' exactly at the critical band (inclusive, like the alert toasts)", () => {
    expect(memSeverity(90, 100, BANDS)).toBe("critical");
  });

  it("follows user-edited bands instead of fixed defaults", () => {
    expect(memSeverity(71, 100, { warning: 85, critical: 95 })).toBe("good");
    expect(memSeverity(51, 100, { warning: 50, critical: 80 })).toBe("warning");
  });

  it("never returns 'critical' when total is 0, regardless of used (216% bug regression)", () => {
    expect(memSeverity(35_389, 0, BANDS)).toBe("good");
    expect(memSeverity(999_999, 0, BANDS)).toBe("good");
  });

  it("returns 'good' when total is negative or non-finite", () => {
    expect(memSeverity(1024, -1, BANDS)).toBe("good");
    expect(memSeverity(1024, Number.NaN, BANDS)).toBe("good");
  });
});

// ── memoryFreeMb ────────────────────────────────────

describe("memoryFreeMb", () => {
  it("is exactly total minus used — nothing estimated", () => {
    expect(memoryFreeMb(1000, 16_384)).toBe(15_384);
  });

  it("clamps to 0 rather than going negative", () => {
    expect(memoryFreeMb(1000, 500)).toBe(0);
  });

  it("returns 0 when total is unknown (no fictitious ceiling)", () => {
    expect(memoryFreeMb(1000, 0)).toBe(0);
  });
});
