import { useAtomValue } from "jotai";
import { useRef, useState } from "react";
import { Button } from "#components/ui/Button";
import { cancelChatTurn, clearChat, sendChatMessage } from "#lib/ai-chat";
import { CLAUDE_MODELS } from "#lib/models";
import { DESKTOP_ONLY_REASON, hasCapability } from "#lib/tauri";
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

// ── Styles (utilities; literals with no token wait for the Q-9 design direction) ──

const CHAT_CONTAINER = "flex h-full flex-col overflow-hidden bg-surface-0";

/**
 * `column-reverse` keeps the scroll position pinned to the newest
 * content natively as the transcript grows — and leaves it alone once
 * the user scrolls up — with no scroll effect. The container clips
 * overflow, so the focus ring is drawn inside the scroller
 * (`-outline-offset-2`).
 */
const SCROLLER =
  "scroll-area scrollbar-thin scrollbar-thumb-border-2 scrollbar-track-transparent flex flex-1 flex-col-reverse overflow-y-auto -outline-offset-2";

const MESSAGES = "flex flex-col gap-3 p-4";

const INPUT_AREA =
  "flex items-end gap-2 border-t border-border bg-[oklch(0.10_0.02_220/0.9)] px-4 py-3 backdrop-blur-[8px]";

const TEXTAREA =
  "swarm-input h-auto max-h-40 min-h-10.5 flex-1 resize-none bg-[oklch(0.12_0.03_220)] px-3.5 py-2.5 text-(length:--text-md) leading-normal text-[oklch(0.88_0.03_220)] [field-sizing:content]";

const USER_BUBBLE =
  "max-w-[75%] self-end rounded-[12px_12px_4px_12px] border border-plasma/30 bg-plasma/15 px-3.5 py-2.5 text-(length:--text-md) leading-[1.6] wrap-anywhere whitespace-pre-wrap text-[oklch(0.88_0.03_220)]";

const ASSISTANT_BUBBLE = "flex max-w-[85%] flex-col gap-1 self-start";

const META_BASE = "text-[11px] text-fg-dim";
const META = `${META_BASE} mt-1`;

const THINKING =
  "text-(length:--text-sm) leading-normal wrap-anywhere whitespace-pre-wrap text-[oklch(0.60_0.03_220)] italic";

const NOTICE_COLORS: Record<ChatNotice["tone"], string> = {
  info: "text-fg-dim",
  warning: "text-[oklch(0.82_0.16_75)]",
  error: "text-[oklch(0.78_0.16_20)]",
};

const EMPTY_STATE =
  "flex min-h-40 flex-col items-center justify-center gap-2 text-(length:--text-md) text-fg-dim";

const ERROR =
  "rounded-md border border-[oklch(0.35_0.10_10)] bg-[oklch(0.14_0.06_10/0.6)] px-3.5 py-2.5 text-[13px] text-[oklch(0.82_0.15_10)]";

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
      <summary className={`${META_BASE} mt-0 cursor-pointer`}>Thinking</summary>
      <div className={THINKING}>{text}</div>
    </details>
  );
}

function MessageBubble({ message }: { readonly message: ChatMessage }): React.ReactElement {
  const time = formatTime(message.timestamp);

  if (message.role === "user") {
    return (
      <div className={USER_BUBBLE}>
        <span className="sr-only">You: </span>
        <div>{message.content}</div>
        <div className={`${META} text-right`}>{time}</div>
      </div>
    );
  }

  return (
    <div className={ASSISTANT_BUBBLE}>
      <span className="sr-only">Assistant: </span>
      {message.thinking && <Thinking text={message.thinking} />}
      {message.content && <AIMessageStream content={message.content} isStreaming={false} />}
      {message.toolCalls && <ToolCalls calls={message.toolCalls} />}
      {message.notice && (
        <div className={`text-[12px] ${NOTICE_COLORS[message.notice.tone]}`}>
          {message.notice.text}
        </div>
      )}
      <div className={META}>
        {time}
        {message.servedBy && `, Answered By ${message.servedBy} (Refusal Fallback)`}
      </div>
    </div>
  );
}

