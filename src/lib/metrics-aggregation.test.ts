import { describe, expect, it } from "vitest";
import { appendCapped, TOKEN_RATE_WINDOW_MS, tokensPerSecond } from "#lib/metrics-aggregation";
import type { TokenUsageRecord } from "#store/types";

describe("appendCapped", () => {
  it("appends while under capacity", () => {
    expect(appendCapped([1, 2], 3, 5)).toEqual([1, 2, 3]);
  });

  it("drops the oldest items once at capacity", () => {
    expect(appendCapped([1, 2, 3], 4, 3)).toEqual([2, 3, 4]);
  });

  it("trims an over-capacity input down to capacity", () => {
    expect(appendCapped([1, 2, 3, 4, 5], 6, 2)).toEqual([5, 6]);
  });

  it("keeps only the new item at capacity 1", () => {
    expect(appendCapped([1, 2], 3, 1)).toEqual([3]);
  });

  it("keeps nothing at capacity 0", () => {
    expect(appendCapped([1], 2, 0)).toEqual([]);
  });

  it("returns a new array and leaves the input untouched", () => {
    const input = [1, 2];
    const output = appendCapped(input, 3, 2);
    expect(output).not.toBe(input);
    expect(input).toEqual([1, 2]);
  });
});

function usage(timestamp: number, tokens: number, model = "claude-sonnet-5"): TokenUsageRecord {
  return {
    inputTokens: tokens / 2,
    outputTokens: tokens / 2,
    model,
    provider: "anthropic",
    costUsd: 0,
    timestamp,
  };
}

describe("tokensPerSecond", () => {
  const now = 100_000;

  it("averages input + output tokens over the trailing window", () => {
    const records = [usage(now - 1_000, 400), usage(now - 5_000, 600)];
    expect(tokensPerSecond(records, now)).toBe(1_000 / (TOKEN_RATE_WINDOW_MS / 1000));
  });

  it("excludes records at or before the window start", () => {
    const records = [usage(now - TOKEN_RATE_WINDOW_MS, 999), usage(now - 1, 100)];
    expect(tokensPerSecond(records, now)).toBe(100 / (TOKEN_RATE_WINDOW_MS / 1000));
  });

  it("is 0 with no records", () => {
    expect(tokensPerSecond([], now)).toBe(0);
  });

  it("honours a custom window", () => {
    expect(tokensPerSecond([usage(now - 30_000, 600)], now, 60_000)).toBe(10);
  });

  it("counts only records the filter includes", () => {
    const records = [
      usage(now - 1, 100, "claude-opus-4-8"),
      usage(now - 1, 300, "claude-haiku-4-5"),
    ];
    const opusOnly = tokensPerSecond(records, now, 1_000, (r) => r.model.includes("opus"));
    expect(opusOnly).toBe(100);
  });
});
