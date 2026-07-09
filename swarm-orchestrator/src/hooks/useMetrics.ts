import { useEffect } from "react";
import { onSystemMetrics } from "#lib/tauri";
import { useSystemStore } from "#store/system";

/**
 * Global metrics event subscription hook.
 *
 * Must be called once at the app root level. Listens for `system:metrics`
 * events from the Tauri backend and updates the Zustand system store:
 *
 * - Updates current metric values (CPU%, memory, etc.)
 * - Pushes a history point for charting
 *
 * The listener is cleaned up on unmount.
 */
export function useMetrics(): void {
  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;

    const setup = async (): Promise<void> => {
      const { updateMetrics, pushHistory } = useSystemStore.getState();

      const fn = await onSystemMetrics((metrics) => {
        updateMetrics({
          cpuPercent: metrics.cpuPercent,
          memoryMb: metrics.memoryMb,
          workerCount: metrics.workerCount,
          aiReqPerSec: metrics.aiReqPerSec,
          tokensPerSec: metrics.tokensPerSec,
        });

        pushHistory({
          time: Date.now(),
          cpu: metrics.cpuPercent,
          memory: metrics.memoryMb,
          workerCount: metrics.workerCount,
        });
      });

      if (cancelled) {
        fn();
        return;
      }
      unlisten = fn;
    };

    void setup();

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);
}
