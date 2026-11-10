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

/** Accent classes per key: `text` and `dot` paint the label and the trigger dot, `border` the open trigger, `tint` the selected option. */
const MODEL_STYLE = {
  fable: {
    text: "text-[oklch(0.80_0.19_55)]",
    dot: "bg-[oklch(0.80_0.19_55)]",
    border: "border-[oklch(0.80_0.19_55)]",
    tint: "bg-[oklch(0.80_0.19_55/0.14)]",
  },
  mythos: {
    text: "text-[oklch(0.75_0.22_340)]",
    dot: "bg-[oklch(0.75_0.22_340)]",
    border: "border-[oklch(0.75_0.22_340)]",
    tint: "bg-[oklch(0.75_0.22_340/0.14)]",
  },
  opus: {
    text: "text-[oklch(0.72_0.20_290)]",
    dot: "bg-[oklch(0.72_0.20_290)]",
    border: "border-[oklch(0.72_0.20_290)]",
    tint: "bg-[oklch(0.72_0.20_290/0.14)]",
  },
  sonnet: {
    text: "text-plasma",
    dot: "bg-plasma",
    border: "border-plasma",
    tint: "bg-plasma/14",
  },
  haiku: {
    text: "text-lime",
    dot: "bg-lime",
    border: "border-lime",
    tint: "bg-lime/14",
  },
} as const satisfies Record<
  ModelKey,
  { readonly text: string; readonly dot: string; readonly border: string; readonly tint: string }
>;

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

// ── Styles (utilities; literals with no token wait for the Q-9 design direction) ──

/** One line at any width: in a narrow toolbar the label ellipsizes (the title names the whole model) instead of wrapping. */
const TRIGGER =
  "flex min-w-0 cursor-pointer items-center gap-2 whitespace-nowrap rounded-md border bg-[oklch(0.12_0.03_220/0.9)] px-3 py-1.5 font-sans text-[13px] text-fg transition-[border-color] duration-150 ease-(--ease-out) [anchor-name:var(--model-anchor)]";

/** CSS anchor positioning where the engine has it (WebKit 26+, Chromium); elsewhere (the WebKit 18.4 floor) the popover is centered in the viewport: `m-auto` restores the UA popover margin that Tailwind's preflight zeroes. */
const SUPPORTS_ANCHOR_POSITIONING = globalThis.CSS?.supports?.("top", "anchor(bottom)") ?? false;

/**
 * The listbox is a popover in the top layer, so no ancestor stacking
 * context (the toolbar's `backdrop-filter`) can trap it and no z-index
 * is needed.
 */
const PANEL =
  "rounded-md border border-border-2 bg-[oklch(0.10_0.03_220/0.95)] p-0 text-fg shadow-[0_8px_32px_oklch(0_0_0/0.4)] backdrop-blur-[16px] backdrop-saturate-150";

const PANEL_CENTERED = "m-auto min-w-70";

/**
 * Keeps the listbox under its trigger through scrolling and resizing,
 * flipping above it when there is no room; used only with
 * SUPPORTS_ANCHOR_POSITIONING.
 */
const PANEL_ANCHORED =
  "mx-0 mb-0 mt-1 top-[anchor(bottom)] right-auto bottom-auto left-[anchor(left)] min-w-[max(280px,anchor-size(width))] [position-anchor:var(--model-anchor)] [position-try-fallbacks:flip-block]";

const OPTION =
  "flex cursor-pointer flex-col gap-1 border-b border-[oklch(0.18_0.03_220)] px-3.5 py-2.5 -outline-offset-2";

const OPTION_HEADER = "flex items-center justify-between text-[13px] font-semibold";

const OPTION_META = "flex items-center gap-2 text-[11px] text-[oklch(0.58_0.03_220)]";

const DOT = "size-1.5 shrink-0 rounded-full";

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
 * anchor positioning where the engine has it. Keyboard: opening focuses
 * the selected option; Arrow Up/Down, Home and End move a roving focus;
 * Enter or Space picks; Tab leaves and closes it. The trigger's
 * accessible name includes the current model.
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
  // Computed per instance, so it travels as a custom property the anchor classes read.
  const anchor = {
    "--model-anchor": `--model-trigger-${id.replace(/[^\w-]/g, "")}`,
  } as CSSProperties;

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
        title={current.label}
        className={`${TRIGGER} ${open ? MODEL_STYLE[currentKey].border : "border-border-2"}`}
        style={anchor}
      >
        <span aria-hidden="true" className={`${DOT} ${MODEL_STYLE[currentKey].dot}`} />
        <span className="truncate">{current.label}</span>
        <span aria-hidden="true" className="ml-auto text-[oklch(0.55_0.03_220)]">
          {open ? "▴" : "▾"}
        </span>
      </button>

      <div
        id={popoverId}
        popover="auto"
        role="listbox"
        aria-label="AI Model Options"
        tabIndex={-1}
        className={`${PANEL} ${SUPPORTS_ANCHOR_POSITIONING ? PANEL_ANCHORED : PANEL_CENTERED} opacity-0 transition-[opacity,translate,display,overlay] transition-discrete duration-150 -translate-y-1 open:translate-y-0 open:opacity-100 starting:open:-translate-y-1 starting:open:opacity-0 motion-reduce:transition-none`}
        style={anchor}
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
              className={`${OPTION} ${isSelected ? style.tint : "bg-transparent"}`}
            >
              <div className={OPTION_HEADER}>
                <span className={`${style.text} whitespace-nowrap`}>{model.label}</span>
                <span className={`${style.text} font-mono text-[12px]`}>
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
              <div className={OPTION_META}>
                <span>{formatContextLabel(model.contextWindow)}</span>
                <span aria-hidden="true" className="text-[oklch(0.35_0.02_220)]">
                  •
                </span>
                <span>{model.id}</span>
              </div>
              <div className="mt-0.5 flex flex-wrap gap-1">
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
