import { describe, expect, it } from "vitest";
import { memoryAvailableMb, memPercent, memSeverity } from "#lib/memory";

// ── memPercent ──────────────────────────────────────

describe("memPercent", () => {
  it("computes percentage from used/total MB", () => {
    expect(memPercent(1024, 16_384)).toBeCloseTo(6.25, 5);
  });

  it("computes the real-hardware regression case (256GB machine)", () => {
    // Bug report: 35,389 MB used on a 256GB (262,144 MB) machine should
    // read ~13.5%, not 216% (which came from dividing by a hardcoded 16GB).
    const pct = memPercent(35_389, 262_144);
    expect(pct).toBeDefined();
    expect(pct as number).toBeCloseTo(13.5, 1);
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
  it("returns 'good' below the warning threshold", () => {
    expect(memSeverity(1024, 16_384)).toBe("good"); // ~6.25%
  });

  it("returns 'good' exactly at the warning threshold (strict >)", () => {
    expect(memSeverity(70, 100)).toBe("good"); // exactly 70%
  });

  it("returns 'warning' just above the warning threshold", () => {
    expect(memSeverity(70.1, 100)).toBe("warning");
  });

  it("returns 'warning' exactly at the critical threshold (strict >)", () => {
    expect(memSeverity(90, 100)).toBe("warning"); // exactly 90%
  });

  it("returns 'critical' just above the critical threshold", () => {
    expect(memSeverity(90.1, 100)).toBe("critical");
  });

  it("respects custom warning/critical thresholds", () => {
    expect(memSeverity(51, 100, 50, 80)).toBe("warning");
    expect(memSeverity(81, 100, 50, 80)).toBe("critical");
  });

  it("never returns 'critical' when total is 0, regardless of used (216% bug regression)", () => {
    // This is the exact shape of the original bug: a huge used value with
    // no known total must never be classified as critical.
    expect(memSeverity(35_389, 0)).toBe("good");
    expect(memSeverity(999_999, 0)).toBe("good");
  });

  it("returns 'good' when total is negative or non-finite", () => {
    expect(memSeverity(1024, -1)).toBe("good");
    expect(memSeverity(1024, Number.NaN)).toBe("good");
  });
});

// ── memoryAvailableMb ───────────────────────────────

describe("memoryAvailableMb", () => {
  it("computes available memory as total minus used minus cached fraction", () => {
    // used=1000, cached=15% of used=150, total=16384 -> 16384-1000-150
    expect(memoryAvailableMb(1000, 16_384)).toBeCloseTo(15_234, 5);
  });

  it("clamps to 0 rather than going negative", () => {
    expect(memoryAvailableMb(1000, 500)).toBe(0);
  });

  it("returns 0 when total is 0 (divide-by-zero guard, no fictitious ceiling)", () => {
    // Original bug: available was computed against a fake 16384 ceiling.
    // With no known total yet, available must be 0, not a fabricated cap.
    expect(memoryAvailableMb(1000, 0)).toBe(0);
  });

  it("accepts a custom cached fraction", () => {
    expect(memoryAvailableMb(1000, 16_384, 0)).toBeCloseTo(15_384, 5);
  });
});
