// ── useStream Hook ──────────────────────────────────
// Wraps the Anthropic async generator with React 19 patterns.
// Provides send/cancel, integrates with useAiStore queue.

import { startTransition, useEffect, useRef, useState } from "react";
import { truncateMessages, withRetry } from "#lib/ai-error";
import type { StreamParams } from "#lib/anthropic";
import { streamMessage } from "#lib/anthropic";
import { useAiStore } from "#store/ai";
import type { AiMessage } from "#store/types";

interface UseStreamReturn {
  /** All messages in the conversation. */
  readonly messages: AiMessage[];
  /** Whether a stream is currently active. */
  readonly isStreaming: boolean;
  /** Last error, if any. */
  readonly error: string | null;
  /** The content currently being streamed (incomplete). */
  readonly streamingContent: string;
  /** Send a user message and begin streaming the response. */
  readonly send: (content: string, params?: Partial<StreamParams>) => void;
  /** Cancel the active stream. */
  readonly cancel: () => void;
}

const MODEL_CONTEXT_LIMITS: Record<string, number> = {
  "claude-sonnet-4-20250514": 200_000,
  "claude-opus-4-0-20250514": 200_000,
  "claude-haiku-3-5-20241022": 200_000,
};

/**
 * Streaming hook for AI chat conversations.
 *
 * - Consumes the async generator from `streamMessage()`.
 * - AbortController threaded through for mid-stream cancellation.
 * - Integrates with useAiStore for queue management.
 * - Uses React 19 `startTransition` for non-urgent message list updates.
 */
export function useStream(
  workerId: string,
  defaultModel = "claude-sonnet-4-20250514",
): UseStreamReturn {
  const [messages, setMessages] = useState<AiMessage[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [streamingContent, setStreamingContent] = useState("");

  const abortRef = useRef<AbortController | null>(null);
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  const enqueue = useAiStore((s) => s.enqueue);
  const dequeue = useAiStore((s) => s.dequeue);

  const send = (content: string, params?: Partial<StreamParams>) => {
    const model = params?.model ?? defaultModel;
    const maxTokens = params?.maxTokens ?? 4096;
    const contextLimit = MODEL_CONTEXT_LIMITS[model] ?? 200_000;

    // Add user message
    const userMessage: AiMessage = {
      id: crypto.randomUUID(),
      role: "user",
      content,
      timestamp: new Date().toISOString(),
    };

    setMessages((prev) => [...prev, userMessage]);
    setError(null);
    setIsStreaming(true);
    setStreamingContent("");

    const controller = new AbortController();
    abortRef.current = controller;

    // Queue item for tracking
    const queueItemId = crypto.randomUUID();
    enqueue({
      id: queueItemId,
      priority: "normal",
      workerId,
      messages: [],
      status: "pending",
    });

    // Build message history for the API
    const apiMessages = [...messagesRef.current, userMessage].map((m) => ({
      role: m.role,
      content: m.content,
    }));

    // Truncate if needed
    const truncated = truncateMessages(apiMessages, contextLimit);

    const streamParams: StreamParams = {
      model,
      maxTokens,
      messages: truncated,
      system: params?.system,
      tools: params?.tools,
      temperature: params?.temperature,
    };

    // Use requestAnimationFrame-batched updates for streaming content
    let buffer = "";
    let rafId = 0;

    const flushBuffer = () => {
      if (buffer) {
        const current = buffer;
        buffer = "";
        setStreamingContent((prev) => prev + current);
      }
      rafId = 0;
    };

    void (async () => {
      try {
        await withRetry(
          async (signal) => {
            // Link abort signals
            controller.signal.addEventListener(
              "abort",
              () => {
                // Signal is already being used by withRetry
              },
              { once: true },
            );

            for await (const delta of streamMessage(streamParams, controller.signal)) {
              if (controller.signal.aborted || signal.aborted) break;

              if (delta.content) {
                buffer += delta.content;
                if (!rafId) {
                  rafId = requestAnimationFrame(flushBuffer);
                }
              }
            }
          },
          { signal: controller.signal },
        );

        // Flush any remaining buffer
        if (rafId) {
          cancelAnimationFrame(rafId);
        }
        flushBuffer();

        if (!controller.signal.aborted) {
          // Commit assistant message via startTransition (non-urgent)
          startTransition(() => {
            // We need the streaming content value, so use a callback
            setStreamingContent((finalContent) => {
              if (finalContent) {
                const assistantMessage: AiMessage = {
                  id: crypto.randomUUID(),
                  role: "assistant",
                  content: finalContent,
                  timestamp: new Date().toISOString(),
                };
                setMessages((prev) => [...prev, assistantMessage]);
              }
              return "";
            });
          });
        }
      } catch (err) {
        if (!controller.signal.aborted) {
          setError(err instanceof Error ? err.message : String(err));
        }
      } finally {
        if (rafId) cancelAnimationFrame(rafId);
        setIsStreaming(false);
        dequeue(queueItemId);
        abortRef.current = null;
      }
    })();
  };

  const cancel = () => {
    abortRef.current?.abort();
    setIsStreaming(false);

    // Commit any partial streaming content as a message
    setStreamingContent((partial) => {
      if (partial) {
        const partialMessage: AiMessage = {
          id: crypto.randomUUID(),
          role: "assistant",
          content: `${partial}\n\n[Cancelled]`,
          timestamp: new Date().toISOString(),
        };
        startTransition(() => {
          setMessages((prev) => [...prev, partialMessage]);
        });
      }
      return "";
    });
  };

  // Abort any active stream on unmount to prevent dangling state
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  return { messages, isStreaming, error, streamingContent, send, cancel };
}
