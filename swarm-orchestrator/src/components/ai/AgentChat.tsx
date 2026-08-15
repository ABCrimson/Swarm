// ── AgentChat ───────────────────────────────────────
// Event-driven transcript for a worker with a live Claude Code session
// (Phase 3's command surface — see docs/architecture.md's adapter-layer
// section). Renders directly from the agent_* event stream; sends
// turns via agentSendTurn. Follow-up UI-overhaul refinement over PR
// #11's minimal surface: streaming text reuses AIMessageStream's
// markdown/code rendering, tool calls render as ToolCallDisplay's
// labeled collapsible blocks (name + input + result, is_error
// styling), permission denials get a distinct report-style notice, the
// settled receipt shows cost/duration/turns, and the input's
// send-during-turn affordance is labeled per the session's actual
// `Capabilities.interruptMidturn` rather than assuming one behavior
// for every provider.

import type { CSSProperties, FormEvent } from "react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Pill } from "#components/ui/Pill";
import type {
  AgentBlockPayload,
  AgentPermissionRequestPayload,
  AgentToolCallPayload,
  AgentToolResultPayload,
  AgentTurnSettledPayload,
} from "#lib/agent-events";
import {
  AgentBlockPayloadSchema,
  AgentPermissionRequestPayloadSchema,
  AgentToolCallPayloadSchema,
  AgentToolResultPayloadSchema,
  AgentTurnDeltaPayloadSchema,
  AgentTurnSettledPayloadSchema,
} from "#lib/agent-events";
import { onEvent } from "#lib/event-bus";
import { agentCancel, agentSendTurn } from "#lib/tauri";
import { useAgentSessionStore } from "#store/agent-sessions";
import { AIMessageStream } from "./AIMessageStream.tsx";
import { ToolCallDisplay } from "./ToolCallDisplay.tsx";

interface AgentChatProps {
  readonly workerId: string;
}

type TranscriptItem =
  | { readonly id: string; readonly kind: "user"; readonly text: string; readonly failed: boolean }
  | { readonly id: string; readonly kind: "block"; readonly payload: AgentBlockPayload }
  | {
      readonly id: string;
      readonly kind: "tool_call";
      readonly payload: AgentToolCallPayload;
      /** `null` until the matching `agent_tool_result` (same `toolUseId`) arrives. */
      readonly result: AgentToolResultPayload | null;
    }
  | {
      readonly id: string;
      readonly kind: "permission_denied";
      readonly payload: AgentPermissionRequestPayload;
    }
  | { readonly id: string; readonly kind: "settled"; readonly payload: AgentTurnSettledPayload };

/** Live, not-yet-finalized text for one (turnId, blockIndex) pair, accumulated from agent_turn_delta. */
interface StreamingBlock {
  readonly kind: string;
  readonly text: string;
}

// ── Denial subclass -> Title Case label (review F10) ─

const DENIAL_SUBCLASS_LABELS: Record<string, string> = {
  mode: "Mode Denied",
  ungranted_write: "Write Not Granted",
  redirection_guard: "Redirection Blocked",
};

function denialSubclassLabel(subclass: string | null | undefined): string {
  if (subclass && subclass in DENIAL_SUBCLASS_LABELS) return DENIAL_SUBCLASS_LABELS[subclass];
  return "Permission Denied";
}

/** `ToolCallDisplay` wants a record; a tool input that isn't an object (rare, but `unknown` on the wire) is wrapped rather than dropped. */
function toRecord(value: unknown): Record<string, unknown> {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return { value };
}

/** A tool result's `content` is `unknown` on the wire — pass strings through verbatim (the common case, already human text), stringify anything else so `ToolCallDisplay`'s own JSON viewer can parse it back. */
function toResultString(content: unknown): string {
  return typeof content === "string" ? content : JSON.stringify(content);
}

/** Compact duration label — sub-second in ms, otherwise one decimal of seconds. */
function formatDurationMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

