import { describe, expect, it } from "vitest";
import { clampNumberInput } from "#lib/number-input";

describe("clampNumberInput", () => {
  it.for([
    ["50", 50],
    ["150", 100],
    ["-3", 0],
    ["", 42],
    ["   ", 42],
    ["abc", 42],
  ] as const)("%j -> %d", ([raw, expected]) => {
    expect(clampNumberInput(raw, 0, 100, 42)).toBe(expected);
  });
});
