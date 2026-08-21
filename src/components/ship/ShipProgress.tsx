import type { CSSProperties } from "react";
import { Spinner } from "#components/ui/Spinner";
import type { ShipProgressRow } from "#hooks/useShip";

interface ShipProgressProps {
  readonly rows: readonly ShipProgressRow[];
}

const STEP_LABELS: Record<string, string> = {
  staging: "Staging",
  commit: "Commit",
  push: "Push",
  compare: "Open Compare Page",
};

const containerStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 8,
  padding: 16,
};

const rowStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 10,
  padding: "8px 10px",
  borderRadius: 8,
  background: "oklch(0.10 0.03 220 / 0.6)",
  border: "1px solid oklch(0.22 0.04 220)",
};

const labelStyle: CSSProperties = {
  fontFamily: "var(--font-body)",
  fontSize: "0.8125rem",
  color: "oklch(0.88 0.03 220)",
  flex: 1,
};

const detailStyle: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: "0.6875rem",
  color: "oklch(0.55 0.04 220)",
  maxWidth: 220,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

function StatusIcon({
  status,
}: {
  readonly status: ShipProgressRow["status"];
}): React.ReactElement {
  if (status === "ok") {
    return (
      <span
        role="img"
        aria-label="Done"
        style={{ color: "oklch(0.75 0.16 150)", fontSize: "0.875rem" }}
      >
        {"✓"}
      </span>
    );
  }
  if (status === "error") {
    return (
      <span
        role="img"
        aria-label="Failed"
        style={{ color: "oklch(0.68 0.20 25)", fontSize: "0.875rem" }}
      >
        {"✕"}
      </span>
    );
  }
  return <Spinner size="sm" />;
}

/**
 * Live progress checklist fed by `ship_progress` events (via
 * `useShip`'s `progress` array) — each row appears the moment its
 * step starts and updates in place as `status` transitions from
 * `"running"` to `"ok"`/`"error"`. Rows appear only for steps the
 * chosen action actually runs (never pre-rendered as pending), since
 * this app doesn't fabricate progress for steps that might not
 * happen.
 */
export function ShipProgress({ rows }: ShipProgressProps): React.ReactElement {
  // Collapse to the latest row per step (a step transitions
  // running → ok/error, both events land in `rows`).
  const latestByStep = new Map<string, ShipProgressRow>();
  for (const row of rows) {
    latestByStep.set(row.step, row);
  }

  return (
    <ul style={{ ...containerStyle, listStyle: "none", margin: 0 }} aria-label="Ship Progress">
      {[...latestByStep.values()].map((row) => (
        <li key={row.step} style={rowStyle}>
          <StatusIcon status={row.status} />
          <span style={labelStyle}>{STEP_LABELS[row.step] ?? row.step}</span>
          {row.detail != null && (
            <span style={detailStyle} title={row.detail}>
              {row.detail}
            </span>
          )}
        </li>
      ))}
    </ul>
  );
}
