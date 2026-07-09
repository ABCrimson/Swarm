// ── Multi-Provider Interface ────────────────────────
// Defines the contract for AI model providers in the SWARM system.
// Each provider implements streaming, model info, and cost estimation.

import type { Tool } from "@anthropic-ai/sdk/resources/messages/messages";

// ── Stream Types ────────────────────────────────────

/** A streaming delta emitted by a model provider during message generation. */
export interface StreamDelta {
  /** The event type from the provider's stream protocol. */
  readonly type: string;
  /** Text content delta for text_delta events. */
  readonly content: string;
  /** Present when the delta represents a tool_use content block. */
  readonly toolUse?: {
    readonly toolName: string;
    readonly partialInput: string;
    readonly complete: boolean;
  };
}

/** Parameters for initiating a streaming message request. */
export interface StreamParams {
  readonly model: string;
  readonly maxTokens: number;
  readonly messages: ReadonlyArray<{
    readonly role: "user" | "assistant";
    readonly content: string | ReadonlyArray<ContentBlock>;
  }>;
  readonly system?: string;
  readonly tools?: Tool[];
  readonly temperature?: number;
  readonly signal?: AbortSignal;
}

/** A content block within a message (text or tool result). */
export interface ContentBlock {
  readonly type: string;
  readonly [key: string]: unknown;
}

/** Token usage information returned after a complete response. */
export interface TokenUsageInfo {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

// ── Model Info ──────────────────────────────────────

/** Static metadata about a model offered by a provider. */
export interface ModelInfo {
  /** The model identifier used in API requests (e.g. "claude-sonnet-4-20250514"). */
  readonly id: string;
  /** Human-readable display name. */
  readonly name: string;
  /** Maximum context window size in tokens. */
  readonly contextWindow: number;
  /** Cost per 1 million input tokens in USD. */
  readonly inputCostPer1M: number;
  /** Cost per 1 million output tokens in USD. */
  readonly outputCostPer1M: number;
}

// ── Provider Interface ──────────────────────────────

/** Contract for an AI model provider (Anthropic, OpenAI, Ollama, etc.). */
export interface ModelProvider {
  /** Unique provider identifier (e.g. "anthropic", "openai"). */
  readonly id: string;
  /** Human-readable provider name. */
  readonly name: string;
  /** Available models from this provider. */
  readonly models: ModelInfo[];
  /**
   * Streams a message response from the provider's API.
   *
   * Yields {@link StreamDelta} objects as the model generates content,
   * including text deltas and structured tool_use deltas.
   *
   * @param params - Request parameters including model, messages, and tools.
   * @returns Async generator of streaming deltas.
   */
  streamMessage(params: StreamParams): AsyncGenerator<StreamDelta>;
  /**
   * Estimates the cost in USD for a given token usage on a specific model.
   *
   * @param inputTokens - Number of input tokens consumed.
   * @param outputTokens - Number of output tokens generated.
   * @param model - The model identifier used.
   * @returns Estimated cost in USD.
   */
  estimateCost(inputTokens: number, outputTokens: number, model: string): number;
}

// ── Provider Registry ───────────────────────────────

const providers = new Map<string, ModelProvider>();

/**
 * Registers a provider in the global provider registry.
 *
 * @param provider - The provider instance to register.
 */
export function registerProvider(provider: ModelProvider): void {
  providers.set(provider.id, provider);
}

/**
 * Retrieves a registered provider by its identifier.
 *
 * @param id - The provider identifier.
 * @returns The provider instance, or undefined if not registered.
 */
export function getProvider(id: string): ModelProvider | undefined {
  return providers.get(id);
}

/**
 * Returns all registered providers.
 *
 * @returns Array of all registered {@link ModelProvider} instances.
 */
export function getAllProviders(): ModelProvider[] {
  return [...providers.values()];
}
