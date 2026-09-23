import { describe, expect, it } from "vitest";
import { withAlpha, workerColor } from "#lib/theme";

describe("workerColor", () => {
  it("starts at the accent: lightness 0.78, chroma 0.18, hue 205", () => {
    expect(workerColor(0)).toBe("oklch(0.78 0.18 205)");
  });

  it("rotates the hue 36° and lowers the lightness 0.04 per index", () => {
    expect(workerColor(1)).toBe("oklch(0.74 0.18 241)");
    expect(workerColor(2)).toBe("oklch(0.70 0.18 277)");
  });

  it("wraps the hue around 360°", () => {
    // (205 + 5 × 36) % 360 = 25
    expect(workerColor(5)).toBe("oklch(0.58 0.18 25)");
  });

  it("clamps the lightness at 0.40", () => {
    // 0.78 − 10 × 0.04 = 0.38, clamped
    expect(workerColor(10)).toBe("oklch(0.40 0.18 205)");
    expect(workerColor(25)).toBe("oklch(0.40 0.18 25)");
  });

  it("gives ten consecutive workers ten distinct colors", () => {
    expect(new Set(Array.from({ length: 10 }, (_, i) => workerColor(i))).size).toBe(10);
  });
});

describe("withAlpha", () => {
  it("sets the alpha through relative color syntax", () => {
    expect(withAlpha("oklch(0.78 0.18 205)", 0.5)).toBe(
      "oklch(from oklch(0.78 0.18 205) l c h / 0.5)",
    );
  });

  it("replaces an existing alpha, whatever its notation", () => {
    expect(withAlpha("oklch(0.7 0.1 200 / 50%)", 0.8)).toBe(
      "oklch(from oklch(0.7 0.1 200 / 50%) l c h / 0.8)",
    );
  });

  it("accepts any CSS color, including a custom property", () => {
    expect(withAlpha("var(--accent)", 0.25)).toBe("oklch(from var(--accent) l c h / 0.25)");
  });

  it("clamps the alpha to 0–1", () => {
    expect(withAlpha("oklch(0.78 0.18 205)", -0.5)).toBe(
      "oklch(from oklch(0.78 0.18 205) l c h / 0)",
    );
    expect(withAlpha("oklch(0.78 0.18 205)", 1.5)).toBe(
      "oklch(from oklch(0.78 0.18 205) l c h / 1)",
    );
  });
});
