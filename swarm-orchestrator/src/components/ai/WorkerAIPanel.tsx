// ── WorkerAIPanel ───────────────────────────────────
// Combined view: terminal on top, AI chat on bottom.
// AI tool execution routes through worker's PTY.
// Bidirectional flow visualization + inject instruction button.

import type { CSSProperties } from "react";
import { useState } from "react";
import { SplitPane } from "#components/layout/SplitPane";
import { WorkerTerminal } from "#components/worker/WorkerTerminal";
import { AIChat } from "./AIChat.tsx";
import { AIQueue } from "./AIQueue.tsx";
import { ModelSelector } from "./ModelSelector.tsx";

interface WorkerAIPanelProps {
  /** Worker ID for this combined view. */
  readonly workerId: string;
}

// ── Styles (OKLCH) ──────────────────────────────────

const panelContainerStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  height: "100%",
  background: "oklch(0.06 0.02 220)",
  overflow: "hidden",
};

const toolbarStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  padding: "6px 12px",
  borderBottom: "1px solid oklch(0.22 0.04 220)",
  background: "oklch(0.10 0.02 220 / 0.9)",
  backdropFilter: "blur(8px)",
  flexShrink: 0,
};

const flowIndicatorStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  fontSize: 11,
  color: "oklch(0.58 0.04 220)",
  fontFamily: "var(--font-mono, 'JetBrains Mono Variable', 'Fira Code', monospace)",
};

const flowDotStyle: CSSProperties = {
  width: 6,
  height: 6,
  borderRadius: "50%",
  background: "oklch(0.82 0.18 140)",
};

const injectButtonStyle: CSSProperties = {
  padding: "4px 10px",
  borderRadius: 6,
  border: "1px solid oklch(0.35 0.10 70)",
  background: "oklch(0.14 0.06 70 / 0.6)",
  color: "oklch(0.82 0.19 70)",
  fontSize: 11,
  fontWeight: 500,
  cursor: "pointer",
  transition: "background 0.15s ease",
};

const modalOverlayStyle: CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "oklch(0 0 0 / 0.5)",
  backdropFilter: "blur(4px)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  zIndex: 100,
};

const modalStyle: CSSProperties = {
  width: 400,
  padding: 20,
  borderRadius: 12,
  background: "oklch(0.12 0.03 220 / 0.95)",
  border: "1px solid oklch(0.28 0.05 220)",
  backdropFilter: "blur(16px) saturate(1.5)",
  boxShadow: "0 16px 48px oklch(0 0 0 / 0.5)",
};

const modalTitleStyle: CSSProperties = {
  fontSize: 15,
  fontWeight: 600,
  color: "oklch(0.82 0.04 220)",
  marginBottom: 12,
};

const modalTextareaStyle: CSSProperties = {
  width: "100%",
  padding: "10px 12px",
  borderRadius: 8,
  border: "1px solid oklch(0.28 0.05 220)",
  background: "oklch(0.08 0.02 220)",
  color: "oklch(0.88 0.03 220)",
  fontFamily: "var(--font-body, 'DM Sans Variable', system-ui, sans-serif)",
  fontSize: 13,
  lineHeight: 1.5,
  resize: "vertical",
  outline: "none",
  minHeight: 80,
  boxSizing: "border-box",
};

const modalActionsStyle: CSSProperties = {
  display: "flex",
  justifyContent: "flex-end",
  gap: 8,
  marginTop: 12,
};

const labelStyle: CSSProperties = {
  fontSize: 11,
  color: "oklch(0.55 0.04 220)",
  fontWeight: 500,
  textTransform: "uppercase",
  letterSpacing: "0.06em",
  padding: "0 4px",
};

const paneWrapperStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  height: "100%",
  overflow: "hidden",
};

// ── Inject Instruction Modal ────────────────────────

