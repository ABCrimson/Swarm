import "./graph.css";

import { openPath } from "@tauri-apps/plugin-opener";
import { formatDistance } from "date-fns";
import { useSetAtom } from "jotai";
import { startTransition, useEffect, useState } from "react";
import { Badge, stateLabels } from "#components/ui/Badge";
import { Pill } from "#components/ui/Pill";
import { toast } from "#components/ui/Toast";
import { useWorker } from "#hooks/useWorker";
import { stripAnsi } from "#lib/ansi";
import { isTauri } from "#lib/tauri";
import { selectMostRecentSeqForWorker, useProvenanceStore } from "#store/provenance";
import type { Worker } from "#store/types";
import { causalityInspectorAtom, detailPanelOpenAtom } from "#store/ui";

interface WorkerDetailProps {
  readonly worker: Worker;
}

/** Characters of (escape-stripped) output shown in the preview. */
const OUTPUT_PREVIEW_CHARS = 2000;
/** How often the uptime readout refreshes. */
const UPTIME_TICK_MS = 15_000;

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
          fontFamily: "var(--font-mono)",
          fontSize: "0.6875rem",
          color: "oklch(0.55 0.04 220)",
          textTransform: "uppercase",
          letterSpacing: "0.08em",
        }}
      >
        {label}
      </dt>
      <dd
        style={{
          margin: 0,
          fontFamily: "var(--font-body)",
          fontSize: "0.8125rem",
          color: "oklch(0.82 0.04 220)",
        }}
      >
        {children}
      </dd>
    </div>
  );
}

/**
 * Side panel with a worker's details — state, ID, PID, a live uptime,
 * branch/worktree, an escape-stripped output preview — and Pause, Resume
 * and Kill, which run `useWorker`'s IPC actions inside a transition so
 * the optimistic state holds while the backend call is in flight.
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
  const now = useNow(UPTIME_TICK_MS);

  const currentState = optimisticState ?? worker.state;
  const canPause = currentState === "running";
  const canResume = currentState === "paused";
  const uptime = formatDistance(now, new Date(worker.startedAt));
  const outputPreview = worker.output ? stripAnsi(worker.output).slice(-OUTPUT_PREVIEW_CHARS) : "";

  const handleOpenWorktree = async (path: string): Promise<void> => {
    // Defense in depth: never hand a path with a ".." segment to the
    // opener. The capability's `opener:allow-open-path` scope is the
    // authoritative allowlist for the worktree root; this check keeps a
    // traversal-shaped path from even being attempted.
    if (path.includes("..")) {
      toast.error("Refusing To Open A Path Containing '..'.");
      return;
    }
    try {
      // openPath (not revealItemInDir): the worktree folder itself
      // opens in the system file manager, which is what the link says.
      await openPath(path);
    } catch (err) {
      toast.error(`Could Not Open Worktree: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  return (
    <div
      style={{
        width: 320,
        height: "100%",
        background: "oklch(0.10 0.03 220)",
        borderLeft: "1px solid oklch(0.22 0.04 220)",
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
          Worker Detail
        </h2>
        <button
          type="button"
          onClick={() => setDetailOpen(false)}
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
            color: "oklch(0.95 0.02 220)",
          }}
        >
          {worker.name ?? worker.id.slice(0, 8)}
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
          {worker.branch != null && <DetailRow label="Branch">{worker.branch}</DetailRow>}
          {worker.worktreePath != null && (
            <DetailRow label="Worktree">
              {isTauri() ? (
                <button
                  type="button"
                  onClick={() => void handleOpenWorktree(worker.worktreePath ?? "")}
                  title={worker.worktreePath}
                  className="worker-detail__path"
                >
                  {worker.worktreePath}
                </button>
              ) : (
                // Opening a folder needs the desktop app's opener plugin.
                <span className="worker-detail__path" title={worker.worktreePath}>
                  {worker.worktreePath}
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

        {outputPreview && (
          <section aria-label="Output">
            <span
              aria-hidden="true"
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: "0.6875rem",
                color: "oklch(0.55 0.04 220)",
                textTransform: "uppercase",
                letterSpacing: "0.08em",
                display: "block",
                marginBottom: 8,
              }}
            >
              Output
            </span>
            <pre
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: "0.6875rem",
                color: "oklch(0.72 0.04 220)",
                background: "oklch(0.06 0.02 220)",
                border: "1px solid oklch(0.14 0.03 220)",
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
          runs as a transition, so useWorker's optimistic state holds
          while the IPC call is in flight. */}
      <div
        style={{
          display: "flex",
          gap: 8,
          padding: "16px",
          borderTop: "1px solid oklch(0.22 0.04 220)",
        }}
      >
        <Pill
          interactive
          tone="neutral"
          size="md"
          onClick={() => startTransition(pause)}
          disabled={!canPause}
          style={{ flex: 1 }}
        >
          Pause
        </Pill>
        <Pill
          interactive
          tone="neutral"
          size="md"
          onClick={() => startTransition(resume)}
          disabled={!canResume}
          style={{ flex: 1 }}
        >
          Resume
        </Pill>
        <Pill
          interactive
          tone="danger"
          size="md"
          onClick={() => startTransition(kill)}
          style={{ flex: 1 }}
        >
          Kill
        </Pill>
      </div>
    </div>
  );
}
