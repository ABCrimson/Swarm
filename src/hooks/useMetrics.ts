import { useEffect } from "react";
import { onEvent } from "#lib/event-bus";
import { tokensPerSecond } from "#lib/metrics-aggregation";
import { useAiStore } from "#store/ai";
import { useSystemStore } from "#store/system";

/**
 * Global metrics event subscription hook. Call once at the app root.
 *
 * Each `system_metrics` envelope (validated by `#lib/event-bus`) is
 * recorded as one sample in the system store, its history point stamped
 * with the envelope's own `ts` — so samples replayed by the event bus's
 * gap backfill land at the time they were measured, not the time they
 * arrived. The backend payload has no token figure, so Tokens/s is
 * derived here from the AI store's token-usage records over
 * `TOKEN_RATE_WINDOW_MS`.
 */
export function useMetrics(): void {
  useEffect(
    () =>
      onEvent(
        "system_metrics",
        ({ ts, payload: { cpuPercent, memoryMb, memoryTotalMb, workerCount } }) =>
          useSystemStore.getState().recordSample(
            {
              cpuPercent,
              memoryMb,
              memoryTotalMb,
              workerCount,
              tokensPerSec: tokensPerSecond(
                useAiStore.getState().cumulativeUsage.history,
                Date.now(),
              ),
            },
            ts,
          ),
      ),
    [],
  );
}
