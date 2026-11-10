import { useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "#components/ui/Button";
import { Pill, type PillTone } from "#components/ui/Pill";
import type { PermissionDecision } from "#lib/agent-events";
import { PROVIDER_LABELS } from "#lib/agent-events";
import { escapeForDisplay } from "#lib/display-escape";
import { errorMessage } from "#lib/is-error";
import { agentCancel, agentPermissionRespond, agentSendTurn } from "#lib/tauri";
import {
  type AgentTranscriptItem,
  type PermissionState,
  useAgentSessionStore,
  useAgentTranscript,
} from "#store/agent-sessions";
import { AIMessageStream } from "./AIMessageStream.tsx";
import { ApprovalArgList, ApprovalBlockedReason, useApprovalReview } from "./ApprovalArgs.tsx";
import { ToolCallDisplay } from "./ToolCallDisplay.tsx";

interface AgentChatProps {
  readonly workerId: string;
}

// ── Labels ───────────────────────────────────────────

/** Claude Code's classified denial reasons, in Title Case. */
const DENIAL_SUBCLASS_LABELS: Readonly<Record<string, string>> = {
  mode: "Mode Denied",
  ungranted_write: "Write Not Granted",
  redirection_guard: "Redirection Blocked",
};

function permissionLabel(state: PermissionState, subclass: string | null | undefined): string {
  switch (state) {
    case "report":
      return (subclass && DENIAL_SUBCLASS_LABELS[subclass]) || "Permission Denied";
    case "pending":
    case "answering":
      return "Permission Requested";
    case "allow":
      return "Allowed";
    case "deny":
      return "Denied";
    case "expired":
      return "Expired Unanswered";
  }
}

const PERMISSION_TONE: Readonly<Record<PermissionState, PillTone>> = {
  report: "danger",
  pending: "warning",
  answering: "warning",
  allow: "success",
  deny: "danger",
  expired: "neutral",
};

/** A tool input as a record for `ToolCallDisplay`; a non-object input is wrapped, not dropped. */
function toRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : { value };
}

/** Tool result content: strings verbatim, anything else as JSON for `ToolCallDisplay`'s viewer. */
function toResultString(content: unknown): string {
  return typeof content === "string" ? content : JSON.stringify(content);
}

