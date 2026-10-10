import type { CSSProperties } from "react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "#components/ui/Button";
import { Pill, type PillTone } from "#components/ui/Pill";
import type { PermissionDecision } from "#lib/agent-events";
import { PROVIDER_LABELS } from "#lib/agent-events";
import { agentCancel, agentPermissionRespond, agentSendTurn } from "#lib/tauri";
import {
  type AgentTranscriptItem,
  type PermissionState,
  useAgentSessionStore,
  useAgentTranscript,
} from "#store/agent-sessions";
import { AIMessageStream } from "./AIMessageStream.tsx";
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

// ── Styles (OKLCH) ───────────────────────────────────

const containerStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  height: "100%",
  overflow: "hidden",
};

/** `column-reverse` pins the scroll position to the newest row natively, and leaves it alone once the user scrolls up. */
const scrollerStyle: CSSProperties = {
  flex: 1,
  overflowY: "auto",
  display: "flex",
  flexDirection: "column-reverse",
};

const transcriptStyle: CSSProperties = {
  padding: 12,
  display: "flex",
  flexDirection: "column",
  gap: 8,
};

const bubbleBaseStyle: CSSProperties = {
  padding: "8px 12px",
  borderRadius: 8,
  fontFamily: "var(--font-body, 'DM Sans Variable', system-ui, sans-serif)",
  fontSize: 13,
  lineHeight: 1.5,
  overflowWrap: "anywhere",
};

const userBubbleStyle: CSSProperties = {
  ...bubbleBaseStyle,
  alignSelf: "flex-end",
  background: "oklch(0.78 0.18 205 / 0.15)",
  color: "oklch(0.92 0.03 205)",
  maxWidth: "85%",
  whiteSpace: "pre-wrap",
};

const userBubbleFailedStyle: CSSProperties = {
  ...userBubbleStyle,
  background: "oklch(0.16 0.08 25 / 0.35)",
  border: "1px solid oklch(0.45 0.18 25)",
};

const streamWrapStyle: CSSProperties = {
  alignSelf: "flex-start",
  maxWidth: "90%",
  width: "100%",
};

const thinkingBlockStyle: CSSProperties = {
  ...bubbleBaseStyle,
  alignSelf: "flex-start",
  background: "oklch(0 0 0 / 0)",
  color: "var(--color-fg-dim)",
  fontStyle: "italic",
  maxWidth: "90%",
  whiteSpace: "pre-wrap",
};

const permissionStyle: CSSProperties = {
  margin: 0,
  minWidth: 0,
  display: "flex",
  flexDirection: "column",
  gap: 6,
  alignSelf: "stretch",
  padding: "8px 12px",
  borderRadius: 8,
  border: "1px solid oklch(0.45 0.18 25)",
  background: "oklch(0.16 0.08 25 / 0.4)",
};

const permissionPendingStyle: CSSProperties = {
  ...permissionStyle,
  border: "1px solid oklch(0.55 0.15 75)",
  background: "oklch(0.18 0.06 75 / 0.4)",
};

const permissionHeaderStyle: CSSProperties = { display: "flex", alignItems: "center", gap: 8 };

const permissionToolStyle: CSSProperties = {
  fontFamily: "var(--font-mono, monospace)",
  fontSize: 11.5,
  color: "oklch(0.85 0.12 60)",
};

const permissionMessageStyle: CSSProperties = {
  fontFamily: "var(--font-mono, monospace)",
  fontSize: 12,
  color: "oklch(0.88 0.06 60)",
  lineHeight: 1.4,
  whiteSpace: "pre-wrap",
  overflowWrap: "anywhere",
};

const settledStyle: CSSProperties = {
  alignSelf: "center",
  color: "var(--color-fg-dim)",
  fontFamily: "var(--font-mono, monospace)",
  fontSize: 10.5,
};

const settledErrorStyle: CSSProperties = { ...settledStyle, color: "oklch(0.72 0.20 25)" };

const capabilityNoteStyle: CSSProperties = {
  padding: "4px 12px",
  fontFamily: "var(--font-mono, monospace)",
  fontSize: 10.5,
  color: "var(--color-fg-dim)",
  flexShrink: 0,
};

const formStyle: CSSProperties = {
  display: "flex",
  gap: 8,
  padding: 10,
  borderTop: "1px solid oklch(0.20 0.03 220)",
  flexShrink: 0,
};

// ── Rows ─────────────────────────────────────────────

