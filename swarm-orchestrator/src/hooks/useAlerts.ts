// ── useAlerts ───────────────────────────────────────
// Subscribes to useSystemStore and evaluates thresholds on each update.
// Fires Sonner toasts with appropriate severity (warning=amber, critical=rose).

import { useAtom, useAtomValue } from "jotai";
import { useEffect, useRef } from "react";
import { toast } from "sonner";
import type { MetricsSnapshot } from "#lib/alerts";
import { alertCooldownsAtom, alertThresholdsAtom, evaluateThresholds } from "#lib/alerts";
import { memPercent } from "#lib/memory";
import { useSystemStore } from "#store/system";

/**
 * Evaluates system metrics against alert thresholds and fires Sonner toasts.
 * Call once at app root level.
 */
export function useAlerts(): void {
  const thresholds = useAtomValue(alertThresholdsAtom);
  const [cooldowns, setCooldowns] = useAtom(alertCooldownsAtom);
  const cooldownsRef = useRef(cooldowns);
  cooldownsRef.current = cooldowns;

  useEffect(() => {
    const unsub = useSystemStore.subscribe(
      (s) => s.metrics,
      (metrics) => {
        const now = Date.now();

        // Build metrics snapshot. `memPercent` derives the denominator from
        // the real hardware total reported by the backend; it returns
        // `undefined` until a nonzero total has been observed, which we
        // treat as 0% so no alert fires on a not-yet-known total.
        const memoryPercent = memPercent(metrics.memoryMb, metrics.memoryTotalMb) ?? 0;
        const snapshot: MetricsSnapshot = {
          cpuPercent: metrics.cpuPercent,
          memoryPercent,
        };

        const alerts = evaluateThresholds(snapshot, thresholds, cooldownsRef.current, now);

        if (alerts.length === 0) return;

        // Update cooldowns
        const newCooldowns = { ...cooldownsRef.current };
        for (const alert of alerts) {
          newCooldowns[alert.metric] = now;

          // Fire Sonner toast
          if (alert.severity === "critical") {
            toast.error(alert.message, {
              duration: 6000,
              style: {
                background: "oklch(0.14 0.06 10 / 0.95)",
                border: "1px solid oklch(0.50 0.14 10)",
                color: "oklch(0.72 0.20 10)",
                fontFamily: "var(--font-mono)",
                fontSize: 12,
              },
            });
          } else {
            toast.warning(alert.message, {
              duration: 4000,
              style: {
                background: "oklch(0.14 0.06 70 / 0.95)",
                border: "1px solid oklch(0.55 0.12 70)",
                color: "oklch(0.82 0.19 70)",
                fontFamily: "var(--font-mono)",
                fontSize: 12,
              },
            });
          }
        }

        setCooldowns(newCooldowns);
      },
    );

    return unsub;
  }, [thresholds, setCooldowns]);
}
