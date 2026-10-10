import { AnimatePresence, MotionConfig, motion } from "motion/react";
import type { CSSProperties } from "react";
import type { PillTone } from "#components/ui/Pill";
import { Pill } from "#components/ui/Pill";
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
  margin: 0,
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
  color: "var(--color-fg-dim)",
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
  color: "var(--color-fg-dim)",
  fontSize: 11,
  fontWeight: 700,
  fontFamily: "var(--font-mono, 'JetBrains Mono Variable', 'Fira Code', monospace)",
  flexShrink: 0,
};

const emptyStyle: CSSProperties = {
  textAlign: "center",
  padding: "16px 0",
  color: "var(--color-fg-dim)",
  fontSize: 13,
};

// ── Priority Badge ──────────────────────────────────

const PRIORITY_TONE = {
  critical: "danger",
  high: "warning",
  normal: "info",
  low: "neutral",
} as const satisfies Record<AiQueueItem["priority"], PillTone>;

const PRIORITY_LABEL = {
  critical: "Critical",
  high: "High",
  normal: "Normal",
  low: "Low",
} as const satisfies Record<AiQueueItem["priority"], string>;

// ── Status Label ────────────────────────────────────

function StatusLabel({
  status,
  waitPosition,
}: {
  readonly status: AiQueueItem["status"];
  /** 1-based place among waiting items, for `pending` ones. */
  readonly waitPosition: number;
}): React.ReactElement {
  switch (status) {
    case "streaming":
      return (
        <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
          <Spinner size="sm" />
          <span style={{ fontSize: 11, color: "oklch(0.78 0.18 205)" }}>Running</span>
        </span>
      );
    case "pending":
      return (
        <span style={{ fontSize: 11, color: "var(--color-fg-dim)" }}>
          Waiting · #{waitPosition} In Line
        </span>
      );
    case "complete":
      return <span style={{ fontSize: 11, color: "oklch(0.82 0.18 140)" }}>✓ Done</span>;
    case "error":
      return <span style={{ fontSize: 11, color: "oklch(0.72 0.20 10)" }}>✗ Error</span>;
  }
}

// ── Component ───────────────────────────────────────

interface AIQueueProps {
  /** Shows only this worker's items. */
  readonly workerId: string;
}

/**
 * The webview AI request queue: each chat turn with its priority, state
 * (waiting for a stream slot, or running) and place in line, plus the
 * slots in use against the concurrent limit. Cancel aborts the turn
 * itself — its stream, or its tool calls between rounds — not just the
 * queue entry, and denies the worker's tool calls still waiting for the
 * user's approval, so the parked turn can finish.
 */
export function AIQueue({ workerId }: AIQueueProps): React.ReactElement {
  const allItems = useAiStore((s) => s.queue);
  const activeStreams = useAiStore((s) => s.activeStreams);
  const concurrentLimit = useAiStore((s) => s.concurrentLimit);
  const cancelItem = useAiStore((s) => s.cancelItem);

  const queue = allItems.filter((q) => q.workerId === workerId);

  // Place in line among waiting items across the WHOLE queue — other
  // workers' turns ahead of this one still delay it.
  const waitPositions = new Map<string, number>();
  let waiting = 0;
  for (const item of allItems) {
    if (item.status === "pending") waitPositions.set(item.id, ++waiting);
  }

  return (
    <section style={queueContainerStyle} aria-label="AI Queue">
      <div style={headerStyle}>
        <h3 style={headerTitleStyle}>AI Queue</h3>
        <span style={streamCountStyle}>
          {activeStreams}/{concurrentLimit} Active
          {waiting > 0 && (
            <span style={{ color: "oklch(0.82 0.19 70)" }}> • {waiting} Waiting</span>
          )}
        </span>
      </div>

      {queue.length === 0 && <div style={emptyStyle}>No Items In Queue</div>}

      <MotionConfig reducedMotion="user">
        <AnimatePresence initial={false}>
          {queue.map((item, index) => (
            <motion.div
              key={item.id}
              initial={{ opacity: 0, y: -8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, x: 20 }}
              transition={{ duration: 0.15 }}
              style={itemStyle}
            >
              <span style={positionStyle}>{index + 1}</span>
              <Pill
                tone={PRIORITY_TONE[item.priority]}
                size="sm"
                style={{ textTransform: "uppercase" }}
              >
                {PRIORITY_LABEL[item.priority]}
              </Pill>
              <StatusLabel status={item.status} waitPosition={waitPositions.get(item.id) ?? 0} />

              {(item.status === "pending" || item.status === "streaming") && (
                <Pill
                  interactive
                  tone="danger"
                  size="sm"
                  onClick={() => cancelItem(item.id)}
                  aria-label={`Cancel Queue Item ${index + 1}`}
                  style={{ marginLeft: "auto", flexShrink: 0 }}
                >
                  Cancel
                </Pill>
              )}
            </motion.div>
          ))}
        </AnimatePresence>
      </MotionConfig>
    </section>
  );
}
