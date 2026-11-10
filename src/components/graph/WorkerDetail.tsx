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
  type Lineage,
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
    <div className="flex items-center justify-between">
      <dt className="font-display text-[length:var(--text-md)] font-semibold tracking-[-0.01em] text-fg-dim">
        {label}
      </dt>
      <dd className="m-0 font-body text-[0.8125rem] text-fg">{children}</dd>
    </div>
  );
}

type LineageRow = Lineage["rows"][number];

/** How many rows the next page adds, and how many are hidden when that is not all of them. */
function showMoreLabel(hidden: number): string {
  return hidden <= LINEAGE_PAGE_STEP
    ? `Show ${hidden} More`
    : `Show ${LINEAGE_PAGE_STEP} More Of ${hidden}`;
}

/** One relation's rows, in list order; the rows arrive grouped (see `deriveLineage`). */
function groupByRelation(
  rows: readonly LineageRow[],
): { readonly relation: LineageRow["relation"]; readonly rows: LineageRow[] }[] {
  const groups: { readonly relation: LineageRow["relation"]; readonly rows: LineageRow[] }[] = [];
  for (const row of rows) {
    const last = groups.at(-1);
    if (last?.relation === row.relation) last.rows.push(row);
    else groups.push({ relation: row.relation, rows: [row] });
  }
  return groups;
}

/** One relation's rows as a single bordered list divided by rules, not a card per row. */
const LINEAGE_GROUP =
  "m-0 list-none divide-y divide-border overflow-hidden rounded-md border border-border p-0";

/** The list clips overflow, so the focus ring is drawn inside the row (`-outline-offset-2`). */
const LINEAGE_ROW =
  "flex w-full cursor-pointer items-center justify-between gap-3 bg-transparent px-3 py-2 text-left font-body text-md text-fg transition-[background-color] duration-150 ease-(--ease-out) -outline-offset-2 hover:bg-surface-2";

/** A trailing chevron in the sidebar icons' line style, at the tool card status marks' 2.2-unit stroke for 14px: the row opens that worker. */
function ChevronIcon(): React.ReactElement {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="size-3.5 text-fg-dim"
    >
      <path d="M9 6l6 6-6 6" />
    </svg>
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
      className="flex h-full w-80 flex-col overflow-hidden border-l border-border bg-surface-1"
    >
      {/* Header */}
      <div className="flex items-center justify-between border-b border-border p-4">
        <h2
          // A focus target for a Related Workers selection (see selectRelated), not a tab stop.
          tabIndex={-1}
          className="m-0 font-display text-[0.9375rem] font-semibold text-fg-bright"
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
      <div className="scroll-area flex flex-1 flex-col gap-4 overflow-y-auto p-4">
        <span className="font-display text-[1rem] font-semibold text-fg-bright">
          {escapeForDisplay(worker.name ?? worker.id.slice(0, 8))}
        </span>

        <dl className="m-0 flex flex-col gap-2.5">
          <DetailRow label="State">
            <Badge state={currentState}>{stateLabels[currentState]}</Badge>
          </DetailRow>
          <DetailRow label="ID">
            <span className="font-mono text-[0.6875rem]">{worker.id.slice(0, 12)}</span>
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
            className="self-start"
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
                  {lineage.failed} In {stateLabels.error}
                </Pill>
              )}
            </div>
            <ul aria-label="Related Workers" className="m-0 flex list-none flex-col gap-3 p-0">
              {groupByRelation(lineage.rows.slice(0, lineageShown)).map((group) => (
                <li key={group.relation}>
                  <span aria-hidden="true" className="mb-1 block text-xs text-fg-dim">
                    {group.relation}
                  </span>
                  <ul aria-label={group.relation} className={LINEAGE_GROUP}>
                    {group.rows.map((row) => {
                      const name = escapeForDisplay(
                        liveNames[row.workerId] ?? row.workerId.slice(0, 8),
                      );
                      return (
                        <li key={row.workerId}>
                          <button
                            type="button"
                            aria-label={`${row.relation}: ${name}, Status: ${stateLabels[row.state]}`}
                            onClick={() => selectRelated(row.workerId)}
                            className={LINEAGE_ROW}
                          >
                            <span className="min-w-0 truncate">{name}</span>
                            <span className="flex shrink-0 items-center gap-2">
                              <Badge state={row.state}>{stateLabels[row.state]}</Badge>
                              <ChevronIcon />
                            </span>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </li>
              ))}
            </ul>
            {lineage.rows.length > lineageShown && (
              <Pill
                interactive
                tone="info"
                size="sm"
                className="mt-2"
                onClick={() => setLineageShown((shown) => shown + LINEAGE_PAGE_STEP)}
              >
                {showMoreLabel(lineage.rows.length - lineageShown)}
              </Pill>
            )}
          </div>
        )}

        {outputPreview && (
          <section aria-label="Output">
            <span
              aria-hidden="true"
              className="mb-2 block font-display text-[length:var(--text-md)] font-semibold tracking-[-0.01em] text-fg-dim"
            >
              Output
            </span>
            <pre
              // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable region must be keyboard-focusable so it can be scrolled without a mouse (WCAG 2.1.1); WebKit (WKWebView, WebKitGTK) does not focus scroll containers natively.
              tabIndex={0}
              className="scroll-area m-0 max-h-[200px] overflow-y-auto rounded-md border border-surface-2 bg-void p-3 font-mono text-[0.6875rem] break-all whitespace-pre-wrap text-[color:oklch(0.72_0.04_220)]"
            >
              {outputPreview}
            </pre>
          </section>
        )}
      </div>

      {/* Actions — a uniform-width group; Kill is the danger tone. Each
          is a transition inside useWorker, so its optimistic state holds
          while the IPC call is in flight. */}
      <div className="flex gap-2 border-t border-border p-4">
        <Pill
          interactive
          tone="neutral"
          size="md"
          onClick={pause}
          disabled={!canPause}
          className="flex-1"
        >
          Pause
        </Pill>
        <Pill
          interactive
          tone="neutral"
          size="md"
          onClick={resume}
          disabled={!canResume}
          className="flex-1"
        >
          Resume
        </Pill>
        <Pill interactive tone="danger" size="md" onClick={kill} className="flex-1">
          Kill
        </Pill>
      </div>
    </div>
  );
}
