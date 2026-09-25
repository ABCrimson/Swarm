import { useAtom } from "jotai";
import type { CSSProperties } from "react";
import { useId, useRef, useState } from "react";
import { Pill } from "#components/ui/Pill";
import {
  CLAUDE_MODELS,
  formatContextLabel,
  MODEL_KEYS,
  type ModelInfo,
  type ModelKey,
  warnIfModelGated,
} from "#lib/models";
import { selectedModelAtom } from "#store/ui";
import { useWorkerAgentStore } from "#store/worker-agents";

// ── Presentation per catalog key ─────────────────────
// Colors and capability badges are cosmetic, so they live here; ids,
// labels, prices and limits come from the catalog (#lib/models).

const MODEL_STYLE = {
  fable: { color: "oklch(0.80 0.19 55)", tint: "oklch(0.80 0.19 55 / 0.14)" },
  mythos: { color: "oklch(0.75 0.22 340)", tint: "oklch(0.75 0.22 340 / 0.14)" },
  opus: { color: "oklch(0.72 0.20 290)", tint: "oklch(0.72 0.20 290 / 0.14)" },
  sonnet: { color: "oklch(0.78 0.18 205)", tint: "oklch(0.78 0.18 205 / 0.14)" },
  haiku: { color: "oklch(0.82 0.18 140)", tint: "oklch(0.82 0.18 140 / 0.14)" },
} as const satisfies Record<ModelKey, { readonly color: string; readonly tint: string }>;

const MODEL_CAPABILITIES = {
  fable: ["Long-Horizon Reasoning", "Agentic Work", "Adaptive Thinking"],
  mythos: ["Long-Horizon Reasoning", "Agentic Work", "Adaptive Thinking"],
  opus: ["Complex Reasoning", "Deep Analysis", "Code Generation"],
  sonnet: ["Balanced", "Fast Reasoning", "Tool Use"],
  haiku: ["Fast", "Low Cost", "Lightweight Tasks"],
} as const satisfies Record<ModelKey, readonly string[]>;

/** A `$`…`$$$$` cost indicator derived from the catalog's output price. */
function costIndicator(model: ModelInfo): string {
  if (model.outputPerMTok >= 50) return "$$$$";
  if (model.outputPerMTok >= 20) return "$$$";
  if (model.outputPerMTok >= 10) return "$$";
  return "$";
}

// ── Styles (OKLCH) ──────────────────────────────────

const triggerStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  padding: "6px 12px",
  borderRadius: 8,
  border: "1px solid oklch(0.28 0.05 220)",
  background: "oklch(0.12 0.03 220 / 0.9)",
  cursor: "pointer",
  transition: "border-color 0.15s ease",
  fontFamily: "var(--font-body, 'DM Sans Variable', system-ui, sans-serif)",
  fontSize: 13,
  color: "oklch(0.82 0.04 220)",
};

/**
 * The listbox is a popover in the top layer, so no ancestor stacking
 * context (the toolbar's `backdrop-filter`) can trap it and no z-index
 * is needed; CSS anchor positioning keeps it under its trigger through
 * scrolling and resizing, flipping above it when there is no room.
 */
const panelStyle: CSSProperties = {
  margin: 0,
  inset: "auto",
  top: "anchor(bottom)",
  left: "anchor(left)",
  marginTop: 4,
  minWidth: "max(280px, anchor-size(width))",
  positionTryFallbacks: "flip-block",
  padding: 0,
  borderRadius: 8,
  border: "1px solid oklch(0.28 0.05 220)",
  background: "oklch(0.10 0.03 220 / 0.95)",
  backdropFilter: "blur(16px) saturate(1.5)",
  boxShadow: "0 8px 32px oklch(0 0 0 / 0.4)",
  color: "oklch(0.82 0.04 220)",
};

const optionStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 4,
  padding: "10px 14px",
  cursor: "pointer",
  borderBottom: "1px solid oklch(0.18 0.03 220)",
  outlineOffset: -2,
};

const optionHeaderStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  fontSize: 13,
  fontWeight: 600,
};

const optionMetaStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  fontSize: 11,
  color: "oklch(0.58 0.03 220)",
};

const dotStyle: CSSProperties = { width: 6, height: 6, borderRadius: "50%", flexShrink: 0 };

// ── Component ───────────────────────────────────────

interface ModelSelectorProps {
  /**
   * Ties the selector to one worker's chat. When that worker has a
   * template-pinned model (`model` in `useWorkerAgentStore`), that entry
   * is the source of truth for both display and selection — a pick
   * overwrites it instead of the global, persisted `selectedModelAtom`.
   * Otherwise the selector reads and writes the global selection.
   */
  readonly workerId?: string;
}

/**
 * Claude model picker: a trigger button that opens a listbox of every
 * catalog model (context window, cost tier, capability badges; Mythos is
 * marked "Requires Project Glasswing" and warns when picked).
 *
 * Built on the platform: the listbox is a `popover="auto"` opened by the
 * trigger's `popovertarget` (top layer, light dismiss on outside click
 * and Escape, focus returning to the trigger) and positioned with CSS
 * anchor positioning. Keyboard: opening focuses the selected option;
 * Arrow Up/Down, Home and End move a roving focus; Enter or Space picks;
 * Tab leaves and closes it. The trigger's accessible name includes the
 * current model.
 */
