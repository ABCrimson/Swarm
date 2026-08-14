// ── AgentChat ───────────────────────────────────────
// Minimal event-driven transcript for a worker with a live Claude Code
// session (Phase 3's command surface — see docs/architecture.md's
// adapter-layer section). Renders directly from the agent_* event
// stream; sends turns via agentSendTurn. The polished, richly
// interactive version (tool-call cards, permission timeline, streaming
// deltas rendered live) is the follow-up UI-overhaul branch — this is
// deliberately the minimal surface: one append-only list, one input.

import type { CSSProperties, FormEvent } from "react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
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
  AgentTurnSettledPayloadSchema,
} from "#lib/agent-events";
import { onEvent } from "#lib/event-bus";
import { agentSendTurn } from "#lib/tauri";

interface AgentChatProps {
  readonly workerId: string;
}

type TranscriptItem =
  | { readonly id: string; readonly kind: "user"; readonly text: string }
  | { readonly id: string; readonly kind: "block"; readonly payload: AgentBlockPayload }
  | { readonly id: string; readonly kind: "tool_call"; readonly payload: AgentToolCallPayload }
  | { readonly id: string; readonly kind: "tool_result"; readonly payload: AgentToolResultPayload }
  | {
      readonly id: string;
      readonly kind: "permission_denied";
      readonly payload: AgentPermissionRequestPayload;
    }
  | { readonly id: string; readonly kind: "settled"; readonly payload: AgentTurnSettledPayload };

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

const textBlockStyle: CSSProperties = {
  ...bubbleBaseStyle,
  alignSelf: "flex-start",
  background: "oklch(0.12 0.03 220 / 0.7)",
  color: "oklch(0.90 0.02 220)",
  maxWidth: "90%",
};

const thinkingBlockStyle: CSSProperties = {
  ...bubbleBaseStyle,
  alignSelf: "flex-start",
  background: "transparent",
  color: "oklch(0.50 0.03 220)",
  fontStyle: "italic",
  maxWidth: "90%",
};

const toolChipStyle: CSSProperties = {
  alignSelf: "flex-start",
  padding: "4px 10px",
  borderRadius: 6,
  border: "1px solid oklch(0.35 0.10 70)",
  background: "oklch(0.14 0.06 70 / 0.5)",
  color: "oklch(0.82 0.19 70)",
  fontFamily: "var(--font-mono, monospace)",
  fontSize: 11.5,
};

const toolResultOkStyle: CSSProperties = {
  ...toolChipStyle,
  borderColor: "oklch(0.35 0.10 150)",
  background: "oklch(0.14 0.06 150 / 0.5)",
  color: "oklch(0.75 0.16 150)",
};

const toolResultErrorStyle: CSSProperties = {
  ...toolChipStyle,
  borderColor: "oklch(0.45 0.18 25)",
  background: "oklch(0.16 0.08 25 / 0.5)",
  color: "oklch(0.78 0.20 25)",
};

const permissionDeniedStyle: CSSProperties = {
  alignSelf: "stretch",
  padding: "8px 12px",
  borderRadius: 8,
  border: "1px solid oklch(0.45 0.18 25)",
  background: "oklch(0.16 0.08 25 / 0.4)",
  color: "oklch(0.82 0.19 25)",
  fontFamily: "var(--font-mono, monospace)",
  fontSize: 11.5,
};

