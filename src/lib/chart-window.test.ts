import { describe, expect, it } from "vitest";
import { lastN, MAX_CHART_POINTS } from "#lib/chart-window";

describe("lastN (chart sliding window)", () => {
  it("keeps every ping while at or under the cap (pings 1-20, nothing dropped)", () => {
    const pings = Array.from({ length: MAX_CHART_POINTS }, (_, i) => i + 1);
    expect(lastN(pings)).toEqual(pings);
  });

  it("drops ping 1 as soon as ping 21 arrives (2-21)", () => {
    const pings = Array.from({ length: MAX_CHART_POINTS + 1 }, (_, i) => i + 1);
    const windowed = lastN(pings);
    expect(windowed).toHaveLength(MAX_CHART_POINTS);
    expect(windowed[0]).toBe(2);
    expect(windowed.at(-1)).toBe(21);
  });

  it("keeps sliding as more pings arrive (25 pings -> 6-25)", () => {
    const pings = Array.from({ length: 25 }, (_, i) => i + 1);
    const windowed = lastN(pings);
    expect(windowed[0]).toBe(6);
    expect(windowed.at(-1)).toBe(25);
  });

  it("returns an empty array for empty input", () => {
    expect(lastN([])).toEqual([]);
  });

  it("honors a custom cap", () => {
    expect(lastN([1, 2, 3, 4, 5], 2)).toEqual([4, 5]);
  });

  it("keeps nothing for a cap of 0 (regression: slice(-0) returned every item)", () => {
    expect(lastN([1, 2, 3], 0)).toEqual([]);
  });

  it("returns a copy, never the input array", () => {
    const pings = [1, 2];
    expect(lastN(pings)).not.toBe(pings);
  });
});
