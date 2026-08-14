import { useAtom } from "jotai";
import { useEffect, useRef, useState } from "react";
import * as z from "zod";
import { Spinner } from "#components/ui/Spinner";
import { type DomainEvent, DomainEventSchema } from "#lib/event-bus";
import { invoke } from "#lib/tauri";
import { useProvenanceStore } from "#store/provenance";
import type { Worker } from "#store/types";
import { detailPanelOpenAtom, selectedWorkerIdAtom } from "#store/ui";
import { useWorkerStore } from "#store/workers";

/**
 * Hard cap on backward hops. Forward traversal (following a `causeSeq`
 * forward to everything it caused) is deliberately out of scope for v1
 * — this cap only bounds the backward walk against a pathological
 * chain; the engine's own invariant (provenance is recorded, never
 * inferred — see `EventSink::emit_with`'s doc) means a real cycle
 * should never occur, but a UI-side cap costs nothing and never trusts
 * that invariant blindly.
 */
export const MAX_CAUSALITY_HOPS = 50;

/**
 * Validates one `events_since` page at this seam — reused from
 * `event-bus.ts`'s canonical envelope shape so a malformed backfill
 * response degrades to "lookup failed" (the walk just stops early)
 * instead of throwing into render.
 */
const EventsSincePageSchema = z.array(DomainEventSchema);

/**
 * Resolves the event at `seq`: the bySeq ring first (the inspector's
 * fast path — populated by every non-telemetry envelope that has
 * flowed through this session, see `#store/provenance`), falling back
 * to a single-row `events_since` backfill on a miss. This is why
 * `events_since` grew an optional `limit` (see
 * `docs/api.md#events_since`) — a bulk backfill page would be
 * needlessly wasteful for "what happened at exactly this one seq".
 * Returns `null` when nothing is found at that exact seq (a malformed
 * response, or a seq that was never persisted).
 */
async function resolveEvent(
  seq: number,
  ring: ReadonlyMap<number, DomainEvent>,
): Promise<DomainEvent | null> {
  const cached = ring.get(seq);
  if (cached) return cached;

  try {
    const raw = await invoke<unknown>("events_since", { afterSeq: seq - 1, limit: 1 });
    const parsed = EventsSincePageSchema.safeParse(raw);
    if (!parsed.success) return null;
    const row = parsed.data[0];
    if (!row || row.seq !== seq) return null;
    return row;
  } catch {
    return null;
  }
}

export interface CausalityWalkResult {
  /** Root-first order — index 0 is the earliest cause found; the last entry is the event at the walk's starting seq. */
  readonly rows: DomainEvent[];
  /** `true` when the walk stopped at {@link MAX_CAUSALITY_HOPS} rather than reaching a real root. */
  readonly truncated: boolean;
  /**
   * `true` when the walk stopped early because a lookup genuinely
   * missed (neither the ring nor a live `events_since` backfill found
   * the cited seq) — distinct from {@link truncated} (hit the hop cap)
   * and distinct from a real root (an event whose own `causeSeq` is
   * absent). Without this flag the topmost RENDERED row is
   * indistinguishable from an actual root — causality-by-omission: the
   * trace looks complete when it isn't. Mutually exclusive with
   * `truncated` by construction (a miss can only occur before the hop
   * cap is reached).
   */
  readonly incomplete: boolean;
}

/**
 * Walks backward from `startSeq` via each event's own `causeSeq`,
 * terminating on an absent `causeSeq` (a real root — typically
 * `agent_turn_started`, which never carries one) or
 * {@link MAX_CAUSALITY_HOPS} hops, whichever comes first. A lookup miss
 * ends the walk early and sets {@link CausalityWalkResult.incomplete} —
 * the rows already collected are still true, just explicitly marked as
 * possibly short of the root rather than silently passed off as complete.
 */
