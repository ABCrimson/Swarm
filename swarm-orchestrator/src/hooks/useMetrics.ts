import { useEffect } from "react";
import { onEvent } from "#lib/event-bus";
import { useSystemStore } from "#store/system";

/**
 * Global metrics event subscription hook.
 *
 * Must be called once at the app root level. Listens for `system_metrics`
 * events on the single ordered event bus and updates the Zustand system
 * store:
 *
 * - Updates current metric values (CPU%, memory, etc.)
 * - Pushes a history point for charting
 *
 * The listener is cleaned up on unmount.
 */
export function useMetrics(): void {
  useEffect(() => {
    const { updateMetrics, pushHistory } = useSystemStore.getState();

    const off = onEvent("system_metrics", (e) => {
      const p = e.payload as {
        cpuPercent: number;
        memoryMb: number;
        workerCount: number;
        aiReqPerSec: number;
      };

      updateMetrics({
        cpuPercent: p.cpuPercent,
        memoryMb: p.memoryMb,
        workerCount: p.workerCount,
        aiReqPerSec: p.aiReqPerSec,
      });

      pushHistory({
        time: Date.now(),
        cpu: p.cpuPercent,
        memory: p.memoryMb,
        workerCount: p.workerCount,
      });
    });

    return () => {
      off();
    };
  }, []);
}
