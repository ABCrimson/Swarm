// Every catalogued model, dated id or alias resolves to its own family series; a model outside
// the catalog falls into 'other' instead of vanishing from the chart.

import { describe, expect, it } from "vitest";
import { sampleThroughput, seriesOf } from "#components/metrics/ThroughputChart";
import { TOKEN_RATE_WINDOW_MS } from "#lib/metrics-aggregation";
import { CLAUDE_MODELS } from "#lib/models";
import type { TokenUsageRecord } from "#store/types";

const usage = (model: string, tokens: number, timestamp: number): TokenUsageRecord => ({
  model,
  inputTokens: tokens,
  outputTokens: 0,
  provider: "anthropic",
  costUsd: 0,
  timestamp,
});

describe("seriesOf", () => {
  it("gives every catalogued model its own family series", () => {
    for (const model of Object.values(CLAUDE_MODELS)) {
      expect(seriesOf(model.id)).not.toBe("other");
    }
    expect(seriesOf("claude-fable-5")).toBe("fable");
    expect(seriesOf("claude-mythos-5")).toBe("mythos");
  });

  it("resolves dated ids and aliases to their family", () => {
    expect(seriesOf("claude-sonnet-5-20260101")).toBe("sonnet");
    expect(seriesOf("Claude-Haiku-Latest")).toBe("haiku");
  });

  it("puts unknown models in 'other' instead of dropping them", () => {
    expect(seriesOf("some-future-model")).toBe("other");
  });
});

describe("sampleThroughput", () => {
  it("splits the trailing rate by series", () => {
    const now = 50_000;
    const perSecond = TOKEN_RATE_WINDOW_MS / 1000;
    const point = sampleThroughput(
      [usage("claude-fable-5", 100, now - 1), usage("mystery", 50, now - 1)],
      now,
    );
    expect(point).toMatchObject({ time: now, fable: 100 / perSecond, other: 50 / perSecond });
    expect(point.sonnet).toBe(0);
  });
});
