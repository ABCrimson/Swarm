import { WorkspacePanel } from "#components/workspace/WorkspacePanel";

/**
 * Workspace page providing a project file browser and viewer.
 *
 * Renders the {@link WorkspacePanel} with a resizable file tree sidebar
 * and read-only file content viewer with syntax highlighting.
 */
export function Workspace(): React.ReactElement {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        overflow: "hidden",
      }}
    >
      {/* Page header */}
      <div style={{ padding: "20px 28px 12px" }}>
        <h1
          style={{
            fontFamily: "var(--font-display)",
            fontSize: 24,
            fontWeight: 700,
            letterSpacing: "-0.01em",
            color: "oklch(0.95 0.02 220)",
            marginBottom: 4,
          }}
        >
          Workspace
        </h1>
        <p
          style={{
            fontFamily: "var(--font-body)",
            fontSize: 13,
            color: "oklch(0.55 0.04 220)",
          }}
        >
          Browse and inspect project files
        </p>
      </div>

      {/* Workspace content */}
      <div
        style={{
          flex: 1,
          margin: "0 16px 16px",
          borderRadius: 12,
          overflow: "hidden",
          border: "1px solid oklch(0.22 0.04 220)",
          background: "oklch(0.09 0.02 220 / 0.5)",
          backdropFilter: "blur(12px) saturate(1.5)",
        }}
      >
        <WorkspacePanel />
      </div>
    </div>
  );
}
