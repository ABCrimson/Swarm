import "./graph.css";

import { useSetAtom } from "jotai";
import { useEffect, useState } from "react";
import { flushSync } from "react-dom";
import { toast } from "sonner";
import { useShallow } from "zustand/react/shallow";
import { Badge, stateLabels } from "#components/ui/Badge";
import { Pill } from "#components/ui/Pill";
import { useWorker } from "#hooks/useWorker";
import { stripAnsi } from "#lib/ansi";
import { walkCausalityChain } from "#lib/causality-walk";
import { escapeForDisplay } from "#lib/display-escape";
import type { DomainEvent } from "#lib/event-bus";
import { errorMessage } from "#lib/is-error";
import {
  deriveLineage,
  LINEAGE_FIRST_PAGE,
  LINEAGE_PAGE_STEP,
  selectLineageStartSeq,
} from "#lib/lineage";
import { isTauri, openWorkerDirectory } from "#lib/tauri";
import { formatElapsed } from "#lib/time";
import { selectMostRecentSeqForWorker, useProvenanceStore } from "#store/provenance";
import type { Worker, WorkerState } from "#store/types";
import { causalityInspectorAtom, detailPanelOpenAtom, selectedWorkerIdAtom } from "#store/ui";
import { useWorkerStore } from "#store/workers";

interface WorkerDetailProps {
  readonly worker: Worker;
}

/** Characters of (escape-stripped) output shown in the preview. */
const OUTPUT_PREVIEW_CHARS = 2000;
/** How often the uptime readout refreshes. */
const UPTIME_TICK_MS = 15_000;

/** State per live worker id, compared shallowly (a PTY output chunk changes none). */
const selectStates = (s: { workers: ReadonlyMap<string, Worker> }): Record<string, WorkerState> =>
  Object.fromEntries(s.workers.values().map((w) => [w.id, w.state]));

/** Display name per live worker id. */
const selectNames = (s: { workers: ReadonlyMap<string, Worker> }): Record<string, string> =>
  Object.fromEntries(s.workers.values().map((w) => [w.id, w.name ?? w.id.slice(0, 8)]));

/** A causality walk back from `startSeq`, root first. */
interface CauseChain {
  readonly startSeq: number;
  readonly rows: readonly DomainEvent[];
}

/** The current time, refreshed every `intervalMs`. */
function useNow(intervalMs: number): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

function DetailRow({
  label,
  children,
}: {
  readonly label: string;
  readonly children: React.ReactNode;
}): React.ReactElement {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
      <dt
        style={{
          fontFamily: "var(--font-display)",
          fontSize: "var(--text-md)",
          fontWeight: 600,
          letterSpacing: "-0.01em",
          color: "var(--color-fg-dim)",
        }}
      >
        {label}
      </dt>
      <dd
        style={{
          margin: 0,
          fontFamily: "var(--font-body)",
          fontSize: "0.8125rem",
          color: "var(--color-fg)",
        }}
      >
        {children}
      </dd>
    </div>
  );
}

/**
 * Side panel with a worker's details — state, ID, PID, a live uptime,
 * branch/worktree, the Related Workers list (`#lib/lineage`), an
 * escape-stripped output preview — and Pause, Resume and Kill,
 * `useWorker`'s IPC actions: each runs as a transition there, so the
 * optimistic state holds while the backend call is in flight.
 */
