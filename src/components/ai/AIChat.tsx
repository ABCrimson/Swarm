import { useAtomValue } from "jotai";
import type { CSSProperties } from "react";
import { useState } from "react";
import { Button } from "#components/ui/Button";
import { cancelChatTurn, clearChat, sendChatMessage } from "#lib/ai-chat";
import { CLAUDE_MODELS } from "#lib/models";
import {
  type ChatMessage,
  type ChatNotice,
  type ChatToolCall,
  type LiveTurn,
  useChatThread,
} from "#store/message-history";
import { selectedModelAtom } from "#store/ui";
import { useWorkerAgentStore } from "#store/worker-agents";
import { AIMessageStream } from "./AIMessageStream.tsx";
import { ToolApprovalPrompt } from "./ToolApprovalPrompt.tsx";
import { ToolCallDisplay } from "./ToolCallDisplay.tsx";

// ── Styles (OKLCH) ──────────────────────────────────

const chatContainerStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  height: "100%",
  background: "oklch(0.08 0.02 220)",
  overflow: "hidden",
};

/**
 * `column-reverse` keeps the scroll position pinned to the newest
 * content natively as the transcript grows — and leaves it alone once
 * the user scrolls up — with no scroll effect.
 */
const scrollerStyle: CSSProperties = {
  flex: 1,
  overflowY: "auto",
  display: "flex",
  flexDirection: "column-reverse",
  scrollbarWidth: "thin",
  scrollbarColor: "oklch(0.28 0.05 220) oklch(0 0 0 / 0)",
};

const messagesStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 12,
  padding: 16,
};

const inputAreaStyle: CSSProperties = {
  display: "flex",
  alignItems: "flex-end",
  gap: 8,
  padding: "12px 16px",
  borderTop: "1px solid oklch(0.22 0.04 220)",
  background: "oklch(0.10 0.02 220 / 0.9)",
  backdropFilter: "blur(8px)",
};

const textareaStyle: CSSProperties = {
  flex: 1,
  height: "auto",
  padding: "10px 14px",
  background: "oklch(0.12 0.03 220)",
  color: "oklch(0.88 0.03 220)",
  fontSize: 14,
  lineHeight: 1.5,
  resize: "none",
  fieldSizing: "content",
  minHeight: 42,
  maxHeight: 160,
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
  overflowWrap: "anywhere",
};

const assistantBubbleStyle: CSSProperties = {
  alignSelf: "flex-start",
  maxWidth: "85%",
  display: "flex",
  flexDirection: "column",
  gap: 4,
};

const metaStyle: CSSProperties = {
  fontSize: 11,
  color: "var(--color-fg-dim)",
  marginTop: 4,
};

const thinkingStyle: CSSProperties = {
  fontSize: 12.5,
  lineHeight: 1.5,
  color: "oklch(0.60 0.03 220)",
  fontStyle: "italic",
  whiteSpace: "pre-wrap",
  overflowWrap: "anywhere",
};

const NOTICE_COLORS: Record<ChatNotice["tone"], string> = {
  info: "oklch(0.62 0.04 220)",
  warning: "oklch(0.82 0.16 75)",
  error: "oklch(0.78 0.16 20)",
};

const emptyStateStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  justifyContent: "center",
  minHeight: 160,
  gap: 8,
  color: "var(--color-fg-dim)",
  fontSize: 14,
};

const errorStyle: CSSProperties = {
  padding: "10px 14px",
  borderRadius: 8,
  background: "oklch(0.14 0.06 10 / 0.6)",
  border: "1px solid oklch(0.35 0.10 10)",
  color: "oklch(0.82 0.15 10)",
  fontSize: 13,
};

/** Bubble timestamps, e.g. "14:05" — one formatter for every message. */
const TIME_FORMAT = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" });

function formatTime(timestamp: string): string {
  return TIME_FORMAT.format(Temporal.Instant.from(timestamp).epochMilliseconds);
}

// ── Pieces ──────────────────────────────────────────

function toolStatus(call: ChatToolCall): "executing" | "complete" | "error" {
  if (call.result === undefined) return "executing";
  return call.isError ? "error" : "complete";
}

function ToolCalls({ calls }: { readonly calls: readonly ChatToolCall[] }): React.ReactNode {
  return calls.map((call) => (
    <ToolCallDisplay
      key={call.id}
      name={call.name}
      input={call.input}
      result={call.result}
      status={toolStatus(call)}
    />
  ));
}

function Thinking({
  text,
  open,
}: {
  readonly text: string;
  readonly open?: boolean;
}): React.ReactElement {
  return (
    <details open={open}>
      <summary style={{ ...metaStyle, marginTop: 0, cursor: "pointer" }}>Thinking</summary>
      <div style={thinkingStyle}>{text}</div>
    </details>
  );
}

