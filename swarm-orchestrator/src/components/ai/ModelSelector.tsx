// ── ModelSelector ───────────────────────────────────
// Claude model selector — iterates the shared catalog in #lib/models
// (single source of truth; no local model list here).
// Per model: context window, cost estimate, capability badges.
// Mythos carries a "Requires Project Glasswing" gating badge.
// Persisted via Jotai atomWithStorage.

import { useAtom } from "jotai";
import { AnimatePresence, motion } from "motion/react";
import type { CSSProperties } from "react";
import { useRef, useState } from "react";
import { CLAUDE_MODELS, formatContextLabel, type ModelInfo, type ModelKey } from "#lib/models";
import { selectedModelAtom } from "#store/ui";

// ── UI-only presentation for each catalog key ───────
// Colors/capability badges are cosmetic and not part of the model
// catalog itself — the catalog (#lib/models) remains the single source
// of truth for ids/labels/pricing/context.

const MODEL_STYLE: Record<ModelKey, { readonly color: string; readonly borderColor: string }> = {
  fable: { color: "oklch(0.80 0.19 55)", borderColor: "oklch(0.42 0.14 55)" },
  mythos: { color: "oklch(0.75 0.22 340)", borderColor: "oklch(0.42 0.16 340)" },
  opus: { color: "oklch(0.72 0.20 290)", borderColor: "oklch(0.40 0.14 290)" },
  sonnet: { color: "oklch(0.78 0.18 205)", borderColor: "oklch(0.40 0.10 205)" },
  haiku: { color: "oklch(0.82 0.18 140)", borderColor: "oklch(0.40 0.10 140)" },
};

const MODEL_CAPABILITIES: Record<ModelKey, readonly string[]> = {
  fable: ["Long-Horizon Reasoning", "Agentic Work", "Adaptive Thinking"],
  mythos: ["Long-Horizon Reasoning", "Agentic Work", "Adaptive Thinking"],
  opus: ["Complex Reasoning", "Deep Analysis", "Code Generation"],
  sonnet: ["Balanced", "Fast Reasoning", "Tool Use"],
  haiku: ["Fast", "Low Cost", "Lightweight Tasks"],
};

/** Ordered `[key, model]` pairs from the shared catalog, for iteration. */
const MODEL_ENTRIES = Object.entries(CLAUDE_MODELS) as ReadonlyArray<[ModelKey, ModelInfo]>;

/** Derives a `$`…`$$$$` cost indicator from the catalog's output price — never hardcoded per model. */
function costIndicator(model: ModelInfo): string {
  if (model.outputPerMTok >= 50) return "$$$$";
  if (model.outputPerMTok >= 20) return "$$$";
  if (model.outputPerMTok >= 10) return "$$";
  return "$";
}

// ── Styles (OKLCH) ──────────────────────────────────

const dropdownTriggerStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  padding: "6px 12px",
  borderRadius: 8,
  border: "1px solid oklch(0.28 0.05 220)",
  background: "oklch(0.12 0.03 220 / 0.9)",
  backdropFilter: "blur(8px)",
  cursor: "pointer",
  transition: "border-color 0.15s ease, background 0.15s ease",
  fontFamily: "var(--font-body, 'DM Sans Variable', system-ui, sans-serif)",
  fontSize: 13,
  color: "oklch(0.82 0.04 220)",
  position: "relative",
};

const dropdownPanelStyle: CSSProperties = {
  position: "absolute",
  top: "100%",
  left: 0,
  right: 0,
  marginTop: 4,
  borderRadius: 8,
  border: "1px solid oklch(0.28 0.05 220)",
  background: "oklch(0.10 0.03 220 / 0.95)",
  backdropFilter: "blur(16px) saturate(1.5)",
  boxShadow: "0 8px 32px oklch(0 0 0 / 0.4)",
  overflow: "hidden",
  zIndex: 50,
  minWidth: 280,
};

const modelOptionStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 4,
  padding: "10px 14px",
  cursor: "pointer",
  transition: "background 0.1s ease",
  borderBottom: "1px solid oklch(0.18 0.03 220)",
};

const modelNameStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  fontSize: 13,
  fontWeight: 600,
};

const modelMetaStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  fontSize: 11,
  color: "oklch(0.58 0.03 220)",
};

const capabilityBadgeStyle: CSSProperties = {
  display: "inline-flex",
  padding: "1px 5px",
  borderRadius: 3,
  fontSize: 10,
  fontWeight: 500,
  background: "oklch(0.16 0.03 220 / 0.6)",
  color: "oklch(0.60 0.04 220)",
  border: "1px solid oklch(0.22 0.03 220)",
};

