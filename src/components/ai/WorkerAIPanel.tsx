import type { CSSProperties } from "react";
import { useId, useRef, useState } from "react";
import { toast } from "sonner";
import { SplitPane } from "#components/layout/SplitPane";
import { Button } from "#components/ui/Button";
import { ProviderBadge } from "#components/worker/ProviderBadge";
import { WorkerTerminal } from "#components/worker/WorkerTerminal";
import { PROVIDER_LABELS } from "#lib/agent-events";
import { injectInstruction } from "#lib/ai-chat";
import { hasCapability } from "#lib/tauri";
import { useAgentSessionStore } from "#store/agent-sessions";
import { AgentChat } from "./AgentChat.tsx";
import { AIChat } from "./AIChat.tsx";
import { AIQueue } from "./AIQueue.tsx";
import { ModelSelector } from "./ModelSelector.tsx";

interface WorkerAIPanelProps {
  /** Worker ID for this combined view. */
  readonly workerId: string;
  /** Whether this worker has an isolated worktree — shipping (and so the toolbar Ship button) requires one. Defaults to `true`. */
  readonly canShip?: boolean;
  /**
   * Invoked when the toolbar's Ship button is clicked — the detail
   * panel's tab strip (`#pages/Workers`) owns the Ship tab, so this
   * panel can only request the switch, not perform it itself.
   */
  readonly onRequestShipTab?: () => void;
}

// ── Styles (OKLCH) ──────────────────────────────────

const panelContainerStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  height: "100%",
  background: "var(--color-void)",
  overflow: "hidden",
};

const toolbarStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  padding: "6px 12px",
  borderBottom: "1px solid var(--color-border)",
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
  fontFamily: "var(--font-mono)",
};

const flowDotStyle: CSSProperties = {
  width: 6,
  height: 6,
  borderRadius: "50%",
  background: "var(--color-lime)",
};

/** Tailwind's preflight zeroes dialog margins; `margin: auto` re-centers the modal. */
const dialogStyle: CSSProperties = {
  margin: "auto",
  width: 400,
  padding: 20,
  borderRadius: 12,
  background: "oklch(0.12 0.03 220 / 0.95)",
  border: "1px solid var(--color-border-2)",
  backdropFilter: "blur(16px) saturate(1.5)",
  boxShadow: "0 16px 48px oklch(0 0 0 / 0.5)",
  color: "var(--color-fg)",
};

const dialogTitleStyle: CSSProperties = {
  margin: "0 0 12px",
  fontSize: 15,
  fontWeight: 600,
  color: "var(--color-fg)",
};

const labelStyle: CSSProperties = {
  fontSize: 11,
  color: "var(--color-fg-dim)",
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

// ── Inject Instruction Dialog ───────────────────────

/**
 * Ref callback that opens its `<dialog>` as a modal when it mounts.
 * Unmounting needs no cleanup — removing a dialog from the document takes
 * it out of the top layer without a `close` event — and returning none
 * keeps React Strict Mode's dev-only ref re-run from closing (and so
 * dismissing) the dialog it just opened.
 */
function showModalOnMount(dialog: HTMLDialogElement | null): void {
  if (dialog && !dialog.open) dialog.showModal();
}

/**
 * Modal for injecting an instruction into the running conversation — a
 * native `<dialog>` opened with `showModal()` (top layer, inert page,
 * Escape and backdrop-click dismissal via `closedby="any"`, or an `onClick`
 * backdrop test where WebKit lacks it). Cancel and Inject
 * also close it with `close()`, never by unmounting it: only the native close
 * returns focus to the button that opened it; its `close` event then unmounts it.
 */
function InjectDialog({
  onSubmit,
  onClose,
}: {
  readonly onSubmit: (instruction: string) => void;
  readonly onClose: () => void;
}): React.ReactElement {
  const titleId = useId();
  const [value, setValue] = useState("");
  const dialogRef = useRef<HTMLDialogElement>(null);

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: the keyboard path is Escape (the dialog's native `cancel`); this click handler only adds backdrop dismissal where `closedby` is missing.
    <dialog
      ref={(dialog) => {
        dialogRef.current = dialog;
        showModalOnMount(dialog);
      }}
      closedby="any"
      aria-labelledby={titleId}
      onClick={(event) => {
        // WebKit ships no `closedby` yet. A backdrop click targets the
        // dialog itself at a point outside its border box.
        const dialog = event.currentTarget;
        if (event.target !== dialog) return;
        const box = dialog.getBoundingClientRect();
        const { clientX: x, clientY: y } = event;
        if (x < box.left || x > box.right || y < box.top || y > box.bottom) dialog.close();
      }}
      onClose={onClose}
      style={dialogStyle}
      className="backdrop:bg-[oklch(0_0_0/0.5)] backdrop:backdrop-blur-sm"
    >
      <form
        action={() => {
          const trimmed = value.trim();
          if (!trimmed) return;
          onSubmit(trimmed);
          dialogRef.current?.close();
        }}
      >
        <h2 id={titleId} style={dialogTitleStyle}>
          Inject Mid-Conversation Instruction
        </h2>
        <textarea
          className="swarm-input"
          aria-label="Instruction"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="Enter An Instruction For The AI…"
          autoFocus
          style={{ height: "auto", minHeight: 80, padding: "10px 12px", resize: "vertical" }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              e.currentTarget.form?.requestSubmit();
            }
          }}
        />
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 12 }}>
          <Button variant="ghost" size="sm" onClick={() => dialogRef.current?.close()}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" size="sm" disabled={!value.trim()}>
            Inject
          </Button>
        </div>
      </form>
    </dialog>
  );
}

