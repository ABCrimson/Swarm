import { open } from "@tauri-apps/plugin-shell";
import { formatDistanceToNow } from "date-fns";
import { useSetAtom } from "jotai";
import { toast } from "sonner";
import { Badge, stateLabels } from "#components/ui/Badge";
import { Pill } from "#components/ui/Pill";
import { useWorker } from "#hooks/useWorker";
import { selectMostRecentSeqForWorker, useProvenanceStore } from "#store/provenance";
import type { Worker } from "#store/types";
import { causalityInspectorAtom, detailPanelOpenAtom } from "#store/ui";

interface WorkerDetailProps {
  readonly worker: Worker;
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
      <span
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: "0.6875rem",
          color: "oklch(0.55 0.04 220)",
          textTransform: "uppercase",
          letterSpacing: "0.08em",
        }}
      >
        {label}
      </span>
      <span
        style={{
          fontFamily: "var(--font-body)",
          fontSize: "0.8125rem",
          color: "oklch(0.82 0.04 220)",
        }}
      >
        {children}
      </span>
    </div>
  );
}

/**
 * Side panel showing detailed worker info: state, ID, PID, uptime,
 * output preview, and action buttons (pause, resume, kill).
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

  const currentState = optimisticState ?? worker.state;
  const canPause = currentState === "running";
  const canResume = currentState === "paused";
  const uptime = formatDistanceToNow(new Date(worker.startedAt), { addSuffix: false });

  const handleOpenWorktree = async () => {
    if (!worker.worktreePath) return;
    // Reject a ".." path-traversal segment before ever reaching
    // open(). tauri.conf.json's plugins.shell.open regex validates the
    // path is a real filesystem path (drive/UNC/absolute), but the
    // `regex` crate the plugin validates with has no lookahead
    // support, so "does this string contain '..' anywhere" cannot be
    // expressed there — this check does it here instead, on the one
    // path that ever reaches open() in the app today.
    if (worker.worktreePath.includes("..")) {
      toast.error("Refusing To Open A Path Containing '..'.");
      return;
    }
    try {
      await open(worker.worktreePath);
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
        {/* Worker Name */}
        <div>
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
        </div>

        {/* Info rows */}
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <DetailRow label="State">
            <Badge state={currentState}>{stateLabels[currentState] ?? currentState}</Badge>
          </DetailRow>
          <DetailRow label="ID">
            <span style={{ fontFamily: "var(--font-mono)", fontSize: "0.6875rem" }}>
              {worker.id.slice(0, 12)}
            </span>
          </DetailRow>
          {worker.pid != null && <DetailRow label="PID">{worker.pid}</DetailRow>}
          <DetailRow label="Uptime">{uptime}</DetailRow>
          {worker.branch != null && <DetailRow label="Branch">{worker.branch}</DetailRow>}
          {worker.worktreePath != null && (
            <DetailRow label="Worktree">
              <button
                type="button"
                onClick={() => void handleOpenWorktree()}
                title={worker.worktreePath}
                style={{
                  background: "none",
                  border: "none",
                  padding: 0,
                  margin: 0,
                  cursor: "pointer",
                  color: "oklch(0.78 0.18 205)",
                  fontFamily: "var(--font-body)",
                  fontSize: "0.8125rem",
                  textDecoration: "underline",
                  textUnderlineOffset: 2,
                  maxWidth: 180,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {worker.worktreePath}
              </button>
            </DetailRow>
          )}
        </div>

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

        {/* Output preview */}
        {worker.output && (
          <div>
            <span
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
              {worker.output.slice(-2000)}
            </pre>
          </div>
        )}
      </div>

      {/* Actions — same-purpose action pills in a uniform-width group
          (flex: 1 on each) rather than three independently-sized
          buttons. Kill is a real button (interactive) with danger tone
          for proper destructive-action affordance. */}
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
