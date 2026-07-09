// ── OpenAI Provider Stub ────────────────────────────
// Placeholder for OpenAI integration. Throws on use until configured.

import type { ModelInfo, ModelProvider, StreamDelta, StreamParams } from "#lib/providers/index";

// ── GPT Model Catalog ───────────────────────────────

const OPENAI_MODELS: ModelInfo[] = [
  {
    id: "gpt-4o",
    name: "GPT-4o",
    contextWindow: 128_000,
    inputCostPer1M: 2.5,
    outputCostPer1M: 10,
  },
  {
    id: "gpt-4o-mini",
    name: "GPT-4o Mini",
    contextWindow: 128_000,
    inputCostPer1M: 0.15,
    outputCostPer1M: 0.6,
  },
  {
    id: "o1",
    name: "o1",
    contextWindow: 200_000,
    inputCostPer1M: 15,
    outputCostPer1M: 60,
  },
  {
    id: "o1-mini",
    name: "o1 Mini",
    contextWindow: 128_000,
    inputCostPer1M: 3,
    outputCostPer1M: 12,
  },
  {
    id: "o3-mini",
    name: "o3 Mini",
    contextWindow: 200_000,
    inputCostPer1M: 1.1,
    outputCostPer1M: 4.4,
  },
];

// ── Provider Implementation ─────────────────────────

/**
 * Creates an async generator that immediately throws for unconfigured providers.
 *
 * @param message - The error message to throw.
 * @returns An async generator that throws on first iteration.
 */
function unconfiguredStream(message: string): AsyncGenerator<StreamDelta> {
  return {
    next: () => Promise.reject(new Error(message)),
    return: (v: StreamDelta) => Promise.resolve({ done: true as const, value: v }),
    throw: (e: unknown) => Promise.reject(e),
    [Symbol.asyncIterator]() {
      return this;
    },
    [Symbol.asyncDispose]() {
      return Promise.resolve();
    },
  };
}

/**
 * OpenAI provider stub.
 *
 * Model catalog is populated with real model info and pricing,
 * but `streamMessage()` throws until the provider is fully integrated.
 */
export const openaiProvider: ModelProvider = {
  id: "openai",
  name: "OpenAI",
  models: OPENAI_MODELS,

  streamMessage(_params: StreamParams): AsyncGenerator<StreamDelta> {
    return unconfiguredStream("OpenAI provider not yet configured");
  },

  estimateCost(inputTokens: number, outputTokens: number, model: string): number {
    const modelInfo = OPENAI_MODELS.find((m) => m.id === model);
    if (!modelInfo) return 0;
    return (
      (inputTokens / 1_000_000) * modelInfo.inputCostPer1M +
      (outputTokens / 1_000_000) * modelInfo.outputCostPer1M
    );
  },
};
