import { WorkspacePanel } from "#components/workspace/WorkspacePanel";

/**
 * Workspace page: a project file browser. Renders the
 * {@link WorkspacePanel} — a resizable file tree and a read-only file
 * viewer (JSON files are syntax-highlighted; everything else is plain
 * text).
 */
export function Workspace(): React.ReactElement {
  return (
    <div className="flex h-full flex-col overflow-hidden">
      <header className="px-7 pt-5 pb-3">
        <h1 className="mb-1 font-bold font-display text-2xl text-fg-bright tracking-[-0.01em]">
          Workspace
        </h1>
        <p className="text-fg-muted text-md">Browse And Inspect Project Files</p>
      </header>

      <div className="mx-4 mb-4 flex-1 overflow-hidden rounded-xl border border-border bg-surface-0/50 backdrop-blur-md">
        <WorkspacePanel />
      </div>
    </div>
  );
}
