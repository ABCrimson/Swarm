import { Pill, type PillTone } from "#components/ui/Pill";
import type { WorkerState } from "#store/types";

interface BadgeProps {
  readonly state: WorkerState;
  readonly children: React.ReactNode;
  readonly className?: string;
}

/** Human-readable, Title Case label for each worker lifecycle state. */
export const stateLabels: Record<WorkerState, string> = {
  idle: "Idle",
  running: "Running",
  paused: "Paused",
  error: "Error",
};

const STATE_TONE: Record<WorkerState, PillTone> = {
  idle: "neutral",
  running: "info",
  paused: "warning",
  error: "danger",
};

/**
 * State-aware badge that renders worker lifecycle status.
 *
 * Thin convenience wrapper around the shared `Pill` component — maps
 * `WorkerState` to a semantic `PillTone` and keeps `data-state` for any
 * state-keyed styling/tests. Sets no color of its own; `.swarm-pill`
 * owns the visual system.
 */
export function Badge({ state, children, className }: BadgeProps): React.ReactElement {
  return (
    <Pill tone={STATE_TONE[state]} size="sm" data-state={state} className={className}>
      {children}
    </Pill>
  );
}