export function ModelSelector({ workerId }: ModelSelectorProps): React.ReactElement {
  const [selectedModel, setSelectedModel] = useAtom(selectedModelAtom);
  const agentMetadata = useWorkerAgentStore((s) =>
    workerId ? s.metadata.get(workerId) : undefined,
  );
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const id = useId();
  const popoverId = `model-listbox-${id}`;
  const anchorName = `--model-trigger-${id.replace(/[^\w-]/g, "")}`;

  const pinned = agentMetadata?.model;
  const currentKey = pinned ?? selectedModel;
  const current = CLAUDE_MODELS[currentKey];

  const select = (key: ModelKey, popover: HTMLElement | null) => {
    if (workerId && agentMetadata && pinned !== undefined) {
      useWorkerAgentStore.getState().setAgentMetadata(workerId, { ...agentMetadata, model: key });
    } else {
      setSelectedModel(key);
    }
    warnIfModelGated(CLAUDE_MODELS[key]);
    popover?.hidePopover();
    triggerRef.current?.focus();
  };

  const focusOption = (listbox: HTMLElement, index: number) => {
    const options = listbox.querySelectorAll<HTMLElement>("[role='option']");
    options[(index + options.length) % options.length]?.focus();
  };

  const onListKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const listbox = e.currentTarget;
    const options = [...listbox.querySelectorAll<HTMLElement>("[role='option']")];
    const index = options.indexOf(document.activeElement as HTMLElement);
    switch (e.key) {
      case "ArrowDown":
        focusOption(listbox, index + 1);
        break;
      case "ArrowUp":
        focusOption(listbox, index - 1);
        break;
      case "Home":
        focusOption(listbox, 0);
        break;
      case "End":
        focusOption(listbox, options.length - 1);
        break;
      default:
        return;
    }
    e.preventDefault();
  };

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        popoverTarget={popoverId}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`AI Model: ${current.label}`}
        style={{
          ...triggerStyle,
          anchorName,
          borderColor: open ? MODEL_STYLE[currentKey].color : "oklch(0.28 0.05 220)",
        }}
      >
        <span
          aria-hidden="true"
          style={{ ...dotStyle, background: MODEL_STYLE[currentKey].color }}
        />
        <span>{current.label}</span>
        <span aria-hidden="true" style={{ marginLeft: "auto", color: "oklch(0.55 0.03 220)" }}>
          {open ? "▴" : "▾"}
        </span>
      </button>

      <div
        id={popoverId}
        popover="auto"
        role="listbox"
        aria-label="AI Model Options"
        tabIndex={-1}
        className="opacity-0 transition-[opacity,translate,display,overlay] transition-discrete duration-150 -translate-y-1 open:translate-y-0 open:opacity-100 starting:open:-translate-y-1 starting:open:opacity-0 motion-reduce:transition-none"
        style={{ ...panelStyle, positionAnchor: anchorName }}
        onToggle={(e) => {
          const isOpen = e.newState === "open";
          setOpen(isOpen);
          if (isOpen) {
            const selected = e.currentTarget.querySelector<HTMLElement>("[aria-selected='true']");
            selected?.focus();
          }
        }}
        onKeyDown={onListKeyDown}
        onBlur={(e) => {
          // Tab (or any focus move) out of the listbox closes it. Focus
          // moving to the trigger is its own popovertarget toggle.
          const next = e.relatedTarget as Node | null;
          if (next && next !== triggerRef.current && !e.currentTarget.contains(next)) {
            e.currentTarget.hidePopover();
          }
        }}
      >
        {MODEL_KEYS.map((key) => {
          const model = CLAUDE_MODELS[key];
          const isSelected = key === currentKey;
          const style = MODEL_STYLE[key];
          return (
            <div
              key={key}
              role="option"
              aria-selected={isSelected}
              // Roving focus: only the selected option is a Tab stop.
              tabIndex={isSelected ? 0 : -1}
              onClick={(e) => select(key, e.currentTarget.closest<HTMLElement>("[popover]"))}
              onKeyDown={(e) => {
                if (e.key !== "Enter" && e.key !== " ") return;
                e.preventDefault();
                select(key, e.currentTarget.closest<HTMLElement>("[popover]"));
              }}
              style={{ ...optionStyle, background: isSelected ? style.tint : "oklch(0 0 0 / 0)" }}
            >
              <div style={optionHeaderStyle}>
                <span style={{ color: style.color, whiteSpace: "nowrap" }}>{model.label}</span>
                <span
                  style={{
                    color: style.color,
                    fontSize: 12,
                    fontFamily: "var(--font-mono, monospace)",
                  }}
                >
                  {costIndicator(model)}
                </span>
              </div>
              {model.gated === "glasswing" && (
                <div>
                  <Pill tone="warning" size="sm">
                    Requires Project Glasswing
                  </Pill>
                </div>
              )}
              <div style={optionMetaStyle}>
                <span>{formatContextLabel(model.contextWindow)}</span>
                <span aria-hidden="true" style={{ color: "oklch(0.35 0.02 220)" }}>
                  •
                </span>
                <span>{model.id}</span>
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginTop: 2 }}>
                {MODEL_CAPABILITIES[key].map((capability) => (
                  <Pill key={capability} tone="neutral" size="sm">
                    {capability}
                  </Pill>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </>
  );
}
