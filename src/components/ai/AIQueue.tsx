import type { CSSProperties } from "react";
import { useState } from "react";
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
  background: "var(--color-surface-0)",
  borderRadius: 8,
  border: "1px solid var(--color-border)",
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
  fontFamily: "var(--font-body)",
};

const streamCountStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  fontSize: 12,
  color: "var(--color-fg-dim)",
  fontFamily: "var(--font-mono)",
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
  fontFamily: "var(--font-mono)",
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
          <span style={{ fontSize: 11, color: "var(--color-plasma)" }}>Running</span>
        </span>
      );
    case "pending":
      return (
        <span style={{ fontSize: 11, color: "var(--color-fg-dim)" }}>
          Waiting, #{waitPosition} In Line
        </span>
      );
    case "complete":
      return <span style={{ fontSize: 11, color: "var(--color-lime)" }}>✓ Done</span>;
    case "error":
      return <span style={{ fontSize: 11, color: "var(--color-rose)" }}>✗ Error</span>;
  }
}

// ── Rows ────────────────────────────────────────────

interface QueueRow {
  readonly item: AiQueueItem;
  /** 1-based place among the live rows; an exiting row keeps its last one. */
  readonly position: number;
  /** The item left the queue; the row waits for its leave transition. */
  readonly exiting: boolean;
}

/** The rows after `queue` changed: kept order, leavers marked, newcomers last. */
function settle(rows: readonly QueueRow[], queue: readonly AiQueueItem[]): readonly QueueRow[] {
  const live = new Map(queue.map((item) => [item.id, item]));
  const known = new Set(rows.map((r) => r.item.id));
  const merged = [
    ...rows.map((r) => {
      const item = live.get(r.item.id);
      return item ? { item, position: 0, exiting: false } : { ...r, exiting: true };
    }),
    ...queue
      .filter((item) => !known.has(item.id))
      .map((item) => ({ item, position: 0, exiting: false })),
  ];
  let position = 0;
  return merged.map((r) => (r.exiting ? r : { ...r, position: ++position }));
}

function sameRows(a: readonly QueueRow[], b: readonly QueueRow[]): boolean {
  return (
    a.length === b.length &&
    a.every((r, i) => {
      const o = b[i];
      return o?.item === r.item && o.position === r.position && o.exiting === r.exiting;
    })
  );
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

  // Rows outlive their queue item: the store drops an item at once, so the
  // leave animation needs its own state. A store update is not a Transition,
  // so the exiting flag is set here while rendering, not in an effect.
  const [rows, setRows] = useState<readonly QueueRow[]>(() => settle([], queue));
  const settled = settle(rows, queue);
  if (!sameRows(rows, settled)) setRows(settled);
  const leave = (id: string): void => setRows((current) => current.filter((r) => r.item.id !== id));

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
          {waiting > 0 && <span style={{ color: "var(--color-amber)" }}> • {waiting} Waiting</span>}
        </span>
      </div>

      {rows.length === 0 && <div style={emptyStyle}>No Items In Queue</div>}

      {rows.map((row) => (
        <div
          key={row.item.id}
          // A removed row stays mounted, faded out, until its leave transition ends.
          className={`transition-[opacity,translate] duration-150 starting:-translate-y-2 starting:opacity-0 motion-reduce:starting:translate-y-0 ${row.exiting ? "translate-x-5 opacity-0 motion-reduce:translate-x-0" : ""}`}
          style={itemStyle}
          inert={row.exiting}
          data-exiting={row.exiting || undefined}
          onTransitionEnd={(event) => {
            if (row.exiting && event.target === event.currentTarget) leave(row.item.id);
          }}
          onTransitionCancel={(event) => {
            if (row.exiting && event.target === event.currentTarget) leave(row.item.id);
          }}
        >
          <span style={positionStyle}>{row.position}</span>
          <Pill tone={PRIORITY_TONE[row.item.priority]} size="sm">
            {PRIORITY_LABEL[row.item.priority]}
          </Pill>
          <StatusLabel
            status={row.item.status}
            waitPosition={waitPositions.get(row.item.id) ?? 0}
          />

          {(row.item.status === "pending" || row.item.status === "streaming") && !row.exiting && (
            <Pill
              interactive
              tone="danger"
              size="sm"
              onClick={() => cancelItem(row.item.id)}
              aria-label={`Cancel Queue Item ${row.position}`}
              style={{ marginLeft: "auto", flexShrink: 0 }}
            >
              Cancel
            </Pill>
          )}
        </div>
      ))}
    </section>
  );
}