// ── Styles (OKLCH) ───────────────────────────────────

const containerStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  height: "100%",
  overflow: "hidden",
};

const transcriptStyle: CSSProperties = {
  flex: 1,
  overflowY: "auto",
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
  wordBreak: "break-word",
};

const userBubbleStyle: CSSProperties = {
  ...bubbleBaseStyle,
  alignSelf: "flex-end",
  background: "oklch(0.78 0.18 205 / 0.15)",
  color: "oklch(0.92 0.03 205)",
  maxWidth: "85%",
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
  background: "transparent",
  color: "oklch(0.50 0.03 220)",
  fontStyle: "italic",
  maxWidth: "90%",
};

const permissionDeniedStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 4,
  alignSelf: "stretch",
  padding: "8px 12px",
  borderRadius: 8,
  border: "1px solid oklch(0.45 0.18 25)",
  background: "oklch(0.16 0.08 25 / 0.4)",
};

const permissionDeniedHeaderStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
};

const permissionDeniedToolStyle: CSSProperties = {
  fontFamily: "var(--font-mono, monospace)",
  fontSize: 11.5,
  color: "oklch(0.82 0.19 25)",
};

const permissionDeniedMessageStyle: CSSProperties = {
  fontFamily: "var(--font-body)",
  fontSize: 12,
  color: "oklch(0.85 0.10 25)",
  lineHeight: 1.4,
};

const settledStyle: CSSProperties = {
  alignSelf: "center",
  color: "oklch(0.50 0.04 220)",
  fontFamily: "var(--font-mono, monospace)",
  fontSize: 10.5,
};

const settledErrorStyle: CSSProperties = {
  ...settledStyle,
  color: "oklch(0.72 0.20 25)",
};

const capabilityNoteStyle: CSSProperties = {
  padding: "4px 12px",
  fontFamily: "var(--font-mono, monospace)",
  fontSize: 10.5,
  color: "oklch(0.55 0.04 220)",
  flexShrink: 0,
};

const formStyle: CSSProperties = {
  display: "flex",
  gap: 8,
  padding: 10,
  borderTop: "1px solid oklch(0.20 0.03 220)",
  flexShrink: 0,
};

const inputStyle: CSSProperties = {
  flex: 1,
  padding: "8px 12px",
  borderRadius: 8,
  border: "1px solid oklch(0.28 0.05 220)",
  background: "oklch(0.08 0.02 220)",
  color: "oklch(0.90 0.02 220)",
  fontFamily: "var(--font-body, system-ui, sans-serif)",
  fontSize: 13,
  outline: "none",
};

const sendButtonStyle: CSSProperties = {
  padding: "8px 16px",
  borderRadius: 8,
  border: "none",
  background: "oklch(0.78 0.18 205)",
  color: "oklch(0.10 0.03 205)",
  fontSize: 13,
  fontWeight: 600,
  cursor: "pointer",
};

const cancelButtonStyle: CSSProperties = {
  padding: "8px 14px",
  borderRadius: 8,
  border: "1px solid oklch(0.45 0.18 25)",
  background: "oklch(0.16 0.08 25 / 0.5)",
  color: "oklch(0.82 0.19 25)",
  fontSize: 13,
  fontWeight: 600,
  cursor: "pointer",
};

// ── Block rendering ───────────────────────────────────

function renderBlockContent(kind: string, content: unknown): string {
  if (kind === "text" && typeof content === "object" && content !== null && "text" in content) {
    const text = (content as { text?: unknown }).text;
    if (typeof text === "string") return text;
  }
  if (
    kind === "thinking" &&
    typeof content === "object" &&
    content !== null &&
    "thinking" in content
  ) {
    const thinking = (content as { thinking?: unknown }).thinking;
    if (typeof thinking === "string" && thinking.length > 0) return thinking;
  }
  return typeof content === "string" ? content : JSON.stringify(content);
}

