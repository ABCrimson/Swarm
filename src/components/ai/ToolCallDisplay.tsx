import { AnimatePresence, MotionConfig, motion } from "motion/react";
import type { CSSProperties } from "react";
import { useState } from "react";
import { Pill } from "#components/ui/Pill";
import { HighlightedJson } from "./HighlightedJson.tsx";

// ── Types ───────────────────────────────────────────

type ToolStatus = "executing" | "complete" | "error";

interface ToolCallDisplayProps {
  /** Tool name (e.g., "spawn_worker"). */
  readonly name: string;
  /** Tool input as a record. */
  readonly input: Record<string, unknown>;
  /** Tool result, once the call has run. */
  readonly result?: string;
  /** Current execution status. */
  readonly status: ToolStatus;
}

const STATUS_LABEL: Record<ToolStatus, string> = {
  executing: "Executing",
  complete: "Complete",
  error: "Error",
};

// ── Styles (OKLCH) ──────────────────────────────────

const containerStyle: CSSProperties = {
  borderRadius: 8,
  border: "1px solid oklch(0.22 0.04 220)",
  background: "oklch(0.10 0.02 220 / 0.8)",
  overflow: "hidden",
  marginBlock: 6,
};

const headerStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  padding: "8px 12px",
  width: "100%",
  border: "none",
  textAlign: "left",
  fontFamily: "inherit",
  fontSize: "inherit",
  color: "inherit",
  cursor: "pointer",
  userSelect: "none",
  transition: "background 0.15s ease",
};

/** Per-tool accent colors for the built-in tools; custom tools get the neutral default. */
const TOOL_BADGE_COLORS: Record<string, { bg: string; text: string; border: string }> = {
  spawn_worker: {
    bg: "oklch(0.18 0.06 205 / 0.4)",
    text: "oklch(0.78 0.18 205)",
    border: "oklch(0.35 0.10 205)",
  },
  kill_worker: {
    bg: "oklch(0.18 0.06 10 / 0.4)",
    text: "oklch(0.72 0.20 10)",
    border: "oklch(0.35 0.10 10)",
  },
  run_command: {
    bg: "oklch(0.18 0.06 70 / 0.4)",
    text: "oklch(0.82 0.19 70)",
    border: "oklch(0.35 0.10 70)",
  },
  read_file: {
    bg: "oklch(0.18 0.06 140 / 0.4)",
    text: "oklch(0.82 0.18 140)",
    border: "oklch(0.35 0.10 140)",
  },
  write_file: {
    bg: "oklch(0.18 0.06 290 / 0.4)",
    text: "oklch(0.72 0.20 290)",
    border: "oklch(0.35 0.10 290)",
  },
  get_metrics: {
    bg: "oklch(0.18 0.06 170 / 0.4)",
    text: "oklch(0.78 0.18 170)",
    border: "oklch(0.35 0.10 170)",
  },
};

const DEFAULT_BADGE_COLORS = {
  bg: "oklch(0.18 0.04 220 / 0.4)",
  text: "oklch(0.65 0.06 220)",
  border: "oklch(0.30 0.05 220)",
};

const jsonStyle: CSSProperties = {
  padding: "10px 14px",
  fontSize: 12,
  lineHeight: 1.6,
  background: "oklch(0.08 0.02 220)",
  borderTop: "1px solid oklch(0.18 0.03 220)",
};

const sectionLabelStyle: CSSProperties = {
  display: "block",
  padding: "6px 14px 2px",
  fontSize: 10,
  fontWeight: 600,
  textTransform: "uppercase",
  letterSpacing: "0.08em",
  color: "oklch(0.55 0.04 220)",
  background: "oklch(0.08 0.02 220)",
};

const expandButtonStyle: CSSProperties = {
  display: "block",
  width: "100%",
  padding: "4px 14px",
  background: "oklch(0.08 0.02 220)",
  border: "none",
  borderTop: "1px solid oklch(0.18 0.03 220)",
  color: "oklch(0.65 0.10 205)",
  fontSize: 11,
  cursor: "pointer",
  textAlign: "center",
};

// ── Status Indicator ────────────────────────────────