function PermissionRow({
  workerId,
  item,
}: {
  readonly workerId: string;
  readonly item: Extract<AgentTranscriptItem, { kind: "permission" }>;
}): React.ReactElement {
  const { payload, state } = item;
  const waiting = state === "pending" || state === "answering";

  const answer = async (decision: PermissionDecision) => {
    const { setPermissionState } = useAgentSessionStore.getState();
    setPermissionState(workerId, payload.requestId, "answering");
    // Both outcomes move the row only while it is still `answering`: the
    // turn may settle (row -> `expired`) before the answer resolves.
    try {
      await agentPermissionRespond(workerId, payload.requestId, decision);
      setPermissionState(workerId, payload.requestId, decision, "answering");
    } catch (err) {
      if (setPermissionState(workerId, payload.requestId, "pending", "answering")) {
        toast.error(`Permission Answer Failed: ${Error.isError(err) ? err.message : String(err)}`);
      }
    }
  };

  return (
    // A fieldset groups the request with its answer buttons and disables
    // them all natively while an answer is in flight.
    <fieldset
      aria-label={`Permission Request: ${payload.tool}`}
      disabled={state === "answering"}
      style={waiting ? permissionPendingStyle : permissionStyle}
    >
      <div style={permissionHeaderStyle}>
        <Pill tone={PERMISSION_TONE[state]} size="sm">
          {permissionLabel(state, payload.denialSubclass)}
        </Pill>
        <span style={permissionToolStyle}>{payload.tool}</span>
      </div>
      {payload.message && <span style={permissionMessageStyle}>{payload.message}</span>}
      {waiting && (
        <div style={{ display: "flex", gap: 8 }}>
          <Button
            size="sm"
            variant={payload.suggestedDecision === "deny" ? "secondary" : "primary"}
            loading={state === "answering"}
            onClick={() => void answer("allow")}
          >
            Allow
          </Button>
          <Button size="sm" variant="danger" onClick={() => void answer("deny")}>
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
}: {
  readonly workerId: string;
  readonly item: AgentTranscriptItem;
}): React.ReactNode {
  switch (item.kind) {
    case "user":
      // The red tint is not the only sign of a failed send: it also says so in words.
      return item.failed ? (
        <div style={userBubbleFailedStyle}>
          {item.text}
          <div style={settledErrorStyle}>Not Sent</div>
        </div>
      ) : (
        <div style={userBubbleStyle}>{item.text}</div>
      );
    case "block": {
      // tool_use blocks render through their agent_tool_call event instead.
      if (item.payload.kind === "tool_use") return null;
      const text = blockText(item.payload.kind, item.payload.content);
      if (!text.trim()) return null;
      if (item.payload.kind === "thinking") return <div style={thinkingBlockStyle}>{text}</div>;
      return (
        <div style={streamWrapStyle}>
          <AIMessageStream content={text} isStreaming={false} />
        </div>
      );
    }
    case "tool_call":
      return (
        <ToolCallDisplay
          name={item.payload.name}
          input={toRecord(item.payload.input)}
          result={item.result ? toResultString(item.result.content) : undefined}
          status={item.result ? (item.result.isError ? "error" : "complete") : "executing"}
        />
      );
    case "permission":
      return <PermissionRow workerId={workerId} item={item} />;
    case "settled": {
      const { status, error, durationMs, numTurns, costUsd } = item.payload;
      const parts = [
        status === "ok" ? "Turn Complete" : `Turn Failed${error ? `: ${error}` : ""}`,
        formatDurationMs(durationMs),
        ...(numTurns != null ? [`${numTurns} Turn${numTurns === 1 ? "" : "s"}`] : []),
        ...(costUsd != null ? [`$${costUsd.toFixed(4)}`] : []),
      ];
      return (
        <div style={status === "ok" ? settledStyle : settledErrorStyle}>{parts.join(" · ")}</div>
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
 * (`capabilities.interactivePermissions`) — otherwise a request is a
 * report of a decision the provider already made.
 *
 * Sending while a turn runs never blocks: the session either interrupts
 * (`interruptMidturn`) or queues the new turn, and the send button and
 * note say which.
 */
export function AgentChat({ workerId }: AgentChatProps): React.ReactElement {
  const transcript = useAgentTranscript(workerId);
  const session = useAgentSessionStore((s) => s.sessions.get(workerId));
  const [draftEmpty, setDraftEmpty] = useState(true);

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
      toast.error(`Send Turn Failed: ${Error.isError(err) ? err.message : String(err)}`);
    });
  };

  const cancel = () => {
    // Between one queued turn's settle and the next one's first event
    // there is briefly nothing to target; Cancel is then a no-op.
    const turnId = transcript.currentTurnId;
    if (!turnId) return;
    agentCancel(workerId, turnId).catch((err: unknown) => {
      toast.error(`Cancel Failed: ${Error.isError(err) ? err.message : String(err)}`);
    });
  };

  return (
    <div style={containerStyle}>
      <div
        role="log"
        aria-label={`${provider} Chat`}
        // biome-ignore lint/a11y/noNoninteractiveTabindex: WebKit (macOS, Linux) never makes a scroll container focusable on its own, and the transcript must scroll from the keyboard (WCAG 2.1.1).
        tabIndex={0}
        style={scrollerStyle}
      >
        <div style={transcriptStyle}>
          {transcript.items.length === 0 && streaming.length === 0 && (
            <div style={{ ...settledStyle, marginTop: 24 }}>
              No Messages Yet — Say Something Below
            </div>
          )}
          {transcript.items.map((item) => (
            <TranscriptRow key={item.id} workerId={workerId} item={item} />
          ))}
          {streaming.map(([key, block]) =>
            block.kind === "thinking" ? (
              <div key={key} style={thinkingBlockStyle} aria-busy="true">
                {block.text}
              </div>
            ) : (
              <div key={key} style={streamWrapStyle}>
                <AIMessageStream content={block.text} isStreaming />
              </div>
            ),
          )}
          {busy && streaming.length === 0 && <div style={settledStyle}>Working…</div>}
        </div>
      </div>

      {busy && (
        <div style={capabilityNoteStyle}>
          {canInterrupt
            ? "Sending Now Interrupts The Current Turn."
            : "This Provider Has No Mid-Turn Interrupt — Sending Now Queues Behind The Current Turn."}
        </div>
      )}

      <form action={send} style={formStyle}>
        <input
          name="message"
          className="swarm-input"
          style={{ flex: 1 }}
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
