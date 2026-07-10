// ── StatusBar ───────────────────────────────────────
// Fixed bottom bar: 24h AI cost estimate, worker count, system status.
// 28px height, OKLCH text, glass-panel background.
// GPU frame time from gpuFrameTimeAtom — toggleable.

import { useAtomValue } from "jotai";
import type { CSSProperties } from "react";
import { useState } from "react";
import { pluralizeWorkers } from "#lib/format";
import { useSystemStore } from "#store/system";
import { gpuFrameTimeAtom } from "#store/ui";

const barStyle: CSSProperties = {
  height: 28,
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  padding: "0 16px",
  background: "oklch(0.08 0.02 220 / 0.85)",
  backdropFilter: "blur(12px) saturate(1.5)",
  borderTop: "1px solid oklch(0.22 0.04 220)",
  fontFamily: "var(--font-mono)",
  fontSize: 11,
  color: "oklch(0.55 0.04 220)",
  flexShrink: 0,
};

const dotStyle: CSSProperties = {
  display: "inline-block",
  width: 6,
  height: 6,
  borderRadius: "50%",
  marginRight: 6,
};

const sectionStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 16,
};

/**
 * Fixed bottom status bar showing system health, worker count,
 * 24h cost estimate, and toggleable GPU frame time.
 *
 * Height: 28px. Uses `aria-live="polite"` for screen reader updates.
 */
export function StatusBar(): React.ReactElement {
  const workerCount = useSystemStore((s) => s.metrics.workerCount) ?? 0;
  const tokensPerSec = useSystemStore((s) => s.metrics.tokensPerSec) ?? 0;
  const cpuPercent = useSystemStore((s) => s.metrics.cpuPercent) ?? 0;
  const gpuFrameTime = useAtomValue(gpuFrameTimeAtom) ?? 0;
  const [showGpu, setShowGpu] = useState(true);

  // Rough 24h cost estimate: tokens/sec * 86400 * $0.000015 (sonnet pricing avg)
  const dailyCost = (tokensPerSec * 86_400 * 0.000015).toFixed(2);

  const statusColor =
    cpuPercent > 80
      ? "oklch(0.68 0.22 15)"
      : cpuPercent > 50
        ? "oklch(0.78 0.18 70)"
        : "oklch(0.78 0.18 140)";

  return (
    <output style={barStyle} aria-live="polite" aria-label="System Status Bar">
      <div style={sectionStyle}>
        <span className="flex items-center">
          <span style={{ ...dotStyle, background: statusColor }} aria-hidden="true" />
          {cpuPercent > 80 ? "High Load" : cpuPercent > 50 ? "Moderate" : "Nominal"}
        </span>
        <span style={{ color: "oklch(0.5 0.04 220)" }} aria-hidden="true">
          |
        </span>
        <span>{pluralizeWorkers(workerCount)}</span>
      </div>

      <div style={sectionStyle}>
        <span style={{ color: "oklch(0.6 0.05 220)" }}>Est. ~${dailyCost}/24h</span>
        {showGpu && (
          <>
            <span style={{ color: "oklch(0.5 0.04 220)" }} aria-hidden="true">
              |
            </span>
            <span>GPU {gpuFrameTime.toFixed(1)}ms</span>
          </>
        )}
        <button
          type="button"
          onClick={() => setShowGpu((v) => !v)}
          aria-label={showGpu ? "Hide GPU Frame Time" : "Show GPU Frame Time"}
          style={{
            background: "none",
            border: "none",
            color: "oklch(0.55 0.04 220)",
            cursor: "pointer",
            fontFamily: "var(--font-mono)",
            fontSize: 10,
            padding: "2px 6px",
            borderRadius: 4,
            outline: "none",
            transition:
              "background 0.12s cubic-bezier(0, 0, 0.2, 1), color 0.12s cubic-bezier(0, 0, 0.2, 1)",
          }}
          onFocus={(e) => {
            e.currentTarget.style.boxShadow = "0 0 0 1px oklch(0.78 0.18 205 / 0.5)";
          }}
          onBlur={(e) => {
            e.currentTarget.style.boxShadow = "none";
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.color = "oklch(0.78 0.18 205)";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.color = "oklch(0.55 0.04 220)";
          }}
        >
          {showGpu ? "Hide GPU" : "Show GPU"}
        </button>
      </div>
    </output>
  );
}
