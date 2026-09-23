import type { CSSProperties } from "react";
import { Spinner } from "#components/ui/Spinner";
import type { ShipProgressRow } from "#hooks/useShip";

interface ShipProgressProps {
  readonly rows: readonly ShipProgressRow[];
}

/** Title Case labels for the steps the backend reports; an unknown step shows its raw name. */
const STEP_LABELS = new Map([
  ["staging", "Staging"],
  ["commit", "Commit"],
  ["push", "Push"],
  ["compare", "Open Compare Page"],
]);

/** Screen-reader wording for a step's status (the icons are decorative). */
const STATUS_LABELS: Record<ShipProgressRow["status"], string> = {
  running: "In Progress",
  ok: "Done",
  error: "Failed",
};

const containerStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 8,
  padding: 16,
  listStyle: "none",
  margin: 0,
};

const rowStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 10,
  padding: "8px 10px",
  borderRadius: 8,
  background: "oklch(0.10 0.03 220 / 0.6)",
  border: "1px solid var(--color-border)",
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
  color: "var(--color-text-dim)",
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
      <span aria-hidden="true" style={{ color: "oklch(0.75 0.16 150)", fontSize: "0.875rem" }}>
        {"✓"}
      </span>
    );
  }
  if (status === "error") {
    return (
      <span aria-hidden="true" style={{ color: "oklch(0.68 0.20 25)", fontSize: "0.875rem" }}>
        {"✕"}
      </span>
    );
  }
  return (
    <span aria-hidden="true">
      <Spinner size="sm" />
    </span>
  );
}

/**
 * Live progress checklist fed by `ship_progress` events (via
 * `useShip`'s `progress` array) — each row appears the moment its
 * step starts and updates in place as `status` transitions from
 * `"running"` to `"ok"`/`"error"`. Rows appear only for steps the
 * chosen action actually runs (never pre-rendered as pending), since
 * this app doesn't fabricate progress for steps that might not
 * happen. The list is a polite live region, so each step's completion
 * or failure is announced as it lands.
 */
export function ShipProgress({ rows }: ShipProgressProps): React.ReactElement {
  // Collapse to the latest row per step (a step transitions
  // running → ok/error, both events land in `rows`); a Map keeps each
  // step at the position it first appeared.
  const latestByStep = new Map(rows.map((row) => [row.step, row]));

  return (
    <ul style={containerStyle} aria-label="Ship Progress" aria-live="polite">
      {latestByStep
        .values()
        .map((row) => (
          <li key={row.step} style={rowStyle}>
            <StatusIcon status={row.status} />
            <span style={labelStyle}>
              {STEP_LABELS.get(row.step) ?? row.step}
              <span className="sr-only">{` — ${STATUS_LABELS[row.status]}`}</span>
            </span>
            {row.detail != null && (
              <span style={detailStyle} title={row.detail}>
                {row.detail}
              </span>
            )}
          </li>
        ))
        .toArray()}
    </ul>
  );
}