// ── Component ───────────────────────────────────────

/**
 * A worker's terminal (top) and chat (bottom) in a resizable split, with
 * a toolbar: the model selector (webview chat) or the attached agent
 * session's provider badge, an instruction-injection dialog, the Ship
 * shortcut and this worker's slice of the AI queue. The model selector,
 * injection and queue belong to the webview chat, so a transport without
 * `localAiChat` (the `pnpm build:web` page) omits them.
 *
 * A worker with a live provider-adapter session (`#store/agent-sessions`)
 * gets `AgentChat` (turns routed to that session); every other worker
 * gets the webview `AIChat`, whose tools act on workers through their
 * PTYs.
 */
export function WorkerAIPanel({
  workerId,
  canShip,
  onRequestShipTab,
}: WorkerAIPanelProps): React.ReactElement {
  const shippable = canShip ?? true;
  const [showInject, setShowInject] = useState(false);
  const [showQueue, setShowQueue] = useState(false);
  const agentSession = useAgentSessionStore((s) => s.sessions.get(workerId));
  const webviewChat = !agentSession && hasCapability("localAiChat");

  const handleInject = (instruction: string) => {
    const outcome = injectInstruction(workerId, instruction);
    if (outcome === "queued") toast.info("Instruction Queued For The Running Turn");
  };

  return (
    <div style={panelContainerStyle}>
      <div style={toolbarStyle}>
        {agentSession ? (
          <ProviderBadge provider={agentSession.provider} model={agentSession.model} />
        ) : (
          webviewChat && <ModelSelector workerId={workerId} />
        )}

        <div style={flowIndicatorStyle}>
          <span style={flowDotStyle} aria-hidden="true" />
          <span>AI ↔ PTY</span>
        </div>

        {webviewChat && (
          <Button
            size="sm"
            variant="secondary"
            onClick={() => setShowInject(true)}
            style={{ borderColor: "oklch(0.35 0.10 70)", color: "var(--color-amber)" }}
          >
            Inject Instruction
          </Button>
        )}

        {onRequestShipTab != null && (
          <Button
            size="sm"
            variant="secondary"
            onClick={onRequestShipTab}
            disabled={!shippable}
            title={shippable ? undefined : "Shipping Requires An Isolated Worktree"}
            style={
              shippable
                ? { borderColor: "oklch(0.35 0.10 150)", color: "oklch(0.75 0.16 150)" }
                : undefined
            }
          >
            Ship
          </Button>
        )}

        {webviewChat && (
          <Button
            size="sm"
            variant="secondary"
            onClick={() => setShowQueue(!showQueue)}
            aria-pressed={showQueue}
            style={{
              marginLeft: "auto",
              borderColor: "oklch(0.35 0.10 205)",
              color: "var(--color-plasma)",
              background: showQueue ? "oklch(0.20 0.08 205 / 0.6)" : undefined,
            }}
          >
            Queue
          </Button>
        )}
      </div>

      {showQueue && webviewChat && (
        <div style={{ padding: "8px 12px", borderBottom: "1px solid oklch(0.18 0.03 220)" }}>
          <AIQueue workerId={workerId} />
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
              <div style={labelStyle}>
                {agentSession ? PROVIDER_LABELS[agentSession.provider] : "AI Chat"}
              </div>
              <div style={{ flex: 1, minHeight: 0 }}>
                {agentSession ? (
                  <AgentChat key={workerId} workerId={workerId} />
                ) : (
                  <AIChat key={workerId} workerId={workerId} />
                )}
              </div>
            </div>
          }
        />
      </div>

      {showInject && <InjectDialog onSubmit={handleInject} onClose={() => setShowInject(false)} />}
    </div>
  );
}