export async function walkCausalityChain(
  startSeq: number,
  ring: ReadonlyMap<number, DomainEvent>,
): Promise<CausalityWalkResult> {
  const chain: DomainEvent[] = []; // collected most-recent-first
  let currentSeq: number | undefined = startSeq;
  let incomplete = false;

  while (currentSeq !== undefined && chain.length < MAX_CAUSALITY_HOPS) {
    const event = await resolveEvent(currentSeq, ring);
    if (!event) {
      incomplete = true; // genuine lookup miss -- stop with whatever's already collected
      break;
    }
    chain.push(event);
    currentSeq = event.causeSeq;
  }

  const truncated = !incomplete && currentSeq !== undefined && chain.length >= MAX_CAUSALITY_HOPS;
  return { rows: chain.toReversed(), truncated, incomplete };
}

function workerLabel(id: string | undefined, workers: ReadonlyMap<string, Worker>): string {
  if (!id) return "An Unknown Worker";
  return workers.get(id)?.name ?? id.slice(0, 8);
}

function titleCaseType(type: string): string {
  return type
    .split("_")
    .map((word) => (word.length > 0 ? word[0]?.toUpperCase() + word.slice(1) : word))
    .join(" ");
}

interface RowDescription {
  readonly text: string;
  /** Worker this row click-throughs to, when resolvable and still live. */
  readonly workerId?: string;
}

/** Renders one causality row's chrome per event type — Title Case, matching the plan's "Worker A's Turn @412 -> Spawned B @418" example shape. */
function describeRow(event: DomainEvent, workers: ReadonlyMap<string, Worker>): RowDescription {
  const payload = (event.payload ?? {}) as Record<string, unknown>;
  const workerIdOf = (key: string): string | undefined =>
    typeof payload[key] === "string" ? (payload[key] as string) : undefined;

  switch (event.type) {
    case "agent_turn_started": {
      const workerId = workerIdOf("workerId");
      return { text: `${workerLabel(workerId, workers)}'s Turn`, workerId };
    }
    case "worker_spawned": {
      const workerId = workerIdOf("workerId");
      return { text: `Spawned ${workerLabel(workerId, workers)}`, workerId };
    }
    case "worker_killed": {
      const workerId = workerIdOf("workerId");
      return { text: `Killed ${workerLabel(workerId, workers)}`, workerId };
    }
    case "worker_input": {
      const workerId = workerIdOf("workerId");
      const preview = typeof payload.preview === "string" ? payload.preview.trim() : "";
      const label = workerLabel(workerId, workers);
      return { text: preview ? `${label} Ran ${preview}` : `${label} Received Input`, workerId };
    }
    case "bus_message": {
      const fromWorker = workerIdOf("fromWorker");
      const toWorker = workerIdOf("toWorker");
      const topic = typeof payload.topic === "string" ? payload.topic : "A Topic";
      return {
        text: `${workerLabel(fromWorker, workers)} Sent "${topic}" To ${workerLabel(toWorker, workers)}`,
        workerId: toWorker ?? fromWorker,
      };
    }
    case "file_written": {
      const path = typeof payload.path === "string" ? payload.path : "A File";
      return { text: `Wrote ${path}` };
    }
    default:
      return { text: titleCaseType(event.type) };
  }
}

interface CausalityPanelProps {
  /** Seq of the measured event to walk backward from — an edge's `lastSeq`, or a worker's most recent inbound event. */
  readonly startSeq: number;
  readonly onClose: () => void;
}

/**
 * Causality inspector — opened from a measured edge click
 * (`WorkerGraph.tsx`'s `handleEdgeClick`) or from `WorkerDetail`'s
 * "View Causality" action, both via the shared `causalityInspectorAtom`.
 * Walks backward from `startSeq` (see {@link walkCausalityChain}) and
 * renders the trace as a vertical, root-first list — rows click through
 * to the worker they name, when that worker is still live.
 *
 * Forward traversal (from a cause to everything it caused) is
 * deliberately out of scope for v1.
 */
