// ── Real Token Cost Tracking ────────────────────────
// Tracks token usage and costs per model across providers.

// ── Types ───────────────────────────────────────────

/** A single token usage record with cost and provenance. */
export interface TokenUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly model: string;
  readonly provider: string;
  readonly costUsd: number;
  readonly timestamp: number;
}

// ── Model Pricing (March 2026) ──────────────────────

/** Cost per 1M tokens in USD, keyed by model identifier. */
const MODEL_PRICING: Record<string, { readonly input: number; readonly output: number }> = {
  // Anthropic Claude
  "claude-opus-4-20250514": { input: 15, output: 75 },
  "claude-sonnet-4-20250514": { input: 3, output: 15 },
  "claude-haiku-3-5-20241022": { input: 0.8, output: 4 },

  // OpenAI
  "gpt-4o": { input: 2.5, output: 10 },
  "gpt-4o-mini": { input: 0.15, output: 0.6 },
  o1: { input: 15, output: 60 },
  "o1-mini": { input: 3, output: 12 },
  "o3-mini": { input: 1.1, output: 4.4 },

  // Ollama local models (free)
  "llama3.3:70b": { input: 0, output: 0 },
  "llama3.2:8b": { input: 0, output: 0 },
  "codellama:34b": { input: 0, output: 0 },
  "mistral:7b": { input: 0, output: 0 },
  "deepseek-coder:33b": { input: 0, output: 0 },
};

// ── Cost Calculation ────────────────────────────────

/**
 * Calculates the USD cost for a given token usage based on the model's pricing.
 *
 * Returns 0 for unknown models (e.g. local/free models not in the pricing table).
 *
 * @param usage - Token counts and model/provider identifiers.
 * @returns Cost in USD.
 */
export function calculateCost(usage: Omit<TokenUsage, "costUsd" | "timestamp">): number {
  const pricing = MODEL_PRICING[usage.model];
  if (!pricing) return 0;
  return (
    (usage.inputTokens / 1_000_000) * pricing.input +
    (usage.outputTokens / 1_000_000) * pricing.output
  );
}

/**
 * Formats a USD cost for display, using appropriate precision.
 *
 * - Costs below $0.01 show 4 decimal places (e.g. "$0.0023").
 * - Costs $0.01 or above show 2 decimal places (e.g. "$1.50").
 * - Zero cost displays as "$0.00".
 *
 * @param usd - The cost in USD.
 * @returns Formatted cost string with dollar sign.
 */
export function formatCost(usd: number): string {
  if (usd === 0) return "$0.00";
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

/**
 * Creates a complete {@link TokenUsage} record with calculated cost and timestamp.
 *
 * @param inputTokens - Number of input tokens consumed.
 * @param outputTokens - Number of output tokens generated.
 * @param model - The model identifier used.
 * @param provider - The provider identifier.
 * @returns A complete token usage record.
 */
export function createTokenUsage(
  inputTokens: number,
  outputTokens: number,
  model: string,
  provider: string,
): TokenUsage {
  const costUsd = calculateCost({ inputTokens, outputTokens, model, provider });
  return {
    inputTokens,
    outputTokens,
    model,
    provider,
    costUsd,
    timestamp: Date.now(),
  };
}