/** Distinct, minimal badge flagging a gated model (e.g. Mythos → Project Glasswing). */
const gatedBadgeStyle: CSSProperties = {
  display: "inline-flex",
  padding: "1px 6px",
  borderRadius: 3,
  fontSize: 10,
  fontWeight: 600,
  letterSpacing: "0.01em",
  background: "oklch(0.30 0.13 55 / 0.35)",
  color: "oklch(0.85 0.15 55)",
  border: "1px solid oklch(0.48 0.16 55 / 0.6)",
};

const costStyle: CSSProperties = {
  fontSize: 12,
  fontFamily: "var(--font-mono, 'JetBrains Mono Variable', 'Fira Code', monospace)",
};

const selectedDotStyle: CSSProperties = {
  width: 6,
  height: 6,
  borderRadius: "50%",
  flexShrink: 0,
};

// ── Component ───────────────────────────────────────

/**
 * Claude model selector dropdown.
 *
 * - Renders one option per entry in the shared catalog (`#lib/models`)
 * - Shows context window, cost indicator, capability badges per model
 * - Mythos carries a "Requires Project Glasswing" badge; selecting it
 *   is still allowed (the owner's decision — see batch-1 task brief)
 * - Persisted via Jotai `atomWithStorage`
 * - Glass-panel OKLCH styling
 */
export function ModelSelector(): React.ReactElement {
  const [selectedModel, setSelectedModel] = useAtom(selectedModelAtom);
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLFieldSetElement>(null);

  const currentModel = CLAUDE_MODELS[selectedModel];
  const currentStyle = MODEL_STYLE[selectedModel];

  const handleSelect = (key: ModelKey) => {
    setSelectedModel(key);
    setOpen(false);
  };

  // Close on click outside
  const handleBlur = (e: React.FocusEvent) => {
    if (!containerRef.current?.contains(e.relatedTarget as Node)) {
      setOpen(false);
    }
  };

  return (
    <fieldset
      ref={containerRef}
      style={{
        position: "relative",
        display: "inline-block",
        border: "none",
        padding: 0,
        margin: 0,
      }}
      onBlur={handleBlur}
    >
      <button
        type="button"
        onClick={() => setOpen(!open)}
        style={{
          ...dropdownTriggerStyle,
          borderColor: open ? currentStyle.color : "oklch(0.28 0.05 220)",
        }}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label="Select AI Model"
      >
        <span
          style={{
            ...selectedDotStyle,
            background: currentStyle.color,
          }}
        />
        <span>{currentModel.label}</span>
        <span style={{ marginLeft: "auto", color: "oklch(0.55 0.03 220)", fontSize: 12 }}>
          {open ? "▴" : "▾"}
        </span>
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.12 }}
            style={dropdownPanelStyle}
            role="listbox"
            aria-label="AI Model Options"
          >
            {MODEL_ENTRIES.map(([key, model]) => {
              const isSelected = key === selectedModel;
              const style = MODEL_STYLE[key];
              return (
                <div
                  key={key}
                  role="option"
                  aria-selected={isSelected}
                  tabIndex={0}
                  onClick={() => handleSelect(key)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      handleSelect(key);
                    }
                  }}
                  style={{
                    ...modelOptionStyle,
                    background: isSelected
                      ? `${style.color.slice(0, -1)} / 0.14)`
                      : "oklch(0 0 0 / 0)",
                  }}
                >
                  <div style={modelNameStyle}>
                    <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      <span style={{ color: style.color }}>{model.label}</span>
                      {model.gated === "glasswing" && (
                        <span style={gatedBadgeStyle}>Requires Project Glasswing</span>
                      )}
                    </span>
                    <span style={{ ...costStyle, color: style.color }}>{costIndicator(model)}</span>
                  </div>

                  <div style={modelMetaStyle}>
                    <span>{formatContextLabel(model.contextWindow)}</span>
                    <span style={{ color: "oklch(0.35 0.02 220)" }}>{"•"}</span>
                    <span>{model.id}</span>
                  </div>

                  <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginTop: 2 }}>
                    {MODEL_CAPABILITIES[key].map((cap) => (
                      <span key={cap} style={capabilityBadgeStyle}>
                        {cap}
                      </span>
                    ))}
                  </div>
                </div>
              );
            })}
          </motion.div>
        )}
      </AnimatePresence>
    </fieldset>
  );
}