export function CausalityPanel({ startSeq, onClose }: CausalityPanelProps): React.ReactElement {
  const workers = useWorkerStore((s) => s.workers);
  const [, setSelectedWorkerId] = useAtom(selectedWorkerIdAtom);
  const [, setDetailOpen] = useAtom(detailPanelOpenAtom);
  const [result, setResult] = useState<CausalityWalkResult | null>(null);
  const [loading, setLoading] = useState(true);
  const panelRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setResult(null);
    // Read the ring imperatively (not via a reactive selector) -- the
    // ring's Map reference changes on nearly every incoming event, and
    // subscribing to it here would re-run the walk (and flicker the
    // loading state) on every tick the panel happens to stay open for.
    // A snapshot taken once, at walk-start, is correct: a ring miss
    // always falls through to a live backfill regardless of how stale
    // the snapshot is.
    const ring = useProvenanceStore.getState().bySeq;
    void walkCausalityChain(startSeq, ring).then((r) => {
      if (!cancelled) {
        setResult(r);
        setLoading(false);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [startSeq]);

  // Focus management: a modal dialog must move focus INTO itself on
  // open (nothing did by default -- role="dialog" alone doesn't), and
  // restore it to whatever had focus before on close, so a keyboard/
  // screen-reader user isn't left on (or dropped back onto) an element
  // behind an overlay they can no longer reach. Runs once per mount,
  // not per `startSeq` change -- WorkerGraph/WorkerDetail always mount
  // a fresh CausalityPanel per open cycle (the atom holds `{startSeq}`
  // or `null`, never rewritten to a new seq while already open), so
  // "on open"/"on close" and "on mount"/"on unmount" coincide here.
  useEffect(() => {
    previouslyFocusedRef.current = document.activeElement as HTMLElement | null;
    closeButtonRef.current?.focus();
    return () => {
      previouslyFocusedRef.current?.focus?.();
    };
  }, []);

  // Focus trap: Tab/Shift+Tab cycle among the dialog's own focusable
  // elements only, never escaping to the graph/page behind it. Recomputes
  // the focusable set on every Tab press (not once at mount) since rows
  // appear asynchronously once the walk resolves.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key !== "Tab" || !panelRef.current) return;
      const focusable = panelRef.current.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      );
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];

      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, []);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [onClose]);

  // Click-outside-to-close via a document-level listener (same pattern as
  // GraphContextMenu.tsx) rather than an onClick handler on the backdrop
  // div itself — a full-viewport div is not a semantically interactive
  // element, and this avoids needing to fake one up with a role/tabIndex
  // just to catch a click.
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [onClose]);

  const handleRowClick = (workerId: string | undefined) => {
    if (!workerId || !workers.has(workerId)) return;
    setSelectedWorkerId(workerId);
    setDetailOpen(true);
  };

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 60,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "oklch(0.04 0.01 220 / 0.55)",
        backdropFilter: "blur(2px)",
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label="Causality Trace"
        style={{
          width: 420,
          maxHeight: "70vh",
          display: "flex",
          flexDirection: "column",
          background: "oklch(0.10 0.03 220)",
          border: "1px solid oklch(0.28 0.05 220)",
          borderRadius: 12,
          boxShadow: "0 0 0 1px oklch(0.78 0.18 205 / 0.1), 0 16px 48px oklch(0.06 0.02 220 / 0.6)",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "14px 16px",
            borderBottom: "1px solid oklch(0.22 0.04 220)",
          }}
        >
          <h2
            style={{
              fontFamily: "var(--font-display)",
              fontSize: "0.9375rem",
              fontWeight: 600,
              color: "oklch(0.95 0.02 220)",
              margin: 0,
            }}
          >
            Causality Trace
          </h2>
          <button
            ref={closeButtonRef}
            type="button"
            onClick={onClose}
            aria-label="Close Causality Trace"
            style={{
              width: 28,
              height: 28,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              background: "oklch(0 0 0 / 0)",
              border: "none",
              borderRadius: 6,
              color: "oklch(0.55 0.04 220)",
              cursor: "pointer",
              fontSize: "1rem",
            }}
          >
            <svg width={14} height={14} viewBox="0 0 14 14" fill="none">
              <title>Close</title>
              <path
                d="M2 2l10 10M12 2L2 12"
                stroke="currentColor"
                strokeWidth={1.5}
                strokeLinecap="round"
              />
            </svg>
          </button>
        </div>

        <div
          className="scroll-area"
          style={{
            flex: 1,
            overflowY: "auto",
            padding: 16,
            display: "flex",
            flexDirection: "column",
          }}
        >
          {loading && (
            <div style={{ display: "flex", justifyContent: "center", padding: 24 }}>
              <Spinner size="md" />
            </div>
          )}

          {/* Terminal placeholder for a genuine lookup miss (`incomplete`)
              — rendered FIRST (it's the earliest point in the chain the
              walk couldn't resolve), distinct in both wording and style
              from a real root so the topmost thing on screen never reads
              as "this is where causality began" when it's actually "the
              trail went cold here". Covers both "nothing at all" (zero
              rows) and "some rows, then a miss" uniformly — the old
              generic "Causality Trace Unavailable" message is exactly
              the zero-rows case of this, so it's subsumed rather than
              duplicated. */}
          {!loading && result?.incomplete && (
            <div
              style={{
                fontFamily: "var(--font-body)",
                fontSize: "0.75rem",
                fontStyle: "italic",
                color: "oklch(0.55 0.04 220)",
                textAlign: "center",
                padding: "10px 12px",
                border: "1px dashed oklch(0.30 0.05 220)",
                borderRadius: 8,
              }}
            >
              Cause Event Not Available (Ephemeral Or Pruned)
            </div>
          )}

          {!loading &&
            result &&
            result.rows.map((row, index) => {
              const { text, workerId } = describeRow(row, workers);
              const clickable = workerId != null && workers.has(workerId);
              const showArrowAbove = index > 0 || result.incomplete;
              return (
                <div key={row.seq} style={{ display: "flex", flexDirection: "column" }}>
                  {showArrowAbove && (
                    <div
                      aria-hidden="true"
                      style={{
                        alignSelf: "center",
                        color: "oklch(0.45 0.04 220)",
                        fontSize: "0.875rem",
                        lineHeight: 1,
                        padding: "2px 0",
                      }}
                    >
                      ↓
                    </div>
                  )}
                  <button
                    type="button"
                    onClick={() => handleRowClick(workerId)}
                    disabled={!clickable}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      gap: 12,
                      width: "100%",
                      padding: "10px 12px",
                      background: "oklch(0.13 0.03 220 / 0.7)",
                      border: "1px solid oklch(0.24 0.04 220)",
                      borderRadius: 8,
                      textAlign: "left",
                      cursor: clickable ? "pointer" : "default",
                      color: "oklch(0.85 0.03 220)",
                      fontFamily: "var(--font-body)",
                      fontSize: "0.8125rem",
                    }}
                  >
                    <span>{text}</span>
                    <span
                      style={{
                        fontFamily: "var(--font-mono)",
                        fontSize: "0.6875rem",
                        color: "oklch(0.55 0.04 220)",
                        fontVariantNumeric: "tabular-nums",
                        flexShrink: 0,
                      }}
                    >
                      @{row.seq}
                    </span>
                  </button>
                </div>
              );
            })}

          {!loading && result?.truncated && (
            <span
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: "0.6875rem",
                color: "oklch(0.55 0.04 220)",
                textAlign: "center",
                marginTop: 12,
              }}
            >
              Trace Truncated At {MAX_CAUSALITY_HOPS} Hops.
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
