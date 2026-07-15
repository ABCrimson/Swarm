// ── AIChat ──────────────────────────────────────────
// Full chat interface for a worker.
// Message input at bottom, messages scroll up.
// User messages right-aligned, AI messages left-aligned.
// Glass-panel OKLCH backgrounds, Suspense boundary.

import { useAtom } from "jotai";
import type { CSSProperties, FormEvent } from "react";
import { Suspense, startTransition, useEffect, useRef, useState } from "react";
import { Spinner } from "#components/ui/Spinner";
import { useAiStream } from "#hooks/useAiStream";
import { truncateMessages } from "#lib/ai-error";
import type { StreamParams } from "#lib/anthropic";
import { CLAUDE_MODELS, getContextWindow } from "#lib/models";
import { executeTool, getAllAnthropicTools } from "#lib/tools";
import { useAiStore } from "#store/ai";
import type { AiMessage } from "#store/types";
import { selectedModelAtom } from "#store/ui";
import { AIMessageStream } from "./AIMessageStream.tsx";
import { ToolCallDisplay } from "./ToolCallDisplay.tsx";

interface AIChatProps {
  /** Worker ID this chat is attached to. */
  readonly workerId: string;
  /**
   * An instruction to inject into the conversation, e.g. from
   * WorkerAIPanel's "Inject Instruction" modal. Give each injection a
   * fresh `id` (even for repeated identical text) so the effect below
   * fires exactly once per injection.
   */
  readonly injectedInstruction?: { readonly id: string; readonly content: string } | null;
}

// ── Streaming tool-call tracking ─────────────────────

interface LiveToolCall {
  readonly id: string;
  readonly name: string;
  readonly input: Record<string, unknown>;
  readonly status: "executing" | "complete" | "error";
  readonly result?: string;
}

// ── Styles (OKLCH) ──────────────────────────────────

const chatContainerStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  height: "100%",
  background: "oklch(0.08 0.02 220)",
  overflow: "hidden",
};

const messagesAreaStyle: CSSProperties = {
  flex: 1,
  overflowY: "auto",
  padding: "16px",
  display: "flex",
  flexDirection: "column",
  gap: 12,
  scrollbarWidth: "thin",
  scrollbarColor: "oklch(0.28 0.05 220) oklch(0 0 0 / 0)",
};

const inputAreaStyle: CSSProperties = {
  display: "flex",
  gap: 8,
  padding: "12px 16px",
  borderTop: "1px solid oklch(0.22 0.04 220)",
  background: "oklch(0.10 0.02 220 / 0.9)",
  backdropFilter: "blur(8px)",
};

const textareaStyle: CSSProperties = {
  flex: 1,
  padding: "10px 14px",
  borderRadius: 8,
  border: "1px solid oklch(0.28 0.05 220)",
  background: "oklch(0.12 0.03 220)",
  color: "oklch(0.88 0.03 220)",
  fontFamily: "var(--font-body, 'DM Sans Variable', system-ui, sans-serif)",
  fontSize: 14,
  lineHeight: 1.5,
  resize: "none",
  outline: "none",
  minHeight: 42,
  maxHeight: 160,
  transition: "border-color 0.15s ease",
};

const sendButtonStyle: CSSProperties = {
  padding: "10px 20px",
  borderRadius: 8,
  border: "none",
  background: "oklch(0.78 0.18 205)",
  color: "oklch(0.10 0.03 205)",
  fontWeight: 600,
  fontSize: 14,
  cursor: "pointer",
  transition: "background 0.15s ease, opacity 0.15s ease",
  alignSelf: "flex-end",
};

const userBubbleStyle: CSSProperties = {
  alignSelf: "flex-end",
  maxWidth: "75%",
  padding: "10px 14px",
  borderRadius: "12px 12px 4px 12px",
  background: "oklch(0.78 0.18 205 / 0.15)",
  border: "1px solid oklch(0.78 0.18 205 / 0.3)",
  color: "oklch(0.88 0.03 220)",
  fontSize: 14,
  lineHeight: 1.6,
  whiteSpace: "pre-wrap",
  wordBreak: "break-word",
};

const assistantBubbleStyle: CSSProperties = {
  alignSelf: "flex-start",
  maxWidth: "85%",
  display: "flex",
  flexDirection: "column",
  gap: 4,
};

const timestampStyle: CSSProperties = {
  fontSize: 11,
  color: "oklch(0.55 0.03 220)",
  marginTop: 4,
};

const emptyStateStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  justifyContent: "center",
  flex: 1,
  gap: 8,
  color: "oklch(0.55 0.06 205)",
  fontSize: 14,
};

const loadingFallbackStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  height: "100%",
  background: "oklch(0.08 0.02 220)",
};

// ── Message Bubble ──────────────────────────────────

function MessageBubble({ message }: { message: AiMessage }): React.ReactElement {
  const time = new Date(message.timestamp).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });

  if (message.role === "user") {
    return (
      <div style={userBubbleStyle}>
        <div>{message.content}</div>
        <div style={{ ...timestampStyle, textAlign: "right" }}>{time}</div>
      </div>
    );
  }

  return (
    <div style={assistantBubbleStyle}>
      {message.content && <AIMessageStream content={message.content} isStreaming={false} />}
      {message.toolCalls?.map((tc) => (
        <ToolCallDisplay
          key={tc.id ?? `${message.id}-tool-${tc.name}-${JSON.stringify(tc.input)}`}
          name={tc.name}
          input={tc.input}
          result={tc.result}
          status={tc.result !== undefined ? "complete" : "executing"}
        />
      ))}
      <div style={timestampStyle}>{time}</div>
    </div>
  );
}

// ── Chat Content ────────────────────────────────────

function AIChatContent({ workerId, injectedInstruction }: AIChatProps): React.ReactElement {
  const [selectedModel] = useAtom(selectedModelAtom);
  // The shared catalog (#lib/models) is the single source of truth for
  // model IDs — `selectedModel` (a ModelKey) indexes it directly.
  const modelId = CLAUDE_MODELS[selectedModel].id;
  const { startStream, cancelStream, atLimit } = useAiStream();
  const enqueue = useAiStore((s) => s.enqueue);
  const dequeue = useAiStore((s) => s.dequeue);

  const [messages, setMessages] = useState<AiMessage[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [streamingContent, setStreamingContent] = useState("");
  const [liveToolCalls, setLiveToolCalls] = useState<LiveToolCall[]>([]);

  const [inputValue, setInputValue] = useState("");
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  const activeItemIdRef = useRef<string | null>(null);
  const finishedToolCallsRef = useRef<AiMessage["toolCalls"]>([]);
  const lastInjectionIdRef = useRef<string | undefined>(undefined);

  // Latest-ref pattern: lets the injection effect below call the current
  // `doSend` without listing it as a dependency (it is a plain function
  // re-created every render, not memoized — house rules disallow useCallback).
  const doSendRef = useRef<(content: string) => void>(() => {});

  const doSend = (content: string) => {
    const trimmed = content.trim();
    if (!trimmed || isStreaming) return;

    const userMessage: AiMessage = {
      id: crypto.randomUUID(),
      role: "user",
      content: trimmed,
      timestamp: new Date().toISOString(),
    };

    setMessages((prev) => [...prev, userMessage]);
    setError(null);
    setIsStreaming(true);
    setStreamingContent("");
    setLiveToolCalls([]);
    finishedToolCallsRef.current = [];

    const itemId = crypto.randomUUID();
    activeItemIdRef.current = itemId;
    enqueue({
      id: itemId,
      priority: "normal",
      workerId,
      messages: [],
      status: "pending",
    });

    const apiMessages = [...messagesRef.current, userMessage].map((m) => ({
      role: m.role,
      content: m.content,
    }));
    const truncated = truncateMessages(apiMessages, getContextWindow(modelId));

    let buffer = "";
    let rafId = 0;
    const flushBuffer = () => {
      if (buffer) {
        const chunk = buffer;
        buffer = "";
        setStreamingContent((prev) => prev + chunk);
      }
      rafId = 0;
    };

    void (async () => {
      // Agentic tool loop: stream → execute any tool calls (built-ins via
      // the registry, custom tools in their sandbox) → report tool_result
      // blocks back to the model → stream again, until the model answers
      // without tools or the round cap is hit. The cap bounds runaway
      // tool chains; the final round's calls still execute and display,
      // the model just doesn't get to react to them.
      const MAX_TOOL_ROUNDS = 4;

      try {
        const tools = getAllAnthropicTools();
        let convo: StreamParams["messages"] = truncated;
        let allText = "";

        for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
          const roundCalls: { id: string; name: string; input: Record<string, unknown> }[] = [];

          const roundText = await startStream(
            itemId,
            { model: modelId, maxTokens: 4096, messages: convo, tools },
            (delta) => {
              if (delta.toolUse) {
                const toolUse = delta.toolUse;
                if (!toolUse.complete) {
                  setLiveToolCalls((prev) =>
                    prev.some((tc) => tc.id === toolUse.id)
                      ? prev
                      : [
                          ...prev,
                          {
                            id: toolUse.id,
                            name: toolUse.toolName,
                            input: {},
                            status: "executing",
                          },
                        ],
                  );
                  return;
                }

                let parsedInput: Record<string, unknown> = {};
                try {
                  parsedInput = toolUse.partialInput
                    ? (JSON.parse(toolUse.partialInput) as Record<string, unknown>)
                    : {};
                } catch {
                  // Malformed partial JSON — display an empty input rather than crash.
                }

                roundCalls.push({ id: toolUse.id, name: toolUse.toolName, input: parsedInput });
                finishedToolCallsRef.current = [
                  ...(finishedToolCallsRef.current ?? []),
                  { id: toolUse.id, name: toolUse.toolName, input: parsedInput },
                ];
                setLiveToolCalls((prev) =>
                  prev.map((tc) => (tc.id === toolUse.id ? { ...tc, input: parsedInput } : tc)),
                );
                return;
              }

              if (delta.content) {
                buffer += delta.content;
                if (!rafId) {
                  rafId = requestAnimationFrame(flushBuffer);
                }
              }
            },
          );
          allText += allText && roundText ? `\n\n${roundText}` : roundText;

          if (roundCalls.length === 0) break;

          // Cancelled mid-round (cancelStream marks the queue item as
          // error immediately): don't execute the calls or keep looping.
          if (useAiStore.getState().queue.find((q) => q.id === itemId)?.status === "error") {
            break;
          }

          const results: { call: (typeof roundCalls)[number]; ok: boolean; text: string }[] = [];
          for (const call of roundCalls) {
            const result = await executeTool(call.name, call.input);
            const text = result.success
              ? JSON.stringify(result.data ?? null)
              : (result.error ?? "Unknown Error");
            results.push({ call, ok: result.success, text });

            finishedToolCallsRef.current = (finishedToolCallsRef.current ?? []).map((tc) =>
              tc.id === call.id ? { ...tc, result: text } : tc,
            );
            setLiveToolCalls((prev) =>
              prev.map((tc) =>
                tc.id === call.id
                  ? { ...tc, status: result.success ? "complete" : "error", result: text }
                  : tc,
              ),
            );
          }

          if (round === MAX_TOOL_ROUNDS) break;

          convo = [
            ...convo,
            {
              role: "assistant",
              content: [
                ...(roundText ? [{ type: "text" as const, text: roundText }] : []),
                ...roundCalls.map((c) => ({
                  type: "tool_use" as const,
                  id: c.id,
                  name: c.name,
                  input: c.input,
                })),
              ],
            },
            {
              role: "user",
              content: results.map((r) => ({
                type: "tool_result" as const,
                tool_use_id: r.call.id,
                content: r.text,
                is_error: !r.ok,
              })),
            },
          ];

          // Visual separation before the next round's streamed text.
          if (roundText) buffer += "\n\n";
        }

        if (rafId) cancelAnimationFrame(rafId);
        flushBuffer();

        startTransition(() => {
          setStreamingContent((finalContent) => {
            if (finalContent || finishedToolCallsRef.current?.length) {
              const assistantMessage: AiMessage = {
                id: crypto.randomUUID(),
                role: "assistant",
                content: finalContent || allText,
                timestamp: new Date().toISOString(),
                toolCalls: finishedToolCallsRef.current?.length
                  ? finishedToolCallsRef.current
                  : undefined,
              };
              setMessages((prev) => [...prev, assistantMessage]);
            }
            return "";
          });
          setLiveToolCalls([]);
        });
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (rafId) cancelAnimationFrame(rafId);
        setIsStreaming(false);
        dequeue(itemId);
        activeItemIdRef.current = null;
      }
    })();
  };
  doSendRef.current = doSend;

  // Fire an injected instruction exactly once per unique injection id.
  useEffect(() => {
    if (!injectedInstruction || injectedInstruction.id === lastInjectionIdRef.current) return;
    lastInjectionIdRef.current = injectedInstruction.id;
    doSendRef.current(injectedInstruction.content);
  }, [injectedInstruction]);

  // Auto-scroll to bottom on new messages or streaming content growth.
  // biome-ignore lint/correctness/useExhaustiveDependencies: deps are intentionally used only as scroll triggers, not read in the effect body
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length, streamingContent, liveToolCalls.length]);

  // Auto-resize textarea
  const handleTextareaInput = () => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  };

  const doSubmit = () => {
    const trimmed = inputValue.trim();
    if (!trimmed || isStreaming) return;

    startTransition(() => {
      doSend(trimmed);
      setInputValue("");
      if (textareaRef.current) {
        textareaRef.current.style.height = "auto";
      }
    });
  };

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    doSubmit();
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      doSubmit();
    }
  };

  const handleCancel = () => {
    if (activeItemIdRef.current) {
      cancelStream(activeItemIdRef.current);
    }
    setIsStreaming(false);

    setStreamingContent((partial) => {
      if (partial) {
        const partialMessage: AiMessage = {
          id: crypto.randomUUID(),
          role: "assistant",
          content: `${partial}\n\n[Cancelled]`,
          timestamp: new Date().toISOString(),
          toolCalls: finishedToolCallsRef.current?.length
            ? finishedToolCallsRef.current
            : undefined,
        };
        startTransition(() => {
          setMessages((prev) => [...prev, partialMessage]);
        });
      }
      return "";
    });
    setLiveToolCalls([]);
  };

  return (
    <div style={chatContainerStyle}>
      <div style={messagesAreaStyle}>
        {messages.length === 0 && !isStreaming && (
          <div style={emptyStateStyle}>
            <span style={{ fontSize: 24, opacity: 0.5 }}>AI</span>
            <span>Send A Message To Start Chatting</span>
          </div>
        )}

        {messages.map((msg) => (
          <MessageBubble key={msg.id} message={msg} />
        ))}

        {isStreaming && (streamingContent || liveToolCalls.length > 0) && (
          <div style={assistantBubbleStyle}>
            {streamingContent && (
              <AIMessageStream
                content={streamingContent}
                isStreaming={true}
                onCancel={handleCancel}
              />
            )}
            {liveToolCalls.map((tc) => (
              <ToolCallDisplay
                key={tc.id}
                name={tc.name}
                input={tc.input}
                result={tc.result}
                status={tc.status}
              />
            ))}
          </div>
        )}

        {error && (
          <div
            style={{
              padding: "10px 14px",
              borderRadius: 8,
              background: "oklch(0.14 0.06 10 / 0.6)",
              border: "1px solid oklch(0.35 0.10 10)",
              color: "oklch(0.82 0.15 10)",
              fontSize: 13,
            }}
          >
            {error}
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      <form onSubmit={handleSubmit} style={inputAreaStyle}>
        <textarea
          ref={textareaRef}
          value={inputValue}
          onChange={(e) => setInputValue(e.target.value)}
          onInput={handleTextareaInput}
          onKeyDown={handleKeyDown}
          placeholder={
            atLimit && !isStreaming
              ? "Concurrent Stream Limit Reached…"
              : "Type A Message... (Shift+Enter For Newline)"
          }
          rows={1}
          style={textareaStyle}
          disabled={isStreaming}
        />
        <button
          type="submit"
          disabled={!inputValue.trim() || isStreaming}
          style={{
            ...sendButtonStyle,
            opacity: !inputValue.trim() || isStreaming ? 0.5 : 1,
            cursor: !inputValue.trim() || isStreaming ? "not-allowed" : "pointer",
          }}
        >
          {isStreaming ? "Streaming..." : "Send"}
        </button>
      </form>
    </div>
  );
}

// ── Exported with Suspense ──────────────────────────

/**
 * Full AI chat interface for a worker.
 *
 * - Messages scroll up, input at bottom
 * - User messages right-aligned, AI left-aligned
 * - Glass-panel OKLCH styling
 * - Auto-scroll on new messages and growing streamed content
 * - Suspense boundary for loading states
 * - Streams through `useAiStream`, so queue item status and
 *   `activeStreams` (shown by AIQueue) stay accurate
 * - Renders `tool_use` content blocks via ToolCallDisplay
 */
export function AIChat({ workerId, injectedInstruction }: AIChatProps): React.ReactElement {
  return (
    <Suspense
      fallback={
        <div style={loadingFallbackStyle}>
          <Spinner size="lg" />
        </div>
      }
    >
      <AIChatContent workerId={workerId} injectedInstruction={injectedInstruction} />
    </Suspense>
  );
}
