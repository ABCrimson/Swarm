// ── AIQueue ─────────────────────────────────────────
// Visual queue display with position indicators, priority badges,
// estimated wait times, and cancel functionality.

import { AnimatePresence, motion } from "motion/react";
import type { CSSProperties } from "react";
import { Spinner } from "#components/ui/Spinner";
import { useAiStore } from "#store/ai";
import type { AiQueueItem } from "#store/types";

// ── Styles (OKLCH) ──────────────────────────────────

const queueContainerStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 2,
  padding: 12,
  background: "oklch(0.08 0.02 220)",
  borderRadius: 8,
  border: "1px solid oklch(0.22 0.04 220)",
};

const headerStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  padding: "0 4px 8px",
  borderBottom: "1px solid oklch(0.18 0.03 220)",
  marginBottom: 4,
};

const headerTitleStyle: CSSProperties = {
  fontSize: 13,
  fontWeight: 600,
  color: "oklch(0.78 0.04 220)",
  fontFamily: "var(--font-body, 'DM Sans Variable', system-ui, sans-serif)",
};

const streamCountStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  fontSize: 12,
  color: "oklch(0.55 0.04 220)",
  fontFamily: "var(--font-mono, 'JetBrains Mono Variable', 'Fira Code', monospace)",
};

const itemStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  padding: "8px 10px",
  borderRadius: 6,
  background: "oklch(0.12 0.03 220 / 0.5)",
  border: "1px solid oklch(0.20 0.03 220)",
};

const positionStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  width: 24,
  height: 24,
  borderRadius: 4,
  background: "oklch(0.16 0.03 220)",
  color: "oklch(0.55 0.04 220)",
  fontSize: 11,
  fontWeight: 700,
  fontFamily: "var(--font-mono, 'JetBrains Mono Variable', 'Fira Code', monospace)",
  flexShrink: 0,
};

const cancelButtonStyle: CSSProperties = {
  marginLeft: "auto",
  padding: "2px 8px",
  borderRadius: 4,
  border: "1px solid oklch(0.30 0.08 10)",
  background: "oklch(0.14 0.04 10 / 0.6)",
  color: "oklch(0.72 0.15 10)",
  fontSize: 11,
  cursor: "pointer",
  transition: "background 0.15s ease",
  flexShrink: 0,
};

const waitEstimateStyle: CSSProperties = {
  fontSize: 11,
  color: "oklch(0.55 0.03 220)",
  fontFamily: "var(--font-mono, 'JetBrains Mono Variable', 'Fira Code', monospace)",
};

const emptyStyle: CSSProperties = {
  textAlign: "center",
  padding: "16px 0",
  color: "oklch(0.55 0.03 220)",
  fontSize: 13,
};

// ── Priority Badge ──────────────────────────────────

const PRIORITY_COLORS: Record<string, { bg: string; text: string; border: string }> = {
  critical: {
    bg: "oklch(0.18 0.08 10 / 0.5)",
    text: "oklch(0.72 0.20 10)",
    border: "oklch(0.40 0.14 10)",
  },
  high: {
    bg: "oklch(0.18 0.08 70 / 0.5)",
    text: "oklch(0.82 0.19 70)",
    border: "oklch(0.40 0.12 70)",
  },
  normal: {
    bg: "oklch(0.18 0.08 205 / 0.5)",
    text: "oklch(0.78 0.18 205)",
    border: "oklch(0.40 0.10 205)",
  },
  low: {
    bg: "oklch(0.14 0.02 220 / 0.5)",
    text: "oklch(0.50 0.03 220)",
    border: "oklch(0.25 0.03 220)",
  },
};

function PriorityBadge({ priority }: { priority: string }): React.ReactElement {
  const colors = PRIORITY_COLORS[priority] ?? PRIORITY_COLORS.normal;
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        padding: "1px 6px",
        borderRadius: 3,
        fontSize: 10,
        fontWeight: 600,
        textTransform: "uppercase",
        letterSpacing: "0.04em",
        background: colors.bg,
        color: colors.text,
        border: `1px solid ${colors.border}`,
      }}
    >
      {priority}
    </span>
  );
}

