import type { WorkerState } from "#store/types";

interface BadgeProps {
  readonly state: WorkerState;
  readonly children: React.ReactNode;
  readonly className?: string;
}

/**
 * State-aware badge that renders worker lifecycle status.
 *
 * Sets `data-state` for CSS-driven colour variants (idle, running, paused, error).
 */
export function Badge({ state, children, className }: BadgeProps): React.ReactElement {
  return (
    <span data-state={state} className={`swarm-badge ${className ?? ""}`}>
      {children}
    </span>
  );
}
