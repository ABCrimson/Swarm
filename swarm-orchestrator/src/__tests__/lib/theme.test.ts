import { describe, expect, it } from "vitest";
import { WORKER_PALETTE, withAlpha, workerColor } from "#lib/theme";

describe("workerColor", () => {
  it("returns an OKLCH color string for index 0", () => {
    const color = workerColor(0);
    expect(color).toMatch(/^oklch\(/);
    expect(color).toContain("0.18");
    expect(color).toContain("205");
  });

  it("rotates hue by 36 degrees per index", () => {
    const color0 = workerColor(0);
    const color1 = workerColor(1);

    // Index 0: hue = 205
    expect(color0).toContain("205");
    // Index 1: hue = (205 + 36) % 360 = 241
    expect(color1).toContain("241");
  });

  it("reduces lightness per index but clamps at 0.4", () => {
    const color0 = workerColor(0);
    const color1 = workerColor(1);
    // Index 0 lightness = 0.78
    expect(color0).toContain("0.78");
    // Index 1 lightness = 0.78 - 0.04 = 0.74
    expect(color1).toContain("0.74");
  });

  it("clamps lightness at 0.40 for high indices", () => {
    // At index 10, lightness would be 0.78 - 10*0.04 = 0.38, but clamped to 0.40
    const color = workerColor(10);
    expect(color).toContain("0.40");
  });

  it("wraps hue around 360 degrees", () => {
    // Index 5: hue = (205 + 5*36) % 360 = 385 % 360 = 25
    const color = workerColor(5);
    expect(color).toContain("25");
  });

  it("produces distinct colors for consecutive indices", () => {
    const colors = [workerColor(0), workerColor(1), workerColor(2)];
    const uniqueColors = new Set(colors);
    expect(uniqueColors.size).toBe(3);
  });
});

describe("withAlpha", () => {
  it("adds alpha to an OKLCH color without existing alpha", () => {
    const result = withAlpha("oklch(0.78 0.18 205)", 0.5);
    expect(result).toBe("oklch(0.78 0.18 205 / 0.5)");
  });

  it("replaces existing alpha", () => {
    const result = withAlpha("oklch(0.78 0.18 205 / 0.3)", 0.8);
    expect(result).toBe("oklch(0.78 0.18 205 / 0.8)");
  });

  it("clamps alpha at 0", () => {
    const result = withAlpha("oklch(0.78 0.18 205)", -0.5);
    expect(result).toBe("oklch(0.78 0.18 205 / 0)");
  });

  it("clamps alpha at 1", () => {
    const result = withAlpha("oklch(0.78 0.18 205)", 1.5);
    expect(result).toBe("oklch(0.78 0.18 205 / 1)");
  });

  it("handles alpha of exactly 0", () => {
    const result = withAlpha("oklch(0.78 0.18 205)", 0);
    expect(result).toBe("oklch(0.78 0.18 205 / 0)");
  });

  it("handles alpha of exactly 1", () => {
    const result = withAlpha("oklch(0.78 0.18 205)", 1);
    expect(result).toBe("oklch(0.78 0.18 205 / 1)");
  });
});

describe("WORKER_PALETTE", () => {
  it("contains 10 pre-generated colors", () => {
    expect(WORKER_PALETTE).toHaveLength(10);
  });

  it("all entries are OKLCH color strings", () => {
    for (const color of WORKER_PALETTE) {
      expect(color).toMatch(/^oklch\(/);
    }
  });

  it("palette[0] matches workerColor(0)", () => {
    expect(WORKER_PALETTE[0]).toBe(workerColor(0));
  });
});
