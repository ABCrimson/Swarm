// ── Context Window Management ───────────────────────
// Handles fitting conversation messages into a model's context window.
// Supports sliding-window, summarize, and truncate strategies.

import type { AiMessage } from "#store/types";

// ── Types ───────────────────────────────────────────

/** Strategy for managing messages that exceed the context window. */
export type ContextStrategy = "sliding-window" | "summarize" | "truncate";

/** Configuration for context window management. */
export interface ContextManagerConfig {
  /** The model's maximum context window size in tokens. */
  readonly maxTokens: number;
  /** Tokens to reserve for the model's response. */
  readonly reserveTokens: number;
  /** Strategy for handling overflow. */
  readonly strategy: ContextStrategy;
}

// ── Token Estimation ────────────────────────────────

/**
 * Estimates the token count for a text string.
 *
 * Uses the approximation of ~4 characters per token, which is a reasonable
 * heuristic for English text with the Claude and GPT tokenizers.
 *
 * @param text - The text to estimate tokens for.
 * @returns Estimated token count.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Estimates the total token count for an array of messages.
 *
 * Includes per-message overhead (~4 tokens for role/formatting).
 *
 * @param messages - Array of AI messages to estimate.
 * @returns Total estimated token count.
 */
export function estimateMessagesTokens(messages: ReadonlyArray<AiMessage>): number {
  return messages.reduce((sum, msg) => {
    const contentTokens = estimateTokens(msg.content);
    // Add overhead for role, formatting, and tool calls
    const toolCallTokens = msg.toolCalls
      ? msg.toolCalls.reduce(
          (tSum, tc) => tSum + estimateTokens(tc.name) + estimateTokens(JSON.stringify(tc.input)),
          0,
        )
      : 0;
    return sum + contentTokens + toolCallTokens + 4; // 4 tokens per-message overhead
  }, 0);
}

// ── Context Fitting ─────────────────────────────────

/**
 * Fits messages into the available context window using the configured strategy.
 *
 * The available budget is `maxTokens - reserveTokens`. Messages are trimmed
 * according to the chosen strategy:
 *
 * - **sliding-window**: Removes the oldest messages (preserving the first/system message).
 * - **summarize**: Condenses older messages into a single summary message.
 * - **truncate**: Hard-truncates from the beginning, keeping only recent messages.
 *
 * @param messages - The full conversation history.
 * @param config - Context window configuration.
 * @returns Messages that fit within the context budget.
 */
export function fitMessagesToContext(
  messages: AiMessage[],
  config: ContextManagerConfig,
): AiMessage[] {
  const budget = config.maxTokens - config.reserveTokens;
  const totalTokens = estimateMessagesTokens(messages);

  if (totalTokens <= budget) return messages;

  switch (config.strategy) {
    case "sliding-window":
      return applySlidingWindow(messages, budget);
    case "summarize":
      return applySummarize(messages, budget);
    case "truncate":
      return applyTruncate(messages, budget);
    default:
      return applySlidingWindow(messages, budget);
  }
}

// ── Strategies ──────────────────────────────────────

/**
 * Sliding window: removes oldest messages (after the first) until within budget.
 * Always preserves the first message and the most recent message.
 */
function applySlidingWindow(messages: AiMessage[], budget: number): AiMessage[] {
  if (messages.length <= 2) return messages;

  const result = [...messages];

  while (result.length > 2 && estimateMessagesTokens(result) > budget) {
    // Remove the second message (index 1), preserving first and last
    result.splice(1, 1);
  }

  return result;
}

/**
 * Summarize: condenses all but the most recent messages into a summary.
 * Keeps the last N messages that fit, plus a summary of the rest.
 */
function applySummarize(messages: AiMessage[], budget: number): AiMessage[] {
  if (messages.length <= 2) return messages;

  // Find how many recent messages fit in half the budget
  const recentBudget = Math.floor(budget * 0.7);
  let recentCount = 0;
  let recentTokens = 0;

  for (let i = messages.length - 1; i >= 0; i--) {
    const msgTokens = estimateTokens(messages[i].content) + 4;
    if (recentTokens + msgTokens > recentBudget) break;
    recentTokens += msgTokens;
    recentCount++;
  }

  // Ensure at least the last message is kept
  recentCount = Math.max(1, recentCount);

  const olderMessages = messages.slice(0, messages.length - recentCount);
  const recentMessages = messages.slice(messages.length - recentCount);

  if (olderMessages.length === 0) return recentMessages;

  const summary = summarizeMessages(olderMessages);
  return [summary, ...recentMessages];
}

/**
 * Truncate: hard cut from the beginning, keeping only messages that fit.
 * Starts from the most recent and works backwards.
 */
function applyTruncate(messages: AiMessage[], budget: number): AiMessage[] {
  const result: AiMessage[] = [];
  let tokenCount = 0;

  for (let i = messages.length - 1; i >= 0; i--) {
    const msgTokens = estimateTokens(messages[i].content) + 4;
    if (tokenCount + msgTokens > budget) break;
    tokenCount += msgTokens;
    result.unshift(messages[i]);
  }

  return result;
}

// ── Message Summarization ───────────────────────────

/**
 * Creates a condensed summary message from an array of messages.
 *
 * Produces a single assistant message that captures the key points
 * of the conversation. Used by the "summarize" context strategy.
 *
 * @param messages - Messages to summarize.
 * @returns A single {@link AiMessage} containing the summary.
 */
export function summarizeMessages(messages: ReadonlyArray<AiMessage>): AiMessage {
  const userMessages = messages.filter((m) => m.role === "user");
  const assistantMessages = messages.filter((m) => m.role === "assistant");
  const toolCallCount = messages.reduce((sum, m) => sum + (m.toolCalls?.length ?? 0), 0);

  const summaryParts: string[] = [`[Context Summary - ${messages.length} messages condensed]`];

  if (userMessages.length > 0) {
    const userTopics = userMessages
      .map((m) => {
        const preview = m.content.slice(0, 100);
        return preview.length < m.content.length ? `${preview}...` : preview;
      })
      .join("; ");
    summaryParts.push(`User discussed: ${userTopics}`);
  }

  if (assistantMessages.length > 0) {
    summaryParts.push(`Assistant provided ${assistantMessages.length} response(s).`);
  }

  if (toolCallCount > 0) {
    const toolNames = [
      ...new Set(messages.flatMap((m) => m.toolCalls?.map((tc) => tc.name) ?? [])),
    ];
    summaryParts.push(`Tools used: ${toolNames.join(", ")} (${toolCallCount} call(s))`);
  }

  return {
    id: crypto.randomUUID(),
    role: "assistant",
    content: summaryParts.join("\n"),
    timestamp: new Date().toISOString(),
  };
}
