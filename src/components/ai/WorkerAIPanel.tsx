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

// ── Styles (utilities; literals with no token wait for the Q-9 design direction) ──

const PANEL_CONTAINER = "flex h-full flex-col overflow-hidden bg-void";

/** A control that does not fit drops whole to a second row; no label wraps inside its control. */
const TOOLBAR =
  "flex shrink-0 flex-wrap items-center gap-2 gap-y-1.5 border-b border-border bg-[oklch(0.10_0.02_220/0.9)] px-3 py-1.5 backdrop-blur-[8px]";

const FLOW_INDICATOR =
  "flex shrink-0 items-center gap-1.5 whitespace-nowrap font-sans text-[11px] text-[oklch(0.58_0.04_220)]";

const FLOW_DOT = "size-1.5 shrink-0 rounded-full bg-lime";

/** Tailwind's preflight zeroes dialog margins; `m-auto` re-centers the modal. */
const DIALOG =
  "m-auto w-100 rounded-lg border border-border-2 bg-[oklch(0.12_0.03_220/0.95)] p-5 text-fg shadow-[0_16px_48px_oklch(0_0_0/0.5)] backdrop-blur-[16px] backdrop-saturate-150 backdrop:bg-[oklch(0_0_0/0.5)] backdrop:backdrop-blur-sm";

const DIALOG_TITLE = "mx-0 mt-0 mb-3 text-[15px] font-semibold text-fg";

/** The transcript's 12px gutter, and 8px clear of the split handle so its focus ring (2px, offset 2px) never crosses the label. */
const PANE_LABEL =
  "px-3 pt-2 pb-1 font-display text-(length:--text-md) font-semibold tracking-[-0.01em] text-fg-dim";

const PANE_WRAPPER = "flex h-full flex-col overflow-hidden";

const PANE_BODY = "min-h-0 flex-1";

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
      className={DIALOG}
    >
      <form
        action={() => {
          const trimmed = value.trim();
          if (!trimmed) return;
          onSubmit(trimmed);
          dialogRef.current?.close();
        }}
      >
        <h2 id={titleId} className={DIALOG_TITLE}>
          Inject Mid-Conversation Instruction
        </h2>
        <textarea
          className="swarm-input h-auto max-h-60 min-h-20 resize-y px-3 py-2.5 [field-sizing:content]"
          aria-label="Instruction"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="Enter An Instruction For The AI…"
          autoFocus
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              e.currentTarget.form?.requestSubmit();
            }
          }}
        />
        <div className="mt-3 flex justify-end gap-2">
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
    <div className={PANEL_CONTAINER}>
      <div className={TOOLBAR}>
        {agentSession ? (
          <ProviderBadge provider={agentSession.provider} model={agentSession.model} />
        ) : (
          webviewChat && <ModelSelector workerId={workerId} />
        )}

        <div className={FLOW_INDICATOR}>
          <span className={FLOW_DOT} aria-hidden="true" />
          <span>AI ↔ PTY</span>
        </div>

        {webviewChat && (
          <Button
            size="sm"
            variant="secondary"
            onClick={() => setShowInject(true)}
            className="border-[oklch(0.35_0.10_70)] text-amber"
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
            className={
              shippable ? "border-[oklch(0.35_0.10_150)] text-[oklch(0.75_0.16_150)]" : undefined
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
            className={`ml-auto border-[oklch(0.35_0.10_205)] text-plasma ${showQueue ? "bg-[oklch(0.20_0.08_205/0.6)]" : ""}`}
          >
            Queue
          </Button>
        )}
      </div>

      {showQueue && webviewChat && (
        <div className="border-b border-[oklch(0.18_0.03_220)] px-3 py-2">
          <AIQueue workerId={workerId} />
        </div>
      )}

      <div className={PANE_BODY}>
        <SplitPane
          direction="vertical"
          minPercent={20}
          maxPercent={80}
          primary={
            <div className={PANE_WRAPPER}>
              <div className={PANE_LABEL}>Terminal</div>
              <div className={PANE_BODY}>
                <WorkerTerminal workerId={workerId} />
              </div>
            </div>
          }
          secondary={
            <div className={PANE_WRAPPER}>
              <div className={PANE_LABEL}>
                {agentSession ? PROVIDER_LABELS[agentSession.provider] : "AI Chat"}
              </div>
              <div className={PANE_BODY}>
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
