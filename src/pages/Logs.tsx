import { PageHeader } from "#components/layout/PageHeader";
import { LogViewer } from "#components/logs/LogViewer";

/**
 * Logs page with centralized log viewer, level/source filters,
 * full-text search, and virtualised rendering.
 */
export function Logs(): React.ReactElement {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        overflow: "hidden",
      }}
    >
      <PageHeader title="Logs" />

      {/* Log viewer */}
      <div
        style={{
          flex: 1,
          margin: "0 16px 16px",
          position: "relative",
        }}
      >
        <LogViewer />
      </div>
    </div>
  );
}