const settledStyle: CSSProperties = {
  alignSelf: "center",
  color: "oklch(0.50 0.04 220)",
  fontFamily: "var(--font-mono, monospace)",
  fontSize: 10.5,
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
      return <div style={userBubbleStyle}>{item.text}</div>;
    case "block": {
      const text = renderBlockContent(item.payload.kind, item.payload.content);
      if (!text.trim()) return null;
      if (item.payload.kind === "thinking") {
        return <div style={thinkingBlockStyle}>{text}</div>;
      }
      if (item.payload.kind === "tool_use") return null; // rendered via the tool_call event instead
      return <div style={textBlockStyle}>{text}</div>;
    }
    case "tool_call":
      return (
        <div style={toolChipStyle}>
          {item.payload.name}({JSON.stringify(item.payload.input)})
        </div>
      );
    case "tool_result":
      return (
        <div style={item.payload.isError ? toolResultErrorStyle : toolResultOkStyle}>
          {item.payload.isError ? "Error: " : "Result: "}
          {typeof item.payload.content === "string"
            ? item.payload.content
            : JSON.stringify(item.payload.content)}
        </div>
      );
    case "permission_denied":
      return (
        <div style={permissionDeniedStyle}>
          Denied — {item.payload.tool} ({item.payload.denialSubclass ?? "unknown"}):{" "}
          {item.payload.message}
        </div>
      );
    case "settled":
      return (
        <div style={settledStyle}>
          {item.payload.status === "ok"
            ? "Turn Complete"
            : `Turn Failed: ${item.payload.error ?? ""}`}
          {item.payload.costUsd != null ? ` · $${item.payload.costUsd.toFixed(4)}` : ""}
        </div>
      );
    default:
      return null;
  }
}

// ── Component ─────────────────────────────────────────

/**
 * Minimal event-driven transcript + input for a worker's attached
 * Claude Code session. Every `TranscriptItem` traces to a real
 * `agent_*` event (or the caller's own optimistic outgoing message) —
 * nothing here fabricates content client-side, matching AIChat's own
 * discipline for the webview path.
 */
export function AgentChat({ workerId }: AgentChatProps): React.ReactElement {
  const [items, setItems] = useState<TranscriptItem[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setItems([]);
    setBusy(false);

    const push = (item: TranscriptItem) => setItems((prev) => [...prev, item]);

    const offs = [
      onEvent("agent_block", (e) => {
        const parsed = AgentBlockPayloadSchema.safeParse(e.payload);
        if (parsed.success && parsed.data.workerId === workerId) {
          push({ id: `${e.seq}`, kind: "block", payload: parsed.data });
        }
      }),
      onEvent("agent_tool_call", (e) => {
        const parsed = AgentToolCallPayloadSchema.safeParse(e.payload);
        if (parsed.success && parsed.data.workerId === workerId) {
          push({ id: `${e.seq}`, kind: "tool_call", payload: parsed.data });
        }
      }),
      onEvent("agent_tool_result", (e) => {
        const parsed = AgentToolResultPayloadSchema.safeParse(e.payload);
        if (parsed.success && parsed.data.workerId === workerId) {
          push({ id: `${e.seq}`, kind: "tool_result", payload: parsed.data });
        }
      }),
      onEvent("agent_permission_request", (e) => {
        const parsed = AgentPermissionRequestPayloadSchema.safeParse(e.payload);
        if (parsed.success && parsed.data.workerId === workerId) {
          push({ id: `${e.seq}`, kind: "permission_denied", payload: parsed.data });
        }
      }),
      onEvent("agent_turn_settled", (e) => {
        const parsed = AgentTurnSettledPayloadSchema.safeParse(e.payload);
        if (parsed.success && parsed.data.workerId === workerId) {
          push({ id: `${e.seq}`, kind: "settled", payload: parsed.data });
          setBusy(false);
        }
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
    if (!trimmed || busy) return;

    setItems((prev) => [...prev, { id: crypto.randomUUID(), kind: "user", text: trimmed }]);
    setDraft("");
    setBusy(true);

    void agentSendTurn(workerId, trimmed).catch((err) => {
      setBusy(false);
      toast.error(`Send Turn Failed: ${err instanceof Error ? err.message : String(err)}`);
    });
  };

  return (
    <div style={containerStyle}>
      <div style={transcriptStyle} ref={scrollRef}>
        {items.length === 0 && (
          <div style={{ ...settledStyle, alignSelf: "center", marginTop: 24 }}>
            No Messages Yet — Say Something Below
          </div>
        )}
        {items.map((item) => (
          <TranscriptRow key={item.id} item={item} />
        ))}
        {busy && <div style={settledStyle}>Working…</div>}
      </div>
      <form style={formStyle} onSubmit={handleSubmit}>
        <input
          style={inputStyle}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Message Claude Code…"
          disabled={busy}
          aria-label="Message Claude Code"
        />
        <button type="submit" style={sendButtonStyle} disabled={busy || !draft.trim()}>
          Send
        </button>
      </form>
    </div>
  );
}