/** Compact duration — milliseconds under a second, else one decimal of seconds. */
function formatDurationMs(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

/** The displayable text of a finalized block (`text`/`thinking` content objects, else JSON). */
function blockText(kind: string, content: unknown): string {
  if (content !== null && typeof content === "object") {
    const field = kind === "thinking" ? "thinking" : kind === "text" ? "text" : null;
    const value = field ? (content as Record<string, unknown>)[field] : undefined;
    if (typeof value === "string") return value;
  }
  return typeof content === "string" ? content : JSON.stringify(content);
}

// ── Styles (utilities; literals with no token wait for the Q-9 design direction) ──

const CONTAINER = "flex h-full flex-col overflow-hidden";

/** `column-reverse` pins the scroll position to the newest row natively, and leaves it alone once the user scrolls up. The container clips overflow, so the focus ring is drawn inside the scroller (`-outline-offset-2`). */
const SCROLLER = "flex flex-1 flex-col-reverse overflow-y-auto -outline-offset-2";

const TRANSCRIPT = "flex flex-col gap-2 p-3";

/**
 * Every transcript row. `content-visibility: auto` skips rendering a row
 * while it is off-screen; it stays in the DOM, the accessibility tree and
 * find-in-page. `contain-intrinsic-size: auto 51px` reserves the median
 * row height measured on the e2e transcript fixture at 1440x900 until the
 * row has rendered once, and its real height after that.
 */
const ROW = "[contain-intrinsic-size:auto_51px] [content-visibility:auto]";

const BUBBLE_BASE = "rounded-md px-3 py-2 font-sans text-[13px] leading-normal wrap-anywhere";

const USER_BUBBLE = `${BUBBLE_BASE} max-w-[85%] self-end whitespace-pre-wrap`;
const USER_BUBBLE_OK = `${USER_BUBBLE} bg-plasma/15 text-[oklch(0.92_0.03_205)]`;
const USER_BUBBLE_FAILED = `${USER_BUBBLE} border border-[oklch(0.45_0.18_25)] bg-[oklch(0.16_0.08_25/0.35)] text-[oklch(0.92_0.03_205)]`;

const STREAM_WRAP = "w-full max-w-[90%] self-start";

const THINKING_BLOCK = `${BUBBLE_BASE} max-w-[90%] self-start whitespace-pre-wrap bg-transparent text-fg-dim italic`;

const PERMISSION = "m-0 flex min-w-0 flex-col gap-1.5 self-stretch rounded-md border px-3 py-2";
const PERMISSION_DENIED = `${PERMISSION} border-[oklch(0.45_0.18_25)] bg-[oklch(0.16_0.08_25/0.4)]`;
const PERMISSION_PENDING = `${PERMISSION} border-[oklch(0.55_0.15_75)] bg-[oklch(0.18_0.06_75/0.4)]`;

const PERMISSION_HEADER = "flex items-center gap-2";

const PERMISSION_TOOL = "font-mono text-(length:--text-xs) text-[oklch(0.85_0.12_60)]";

const PERMISSION_MESSAGE =
  "font-mono text-[12px] leading-[1.4] wrap-anywhere whitespace-pre-wrap text-[oklch(0.88_0.06_60)]";

const SETTLED = "self-center font-mono text-(length:--text-xs) text-fg-dim";
const SETTLED_ERROR = "self-center font-mono text-(length:--text-xs) text-[oklch(0.72_0.20_25)]";

const CAPABILITY_NOTE = "shrink-0 px-3 py-1 font-mono text-(length:--text-xs) text-fg-dim";

const FORM = "flex shrink-0 gap-2 border-t border-[oklch(0.20_0.03_220)] p-2.5";

// ── Rows ─────────────────────────────────────────────

function PermissionRow({
  workerId,
  item,
  inputRef,
}: {
  readonly workerId: string;
  readonly inputRef: React.RefObject<HTMLInputElement | null>;
  readonly item: Extract<AgentTranscriptItem, { kind: "permission" }>;
}): React.ReactElement {
  const { payload, state } = item;
  const waiting = state === "pending" || state === "answering";
  const { items } = useAgentTranscript(workerId);
  // Codex's fileChange request names only its item: the paths and diff being approved are on that item's own tool call (same id, sent first).
  const isPatch = payload.tool === "fileChange";
  const request = toRecord(payload.input);
  const patch = isPatch
    ? items.find(
        (row): row is Extract<AgentTranscriptItem, { kind: "tool_call" }> =>
          row.kind === "tool_call" && row.payload.toolUseId === request.itemId,
      )
    : undefined;
  // The exact arguments are what the user approves; the provider's message
  // is only prose beside them (Codex sends none).
  const review = useApprovalReview(
    payload.tool,
    isPatch
      ? {
          ...request,
          changes: patch ? toRecord(patch.payload.input).changes : "(Not Received Yet)",
        }
      : payload.input,
  );

  const answer = async (decision: PermissionDecision, button: HTMLButtonElement) => {
    const { setPermissionState } = useAgentSessionStore.getState();
    setPermissionState(workerId, payload.requestId, "answering");
    // Both outcomes move the row only while it is still `answering`: the
    // turn may settle (row -> `expired`) before the answer resolves.
    try {
      await agentPermissionRespond(workerId, payload.requestId, decision);
      // The buttons unmount once the row leaves `answering`; keep focus in the chat.
      const hadFocus = document.activeElement === button;
      if (setPermissionState(workerId, payload.requestId, decision, "answering") && hadFocus) {
        inputRef.current?.focus();
      }
    } catch (err) {
      if (setPermissionState(workerId, payload.requestId, "pending", "answering")) {
        toast.error(`Permission Answer Failed: ${errorMessage(err)}`);
      }
    }
  };

  return (
    // A fieldset groups the request with its answer buttons; `loading`, not `disabled`, holds them while an answer is in flight, so keyboard focus stays on the pressed button.
    <fieldset
      aria-label={`Permission Request: ${escapeForDisplay(payload.tool)}`}
      className={`${waiting ? PERMISSION_PENDING : PERMISSION_DENIED} ${ROW}`}
    >
      <div className={PERMISSION_HEADER}>
        <Pill tone={PERMISSION_TONE[state]} size="sm">
          {permissionLabel(state, payload.denialSubclass)}
        </Pill>
        <span className={PERMISSION_TOOL}>{escapeForDisplay(payload.tool)}</span>
      </div>
      {review.args.length > 0 && <ApprovalArgList review={review} />}
      {payload.message && (
        <span className={PERMISSION_MESSAGE}>{escapeForDisplay(payload.message)}</span>
      )}
      {waiting && <ApprovalBlockedReason review={review} />}
      {waiting && (
        <div className="flex gap-2">
          <Button
            size="sm"
            variant={payload.suggestedDecision === "deny" ? "secondary" : "primary"}
            loading={state === "answering"}
            disabled={review.blocked || (isPatch && !patch)}
            aria-describedby={review.blocked ? review.reasonId : undefined}
            onClick={(e) => void answer("allow", e.currentTarget)}
          >
            Allow
          </Button>
          <Button
            size="sm"
            variant="danger"
            loading={state === "answering"}
            onClick={(e) => void answer("deny", e.currentTarget)}
          >
            Deny
          </Button>
        </div>
      )}
    </fieldset>
  );
}

function TranscriptRow({
  workerId,
  item,
  inputRef,
}: {
  readonly workerId: string;
  readonly inputRef: React.RefObject<HTMLInputElement | null>;
  readonly item: AgentTranscriptItem;
}): React.ReactNode {
  switch (item.kind) {
    case "user":
      // The red tint is not the only sign of a failed send: it also says so in words.
      return item.failed ? (
        <div className={`${USER_BUBBLE_FAILED} ${ROW}`}>
          <span className="sr-only">You: </span>
          {item.text}
          <div className={SETTLED_ERROR}>Not Sent</div>
        </div>
      ) : (
        <div className={`${USER_BUBBLE_OK} ${ROW}`}>
          <span className="sr-only">You: </span>
          {item.text}
        </div>
      );
    case "block": {
      // tool_use blocks render through their agent_tool_call event instead.
      if (item.payload.kind === "tool_use") return null;
      const text = blockText(item.payload.kind, item.payload.content);
      if (!text.trim()) return null;
      if (item.payload.kind === "thinking") {
        return (
          <div className={`${THINKING_BLOCK} ${ROW}`}>
            <span className="sr-only">Assistant (thinking): </span>
            {text}
          </div>
        );
      }
      return (
        <div className={`${STREAM_WRAP} ${ROW}`}>
          <span className="sr-only">Assistant: </span>
          <AIMessageStream content={text} isStreaming={false} />
        </div>
      );
    }
    case "tool_call":
      // The card has no class of its own to take; the wrapper is the row.
      return (
        <div className={ROW}>
          <ToolCallDisplay
            name={item.payload.name}
            input={toRecord(item.payload.input)}
            result={item.result ? toResultString(item.result.content) : undefined}
            status={item.result ? (item.result.isError ? "error" : "complete") : "executing"}
          />
        </div>
      );
    case "permission":
      return <PermissionRow workerId={workerId} item={item} inputRef={inputRef} />;
    case "settled": {
      const { status, error, durationMs, numTurns, costUsd } = item.payload;
      const parts = [
        status === "ok" ? "Turn Complete" : `Turn Failed${error ? `: ${error}` : ""}`,
        formatDurationMs(durationMs),
        ...(numTurns != null ? [`${numTurns} Turn${numTurns === 1 ? "" : "s"}`] : []),
        ...(costUsd != null ? [`$${costUsd.toFixed(4)}`] : []),
      ];
      return (
        <div className={`${status === "ok" ? SETTLED : SETTLED_ERROR} ${ROW}`}>
          {parts.join(", ")}
        </div>
      );
    }
  }
}

// ── Component ────────────────────────────────────────

/**
 * Chat with a worker's provider-adapter session (Claude Code or Codex).
 * The transcript is reduced from the `agent_*` events in
 * `#store/agent-sessions`, so it outlives this component; this renders
 * it, sends turns (`agent_send_turn`), cancels the running one, and
 * answers permission requests (`agent_permission_respond`) when the
 * provider is actually waiting for an answer
 * (`capabilities.interactivePermissions` and no `suggestedDecision`) —
 * otherwise a request is a report of a decision the provider already made.
 *
 * Sending while a turn runs never blocks: the session either interrupts
 * (`interruptMidturn`) or queues the new turn, and the send button and
 * note say which.
 */
export function AgentChat({ workerId }: AgentChatProps): React.ReactElement {
  const transcript = useAgentTranscript(workerId);
  const session = useAgentSessionStore((s) => s.sessions.get(workerId));
  const [draftEmpty, setDraftEmpty] = useState(true);
  const inputRef = useRef<HTMLInputElement>(null);

  const provider = session ? PROVIDER_LABELS[session.provider] : "Agent";
  // No session announcement yet → never claim an interrupt it hasn't reported.
  const canInterrupt = session?.capabilities.interruptMidturn ?? false;
  const busy = transcript.pendingTurns > 0;
  const streaming = [...transcript.streaming].filter(([, block]) => block.text.trim());

  const send = (formData: FormData) => {
    const text = String(formData.get("message") ?? "").trim();
    if (!text) return;
    const bubbleId = crypto.randomUUID();
    useAgentSessionStore.getState().addUserTurn(workerId, bubbleId, text);
    setDraftEmpty(true);
    agentSendTurn(workerId, text).catch((err: unknown) => {
      // Never admitted (e.g. the scheduler queue is full): no settle
      // will arrive for it, so the bubble fails here.
      useAgentSessionStore.getState().failUserTurn(workerId, bubbleId);
      toast.error(`Send Turn Failed: ${errorMessage(err)}`);
    });
  };

  const cancel = () => {
    // Between one queued turn's settle and the next one's first event
    // there is briefly nothing to target; Cancel is then a no-op.
    const turnId = transcript.currentTurnId;
    if (!turnId) return;
    agentCancel(workerId, turnId).catch((err: unknown) => {
      toast.error(`Cancel Failed: ${errorMessage(err)}`);
    });
  };

  return (
    <div className={CONTAINER}>
      <div
        role="log"
        aria-label={`${provider} Chat`}
        // biome-ignore lint/a11y/noNoninteractiveTabindex: WebKit (macOS, Linux) never makes a scroll container focusable on its own, and the transcript must scroll from the keyboard (WCAG 2.1.1).
        tabIndex={0}
        className={SCROLLER}
      >
        <div className={TRANSCRIPT}>
          {transcript.items.length === 0 && streaming.length === 0 && (
            <div className={`${SETTLED} mt-6`}>No Messages Yet — Say Something Below</div>
          )}
          {transcript.items.map((item) => (
            <TranscriptRow key={item.id} workerId={workerId} item={item} inputRef={inputRef} />
          ))}
          {streaming.map(([key, block]) =>
            block.kind === "thinking" ? (
              <div key={key} className={THINKING_BLOCK} aria-busy="true">
                <span className="sr-only">Assistant (thinking): </span>
                {block.text}
              </div>
            ) : (
              <div key={key} className={STREAM_WRAP}>
                <span className="sr-only">Assistant: </span>
                <AIMessageStream content={block.text} isStreaming />
              </div>
            ),
          )}
          {busy && streaming.length === 0 && <div className={SETTLED}>Working…</div>}
        </div>
      </div>

      {busy && (
        <div className={CAPABILITY_NOTE}>
          {canInterrupt
            ? "Sending Now Interrupts The Current Turn."
            : "This Provider Has No Mid-Turn Interrupt — Sending Now Queues Behind The Current Turn."}
        </div>
      )}

      <form action={send} className={FORM}>
        <input
          ref={inputRef}
          name="message"
          className="swarm-input flex-1"
          placeholder={`Message ${provider}…`}
          aria-label={`Message ${provider}`}
          autoComplete="off"
          onInput={(e) => setDraftEmpty(!e.currentTarget.value.trim())}
        />
        {busy && (
          <Button variant="danger" onClick={cancel} aria-label="Cancel Turn">
            Cancel
          </Button>
        )}
        <Button type="submit" variant="primary" disabled={draftEmpty}>
          {busy ? (canInterrupt ? "Interrupt" : "Queue Next Turn") : "Send"}
        </Button>
      </form>
    </div>
  );
}