function MessageBubble({ message }: { readonly message: ChatMessage }): React.ReactElement {
  const time = formatTime(message.timestamp);

  if (message.role === "user") {
    return (
      <div style={userBubbleStyle}>
        <div>{message.content}</div>
        <div style={{ ...metaStyle, textAlign: "right" }}>{time}</div>
      </div>
    );
  }

  return (
    <div style={assistantBubbleStyle}>
      {message.thinking && <Thinking text={message.thinking} />}
      {message.content && <AIMessageStream content={message.content} isStreaming={false} />}
      {message.toolCalls && <ToolCalls calls={message.toolCalls} />}
      {message.notice && (
        <div style={{ fontSize: 12, color: NOTICE_COLORS[message.notice.tone] }}>
          {message.notice.text}
        </div>
      )}
      <div style={metaStyle}>
        {time}
        {message.servedBy && ` · Answered By ${message.servedBy} (Refusal Fallback)`}
      </div>
    </div>
  );
}

function LiveBubble({ live }: { readonly live: LiveTurn }): React.ReactElement {
  const idle = !live.text && !live.thinking && live.toolCalls.length === 0;
  return (
    <div style={assistantBubbleStyle} aria-busy="true">
      {live.phase === "queued" && <div style={metaStyle}>Waiting For A Free Stream Slot…</div>}
      {live.thinking && <Thinking text={live.thinking} open={!live.text} />}
      {live.text && <AIMessageStream content={live.text} isStreaming />}
      <ToolCalls calls={live.toolCalls} />
      {live.phase !== "queued" && idle && <div style={metaStyle}>Thinking…</div>}
    </div>
  );
}

// ── Component ───────────────────────────────────────

interface AIChatProps {
  /** Worker this chat belongs to. */
  readonly workerId: string;
}

/**
 * The webview AI chat for one worker: the transcript (user and assistant
 * bubbles, summarized thinking, tool calls with their results, notices),
 * the in-flight turn as it streams, and the message input.
 *
 * All conversation state lives in the worker's thread
 * (`#store/message-history`) and every turn runs in `#lib/ai-chat`, so
 * unmounting this component — switching tabs — neither loses the
 * conversation nor cancels a running turn. The transcript is a polite
 * live region (`role="log"`); the streaming bubble is `aria-busy` until
 * it commits.
 */
export function AIChat({ workerId }: AIChatProps): React.ReactElement {
  const thread = useChatThread(workerId);
  const selectedModel = useAtomValue(selectedModelAtom);
  const pinnedModel = useWorkerAgentStore((s) => s.metadata.get(workerId)?.model);
  const model = CLAUDE_MODELS[pinnedModel ?? selectedModel];
  const [draftEmpty, setDraftEmpty] = useState(true);
  const busy = thread.live !== null;

  const send = (formData: FormData) => {
    if (sendChatMessage(workerId, String(formData.get("message") ?? ""))) {
      setDraftEmpty(true);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== "Enter" || e.shiftKey || e.nativeEvent.isComposing) return;
    e.preventDefault();
    if (!busy && !draftEmpty) e.currentTarget.form?.requestSubmit();
  };

  return (
    <div style={chatContainerStyle}>
      <div
        role="log"
        aria-label={`AI Chat With ${model.label}`}
        // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable region must be keyboard-focusable so it can be scrolled without a mouse (WCAG 2.1.1); WebKit (WKWebView, WebKitGTK) does not focus scroll containers natively.
        tabIndex={0}
        style={scrollerStyle}
      >
        <div style={messagesStyle}>
          {thread.messages.length === 0 && !busy && (
            <div style={emptyStateStyle}>
              <span style={{ fontSize: 24, opacity: 0.5 }}>AI</span>
              <span>Send A Message To Start Chatting</span>
            </div>
          )}
          {thread.messages.map((message) => (
            <MessageBubble key={message.id} message={message} />
          ))}
          {thread.live && <LiveBubble live={thread.live} />}
          {thread.error && (
            <div role="alert" style={errorStyle}>
              {thread.error}
            </div>
          )}
        </div>
      </div>

      <ToolApprovalPrompt workerId={workerId} />

      <form action={send} style={inputAreaStyle}>
        <textarea
          name="message"
          className="swarm-input"
          aria-label={`Message ${model.label}`}
          placeholder="Type A Message… (Shift+Enter For A New Line)"
          rows={1}
          style={textareaStyle}
          onInput={(e) => setDraftEmpty(!e.currentTarget.value.trim())}
          onKeyDown={handleKeyDown}
        />
        {busy ? (
          <Button variant="danger" onClick={() => cancelChatTurn(workerId)}>
            Stop
          </Button>
        ) : (
          <>
            {thread.messages.length > 0 && (
              <Button variant="ghost" onClick={() => clearChat(workerId)}>
                New Chat
              </Button>
            )}
            <Button type="submit" variant="primary" disabled={draftEmpty}>
              Send
            </Button>
          </>
        )}
      </form>
    </div>
  );
}
