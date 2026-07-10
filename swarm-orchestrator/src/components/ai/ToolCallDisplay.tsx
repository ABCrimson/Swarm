// ── ToolCallDisplay ─────────────────────────────────
// Animated accordion showing tool name, input, and result.
// Uses Framer Motion for expand/collapse.
// Status indicators: pending (spinner), executing (pulse),
// complete (checkmark), error (rose).

import { AnimatePresence, motion } from "motion/react";
import type { CSSProperties } from "react";
import { useState } from "react";
import { Pill } from "#components/ui/Pill";
import { Spinner } from "#components/ui/Spinner";
import { tokenizeJson } from "#lib/syntax-highlight";

// ── Types ───────────────────────────────────────────

type ToolStatus = "pending" | "executing" | "complete" | "error";

interface ToolCallDisplayProps {
  /** Tool name (e.g., "spawn_worker"). */
  readonly name: string;
  /** Tool input as a record. */
  readonly input: Record<string, unknown>;
  /** Tool result, if available. */
  readonly result?: string;
  /** Current execution status. */
  readonly status: ToolStatus;
}

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
  cursor: "pointer",
  userSelect: "none",
  transition: "background 0.15s ease",
};

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

const jsonContainerStyle: CSSProperties = {
  padding: "10px 14px",
  margin: 0,
  fontFamily: "var(--font-mono, 'JetBrains Mono Variable', 'Fira Code', monospace)",
  fontSize: 12,
  lineHeight: 1.6,
  whiteSpace: "pre-wrap",
  wordBreak: "break-all",
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

const chevronStyle: CSSProperties = {
  marginLeft: "auto",
  color: "oklch(0.55 0.03 220)",
  fontSize: 14,
  transition: "transform 0.2s ease",
};

// ── Status Indicator ────────────────────────────────

function StatusIndicator({ status }: { status: ToolStatus }): React.ReactElement {
  switch (status) {
    case "pending":
      return <Spinner size="sm" />;

    case "executing":
      return (
        <output
          style={{
            display: "inline-block",
            width: 8,
            height: 8,
            borderRadius: "50%",
            background: "oklch(0.82 0.19 70)",
            animation: "tool-pulse 1.5s ease-in-out infinite",
          }}
          aria-label="Executing"
        />
      );

    case "complete":
      return (
        <output
          style={{ color: "oklch(0.82 0.18 140)", fontSize: 16, lineHeight: 1 }}
          aria-label="Complete"
        >
          {"\u2713"}
        </output>
      );

    case "error":
      return (
        <output
          style={{ color: "oklch(0.72 0.20 10)", fontSize: 16, lineHeight: 1 }}
          aria-label="Error"
        >
          {"\u2717"}
        </output>
      );
  }
}

// ── JSON Renderer with OKLCH Highlighting ───────────

function HighlightedJson({ data }: { data: unknown }): React.ReactElement {
  const jsonStr = JSON.stringify(data, null, 2);
  const tokens = tokenizeJson(jsonStr);

  // Keyed by cumulative character offset in the source string — a stable,
  // data-derived position since tokens are never reordered or spliced.
  let offset = 0;
  const keyedTokens = tokens.map((token) => {
    const key = offset;
    offset += token.value.length;
    return { ...token, key };
  });

  return (
    <pre style={jsonContainerStyle}>
      {keyedTokens.map((token) => (
        <span key={token.key} style={{ color: token.color }}>
          {token.value}
        </span>
      ))}
    </pre>
  );
}

// ── Collapsible Result Viewer ───────────────────────

function ResultViewer({ result }: { result: string }): React.ReactElement {
  const [collapsed, setCollapsed] = useState(result.length > 500);

  // Try to parse as JSON
  let parsed: unknown;
  try {
    parsed = JSON.parse(result);
  } catch {
    parsed = null;
  }

  if (parsed !== null) {
    if (collapsed) {
      return (
        <div>
          <pre style={{ ...jsonContainerStyle, maxHeight: 120, overflow: "hidden" }}>
            {result.slice(0, 200)}...
          </pre>
          <button
            type="button"
            onClick={() => setCollapsed(false)}
            style={{
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
            }}
          >
            Expand result
          </button>
        </div>
      );
    }

    return <HighlightedJson data={parsed} />;
  }

  // Plain text fallback
  return (
    <pre style={{ ...jsonContainerStyle, color: "oklch(0.82 0.04 220)" }}>
      {collapsed ? `${result.slice(0, 200)}...` : result}
      {collapsed && (
        <button
          type="button"
          onClick={() => setCollapsed(false)}
          style={{
            display: "inline",
            background: "none",
            border: "none",
            color: "oklch(0.65 0.10 205)",
            fontSize: 11,
            cursor: "pointer",
            marginLeft: 4,
          }}
        >
          Show more
        </button>
      )}
    </pre>
  );
}

// ── Component ───────────────────────────────────────

/**
 * Animated accordion displaying a tool call's name, input, and result.
 *
 * - Badge colored per tool name (OKLCH)
 * - Input: JSON with syntax highlighting
 * - Result: collapsible JSON viewer
 * - Status indicators per execution phase
 * - Framer Motion expand/collapse animation
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
          border: "none",
          width: "100%",
          textAlign: "left",
          fontFamily: "inherit",
          fontSize: "inherit",
          color: "inherit",
        }}
        onClick={() => setExpanded(!expanded)}
        aria-expanded={expanded}
        aria-label={`Tool call: ${name}`}
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

        <span style={chevronStyle}>{expanded ? "\u25B4" : "\u25BE"}</span>
      </button>

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
            <HighlightedJson data={input} />

            {result !== undefined && (
              <>
                <span style={sectionLabelStyle}>Result</span>
                <ResultViewer result={result} />
              </>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
