import { toast } from "sonner";
import { describe, expect, it, vi } from "vitest";
import {
  CLAUDE_MODELS,
  estimateCostUsd,
  formatContextLabel,
  formatMaxOutputLabel,
  getModelById,
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
      "claude-sonnet-5",
      "claude-haiku-4-5",
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
      ["haiku", 1, 5],
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
      estimateCostUsd("claude-sonnet-5", {
        input_tokens: 500_000,
        output_tokens: 100_000,
        cache_creation_input_tokens: null,
        cache_read_input_tokens: null,
      }),
    ).toBeCloseTo(2, 10);
    expect(estimateCostUsd("claude-unknown", { input_tokens: 1, output_tokens: 1 })).toBe(0);
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
