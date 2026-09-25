import { describe, expect, it } from "vitest";
import { sampleAiMetrics } from "#components/metrics/AIMetricsChart";
import type { TokenUsageRecord } from "#store/types";

const usage = (timestamp: number, tokens: number): TokenUsageRecord => ({
  model: "claude-sonnet-5",
  inputTokens: tokens,
  outputTokens: 0,
  provider: "anthropic",
  costUsd: 0,
  timestamp,
});

describe("sampleAiMetrics", () => {
  it("measures per-minute rates over the trailing minute only", () => {
    const now = 200_000;
    const point = sampleAiMetrics(
      {
        queue: [],
        activeStreams: 2,
        usage: [usage(now - 1_000, 300), usage(now - 30_000, 200), usage(now - 61_000, 999)],
      },
      now,
    );
    expect(point).toEqual({
      time: now,
      queueDepth: 0,
      activeStreams: 2,
      tokensPerMin: expect.closeTo(500),
      reqPerMin: 2,
    });
  });
});