function InjectModal({
  onSubmit,
  onClose,
}: {
  onSubmit: (instruction: string) => void;
  onClose: () => void;
}): React.ReactElement {
  const [value, setValue] = useState("");

  const handleSubmit = () => {
    const trimmed = value.trim();
    if (trimmed) {
      onSubmit(trimmed);
      onClose();
    }
  };

  return (
    <div style={modalOverlayStyle}>
      <dialog
        open
        style={{
          ...modalStyle,
          position: "relative",
        }}
        aria-label="Inject instruction"
        onClose={onClose}
      >
        <div style={modalTitleStyle}>Inject Mid-Conversation Instruction</div>
        <textarea
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="Enter instruction to inject into the AI conversation..."
          style={modalTextareaStyle}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              handleSubmit();
            }
          }}
        />
        <div style={modalActionsStyle}>
          <button
            type="button"
            onClick={onClose}
            style={{
              padding: "6px 14px",
              borderRadius: 6,
              border: "1px solid oklch(0.28 0.05 220)",
              background: "oklch(0.12 0.03 220)",
              color: "oklch(0.65 0.04 220)",
              fontSize: 12,
              cursor: "pointer",
            }}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={!value.trim()}
            style={{
              padding: "6px 14px",
              borderRadius: 6,
              border: "none",
              background: "oklch(0.78 0.18 205)",
              color: "oklch(0.10 0.03 205)",
              fontSize: 12,
              fontWeight: 600,
              cursor: value.trim() ? "pointer" : "not-allowed",
              opacity: value.trim() ? 1 : 0.5,
            }}
          >
            Inject
          </button>
        </div>
      </dialog>
    </div>
  );
}

// ── Component ───────────────────────────────────────

/**
 * Combined worker terminal + AI chat panel.
 *
 * - Terminal on top, AI chat on bottom in a SplitPane
 * - Toolbar with model selector, queue info, flow indicators
 * - Inject instruction button for mid-conversation commands
 * - Bidirectional flow: AI sends commands to PTY, results flow back
 */
export function WorkerAIPanel({ workerId }: WorkerAIPanelProps): React.ReactElement {
  const [showInjectModal, setShowInjectModal] = useState(false);
  const [showQueue, setShowQueue] = useState(false);
  // Each injection gets a fresh id so AIChat's effect fires even when the
  // same instruction text is injected twice in a row.
  const [injection, setInjection] = useState<{ id: string; content: string } | null>(null);

  const handleInject = (instruction: string) => {
    setInjection({ id: crypto.randomUUID(), content: instruction });
  };

  return (
    <div style={panelContainerStyle}>
      <div style={toolbarStyle}>
        <ModelSelector />

        <div style={flowIndicatorStyle}>
          <span style={flowDotStyle} />
          <span>AI {"\u2194"} PTY</span>
        </div>

        <button
          type="button"
          onClick={() => setShowInjectModal(true)}
          style={injectButtonStyle}
          aria-label="Inject instruction"
        >
          Inject Instruction
        </button>

        <button
          type="button"
          onClick={() => setShowQueue(!showQueue)}
          style={{
            ...injectButtonStyle,
            borderColor: "oklch(0.35 0.10 205)",
            background: showQueue ? "oklch(0.20 0.08 205 / 0.6)" : "oklch(0.14 0.06 205 / 0.6)",
            color: "oklch(0.78 0.18 205)",
            marginLeft: "auto",
          }}
          aria-label="Toggle queue"
          aria-pressed={showQueue}
        >
          Queue
        </button>
      </div>

      {showQueue && (
        <div style={{ padding: "8px 12px", borderBottom: "1px solid oklch(0.18 0.03 220)" }}>
          <AIQueue />
        </div>
      )}

      <div style={{ flex: 1, minHeight: 0 }}>
        <SplitPane
          direction="vertical"
          minPercent={20}
          maxPercent={80}
          primary={
            <div style={paneWrapperStyle}>
              <div style={labelStyle}>Terminal</div>
              <div style={{ flex: 1, minHeight: 0 }}>
                <WorkerTerminal workerId={workerId} />
              </div>
            </div>
          }
          secondary={
            <div style={paneWrapperStyle}>
              <div style={labelStyle}>AI Chat</div>
              <div style={{ flex: 1, minHeight: 0 }}>
                <AIChat workerId={workerId} injectedInstruction={injection} />
              </div>
            </div>
          }
        />
      </div>

      {showInjectModal && (
        <InjectModal onSubmit={handleInject} onClose={() => setShowInjectModal(false)} />
      )}
    </div>
  );
}
