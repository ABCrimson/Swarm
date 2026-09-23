import { pluralizeWorkers } from "#lib/format";
import { useSystemStore } from "#store/system";

/**
 * Top bar: the app name and the live worker count.
 *
 * The window keeps its native title bar (`decorations: true` in
 * tauri.conf.json), so this is ordinary page chrome, not a drag region.
 * The name is not a heading: every page renders its own `<h1>`.
 */
export function TopBar(): React.ReactElement {
  const workerCount = useSystemStore((s) => s.metrics.workerCount) ?? 0;

  return (
    <header className="glass-panel flex h-12 items-center justify-between border-border border-b px-6">
      <p className="flex items-baseline gap-3">
        <span className="font-bold font-display text-plasma text-sm uppercase tracking-[0.08em]">
          SWARM
        </span>
        <span className="text-fg-muted text-sm">Orchestrator</span>
      </p>

      <p className="flex items-center gap-2 font-mono text-fg-muted text-sm">
        <span aria-hidden="true" className="size-1.5 rounded-full bg-lime" />
        {pluralizeWorkers(workerCount)}
      </p>
    </header>
  );
}
