import { useSystemStore } from "#store/system";

/**
 * Top bar for the SWARM Orchestrator.
 * Shows app title in Syne Variable and worker count.
 * Acts as the Tauri frameless window drag region.
 */
export function Topbar(): React.ReactElement {
  const workerCount = useSystemStore((s) => s.metrics.workerCount) ?? 0;

  return (
    <header
      data-tauri-drag-region
      className="flex items-center justify-between px-6"
      style={{
        height: 48,
        borderBottom: "1px solid oklch(0.22 0.04 220)",
        background: "oklch(0.08 0.02 220 / 0.8)",
        backdropFilter: "blur(8px) saturate(1.5)",
      }}
    >
      <div className="flex items-center gap-3">
        <h1
          style={{
            fontFamily: "var(--font-display)",
            fontWeight: 700,
            fontSize: "0.875rem",
            letterSpacing: "0.08em",
            textTransform: "uppercase",
            color: "oklch(0.78 0.18 205)",
          }}
        >
          SWARM
        </h1>
        <span
          style={{
            fontFamily: "var(--font-body)",
            fontSize: "0.75rem",
            color: "oklch(0.55 0.04 220)",
          }}
        >
          Orchestrator
        </span>
      </div>

      {/* Worker count badge */}
      <div
        className="flex items-center gap-2"
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: "0.75rem",
          color: "oklch(0.55 0.04 220)",
        }}
      >
        <span
          aria-hidden="true"
          className="inline-block rounded-full"
          style={{
            width: 6,
            height: 6,
            background: "oklch(0.82 0.18 140)",
          }}
        />
        <span>
          {workerCount} worker{workerCount !== 1 ? "s" : ""}
        </span>
      </div>
    </header>
  );
}
