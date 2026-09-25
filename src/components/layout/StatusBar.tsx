import { useAtom, useAtomValue } from "jotai";
import { pluralizeWorkers } from "#lib/format";
import { useAiStore } from "#store/ai";
import { useSystemStore } from "#store/system";
import { gpuFrameTimeAtom, themeAtom } from "#store/ui";

const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

/** Health label and dot color for a CPU load percentage. */
function health(cpuPercent: number): { readonly label: string; readonly dot: string } {
  if (cpuPercent > 80) return { label: "High Load", dot: "bg-rose" };
  if (cpuPercent > 50) return { label: "Moderate", dot: "bg-amber" };
  return { label: "Nominal", dot: "bg-lime" };
}

/**
 * Status bar, the last row of the main column: system health, worker
 * count, AI spend so far this session, and (toggleable) the particle
 * background's GPU frame time.
 *
 * Only the health label is a live region (`role="status"`): it changes
 * rarely and is worth announcing. The fast-changing numbers and the
 * toggle stay out of it so screen readers are not flooded.
 */
export function StatusBar(): React.ReactElement {
  const workerCount = useSystemStore((s) => s.metrics.workerCount) ?? 0;
  const cpuPercent = useSystemStore((s) => s.metrics.cpuPercent) ?? 0;
  const spentUsd = useAiStore((s) => s.cumulativeUsage.totalCostUsd);
  const gpuFrameTime = useAtomValue(gpuFrameTimeAtom);
  // Shared with Settings' "GPU Frame Time Overlay" toggle: one persisted setting.
  const [theme, setTheme] = useAtom(themeAtom);
  const showGpu = theme.gpuOverlay;
  const { label, dot } = health(cpuPercent);

  return (
    <footer className="glass-panel flex h-7 shrink-0 items-center justify-between border-border border-t px-4 font-mono text-fg-muted text-xs">
      <div className="flex items-center gap-4">
        <span role="status" className="flex items-center gap-1.5">
          <span aria-hidden="true" className={`size-1.5 rounded-full ${dot}`} />
          {label}
        </span>
        <span aria-hidden="true" className="text-fg-dim">
          |
        </span>
        <span>{pluralizeWorkers(workerCount)}</span>
      </div>

      <div className="flex items-center gap-4">
        <span title="Anthropic API Spend Recorded Since The App Started">
          AI Spend {usd.format(spentUsd)}
        </span>
        {showGpu && (
          <>
            <span aria-hidden="true" className="text-fg-dim">
              |
            </span>
            <span title="Time The GPU Took To Finish The Last Particle Frames">
              GPU {gpuFrameTime.toFixed(1)}ms
            </span>
          </>
        )}
        <button
          type="button"
          onClick={() => setTheme((prev) => ({ ...prev, gpuOverlay: !prev.gpuOverlay }))}
          aria-label={showGpu ? "Hide GPU Frame Time" : "Show GPU Frame Time"}
          className="cursor-pointer rounded px-1.5 py-0.5 text-2xs transition-colors duration-150 hover:bg-surface-2 hover:text-plasma"
        >
          {showGpu ? "Hide GPU" : "Show GPU"}
        </button>
      </div>
    </footer>
  );
}