// ── Status Label ────────────────────────────────────

function StatusLabel({ status }: { status: AiQueueItem["status"] }): React.ReactElement {
  switch (status) {
    case "streaming":
      return (
        <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
          <Spinner size="sm" />
          <span style={{ fontSize: 11, color: "oklch(0.78 0.18 205)" }}>Streaming</span>
        </span>
      );
    case "pending":
      return <span style={{ fontSize: 11, color: "oklch(0.55 0.04 220)" }}>Pending</span>;
    case "complete":
      return <span style={{ fontSize: 11, color: "oklch(0.82 0.18 140)" }}>{"\u2713"} Done</span>;
    case "error":
      return <span style={{ fontSize: 11, color: "oklch(0.72 0.20 10)" }}>{"\u2717"} Error</span>;
  }
}

// ── Average Completion Tracker ──────────────────────

/** Rough average seconds per request for wait estimation. */
const AVG_COMPLETION_SECONDS = 12;

function formatWait(position: number): string {
  const secs = position * AVG_COMPLETION_SECONDS;
  if (secs < 60) return `~${secs}s`;
  const mins = Math.floor(secs / 60);
  const remainSecs = secs % 60;
  return remainSecs > 0 ? `~${mins}m ${remainSecs}s` : `~${mins}m`;
}

// ── Component ───────────────────────────────────────

/**
 * Visual AI request queue display.
 *
 * - Position indicators for each queued item
 * - Priority badges with OKLCH color coding
 * - Estimated wait times based on average completion
 * - Cancel individual items
 * - Concurrent stream count display
 */
export function AIQueue(): React.ReactElement {
  const queue = useAiStore((s) => s.queue);
  const activeStreams = useAiStore((s) => s.activeStreams);
  const concurrentLimit = useAiStore((s) => s.concurrentLimit);
  const dequeue = useAiStore((s) => s.dequeue);

  const handleCancel = (id: string) => {
    dequeue(id);
  };

  const pendingCount = queue.filter((q) => q.status === "pending").length;

  // Position of each pending item within the pending sub-queue (1-based),
  // counting only preceding items that are themselves still pending —
  // streaming/complete/error items ahead in the array don't add wait time.
  let pendingSeen = 0;
  const pendingPositions = queue.map((item) => (item.status === "pending" ? ++pendingSeen : 0));

  return (
    <div style={queueContainerStyle}>
      <div style={headerStyle}>
        <span style={headerTitleStyle}>AI Queue</span>
        <span style={streamCountStyle}>
          {activeStreams}/{concurrentLimit} active
          {pendingCount > 0 && (
            <span style={{ color: "oklch(0.82 0.19 70)" }}>
              {" "}
              {"\u2022"} {pendingCount} pending
            </span>
          )}
        </span>
      </div>

      {queue.length === 0 && <div style={emptyStyle}>No items in queue</div>}

      <AnimatePresence initial={false}>
        {queue.map((item, idx) => (
          <motion.div
            key={item.id}
            initial={{ opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, x: 20 }}
            transition={{ duration: 0.15 }}
            style={itemStyle}
          >
            <span style={positionStyle}>{idx + 1}</span>
            <PriorityBadge priority={item.priority} />
            <StatusLabel status={item.status} />

            {item.status === "pending" && (
              <span style={waitEstimateStyle}>
                {formatWait(Math.max(1, pendingPositions[idx]))}
              </span>
            )}

            {(item.status === "pending" || item.status === "streaming") && (
              <button
                type="button"
                onClick={() => handleCancel(item.id)}
                style={cancelButtonStyle}
                aria-label={`Cancel queue item ${idx + 1}`}
              >
                Cancel
              </button>
            )}
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}
