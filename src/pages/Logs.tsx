import { PageHeader } from "#components/layout/PageHeader";
import { LogViewer } from "#components/logs/LogViewer";

/**
 * Logs page with centralized log viewer, level/source filters,
 * full-text search, and virtualised rendering.
 */
export function Logs(): React.ReactElement {
  return (
    <div className="flex h-full flex-col overflow-hidden">
      <PageHeader title="Logs" />

      {/* Log viewer, on the PageHeader's 28px gutter */}
      <div className="relative mx-7 mb-6 flex-1">
        <LogViewer />
      </div>
    </div>
  );
}
