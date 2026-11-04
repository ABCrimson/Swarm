import { PageHeader } from "#components/layout/PageHeader";
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
      <PageHeader title="Workspace" />

      <div className="mx-4 mb-4 flex-1 overflow-hidden rounded-lg border border-border bg-surface-0/50 backdrop-blur-md">
        <WorkspacePanel />
      </div>
    </div>
  );
}
