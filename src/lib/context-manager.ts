/**
 * Keeps a chat transcript inside a model's context window without
 * breaking the rules the Messages API puts on replayed history.
 *
 * Token counts here are a deliberately conservative local estimate —
 * ~3 characters per token, since the tokenizers of Opus 4.7+, Fable,
 * Sonnet 5.5 and Haiku 5.5 produce up to ~1.35x more tokens than the old ~4-chars rule —
 * so trimming happens early rather than a request overflowing. It only
 * matters near the limit: every current model has a 1M window
 * (platform.claude.com models overview, 2026-10-10).
 *
 * @module context-manager
 */

import type { ChatMessageParam } from "#lib/anthropic";
import { withoutThinking } from "#lib/anthropic";

/** Characters per token assumed by {@link estimateTokens}. */
const CHARS_PER_TOKEN = 3;

/** Conservatively estimates the tokens in a string. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/** Estimates the tokens one message contributes (its serialized form, framing included). */
export function estimateMessageTokens(message: ChatMessageParam): number {
  return estimateTokens(JSON.stringify(message));
}

/** Whether a message opens a new exchange: a user message that is not a `tool_result` reply. */
function startsExchange(message: ChatMessageParam): boolean {
  if (message.role !== "user") return false;
  return (
    typeof message.content === "string" ||
    !message.content.some((block) => block.type === "tool_result")
  );
}

/** Strips `thinking`/`redacted_thinking` blocks from every message, dropping messages left empty. */
export function stripThinking(transcript: readonly ChatMessageParam[]): ChatMessageParam[] {
  return transcript.flatMap((message) => {
    const content = withoutThinking(message.content);
    return content.length === 0 ? [] : [{ ...message, content }];
  });
}

/** The result of {@link fitTranscript}. */
export interface FittedTranscript {
  readonly messages: ChatMessageParam[];
  /** How many leading exchanges were dropped to fit. */
  readonly droppedExchanges: number;
}

/**
 * Drops whole exchanges from the front of `transcript` until it fits in
 * `budgetTokens`, always keeping the newest exchange.
 *
 * Whole exchanges (a user message through everything that answered it)
 * keep every `tool_use` paired with its `tool_result` and the first
 * message a user turn. Removing earlier turns while keeping later ones
 * invalidates the later turns' thinking blocks (their signatures are
 * bound to the full prefix they were produced after), so when anything
 * is dropped the retained history is replayed without thinking blocks —
 * the documented recovery for keep-tail trimming.
 */
export function fitTranscript(
  transcript: readonly ChatMessageParam[],
  budgetTokens: number,
): FittedTranscript {
  let total = transcript.reduce((sum, message) => sum + estimateMessageTokens(message), 0);
  if (total <= budgetTokens) return { messages: [...transcript], droppedExchanges: 0 };

  const starts = transcript.flatMap((message, index) => (startsExchange(message) ? [index] : []));
  let cut = 0;
  let dropped = 0;
  for (const [i, start] of starts.entries()) {
    if (i === starts.length - 1 || total <= budgetTokens) break;
    const next = starts[i + 1] ?? transcript.length;
    for (const message of transcript.slice(start, next)) total -= estimateMessageTokens(message);
    cut = next;
    dropped++;
  }
  return dropped === 0
    ? { messages: [...transcript], droppedExchanges: 0 }
    : { messages: stripThinking(transcript.slice(cut)), droppedExchanges: dropped };
}