function TranscriptRow({ item }: { readonly item: TranscriptItem }): React.ReactElement | null {
  switch (item.kind) {
    case "user":
      return <div style={item.failed ? userBubbleFailedStyle : userBubbleStyle}>{item.text}</div>;
    case "block": {
      const text = renderBlockContent(item.payload.kind, item.payload.content);
      if (!text.trim()) return null;
      if (item.payload.kind === "thinking") {
        return <div style={thinkingBlockStyle}>{text}</div>;
      }
      if (item.payload.kind === "tool_use") return null; // rendered via the tool_call event instead
      // Finalized assistant text reuses AIMessageStream (not streaming)
      // so code blocks/inline code render identically whether the text
      // is still live or already settled.
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
    case "permission_denied":
      return (
        <div style={permissionDeniedStyle}>
          <div style={permissionDeniedHeaderStyle}>
            <Pill tone="danger" size="sm">
              {denialSubclassLabel(item.payload.denialSubclass)}
            </Pill>
            <span style={permissionDeniedToolStyle}>{item.payload.tool}</span>
          </div>
          {item.payload.message && (
            <span style={permissionDeniedMessageStyle}>{item.payload.message}</span>
          )}
        </div>
      );
    case "settled": {
      const parts = [
        item.payload.status === "ok"
          ? "Turn Complete"
          : `Turn Failed${item.payload.error ? `: ${item.payload.error}` : ""}`,
        formatDurationMs(item.payload.durationMs),
      ];
      if (item.payload.numTurns != null) {
        parts.push(`${item.payload.numTurns} Turn${item.payload.numTurns === 1 ? "" : "s"}`);
      }
      if (item.payload.costUsd != null) {
        parts.push(`$${item.payload.costUsd.toFixed(4)}`);
      }
      return (
        <div style={item.payload.status === "ok" ? settledStyle : settledErrorStyle}>
          {parts.join(" · ")}
        </div>
      );
    }
    default:
      return null;
  }
}

// ── Component ─────────────────────────────────────────

/**
 * Event-driven transcript + input for a worker's attached Claude Code
 * session. Every persisted `TranscriptItem` traces to a real `agent_*`
 * event (or the caller's own optimistic outgoing message) — nothing
 * here fabricates content client-side, matching AIChat's own
 * discipline for the webview path. `agent_turn_delta` (ephemeral,
 * review F6) additionally renders as a live, in-progress bubble per
 * (turnId, blockIndex) that gets replaced by the real `agent_block`
 * once the provider finalizes it.
 */
export function AgentChat({ workerId }: AgentChatProps): React.ReactElement {
  const [items, setItems] = useState<TranscriptItem[]>([]);
  const [streaming, setStreaming] = useState<Map<string, StreamingBlock>>(new Map());
  const [draft, setDraft] = useState("");
  // Count of turns admitted-but-not-yet-settled, NOT a boolean (review
  // FIX-1) — with queueing, N sends means N outstanding settlements;
  // a single `busy` flag cleared by the FIRST agent_turn_settled would
  // flip the UI back to idle (wrong label, Cancel disappearing) while
  // later queued turns are still executing. `busy` is derived, never
  // set directly.
  const [pendingCount, setPendingCount] = useState(0);
  const busy = pendingCount > 0;
  // The most recently observed turnId for THIS worker's in-flight turn
  // (review F7) — agent_send_turn is fire-and-forget and never hands
  // back a turnId directly, so Cancel correlates via whatever the
  // event stream has told us about the turn actually running. Still
  // correct under queueing: Claude Code processes turns strictly
  // sequentially in one process (module doc's "multi-turn reality") —
  // turn K+1 emits no events at all until turn K's agent_turn_settled
  // fires, so "the turnId of the most recent event" is always the
  // ACTIVELY PROCESSING turn, queue or no queue.
  const [currentTurnId, setCurrentTurnId] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  // FIFO correlation between optimistic user bubbles and the turnId
  // the backend eventually assigns them (review FIX-2) — agentSendTurn
  // never returns a turnId, and there is no separate agent_turn_started
  // EVENT for this provider (only the webview-direct AIChat path has a
  // synchronous agentTurnStarted COMMAND). Sound because: (a) Claude
  // Code executes admitted turns strictly in submission order (same
  // process, same stdin, one at a time — see the module doc), so the
  // FIRST event carrying a turnId not yet mapped belongs to the OLDEST
  // still-queued bubble; (b) a bubble whose admission fails outright is
  // removed from this queue immediately, in its own .catch, by id — not
  // by shifting — so a later turn's mapping can never be thrown off by
  // an earlier one that was never actually admitted.
  const pendingBubbleIdsRef = useRef<string[]>([]);
  const turnIdToBubbleRef = useRef<Map<string, string>>(new Map());

  // Capability-honesty: whether THIS session's provider can actually
  // interrupt an in-flight turn (`Capabilities.interruptMidturn`, off
  // `agent_session_started`). Claude Code's is always `false` (no
  // provider currently reports `true`) — defaulting to `false` when
  // the session hasn't announced itself yet means the UI never claims
  // an interrupt capability it hasn't measured.
  const canInterruptMidturn =
    useAgentSessionStore((s) => s.sessions.get(workerId)?.capabilities.interruptMidturn) ?? false;

  useEffect(() => {
    setItems([]);
    setStreaming(new Map());
    setPendingCount(0);
    setCurrentTurnId(null);
    pendingBubbleIdsRef.current = [];
    turnIdToBubbleRef.current = new Map();

    const push = (item: TranscriptItem) => setItems((prev) => [...prev, item]);
    const streamKey = (turnId: string, blockIndex: number) => `${turnId}:${blockIndex}`;
    // Maps `turnId` to the oldest still-unmapped pending bubble, once —
    // see the FIFO-correlation doc on `pendingBubbleIdsRef` above. A
    // no-op once `turnId` is already mapped, so every event handler
    // below can call this unconditionally as its first line.
    const ensureTurnMapped = (turnId: string) => {
      if (turnIdToBubbleRef.current.has(turnId)) return;
      const bubbleId = pendingBubbleIdsRef.current.shift();
      if (bubbleId) turnIdToBubbleRef.current.set(turnId, bubbleId);
    };

    const offs = [
      onEvent("agent_turn_delta", (e) => {
        const parsed = AgentTurnDeltaPayloadSchema.safeParse(e.payload);
        if (!parsed.success || parsed.data.workerId !== workerId) return;
        setCurrentTurnId(parsed.data.turnId);
        ensureTurnMapped(parsed.data.turnId);
        const key = streamKey(parsed.data.turnId, parsed.data.blockIndex);
        setStreaming((prev) => {
          const next = new Map(prev);
          const existing = next.get(key);
          next.set(key, {
            kind: parsed.data.kind,
            text: (existing?.text ?? "") + parsed.data.text,
          });
          return next;
        });
      }),
      onEvent("agent_block", (e) => {
        const parsed = AgentBlockPayloadSchema.safeParse(e.payload);
        if (!parsed.success || parsed.data.workerId !== workerId) return;
        setCurrentTurnId(parsed.data.turnId);
        ensureTurnMapped(parsed.data.turnId);
        // The finalized block supersedes any in-progress streaming
        // bubble for the same (turnId, blockIndex) — drop it so the
        // content isn't shown twice.
        const key = streamKey(parsed.data.turnId, parsed.data.blockIndex);
        setStreaming((prev) => {
          if (!prev.has(key)) return prev;
          const next = new Map(prev);
          next.delete(key);
          return next;
        });
        push({ id: `${e.seq}`, kind: "block", payload: parsed.data });
      }),
      onEvent("agent_tool_call", (e) => {
        const parsed = AgentToolCallPayloadSchema.safeParse(e.payload);
        if (parsed.success && parsed.data.workerId === workerId) {
          setCurrentTurnId(parsed.data.turnId);
          ensureTurnMapped(parsed.data.turnId);
          push({ id: `${e.seq}`, kind: "tool_call", payload: parsed.data, result: null });
        }
      }),
      onEvent("agent_tool_result", (e) => {
        const parsed = AgentToolResultPayloadSchema.safeParse(e.payload);
        if (!parsed.success || parsed.data.workerId !== workerId) return;
        setItems((prev) => {
          const idx = prev.findIndex(
            (it) => it.kind === "tool_call" && it.payload.toolUseId === parsed.data.toolUseId,
          );
          // No matching agent_tool_call in this transcript (e.g. the
          // chat mounted mid-turn) — still show the result honestly
          // rather than silently dropping it, labeled as an unknown
          // tool rather than guessing a name.
          if (idx === -1) {
            return [
              ...prev,
              {
                id: `${e.seq}`,
                kind: "tool_call",
                payload: {
                  workerId,
                  turnId: parsed.data.turnId,
                  toolUseId: parsed.data.toolUseId,
                  name: "Unknown Tool",
                  input: {},
                },
                result: parsed.data,
              },
            ];
          }
          const next = [...prev];
          const target = next[idx];
          if (target.kind === "tool_call") {
            next[idx] = { ...target, result: parsed.data };
          }
          return next;
        });
      }),
      onEvent("agent_permission_request", (e) => {
        const parsed = AgentPermissionRequestPayloadSchema.safeParse(e.payload);
        if (parsed.success && parsed.data.workerId === workerId) {
          ensureTurnMapped(parsed.data.turnId);
          push({ id: `${e.seq}`, kind: "permission_denied", payload: parsed.data });
        }
      }),
      onEvent("agent_turn_settled", (e) => {
        const parsed = AgentTurnSettledPayloadSchema.safeParse(e.payload);
        if (!parsed.success || parsed.data.workerId !== workerId) return;
        // Covers a turn that settles having emitted no other event at
        // all (e.g. an immediate error) — without this, such a turn's
        // bubble would never get mapped and an error on it would be
        // silently unattributed instead of marked.
        ensureTurnMapped(parsed.data.turnId);
        push({ id: `${e.seq}`, kind: "settled", payload: parsed.data });
        // One settlement retires exactly one admitted turn — decrement,
        // never reset to 0/false (review FIX-1): other queued turns may
        // still be outstanding.
        setPendingCount((c) => Math.max(0, c - 1));
        setCurrentTurnId(null);
        // Reconcile the optimistic bubble (review B3, corrected by
        // FIX-2): every admitted turn reaches exactly one terminal
        // agent_turn_settled — mark the bubble THIS turnId was mapped
        // to (via ensureTurnMapped's FIFO correlation above), not
        // "whichever pending bubble is most recent." With 2+ queued
        // turns settling FIFO, that heuristic attached an early turn's
        // failure to the LAST bubble instead of the first.
        const bubbleId = turnIdToBubbleRef.current.get(parsed.data.turnId);
        if (parsed.data.status === "error" && bubbleId) {
          setItems((prev) =>
            prev.map((it) =>
              it.id === bubbleId && it.kind === "user" ? { ...it, failed: true } : it,
            ),
          );
        }
        turnIdToBubbleRef.current.delete(parsed.data.turnId);
      }),
    ];

    return () => {
      for (const off of offs) off();
    };
  }, [workerId]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, []);

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    const trimmed = draft.trim();
    if (!trimmed) return;

    const bubbleId = crypto.randomUUID();
    pendingBubbleIdsRef.current.push(bubbleId);
    setItems((prev) => [...prev, { id: bubbleId, kind: "user", text: trimmed, failed: false }]);
    setDraft("");
    // A submit while a turn is already in flight does NOT block — see
    // this component's header doc. `agentSendTurn` itself is what
    // determines whether that's a true interrupt or a queued follow-up
    // (see `canInterruptMidturn` above); this call is identical either
    // way, it just admits the new turn to the backend scheduler.
    setPendingCount((c) => c + 1);

    void agentSendTurn(workerId, trimmed).catch((err) => {
      setPendingCount((c) => Math.max(0, c - 1));
      toast.error(`Send Turn Failed: ${err instanceof Error ? err.message : String(err)}`);
      // Admission itself failed (e.g. the scheduler's queue is full) —
      // no agent_turn_settled will ever arrive for this message, so
      // reconcile the optimistic bubble here directly (review B3),
      // via its own known id (review FIX-2) rather than "whichever
      // pending bubble is most recent" — with queueing, a LATER send
      // may already be pending too. Removed from the FIFO queue by id,
      // not by position, so a still-outstanding EARLIER turn's eventual
      // first event can never be mis-shifted onto this bubble instead
      // of its own (see ensureTurnMapped's doc above). Does NOT touch
      // currentTurnId — an earlier turn may still be actively running.
      pendingBubbleIdsRef.current = pendingBubbleIdsRef.current.filter((id) => id !== bubbleId);
      setItems((prev) =>
        prev.map((it) => (it.id === bubbleId && it.kind === "user" ? { ...it, failed: true } : it)),
      );
    });
  };

  const handleCancel = () => {
    // Cancel is visible whenever busy (pendingCount > 0, review FIX-1)
    // so it doesn't flicker off between one queued turn's settle and
    // the next one's first event — currentTurnId can be briefly null
    // in that gap even though work is still outstanding. There is
    // genuinely nothing to target yet in that split second; a no-op
    // here (rather than hiding the button) is the honest behavior.
    if (!currentTurnId) return;
    void agentCancel(workerId, currentTurnId).catch((err) => {
      toast.error(`Cancel Failed: ${err instanceof Error ? err.message : String(err)}`);
    });
  };

  const streamingEntries = [...streaming.entries()];
  const sendLabel = busy ? (canInterruptMidturn ? "Interrupt" : "Queue Next Turn") : "Send";

  return (
    <div style={containerStyle}>
      <div style={transcriptStyle} ref={scrollRef}>
        {items.length === 0 && streamingEntries.length === 0 && (
          <div style={{ ...settledStyle, alignSelf: "center", marginTop: 24 }}>
            No Messages Yet — Say Something Below
          </div>
        )}
        {items.map((item) => (
          <TranscriptRow key={item.id} item={item} />
        ))}
        {streamingEntries.map(([key, block]) => {
          if (!block.text.trim()) return null;
          if (block.kind === "thinking") {
            return (
              <div key={key} style={thinkingBlockStyle}>
                {block.text}
              </div>
            );
          }
          return (
            <div key={key} style={streamWrapStyle}>
              <AIMessageStream content={block.text} isStreaming={true} />
            </div>
          );
        })}
        {busy && streamingEntries.length === 0 && <div style={settledStyle}>Working…</div>}
      </div>

      {busy && (
        <div style={capabilityNoteStyle}>
          {canInterruptMidturn
            ? "Sending Now Interrupts The Current Turn."
            : "This Provider Has No Mid-Turn Interrupt — Sending Now Queues Behind The Current Turn."}
        </div>
      )}

      <form style={formStyle} onSubmit={handleSubmit}>
        <input
          style={inputStyle}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Message Claude Code…"
          aria-label="Message Claude Code"
        />
        {busy && (
          <button
            type="button"
            style={cancelButtonStyle}
            onClick={handleCancel}
            aria-label="Cancel Turn"
          >
            Cancel
          </button>
        )}
        <button type="submit" style={sendButtonStyle} disabled={!draft.trim()}>
          {sendLabel}
        </button>
      </form>
    </div>
  );
}
