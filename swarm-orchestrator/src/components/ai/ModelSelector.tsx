// ── ModelSelector ───────────────────────────────────
// Claude opus/sonnet/haiku model selector.
// Per model: context window, cost estimate, capability badges.
// Persisted via Jotai atomWithStorage.

import { AnimatePresence, motion } from "framer-motion";
import { useAtom } from "jotai";
import type { CSSProperties } from "react";
import { useRef, useState } from "react";
import { selectedModelAtom } from "#store/ui";

// ── Model Definitions ───────────────────────────────

type ModelKey = "opus" | "sonnet" | "haiku";

interface ModelInfo {
  readonly key: ModelKey;
  readonly label: string;
  readonly id: string;
  readonly contextWindow: string;
  readonly costIndicator: "$$$" | "$$" | "$";
  readonly capabilities: readonly string[];
  readonly color: string;
  readonly borderColor: string;
}

const MODELS: ModelInfo[] = [
  {
    key: "opus",
    label: "Claude Opus",
    id: "claude-opus-4-0-20250514",
    contextWindow: "200K tokens",
    costIndicator: "$$$",
    capabilities: ["Extended thinking", "Complex reasoning", "Code generation", "Analysis"],
    color: "oklch(0.72 0.20 290)",
    borderColor: "oklch(0.40 0.14 290)",
  },
  {
    key: "sonnet",
    label: "Claude Sonnet",
    id: "claude-sonnet-4-20250514",
    contextWindow: "200K tokens",
    costIndicator: "$$",
    capabilities: ["Balanced", "Fast reasoning", "Code generation", "Tool use"],
    color: "oklch(0.78 0.18 205)",
    borderColor: "oklch(0.40 0.10 205)",
  },
  {
    key: "haiku",
    label: "Claude Haiku",
    id: "claude-haiku-3-5-20241022",
    contextWindow: "200K tokens",
    costIndicator: "$",
    capabilities: ["Fast", "Low cost", "Simple tasks", "Lightweight"],
    color: "oklch(0.82 0.18 140)",
    borderColor: "oklch(0.40 0.10 140)",
  },
];

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
  minWidth: 260,
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
 * - Opus / Sonnet / Haiku selection
 * - Shows context window, cost indicator, capability badges per model
 * - Persisted via Jotai `atomWithStorage`
 * - Glass-panel OKLCH styling
 */
export function ModelSelector(): React.ReactElement {
  const [selectedModel, setSelectedModel] = useAtom(selectedModelAtom);
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLFieldSetElement>(null);

  const currentModel = MODELS.find((m) => m.key === selectedModel) ?? MODELS[1];

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
          borderColor: open ? currentModel.color : "oklch(0.28 0.05 220)",
        }}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label="Select AI model"
      >
        <span
          style={{
            ...selectedDotStyle,
            background: currentModel.color,
          }}
        />
        <span>{currentModel.label}</span>
        <span style={{ marginLeft: "auto", color: "oklch(0.55 0.03 220)", fontSize: 12 }}>
          {open ? "\u25B4" : "\u25BE"}
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
            aria-label="AI Model options"
          >
            {MODELS.map((model) => {
              const isSelected = model.key === selectedModel;
              return (
                <div
                  key={model.key}
                  role="option"
                  aria-selected={isSelected}
                  tabIndex={0}
                  onClick={() => handleSelect(model.key)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      handleSelect(model.key);
                    }
                  }}
                  style={{
                    ...modelOptionStyle,
                    background: isSelected
                      ? `oklch(0.16 0.04 ${model.key === "opus" ? 290 : model.key === "sonnet" ? 205 : 140} / 0.3)`
                      : "oklch(0 0 0 / 0)",
                  }}
                >
                  <div style={modelNameStyle}>
                    <span style={{ color: model.color }}>{model.label}</span>
                    <span style={{ ...costStyle, color: model.color }}>{model.costIndicator}</span>
                  </div>

                  <div style={modelMetaStyle}>
                    <span>{model.contextWindow}</span>
                    <span style={{ color: "oklch(0.35 0.02 220)" }}>{"\u2022"}</span>
                    <span>{model.id}</span>
                  </div>

                  <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginTop: 2 }}>
                    {model.capabilities.map((cap) => (
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
