// ── AI Error Handling ───────────────────────────────
// Rate limiting, context overflow, network timeout, retries.

import { toast } from "sonner";

// ── Error Types ─────────────────────────────────────

/** Discriminated error categories for AI API failures. */
export type AiErrorKind =
  | "rate_limit"
  | "context_overflow"
  | "network_timeout"
  | "auth_invalid"
  | "api_error"
  | "unknown";

/** Structured AI error with classification, retryability, and optional backoff hint. */
export interface AiError {
  readonly kind: AiErrorKind;
  readonly message: string;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;
  readonly statusCode?: number;
}

// ── Error Classification ────────────────────────────

/**
 * Classifies an unknown error into a structured AiError.
 */
export function classifyError(error: unknown): AiError {
  if (error instanceof Error) {
    const msg = error.message.toLowerCase();

    // Authentication / invalid API key detection
    if (
      msg.includes("401") ||
      msg.includes("unauthorized") ||
      msg.includes("authentication") ||
      msg.includes("invalid api key") ||
      msg.includes("invalid x-api-key") ||
      msg.includes("api key not configured")
    ) {
      return {
        kind: "auth_invalid",
        message: "API key invalid or missing \u2014 update in Settings.",
        retryable: false,
        statusCode: 401,
      };
    }

    // Rate limit detection
    if (msg.includes("rate_limit") || msg.includes("429") || msg.includes("too many requests")) {
      return {
        kind: "rate_limit",
        message: "Rate limit exceeded. Retrying with backoff...",
        retryable: true,
        retryAfterMs: 1000,
        statusCode: 429,
      };
    }

    // Context overflow detection
    if (
      msg.includes("context") ||
      msg.includes("token") ||
      msg.includes("max_tokens") ||
      msg.includes("too long")
    ) {
      return {
        kind: "context_overflow",
        message: "Context window exceeded. Truncating oldest messages.",
        retryable: true,
      };
    }

    // Network timeout
    if (
      msg.includes("timeout") ||
      msg.includes("network") ||
      msg.includes("econnrefused") ||
      msg.includes("fetch failed")
    ) {
      return {
        kind: "network_timeout",
        message: "Network request timed out after 30s.",
        retryable: true,
        retryAfterMs: 2000,
      };
    }

    // Generic API error
    if (msg.includes("api") || msg.includes("500") || msg.includes("server")) {
      return {
        kind: "api_error",
        message: error.message,
        retryable: true,
        retryAfterMs: 1000,
      };
    }

    return {
      kind: "unknown",
      message: error.message,
      retryable: false,
    };
  }

  return {
    kind: "unknown",
    message: String(error),
    retryable: false,
  };
}

// ── Retry with Exponential Backoff ──────────────────

const MAX_RETRIES = 3;
const BACKOFF_BASE_MS = 1000;

/**
 * Executes an async function with exponential backoff retry.
 *
 * Backoff schedule: 1s, 2s, 4s (max 3 retries).
 * Shows a Sonner toast with countdown during each backoff wait.
 */
export async function withRetry<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  options?: {
    signal?: AbortSignal;
    onRetry?: (attempt: number, waitMs: number) => void;
  },
): Promise<T> {
  let lastError: AiError | null = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const controller = new AbortController();

      // Link to parent signal
      if (options?.signal) {
        if (options.signal.aborted) {
          throw new Error("Aborted");
        }
        options.signal.addEventListener("abort", () => controller.abort(), { once: true });
      }

      // 30s hard timeout
      const timeoutId = globalThis.setTimeout(() => controller.abort(), 30_000);
      try {
        const result = await fn(controller.signal);
        return result;
      } finally {
        globalThis.clearTimeout(timeoutId);
      }
    } catch (error) {
      lastError = classifyError(error);

      if (!lastError.retryable || attempt >= MAX_RETRIES) {
        break;
      }

      const waitMs = BACKOFF_BASE_MS * 2 ** attempt;
      options?.onRetry?.(attempt + 1, waitMs);

      // Show countdown toast
      showRetryToast(attempt + 1, waitMs);

      await sleep(waitMs, options?.signal);
    }
  }

  // All retries exhausted — show final error toast
  showErrorToast(lastError ?? { kind: "unknown", message: "Unknown error", retryable: false });

  throw new Error(lastError?.message ?? "AI request failed after retries");
}

// ── Context Truncation ──────────────────────────────

/** Rough token estimate: ~4 characters per token. */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Truncates the oldest messages to fit within a token budget.
 * Always preserves the system message and the most recent user message.
 */
export function truncateMessages(
  messages: Array<{ role: "user" | "assistant"; content: string }>,
  maxTokens: number,
): Array<{ role: "user" | "assistant"; content: string }> {
  if (messages.length === 0) return messages;

  let totalTokens = messages.reduce((sum, m) => sum + estimateTokens(m.content), 0);

  if (totalTokens <= maxTokens) return messages;

  // Always keep first and last message
  const result = [...messages];

  while (result.length > 2 && totalTokens > maxTokens) {
    const removed = result.splice(1, 1)[0];
    totalTokens -= estimateTokens(removed.content);
  }

  if (result.length < messages.length) {
    toast.info("Oldest messages truncated to fit context window", {
      description: `Removed ${messages.length - result.length} message(s)`,
    });
  }

  return result;
}

// ── Toast Helpers ───────────────────────────────────

function showRetryToast(attempt: number, waitMs: number): void {
  const seconds = Math.ceil(waitMs / 1000);
  toast.warning(`Retrying in ${seconds}s...`, {
    description: `Attempt ${attempt}/${MAX_RETRIES} — Rate limit backoff`,
    duration: waitMs + 500,
  });
}

function showErrorToast(error: AiError): void {
  const actions: Record<AiErrorKind, string> = {
    rate_limit: "Rate limit exhausted after 3 retries",
    context_overflow: "Context window overflow",
    network_timeout: "Network connection failed",
    auth_invalid: "API key invalid \u2014 update in Settings",
    api_error: "API error",
    unknown: "Unexpected error",
  };

  toast.error(actions[error.kind], {
    description: error.message,
    duration: 8000,
    action: error.retryable ? { label: "Retry", onClick: () => {} } : undefined,
  });
}

// ── Utilities ───────────────────────────────────────

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("Aborted"));
      return;
    }

    const id = globalThis.setTimeout(resolve, ms);

    signal?.addEventListener(
      "abort",
      () => {
        globalThis.clearTimeout(id);
        reject(new Error("Aborted"));
      },
      { once: true },
    );
  });
}
