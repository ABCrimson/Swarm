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
          Logs
        </h1>
        <p
          style={{
            fontFamily: "var(--font-body)",
            fontSize: 13,
            color: "oklch(0.55 0.04 220)",
          }}
        >
          Centralised log aggregation from all sources
        </p>
      </div>

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