export function WorkerDetail({ worker }: WorkerDetailProps): React.ReactElement {
  const setDetailOpen = useSetAtom(detailPanelOpenAtom);
  const { pause, resume, kill, optimisticState } = useWorker(worker.id);
  // Most recent measured edge (either endpoint) involving this worker —
  // the CausalityPanel walk's starting seq. `null` when this worker has
  // no measured causality at all, in which case "View Causality" is
  // simply not shown (a dead-end button would contradict the "quiet,
  // honest empty state" the graph itself uses).
  const mostRecentCausalitySeq = useProvenanceStore((s) =>
    selectMostRecentSeqForWorker(s.edges, worker.id),
  );
  const setCausalityTarget = useSetAtom(causalityInspectorAtom);
  const setSelectedId = useSetAtom(selectedWorkerIdAtom);
  const now = useNow(UPTIME_TICK_MS);

  // Related Workers: measured edges give Spawned By, Spawned and the
  // direct Caused By rows; a causality walk back from the latest edge into
  // this worker adds the transitive causes once it lands.
  const edges = useProvenanceStore((s) => s.edges);
  const liveStates = useWorkerStore(useShallow(selectStates));
  const liveNames = useWorkerStore(useShallow(selectNames));
  const lineageStartSeq = selectLineageStartSeq(edges, worker.id);
  const [causeChain, setCauseChain] = useState<CauseChain | null>(null);
  const [lineageShown, setLineageShown] = useState(LINEAGE_FIRST_PAGE);
  const lineage = deriveLineage(
    worker.id,
    edges,
    liveStates,
    causeChain?.startSeq === lineageStartSeq ? causeChain.rows : [],
  );

  useEffect(() => {
    if (lineageStartSeq === null) return undefined;
    const controller = new AbortController();
    // As in CausalityPanel: the ring is read once, at walk start, and a
    // miss falls through to a backfill. A failed or short walk still
    // yields the causes it reached.
    walkCausalityChain(lineageStartSeq, useProvenanceStore.getState().bySeq, controller.signal)
      .then((result) => setCauseChain({ startSeq: lineageStartSeq, rows: result.rows }))
      .catch(() => {
        // Aborted: the start seq moved or the panel closed.
      });
    return () => controller.abort();
  }, [lineageStartSeq]);

  // The Workers page keys this panel by worker, so selecting a related
  // worker remounts it and the activated row unmounts: commit
  // synchronously, then focus the new panel's heading instead of letting
  // focus fall to <body>.
  const selectRelated = (workerId: string): void => {
    flushSync(() => {
      setSelectedId(workerId);
      setDetailOpen(true);
    });
    document
      .querySelector<HTMLElement>(`[data-worker-detail="${CSS.escape(workerId)}"] h2`)
      ?.focus();
  };

  const closePanel = (): void => {
    // Hand focus back to this worker's graph node or list row before the
    // panel unmounts, so keyboard focus does not fall to <body>. Only the
    // rendered one (the other view is hidden) can take it.
    const target = [
      ...document.querySelectorAll<HTMLElement>(
        `.react-flow__node[data-id="${CSS.escape(worker.id)}"], li > button[aria-current="true"]`,
      ),
    ].find((el) => el.getClientRects().length > 0);
    target?.focus();
    setDetailOpen(false);
  };

  const currentState = optimisticState ?? worker.state;
  const canPause = currentState === "running";
  const canResume = currentState === "paused";
  const uptime = formatElapsed(
    Temporal.Instant.from(worker.startedAt),
    Temporal.Instant.fromEpochMilliseconds(now),
  );
  const outputPreview = worker.output ? stripAnsi(worker.output).slice(-OUTPUT_PREVIEW_CHARS) : "";

  const handleOpenWorktree = async (): Promise<void> => {
    try {
      // By worker id, never by path: the shell opens the worktree folder
      // its registry recorded for this worker, and only while it is a
      // directory. The webview has no opener path grant at all, so no
      // path it holds (the displayed one included) can be opened.
      await openWorkerDirectory(worker.id);
    } catch (err) {
      toast.error(`Could Not Open Worktree: ${errorMessage(err)}`);
    }
  };

  return (
    <div
      data-worker-detail={worker.id}
      style={{
        width: 320,
        height: "100%",
        background: "var(--color-surface-1)",
        borderLeft: "1px solid var(--color-border)",
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
      }}
    >
      {/* Header */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "16px",
          borderBottom: "1px solid var(--color-border)",
        }}
      >
        <h2
          // A focus target for a Related Workers selection (see selectRelated), not a tab stop.
          tabIndex={-1}
          style={{
            fontFamily: "var(--font-display)",
            fontSize: "0.9375rem",
            fontWeight: 600,
            color: "var(--color-fg-bright)",
            margin: 0,
          }}
        >
          Worker Detail
        </h2>
        <button
          type="button"
          onClick={closePanel}
          aria-label="Close Detail Panel"
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

      {/* Content */}
      <div
        style={{
          flex: 1,
          padding: "16px",
          display: "flex",
          flexDirection: "column",
          gap: 16,
          overflowY: "auto",
        }}
        className="scroll-area"
      >
        <span
          style={{
            fontFamily: "var(--font-display)",
            fontSize: "1rem",
            fontWeight: 600,
            color: "var(--color-fg-bright)",
          }}
        >
          {escapeForDisplay(worker.name ?? worker.id.slice(0, 8))}
        </span>

        <dl style={{ display: "flex", flexDirection: "column", gap: 10, margin: 0 }}>
          <DetailRow label="State">
            <Badge state={currentState}>{stateLabels[currentState]}</Badge>
          </DetailRow>
          <DetailRow label="ID">
            <span style={{ fontFamily: "var(--font-mono)", fontSize: "0.6875rem" }}>
              {worker.id.slice(0, 12)}
            </span>
          </DetailRow>
          {worker.pid != null && <DetailRow label="PID">{worker.pid}</DetailRow>}
          <DetailRow label="Uptime">
            <time dateTime={worker.startedAt}>{uptime}</time>
          </DetailRow>
          {worker.branch != null && (
            <DetailRow label="Branch">{escapeForDisplay(worker.branch)}</DetailRow>
          )}
          {worker.worktreePath != null && (
            <DetailRow label="Worktree">
              {isTauri() ? (
                <button
                  type="button"
                  onClick={() => void handleOpenWorktree()}
                  title={escapeForDisplay(worker.worktreePath)}
                  className="worker-detail__path"
                >
                  {escapeForDisplay(worker.worktreePath)}
                </button>
              ) : (
                // Opening a folder needs the desktop shell.
                <span className="worker-detail__path" title={escapeForDisplay(worker.worktreePath)}>
                  {escapeForDisplay(worker.worktreePath)}
                </span>
              )}
            </DetailRow>
          )}
        </dl>

        {/* Causality — only shown when this worker actually has measured
            causality to walk; a worker with none gets no dead-end button,
            consistent with the graph's own quiet empty state. */}
        {mostRecentCausalitySeq !== null && (
          <Pill
            interactive
            tone="info"
            size="sm"
            style={{ alignSelf: "flex-start" }}
            onClick={() => setCausalityTarget({ startSeq: mostRecentCausalitySeq })}
          >
            View Causality
          </Pill>
        )}

        {lineage.rows.length > 0 && (
          <div>
            <div className="mb-2 flex items-center justify-between gap-2">
              <span
                aria-hidden="true"
                className="font-display text-md font-semibold tracking-[-0.01em] text-fg-dim"
              >
                Related Workers
              </span>
              {lineage.failed > 0 && (
                <Pill tone="danger" size="sm">
                  {lineage.failed} Failed
                </Pill>
              )}
            </div>
            <ul aria-label="Related Workers" className="m-0 flex list-none flex-col gap-1.5 p-0">
              {lineage.rows.slice(0, lineageShown).map((row) => {
                const name = escapeForDisplay(liveNames[row.workerId] ?? row.workerId.slice(0, 8));
                return (
                  <li key={row.workerId}>
                    <button
                      type="button"
                      aria-label={`${row.relation}: ${name}, Status: ${stateLabels[row.state]}`}
                      onClick={() => selectRelated(row.workerId)}
                      className="flex w-full cursor-pointer items-center justify-between gap-3 rounded-md border border-border bg-surface-2/70 px-3 py-2 text-left font-body text-md text-fg hover:border-border-3"
                    >
                      <span className="flex min-w-0 flex-col">
                        <span className="text-xs text-fg-dim">{row.relation}</span>
                        <span className="truncate">{name}</span>
                      </span>
                      <Badge state={row.state}>{stateLabels[row.state]}</Badge>
                    </button>
                  </li>
                );
              })}
            </ul>
            {lineage.rows.length > lineageShown && (
              <Pill
                interactive
                tone="neutral"
                size="sm"
                className="mt-2"
                onClick={() => setLineageShown((shown) => shown + LINEAGE_PAGE_STEP)}
              >
                Show More
              </Pill>
            )}
          </div>
        )}

        {outputPreview && (
          <section aria-label="Output">
            <span
              aria-hidden="true"
              style={{
                fontFamily: "var(--font-display)",
                fontSize: "var(--text-md)",
                fontWeight: 600,
                letterSpacing: "-0.01em",
                color: "var(--color-fg-dim)",
                display: "block",
                marginBottom: 8,
              }}
            >
              Output
            </span>
            <pre
              // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable region must be keyboard-focusable so it can be scrolled without a mouse (WCAG 2.1.1); WebKit (WKWebView, WebKitGTK) does not focus scroll containers natively.
              tabIndex={0}
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: "0.6875rem",
                color: "oklch(0.72 0.04 220)",
                background: "var(--color-void)",
                border: "1px solid var(--color-surface-2)",
                borderRadius: 8,
                padding: 12,
                maxHeight: 200,
                overflowY: "auto",
                whiteSpace: "pre-wrap",
                wordBreak: "break-all",
                margin: 0,
              }}
              className="scroll-area"
            >
              {outputPreview}
            </pre>
          </section>
        )}
      </div>

      {/* Actions — a uniform-width group; Kill is the danger tone. Each
          is a transition inside useWorker, so its optimistic state holds
          while the IPC call is in flight. */}
      <div
        style={{
          display: "flex",
          gap: 8,
          padding: "16px",
          borderTop: "1px solid var(--color-border)",
        }}
      >
        <Pill
          interactive
          tone="neutral"
          size="md"
          onClick={pause}
          disabled={!canPause}
          style={{ flex: 1 }}
        >
          Pause
        </Pill>
        <Pill
          interactive
          tone="neutral"
          size="md"
          onClick={resume}
          disabled={!canResume}
          style={{ flex: 1 }}
        >
          Resume
        </Pill>
        <Pill interactive tone="danger" size="md" onClick={kill} style={{ flex: 1 }}>
          Kill
        </Pill>
      </div>
    </div>
  );
}
