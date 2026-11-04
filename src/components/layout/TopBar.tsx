import { useAtomValue } from "jotai";
import { pluralizeWorkers } from "#lib/format";
import { formatBinding } from "#lib/keybindings";
import { useSystemStore } from "#store/system";
import { keybindingsAtom } from "#store/ui";

/**
 * Top bar: the product name (the SWARM wordmark itself lives in the sidebar), the command palette shortcut and the live worker count.
 *
 * The window keeps its native title bar (`decorations: true` in
 * tauri.conf.json), so this is ordinary page chrome, not a drag region.
 * The name is not a heading: every page renders its own `<h1>`.
 */
export function TopBar(): React.ReactElement {
  const workerCount = useSystemStore((s) => s.metrics.workerCount) ?? 0;
  const { commandPalette } = useAtomValue(keybindingsAtom);

  return (
    <header className="glass-panel flex h-12 items-center justify-between border-border border-b px-6">
      <p className="flex items-center gap-2 text-fg-muted text-sm">
        <span className="sr-only">SWARM </span>
        <span>Orchestrator</span>
        <span className="sr-only">Command Palette </span>
        <kbd className="rounded-md border border-border bg-surface-0 px-1.5 py-0.5 font-mono text-fg-dim text-xs">
          {formatBinding(commandPalette)}
        </kbd>
      </p>

      <p className="flex items-center gap-2 font-mono text-fg-muted text-sm">
        <span aria-hidden="true" className="size-1.5 rounded-full bg-lime" />
        {pluralizeWorkers(workerCount)}
      </p>
    </header>
  );
}