function StatusIndicator({ status }: { readonly status: ToolStatus }): React.ReactElement {
  switch (status) {
    case "executing":
      return (
        <span
          className="motion-safe:animate-[tool-pulse_1.5s_ease-in-out_infinite]"
          style={{
            display: "inline-block",
            width: 8,
            height: 8,
            borderRadius: "50%",
            background: "oklch(0.82 0.19 70)",
          }}
          aria-hidden="true"
        />
      );
    case "complete":
      return (
        <span
          style={{ color: "oklch(0.82 0.18 140)", fontSize: 16, lineHeight: 1 }}
          aria-hidden="true"
        >
          ✓
        </span>
      );
    case "error":
      return (
        <span
          style={{ color: "oklch(0.72 0.20 10)", fontSize: 16, lineHeight: 1 }}
          aria-hidden="true"
        >
          ✗
        </span>
      );
  }
}

// ── Collapsible Result Viewer ───────────────────────

/** Results longer than this start collapsed. */
const COLLAPSE_THRESHOLD = 500;

function parseJson(
  text: string,
): { readonly ok: true; readonly value: unknown } | { readonly ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

function ResultViewer({ result }: { readonly result: string }): React.ReactElement {
  const [collapsed, setCollapsed] = useState(result.length > COLLAPSE_THRESHOLD);
  const parsed = parseJson(result);

  if (collapsed) {
    return (
      <div>
        <pre
          style={{
            ...jsonStyle,
            margin: 0,
            maxHeight: 120,
            overflow: "hidden",
            fontFamily: "var(--font-mono, monospace)",
            whiteSpace: "pre-wrap",
            overflowWrap: "anywhere",
          }}
        >
          {result.slice(0, 200)}…
        </pre>
        <button type="button" onClick={() => setCollapsed(false)} style={expandButtonStyle}>
          Show Full Result
        </button>
      </div>
    );
  }

  return parsed.ok ? (
    <HighlightedJson data={parsed.value} style={jsonStyle} />
  ) : (
    <pre
      style={{
        ...jsonStyle,
        margin: 0,
        color: "oklch(0.82 0.04 220)",
        fontFamily: "var(--font-mono, monospace)",
        whiteSpace: "pre-wrap",
        overflowWrap: "anywhere",
      }}
    >
      {result}
    </pre>
  );
}

// ── Component ───────────────────────────────────────

/**
 * Collapsible card for one tool call: a status indicator (reduced-motion
 * aware), the tool's name badge, and — expanded — its input and result
 * as highlighted JSON (long results start collapsed). The expand button's
 * accessible name carries the tool and its status.
 */
export function ToolCallDisplay({
  name,
  input,
  result,
  status,
}: ToolCallDisplayProps): React.ReactElement {
  const [expanded, setExpanded] = useState(false);
  const badgeColors = TOOL_BADGE_COLORS[name] ?? DEFAULT_BADGE_COLORS;

  return (
    <div style={containerStyle}>
      <button
        type="button"
        style={{
          ...headerStyle,
          background: expanded ? "oklch(0.12 0.03 220 / 0.5)" : "oklch(0 0 0 / 0)",
        }}
        onClick={() => setExpanded(!expanded)}
        aria-expanded={expanded}
        aria-label={`Tool Call: ${name}, ${STATUS_LABEL[status]}`}
      >
        <StatusIndicator status={status} />
        <Pill
          tone="neutral"
          size="sm"
          style={{
            background: badgeColors.bg,
            color: badgeColors.text,
            borderColor: badgeColors.border,
          }}
        >
          {name}
        </Pill>
        <span
          style={{ marginLeft: "auto", color: "oklch(0.55 0.03 220)", fontSize: 14 }}
          aria-hidden="true"
        >
          {expanded ? "▴" : "▾"}
        </span>
      </button>

      <MotionConfig reducedMotion="user">
        <AnimatePresence initial={false}>
          {expanded && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: "auto", opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.2, ease: "easeInOut" }}
              style={{ overflow: "hidden" }}
            >
              <span style={sectionLabelStyle}>Input</span>
              <HighlightedJson data={input} style={jsonStyle} />
              {result !== undefined && (
                <>
                  <span style={sectionLabelStyle}>Result</span>
                  <ResultViewer result={result} />
                </>
              )}
            </motion.div>
          )}
        </AnimatePresence>
      </MotionConfig>
    </div>
  );
}
