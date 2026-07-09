// ── Anthropic Provider ──────────────────────────────
// Wraps the existing streamMessage() into the ModelProvider interface.
// Provides Claude model info with real pricing (March 2026).

import { streamMessage as rawStreamMessage, resetClient } from "#lib/anthropic";
import type { ModelInfo, ModelProvider, StreamDelta, StreamParams } from "#lib/providers/index";

// ── Claude Model Catalog ────────────────────────────

const CLAUDE_MODELS: ModelInfo[] = [
  {
    id: "claude-opus-4-20250514",
    name: "Claude Opus 4",
    contextWindow: 200_000,
    inputCostPer1M: 15,
    outputCostPer1M: 75,
  },
  {
    id: "claude-sonnet-4-20250514",
    name: "Claude Sonnet 4",
    contextWindow: 200_000,
    inputCostPer1M: 3,
    outputCostPer1M: 15,
  },
  {
    id: "claude-haiku-3-5-20241022",
    name: "Claude 3.5 Haiku",
    contextWindow: 200_000,
    inputCostPer1M: 0.8,
    outputCostPer1M: 4,
  },
];

// ── Provider Implementation ─────────────────────────

/**
 * Anthropic provider implementation wrapping the Claude API.
 *
 * Delegates to the existing `streamMessage()` function in `#lib/anthropic`,
 * which already handles structured tool_use delta parsing (content_block_start,
 * input_json_delta accumulation, and content_block_stop finalization).
 */
export const anthropicProvider: ModelProvider = {
  id: "anthropic",
  name: "Anthropic",
  models: CLAUDE_MODELS,

  async *streamMessage(params: StreamParams): AsyncGenerator<StreamDelta> {
    // Map provider StreamParams to the legacy format expected by rawStreamMessage
    const legacyParams = {
      model: params.model,
      maxTokens: params.maxTokens,
      messages: params.messages.map((m) => ({
        role: m.role,
        content: typeof m.content === "string" ? m.content : JSON.stringify(m.content),
      })),
      system: params.system,
      tools: params.tools,
      temperature: params.temperature,
    };

    // Delegate to the core Anthropic streamMessage which handles all event types
    // including tool_use content blocks with streaming partial JSON
    for await (const delta of rawStreamMessage(legacyParams, params.signal)) {
      yield {
        type: delta.type,
        content: delta.content,
        ...(delta.toolUse ? { toolUse: delta.toolUse } : {}),
      };
    }
  },

  estimateCost(inputTokens: number, outputTokens: number, model: string): number {
    const modelInfo = CLAUDE_MODELS.find((m) => m.id === model);
    if (!modelInfo) return 0;
    return (
      (inputTokens / 1_000_000) * modelInfo.inputCostPer1M +
      (outputTokens / 1_000_000) * modelInfo.outputCostPer1M
    );
  },
};

/**
 * Resets the underlying Anthropic client (useful for re-authentication).
 */
export function resetAnthropicProvider(): void {
  resetClient();
}
