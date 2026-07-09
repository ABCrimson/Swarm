// ── AIChat ──────────────────────────────────────────
// Full chat interface for a worker.
// Message input at bottom, messages scroll up.
// User messages right-aligned, AI messages left-aligned.
// Glass-panel OKLCH backgrounds, Suspense boundary.

import { useAtom } from "jotai";
import type { CSSProperties, FormEvent } from "react";
import { Suspense, startTransition, useEffect, useRef, useState } from "react";
import { Spinner } from "#components/ui/Spinner";
import { useStream } from "#hooks/useStream";
import type { AiMessage } from "#store/types";
import { selectedModelAtom } from "#store/ui";
import { AIMessageStream } from "./AIMessageStream.tsx";

interface AIChatProps {
  /** Worker ID this chat is attached to. */
  readonly workerId: string;
}

// ── Model mapping ───────────────────────────────────

const MODEL_IDS: Record<"opus" | "sonnet" | "haiku", string> = {
  opus: "claude-opus-4-0-20250514",
  sonnet: "claude-sonnet-4-20250514",
  haiku: "claude-haiku-3-5-20241022",
};

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
      <AIMessageStream content={message.content} isStreaming={false} />
      <div style={timestampStyle}>{time}</div>
    </div>
  );
}

// ── Chat Content ────────────────────────────────────

function AIChatContent({ workerId }: AIChatProps): React.ReactElement {
  const [selectedModel] = useAtom(selectedModelAtom);
  const modelId = MODEL_IDS[selectedModel];
  const { messages, isStreaming, error, streamingContent, send, cancel } = useStream(
    workerId,
    modelId,
  );

  const [inputValue, setInputValue] = useState("");
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Auto-scroll to bottom on new messages or streaming content
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length, streamingContent.length > 0]);

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
      send(trimmed);
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

  return (
    <div style={chatContainerStyle}>
      <div style={messagesAreaStyle}>
        {messages.length === 0 && !isStreaming && (
          <div style={emptyStateStyle}>
            <span style={{ fontSize: 24, opacity: 0.5 }}>AI</span>
            <span>Send a message to start chatting</span>
          </div>
        )}

        {messages.map((msg) => (
          <MessageBubble key={msg.id} message={msg} />
        ))}

        {isStreaming && streamingContent && (
          <div style={assistantBubbleStyle}>
            <AIMessageStream content={streamingContent} isStreaming={true} onCancel={cancel} />
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
          placeholder="Type a message... (Shift+Enter for newline)"
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
 * - Auto-scroll on new messages
 * - Suspense boundary for loading states
 */
export function AIChat({ workerId }: AIChatProps): React.ReactElement {
  return (
    <Suspense
      fallback={
        <div style={loadingFallbackStyle}>
          <Spinner size="lg" />
        </div>
      }
    >
      <AIChatContent workerId={workerId} />
    </Suspense>
  );
}