function LiveBubble({ live }: { readonly live: LiveTurn }): React.ReactElement {
  const idle = !live.text && !live.thinking && live.toolCalls.length === 0;
  return (
    <div className={ASSISTANT_BUBBLE} aria-busy="true">
      <span className="sr-only">Assistant: </span>
      {live.phase === "queued" && <div className={META}>Waiting For A Free Stream Slot…</div>}
      {live.thinking && <Thinking text={live.thinking} open={!live.text} />}
      {live.text && <AIMessageStream content={live.text} isStreaming />}
      <ToolCalls calls={live.toolCalls} />
      {live.phase !== "queued" && idle && <div className={META}>Thinking…</div>}
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
 *
 * The chat streams straight from the webview to Anthropic, which only
 * the desktop shell offers; a transport without `localAiChat` (the
 * `pnpm build:web` page) gets a notice instead of a message box.
 */
export function AIChat({ workerId }: AIChatProps): React.ReactElement {
  const thread = useChatThread(workerId);
  const selectedModel = useAtomValue(selectedModelAtom);
  const pinnedModel = useWorkerAgentStore((s) => s.metadata.get(workerId)?.model);
  const model = CLAUDE_MODELS[pinnedModel ?? selectedModel];
  const [draftEmpty, setDraftEmpty] = useState(true);
  const inputRef = useRef<HTMLTextAreaElement>(null);
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

  if (!hasCapability("localAiChat")) {
    return (
      <div className={CHAT_CONTAINER}>
        <div role="status" className={EMPTY_STATE}>
          <span>{DESKTOP_ONLY_REASON}</span>
          <span>Use A Claude Code Or Codex Worker For AI Chat Here</span>
        </div>
      </div>
    );
  }

  return (
    <div className={CHAT_CONTAINER}>
      <div
        role="log"
        aria-label={`AI Chat With ${model.label}`}
        // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable region must be keyboard-focusable so it can be scrolled without a mouse (WCAG 2.1.1); WebKit (WKWebView, WebKitGTK) does not focus scroll containers natively.
        tabIndex={0}
        className={SCROLLER}
      >
        <div className={MESSAGES}>
          {thread.messages.length === 0 && !busy && (
            <div className={EMPTY_STATE}>
              <span className="text-[24px] opacity-50">AI</span>
              <span>Send A Message To Start Chatting</span>
            </div>
          )}
          {thread.messages.map((message) => (
            <MessageBubble key={message.id} message={message} />
          ))}
          {thread.live && <LiveBubble live={thread.live} />}
          {thread.error && (
            <div role="alert" className={ERROR}>
              {thread.error}
            </div>
          )}
        </div>
      </div>

      <ToolApprovalPrompt workerId={workerId} onResolved={() => inputRef.current?.focus()} />

      <form action={send} className={INPUT_AREA}>
        <textarea
          ref={inputRef}
          name="message"
          className={TEXTAREA}
          aria-label={`Message ${model.label}`}
          placeholder="Type A Message… (Shift+Enter For A New Line)"
          rows={3}
          onInput={(e) => setDraftEmpty(!e.currentTarget.value.trim())}
          onKeyDown={handleKeyDown}
        />
        {!busy && thread.messages.length > 0 && (
          <Button variant="ghost" onClick={() => clearChat(workerId)}>
            New Chat
          </Button>
        )}
        {/* One button that turns from Send into Stop, so keyboard focus stays on it when a turn starts. */}
        <Button
          type={busy ? "button" : "submit"}
          variant={busy ? "danger" : "primary"}
          disabled={!busy && draftEmpty}
          onClick={busy ? () => cancelChatTurn(workerId) : undefined}
        >
          {busy ? "Stop" : "Send"}
        </Button>
      </form>
    </div>
  );
}
