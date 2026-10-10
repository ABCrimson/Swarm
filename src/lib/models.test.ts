import { toast } from "sonner";
import { describe, expect, it, vi } from "vitest";
import {
  CLAUDE_MODELS,
  estimateCostUsd,
  formatContextLabel,
  formatMaxOutputLabel,
  getModelById,
  hasPricing,
  MODEL_KEYS,
  warnIfModelGated,
} from "#lib/models";

describe("model catalog", () => {
  it("keeps the persisted keys stable and points each at the current model", () => {
    expect(MODEL_KEYS).toEqual(["fable", "mythos", "opus", "sonnet", "haiku"]);
    expect(MODEL_KEYS.map((key) => CLAUDE_MODELS[key].id)).toEqual([
      "claude-fable-5-1",
      "claude-mythos-5-1",
      "claude-opus-5-5",
      "claude-sonnet-5-5",
      "claude-haiku-5-5",
    ]);
  });

  it("carries the current per-MTok prices", () => {
    expect(
      MODEL_KEYS.map((key) => [
        key,
        CLAUDE_MODELS[key].inputPerMTok,
        CLAUDE_MODELS[key].outputPerMTok,
      ]),
    ).toEqual([
      ["fable", 10, 50],
      ["mythos", 10, 50],
      ["opus", 4, 20],
      ["sonnet", 2, 10],
      ["haiku", 0.1, 0.5],
    ]);
  });

  it("gates only Mythos behind Project Glasswing", () => {
    expect(MODEL_KEYS.filter((key) => CLAUDE_MODELS[key].gated === "glasswing")).toEqual([
      "mythos",
    ]);
  });

  it("looks models up by API id", () => {
    expect(getModelById("claude-opus-5-5")).toBe(CLAUDE_MODELS.opus);
    expect(getModelById("claude-opus-4-8")).toBeUndefined();
  });
});

describe("estimateCostUsd", () => {
  it("prices uncached input, cache writes, cache reads and output at the model's rates", () => {
    const cost = estimateCostUsd("claude-opus-5-5", {
      input_tokens: 1_000_000,
      cache_creation_input_tokens: 1_000_000,
      cache_read_input_tokens: 1_000_000,
      output_tokens: 1_000_000,
    });
    // $4 input + $5 cache write (1.25x) + $0.20 cache read + $20 output.
    expect(cost).toBeCloseTo(29.2, 10);
  });

  it("treats absent cache fields as zero and unknown models as free rather than guessing", () => {
    expect(
      estimateCostUsd("claude-sonnet-5-5", {
        input_tokens: 500_000,
        output_tokens: 100_000,
        cache_creation_input_tokens: null,
        cache_read_input_tokens: null,
      }),
    ).toBeCloseTo(2, 10);
    expect(estimateCostUsd("claude-unknown", { input_tokens: 1, output_tokens: 1 })).toBe(0);
  });
});

describe("fallback-target pricing", () => {
  it("prices claude-sonnet-5, Sonnet 5.5's fallback target, without listing it in the catalog", () => {
    expect(hasPricing("claude-sonnet-5")).toBe(true);
    expect(getModelById("claude-sonnet-5")).toBeUndefined();
    expect(
      estimateCostUsd("claude-sonnet-5", {
        input_tokens: 0,
        output_tokens: 0,
        cache_read_input_tokens: 1_000_000,
      }),
    ).toBeCloseTo(0.2, 10);
  });
});

describe("Haiku 5.5 long-prompt tier", () => {
  const HAIKU = "claude-haiku-5-5";

  it("prices a prompt at or under 100k tokens at the base rates", () => {
    const cost = estimateCostUsd(HAIKU, {
      input_tokens: 100_000,
      output_tokens: 1_000_000,
    });
    // $0.10 * 0.1M input + $0.50 * 1M output.
    expect(cost).toBeCloseTo(0.01 + 0.5, 10);
  });

  it("counts cache reads toward the threshold: 90k read + 20k fresh prices at the >100k rates", () => {
    const cost = estimateCostUsd(HAIKU, {
      input_tokens: 20_000,
      cache_read_input_tokens: 90_000,
      output_tokens: 10_000,
    });
    // $0.50 * 0.02M + $0.05 * 0.09M + $2.50 * 0.01M.
    expect(cost).toBeCloseTo(0.01 + 0.0045 + 0.025, 10);
  });

  it("counts cache writes toward the threshold and bills them at 1.25x the long input rate", () => {
    const cost = estimateCostUsd(HAIKU, {
      input_tokens: 1,
      cache_creation_input_tokens: 100_000,
      output_tokens: 0,
    });
    // 100,001 prompt tokens: $0.50 * 1e-6 + $0.625 * 0.1M.
    expect(cost).toBeCloseTo(0.0000005 + 0.0625, 10);
  });

  it("leaves models without a tier flat at any prompt length", () => {
    const cost = estimateCostUsd("claude-sonnet-5-5", {
      input_tokens: 900_000,
      cache_read_input_tokens: 90_000,
      output_tokens: 0,
    });
    // $2 * 0.9M + $0.10 * 0.09M.
    expect(cost).toBeCloseTo(1.8 + 0.009, 10);
  });
});

describe("labels and gating", () => {
  it("formats compact Title Case limit labels", () => {
    expect(formatContextLabel(1_000_000)).toBe("1M Context");
    expect(formatContextLabel(200_000)).toBe("200K Context");
    expect(formatMaxOutputLabel(128_000)).toBe("128K Max Output");
  });

  it("warns once for a gated model and stays silent otherwise", () => {
    vi.mocked(toast.warning).mockClear();

    expect(warnIfModelGated(CLAUDE_MODELS.mythos)).toBe(true);
    expect(warnIfModelGated(CLAUDE_MODELS.sonnet)).toBe(false);

    expect(toast.warning).toHaveBeenCalledExactlyOnceWith(
      "Claude Mythos 5.1 Requires Project Glasswing Access",
    );
  });
});
