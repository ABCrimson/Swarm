import { useState } from "react";
import type { PillTone } from "#components/ui/Pill";
import { Pill } from "#components/ui/Pill";
import { Spinner } from "#components/ui/Spinner";
import { useAiStore } from "#store/ai";
import type { AiQueueItem } from "#store/types";

// ── Styles (utilities; literals with no token wait for the Q-9 design direction) ──

const QUEUE_CONTAINER = "flex flex-col gap-0.5 rounded-md border border-border bg-surface-0 p-3";

const HEADER =
  "mb-1 flex items-center justify-between border-b border-[oklch(0.18_0.03_220)] px-1 pb-2";

const HEADER_TITLE = "m-0 font-sans text-[13px] font-semibold text-[oklch(0.78_0.04_220)]";

const STREAM_COUNT = "inline-flex items-center gap-1.5 font-sans text-[12px] text-fg-dim";

const ITEM =
  "flex items-center gap-2 rounded-[6px] border border-[oklch(0.20_0.03_220)] bg-[oklch(0.12_0.03_220/0.5)] px-2.5 py-2";

const POSITION =
  "inline-flex size-6 shrink-0 items-center justify-center rounded-sm bg-[oklch(0.16_0.03_220)] font-mono text-[11px] font-bold text-fg-dim";

const EMPTY = "py-4 text-center text-[13px] text-fg-dim";

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
        <span className="inline-flex items-center gap-1">
          <Spinner size="sm" />
          <span className="text-[11px] text-plasma">Running</span>
        </span>
      );
    case "pending":
      return <span className="text-[11px] text-fg-dim">Waiting, #{waitPosition} In Line</span>;
    case "complete":
      return <span className="text-[11px] text-lime">✓ Done</span>;
    case "error":
      return <span className="text-[11px] text-rose">✗ Error</span>;
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
    <section className={QUEUE_CONTAINER} aria-label="AI Queue">
      <div className={HEADER}>
        <h3 className={HEADER_TITLE}>AI Queue</h3>
        <span className={STREAM_COUNT}>
          <span className="font-mono tabular-nums">
            {activeStreams}/{concurrentLimit}
          </span>{" "}
          Active
          {waiting > 0 && <span className="text-amber"> • {waiting} Waiting</span>}
        </span>
      </div>

      {rows.length === 0 && <div className={EMPTY}>No Items In Queue</div>}

      {rows.map((row) => (
        <div
          key={row.item.id}
          // getAnimations() flushes style, so a leave transition that started is
          // listed. None (reduced motion, or an ancestor with display:none) means
          // no transitionend will come: the row leaves at once.
          ref={(el) => {
            if (
              el &&
              row.exiting &&
              typeof el.getAnimations === "function" &&
              el.getAnimations().length === 0
            ) {
              leave(row.item.id);
            }
          }}
          // A removed row stays mounted, faded out, until its leave transition ends.
          className={`transition-[opacity,translate] duration-150 starting:-translate-y-2 starting:opacity-0 motion-reduce:starting:translate-y-0 ${row.exiting ? "translate-x-5 opacity-0 motion-reduce:translate-x-0" : ""} ${ITEM}`}
          inert={row.exiting}
          data-exiting={row.exiting || undefined}
          onTransitionEnd={(event) => {
            if (row.exiting && event.target === event.currentTarget) leave(row.item.id);
          }}
          onTransitionCancel={(event) => {
            if (row.exiting && event.target === event.currentTarget) leave(row.item.id);
          }}
        >
          <span className={POSITION}>{row.position}</span>
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
              className="ml-auto shrink-0"
            >
              Cancel
            </Pill>
          )}
        </div>
      ))}
    </section>
  );
}
