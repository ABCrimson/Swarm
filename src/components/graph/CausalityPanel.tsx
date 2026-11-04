import "./graph.css";

import { useSetAtom } from "jotai";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { Spinner } from "#components/ui/Spinner";
import {
  type CausalityWalkResult,
  MAX_CAUSALITY_HOPS,
  walkCausalityChain,
} from "#lib/causality-walk";
import { escapeForDisplay } from "#lib/display-escape";
import type { DomainEvent } from "#lib/event-bus";
import { useProvenanceStore } from "#store/provenance";
import { detailPanelOpenAtom, selectedWorkerIdAtom } from "#store/ui";
import { useWorkerStore } from "#store/workers";

/** Display name per live worker id. */
type LiveNames = Readonly<Record<string, string>>;

function workerLabel(id: string | undefined, names: LiveNames): string {
  if (!id) return "An Unknown Worker";
  return names[id] ?? id.slice(0, 8);
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

/** Describes one causality row per event type: Title Case text (e.g. "Worker A's Turn", "Spawned Worker B") plus the live worker a click opens; the row's `@seq` is rendered separately by `SeqLabel`. */
function describeRow(event: DomainEvent, names: LiveNames): RowDescription {
  const payload = (event.payload ?? {}) as Record<string, unknown>;
  const workerIdOf = (key: string): string | undefined =>
    typeof payload[key] === "string" ? (payload[key] as string) : undefined;

  switch (event.type) {
    case "agent_turn_started": {
      const workerId = workerIdOf("workerId");
      return { text: `${workerLabel(workerId, names)}'s Turn`, workerId };
    }
    case "worker_spawned": {
      const workerId = workerIdOf("workerId");
      return { text: `Spawned ${workerLabel(workerId, names)}`, workerId };
    }
    case "worker_killed": {
      const workerId = workerIdOf("workerId");
      return { text: `Killed ${workerLabel(workerId, names)}`, workerId };
    }
    case "worker_input": {
      const workerId = workerIdOf("workerId");
      const preview =
        typeof payload.preview === "string" ? escapeForDisplay(payload.preview.trim()) : "";
      const label = workerLabel(workerId, names);
      return { text: preview ? `${label} Ran ${preview}` : `${label} Received Input`, workerId };
    }
    case "bus_message": {
      const fromWorker = workerIdOf("fromWorker");
      const toWorker = workerIdOf("toWorker");
      const topic = typeof payload.topic === "string" ? escapeForDisplay(payload.topic) : "A Topic";
      return {
        text: `${workerLabel(fromWorker, names)} Sent "${topic}" To ${workerLabel(toWorker, names)}`,
        workerId: toWorker ?? fromWorker,
      };
    }
    case "file_written": {
      const path = typeof payload.path === "string" ? escapeForDisplay(payload.path) : "A File";
      return { text: `Wrote ${path}` };
    }
    default:
      return { text: titleCaseType(event.type) };
  }
}

const rowStyle: React.CSSProperties = {
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
  color: "oklch(0.85 0.03 220)",
  fontFamily: "var(--font-body)",
  fontSize: "0.8125rem",
};

function SeqLabel({ seq }: { readonly seq: number }): React.ReactElement {
  return (
    <span
      style={{
        fontFamily: "var(--font-mono)",
        fontSize: "0.6875rem",
        color: "var(--color-fg-dim)",
        fontVariantNumeric: "tabular-nums",
        flexShrink: 0,
      }}
    >
      @{seq}
    </span>
  );
}

/** Terminal placeholder chrome shared by the "not available" and "could not load" notes. */
const placeholderStyle: React.CSSProperties = {
  margin: 0,
  fontFamily: "var(--font-body)",
  fontSize: "0.75rem",
  fontStyle: "italic",
  color: "var(--color-fg-dim)",
  textAlign: "center",
  padding: "10px 12px",
  border: "1px dashed oklch(0.30 0.05 220)",
  borderRadius: 8,
};

interface CausalityPanelProps {
  /** Seq of the measured event to walk backward from — an edge's `lastSeq`, or a worker's most recent inbound event. */
  readonly startSeq: number;
  readonly onClose: () => void;
}

/**
 * Causality inspector — opened from a measured edge (`WorkerGraph`'s edge
 * click or Enter) or from `WorkerDetail`'s "View Causality" action, both
 * via the shared `causalityInspectorAtom`. Walks backward from `startSeq`
 * (see {@link walkCausalityChain} (`#lib/causality-walk`)) and renders the trace as a root-first
 * ordered list; a row naming a live worker is a button that selects that
 * worker, opens its detail panel and closes the inspector.
 *
 * A native modal `<dialog>` (`showModal()`): the browser provides the
 * top layer, an inert background, the focus trap, focus restore on
 * close, Escape, and (`closedby="any"`, or a press-and-release backdrop test
 * where the engine lacks it) closing on a backdrop click. Key
 * events still bubble to `document`, so the graph's own shortcuts stay
 * gated on the inspector atom. A fresh panel mounts per open cycle, and
 * closing it aborts a walk still in flight.
 *
 * Forward traversal (from a cause to everything it caused) is
 * deliberately out of scope for v1.
 */
/**
 * Whether a viewport point lies outside the dialog's border box (on its
 * `::backdrop`).
 */
function isOutside(dialog: HTMLDialogElement, x: number, y: number): boolean {
  const box = dialog.getBoundingClientRect();
  return x < box.left || x > box.right || y < box.top || y > box.bottom;
}

export function CausalityPanel({ startSeq, onClose }: CausalityPanelProps): React.ReactElement {
  // Names of live workers, compared shallowly: a PTY output chunk (which
  // replaces a worker object) does not re-render the open inspector.
  const names = useWorkerStore(
    useShallow((s) =>
      Object.fromEntries(
        s.workers.values().map((w) => [w.id, escapeForDisplay(w.name ?? w.id.slice(0, 8))]),
      ),
    ),
  );
  const setSelectedWorkerId = useSetAtom(selectedWorkerIdAtom);
  const setDetailOpen = useSetAtom(detailPanelOpenAtom);
  const [result, setResult] = useState<CausalityWalkResult | null>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const unmountingRef = useRef(false);
  // Whether the current press began on the backdrop: a drag that starts
  // inside the panel and ends outside it fires `click` on the dialog too,
  // and must not close it.
  const backdropPressRef = useRef(false);
  const titleId = useId();

  useEffect(() => {
    const controller = new AbortController();
    // The ring is read once, at walk start (its Map changes on nearly
    // every event, and a subscription would restart the walk). A stale
    // snapshot is still correct: a ring miss falls through to a backfill.
    walkCausalityChain(startSeq, useProvenanceStore.getState().bySeq, controller.signal)
      .then(setResult)
      .catch(() => {
        // Aborted on close — nothing left to render.
      });
    return () => controller.abort();
  }, [startSeq]);

  // Open as a modal before paint; close before the node leaves the
  // document on unmount, so the browser restores focus to the opener.
  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return undefined;
    unmountingRef.current = false;
    dialog.showModal();
    return () => {
      unmountingRef.current = true;
      if (dialog.open) dialog.close();
    };
  }, []);

  const close = (): void => dialogRef.current?.close();

  const handleRowClick = (workerId: string): void => {
    setSelectedWorkerId(workerId);
    setDetailOpen(true);
    close();
  };

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: the keyboard path is Escape (the dialog's native `cancel`); this click handler only adds backdrop dismissal where `closedby` is missing.
    <dialog
      ref={dialogRef}
      className="causality-panel"
      aria-labelledby={titleId}
      closedby="any"
      onPointerDown={(event) => {
        backdropPressRef.current =
          event.target === event.currentTarget &&
          isOutside(event.currentTarget, event.clientX, event.clientY);
      }}
      onClick={(event) => {
        // Only engines without `closedby` (WebKit today) take this path. A
        // backdrop click is pressed and released on the dialog itself at a
        // point outside its border box.
        const pressed = backdropPressRef.current;
        backdropPressRef.current = false;
        if ("closedBy" in HTMLDialogElement.prototype) return;
        const dialog = event.currentTarget;
        if (pressed && event.target === dialog && isOutside(dialog, event.clientX, event.clientY))
          dialog.close();
      }}
      onClose={(event) => {
        // `close` is delivered as a queued task. Ignore it when this panel
        // is unmounting, and when the dialog is open again by then —
        // StrictMode's effect replay closes and re-opens it on mount, and
        // that stale event must not report a close.
        if (!unmountingRef.current && !event.currentTarget.open) onClose();
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "14px 16px",
          borderBottom: "1px solid var(--color-border)",
        }}
      >
        <h2
          id={titleId}
          style={{
            fontFamily: "var(--font-display)",
            fontSize: "0.9375rem",
            fontWeight: 600,
            color: "var(--color-fg-bright)",
            margin: 0,
          }}
        >
          Causality Trace
        </h2>
        <button
          type="button"
          onClick={close}
          aria-label="Close Causality Trace"
          className="graph-icon-button"
        >
          <svg width={14} height={14} viewBox="0 0 14 14" fill="none" aria-hidden="true">
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
        <p role="status" className="sr-only">
          {result === null
            ? "Loading Causality Trace"
            : `${result.rows.length} ${result.rows.length === 1 ? "Event" : "Events"} In Trace${result.incomplete ? ", Earlier Causes Unavailable" : ""}${result.truncated ? `, Truncated At ${MAX_CAUSALITY_HOPS} Hops` : ""}`}
        </p>
        {result === null && (
          <div
            aria-hidden="true"
            style={{ display: "flex", justifyContent: "center", padding: 24 }}
          >
            <Spinner size="md" />
          </div>
        )}

        {/* Terminal placeholder for a genuine lookup miss (`incomplete`)
            — rendered FIRST (it's the earliest point in the chain the
            walk couldn't resolve), distinct in both wording and style
            from a real root so the topmost thing on screen never reads
            as "this is where causality began" when it's actually "the
            trail went cold here". Covers both "nothing at all" (zero
            rows) and "some rows, then a miss". */}
        {result?.incomplete && (
          <p style={placeholderStyle}>Cause Event Not Available (Ephemeral Or Pruned)</p>
        )}

        {/* A rejected or malformed backfill is a failure to look, not a pruned cause. */}
        {result?.failure != null && (
          <p role="alert" style={placeholderStyle}>
            Could Not Load The Causality Trace: {result.failure}
          </p>
        )}

        {result && result.rows.length > 0 && (
          <ol aria-label="Causes, Earliest First" className="causality-panel__trace">
            {result.rows.map((row, index) => {
              const { text, workerId } = describeRow(row, names);
              const liveWorkerId =
                workerId != null && Object.hasOwn(names, workerId) ? workerId : null;
              return (
                <li key={row.seq}>
                  {(index > 0 || result.incomplete || result.failure != null) && (
                    <span aria-hidden="true" className="causality-panel__arrow">
                      ↓
                    </span>
                  )}
                  {liveWorkerId ? (
                    <button
                      type="button"
                      className="causality-panel__row"
                      style={{ ...rowStyle, cursor: "pointer" }}
                      onClick={() => handleRowClick(liveWorkerId)}
                    >
                      <span>{text}</span>
                      <SeqLabel seq={row.seq} />
                    </button>
                  ) : (
                    <div style={rowStyle}>
                      <span>{text}</span>
                      <SeqLabel seq={row.seq} />
                    </div>
                  )}
                </li>
              );
            })}
          </ol>
        )}

        {result?.truncated && (
          <p
            style={{
              margin: "12px 0 0",
              fontFamily: "var(--font-mono)",
              fontSize: "0.6875rem",
              color: "var(--color-fg-dim)",
              textAlign: "center",
            }}
          >
            Trace Truncated At {MAX_CAUSALITY_HOPS} Hops.
          </p>
        )}
      </div>
    </dialog>
  );
}
