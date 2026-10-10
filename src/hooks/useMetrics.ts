import { useEffect } from "react";
import * as z from "zod";
import { onEvent } from "#lib/event-bus";
import { tokensPerSecond } from "#lib/metrics-aggregation";
import { useAiStore } from "#store/ai";
import { useSystemStore } from "#store/system";

/** The backend's `system_metrics` payload (swarm-core `SystemMetricsPayload`, camelCase). */
const SystemMetricsPayloadSchema = z.object({
  cpuPercent: z.number(),
  memoryMb: z.number(),
  memoryTotalMb: z.number(),
  workerCount: z.number().int(),
});

/**
 * Global metrics event subscription hook. Call once at the app root.
 *
 * Each `system_metrics` envelope is validated and recorded as one sample
 * in the system store, its history point stamped with the envelope's own
 * `ts` — so samples replayed by the event bus's gap backfill land at the
 * time they were measured, not the time they arrived. The backend payload
 * has no token figure, so Tokens/s is derived here from the AI store's
 * token-usage records over `TOKEN_RATE_WINDOW_MS`.
 */
export function useMetrics(): void {
  useEffect(
    () =>
      onEvent("system_metrics", (e) => {
        const parsed = SystemMetricsPayloadSchema.safeParse(e.payload);
        if (!parsed.success) {
          console.warn("[metrics] Ignoring malformed system_metrics payload:", parsed.error);
          return;
        }
        const tokensPerSec = tokensPerSecond(
          useAiStore.getState().cumulativeUsage.history,
          Date.now(),
        );
        useSystemStore.getState().recordSample({ ...parsed.data, tokensPerSec }, e.ts);
      }),
    [],
  );
}
