import { formatDistanceToNow } from "date-fns";
import { useAtom } from "jotai";
import { Badge } from "#components/ui/Badge";
import { Button } from "#components/ui/Button";
import { useWorker } from "#hooks/useWorker";
import type { Worker } from "#store/types";
import { detailPanelOpenAtom } from "#store/ui";

interface WorkerDetailProps {
  readonly worker: Worker;
}

const stateLabels: Record<string, string> = {
  idle: "Idle",
  running: "Running",
  paused: "Paused",
  error: "Error",
};

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
  const [, setDetailOpen] = useAtom(detailPanelOpenAtom);
  const { pause, resume, kill, optimisticState } = useWorker(worker.id);

  const currentState = optimisticState ?? worker.state;
  const canPause = currentState === "running";
  const canResume = currentState === "paused";
  const uptime = formatDistanceToNow(new Date(worker.startedAt), { addSuffix: false });

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
          aria-label="Close detail panel"
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
        </div>

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

      {/* Actions */}
      <div
        style={{
          display: "flex",
          gap: 8,
          padding: "16px",
          borderTop: "1px solid oklch(0.22 0.04 220)",
        }}
      >
        <Button variant="secondary" size="sm" onClick={pause} disabled={!canPause}>
          Pause
        </Button>
        <Button variant="secondary" size="sm" onClick={resume} disabled={!canResume}>
          Resume
        </Button>
        <Button variant="danger" size="sm" onClick={kill}>
          Kill
        </Button>
      </div>
    </div>
  );
}
