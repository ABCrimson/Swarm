import { Spinner } from "#components/ui/Spinner";
import type { ShipProgressRow } from "#hooks/useShip";

interface ShipProgressProps {
  readonly rows: readonly ShipProgressRow[];
}

/**
 * Title Case labels for the steps the backend reports; an unknown step
 * shows its raw name. `compare` is `ship_compare_url` building the link —
 * the browser opens it only after the ship has settled (`useShip`), so the
 * row must not claim the page was opened.
 */
const STEP_LABELS = new Map([
  ["staging", "Staging"],
  ["commit", "Commit"],
  ["push", "Push"],
  ["compare", "Compare Page Link"],
]);

/** Screen-reader wording for a step's status (the icons are decorative). */
const STATUS_LABELS: Record<ShipProgressRow["status"], string> = {
  running: "In Progress",
  ok: "Done",
  error: "Failed",
};

const CONTAINER_CLASS = "m-0 flex list-none flex-col gap-2 p-4";
const ROW_CLASS =
  "flex items-center gap-2.5 rounded-md border border-border bg-[oklch(0.10_0.03_220/0.6)] px-2.5 py-2";
const LABEL_CLASS = "flex-1 font-body text-[0.8125rem] text-[oklch(0.88_0.03_220)]";
const DETAIL_CLASS =
  "max-w-[220px] overflow-hidden text-ellipsis whitespace-nowrap font-mono text-[0.6875rem] text-fg-dim";

function StatusIcon({
  status,
}: {
  readonly status: ShipProgressRow["status"];
}): React.ReactElement {
  if (status === "ok") {
    return (
      <span aria-hidden="true" className="text-[0.875rem] text-[oklch(0.75_0.16_150)]">
        {"✓"}
      </span>
    );
  }
  if (status === "error") {
    return (
      <span aria-hidden="true" className="text-[0.875rem] text-[oklch(0.68_0.20_25)]">
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
    <ul className={CONTAINER_CLASS} aria-label="Ship Progress" aria-live="polite">
      {latestByStep
        .values()
        .map((row) => (
          <li key={row.step} className={ROW_CLASS}>
            <StatusIcon status={row.status} />
            <span className={LABEL_CLASS}>
              {STEP_LABELS.get(row.step) ?? row.step}
              <span className="sr-only">{` — ${STATUS_LABELS[row.status]}`}</span>
            </span>
            {row.detail != null && (
              <span className={DETAIL_CLASS} title={row.detail}>
                {row.detail}
              </span>
            )}
          </li>
        ))
        .toArray()}
    </ul>
  );
}
