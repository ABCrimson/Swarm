// ── Ollama Local Provider Stub ──────────────────────
// Placeholder for Ollama local model integration. Throws on use until connected.

import type { ModelInfo, ModelProvider, StreamDelta, StreamParams } from "#lib/providers/index";

// ── Local Model Catalog ─────────────────────────────

const OLLAMA_MODELS: ModelInfo[] = [
  {
    id: "llama3.3:70b",
    name: "Llama 3.3 70B",
    contextWindow: 128_000,
    inputCostPer1M: 0,
    outputCostPer1M: 0,
  },
  {
    id: "llama3.2:8b",
    name: "Llama 3.2 8B",
    contextWindow: 128_000,
    inputCostPer1M: 0,
    outputCostPer1M: 0,
  },
  {
    id: "codellama:34b",
    name: "Code Llama 34B",
    contextWindow: 16_000,
    inputCostPer1M: 0,
    outputCostPer1M: 0,
  },
  {
    id: "mistral:7b",
    name: "Mistral 7B",
    contextWindow: 32_000,
    inputCostPer1M: 0,
    outputCostPer1M: 0,
  },
  {
    id: "deepseek-coder:33b",
    name: "DeepSeek Coder 33B",
    contextWindow: 16_000,
    inputCostPer1M: 0,
    outputCostPer1M: 0,
  },
];

// ── Provider Implementation ─────────────────────────

/**
 * Creates an async generator that immediately throws for disconnected providers.
 *
 * @param message - The error message to throw.
 * @returns An async generator that throws on first iteration.
 */
function disconnectedStream(message: string): AsyncGenerator<StreamDelta> {
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
 * Ollama local provider stub.
 *
 * Model catalog is populated with common local models (all free),
 * but `streamMessage()` throws until Ollama is connected on `localhost:11434`.
 */
export const ollamaProvider: ModelProvider = {
  id: "ollama",
  name: "Ollama (Local)",
  models: OLLAMA_MODELS,

  streamMessage(_params: StreamParams): AsyncGenerator<StreamDelta> {
    return disconnectedStream("Ollama not connected");
  },

  estimateCost(_inputTokens: number, _outputTokens: number, _model: string): number {
    // Local models are free
    return 0;
  },
};
