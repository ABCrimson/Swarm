// ── useAlerts ───────────────────────────────────────
// Evaluates every system-metrics update against the user's alert
// thresholds and fires Sonner toasts (warning = amber, critical = rose),
// mirrored as native OS notifications when that setting is on.

import { useAtomValue } from "jotai";
import { useEffect, useEffectEvent, useRef } from "react";
import { toast } from "sonner";
import type { Alert, AlertCooldowns } from "#lib/alerts";
import { alertThresholdsAtom, evaluateThresholds } from "#lib/alerts";
import { memPercent } from "#lib/memory";
import { hasCapability, isTauri, sendNotification } from "#lib/tauri";
import { useSystemStore } from "#store/system";
import type { SystemMetrics } from "#store/types";
import { appSettingsAtom } from "#store/ui";

/**
 * Toast skins as utilities. Sonner's own stylesheet is unlayered, so every
 * declaration here is important to outrank it; the colors are not tokens.
 */
const TOAST_CLASS = {
  critical:
    "border! border-solid! border-[oklch(0.50_0.14_10)]! bg-[oklch(0.14_0.06_10/0.95)]! font-mono! text-[12px]! text-rose!",
  warning:
    "border! border-solid! border-[oklch(0.55_0.12_70)]! bg-[oklch(0.14_0.06_70/0.95)]! font-mono! text-[12px]! text-amber!",
} as const;

/** Toasts one alert, and mirrors it as a fire-and-forget native notification when enabled and the transport can show one. */
function announce(alert: Alert, nativeNotifications: boolean): void {
  if (nativeNotifications && hasCapability("nativeNotifications") && isTauri()) {
    const title = alert.severity === "critical" ? "SWARM Critical Alert" : "SWARM Warning";
    // A notification failure must never break alert handling.
    sendNotification(title, alert.message).catch(() => {});
  }
  if (alert.severity === "critical") {
    toast.error(alert.message, { duration: 6000, className: TOAST_CLASS.critical });
  } else {
    toast.warning(alert.message, { duration: 4000, className: TOAST_CLASS.warning });
  }
}

/**
 * Evaluates system metrics against the persisted alert thresholds and
 * fires toasts. Call once at the app root.
 *
 * The store subscription is made once; the handler is an Effect Event,
 * so it always reads the latest thresholds and settings without
 * re-subscribing when they change. Cooldowns live in a ref written at
 * alert time, so two metric ticks that land before a re-render can never
 * both fire the same alert.
 */
export function useAlerts(): void {
  const thresholds = useAtomValue(alertThresholdsAtom);
  const { alertCooldownSec, nativeAlertNotifications } = useAtomValue(appSettingsAtom);
  const cooldownsRef = useRef<AlertCooldowns>({});

  const onMetrics = useEffectEvent((metrics: SystemMetrics): void => {
    const now = Date.now();
    // `memPercent` is `undefined` until the backend has reported a real
    // (nonzero) total; that reads as 0% so nothing alerts on an unknown total.
    const alerts = evaluateThresholds(
      {
        cpuPercent: metrics.cpuPercent,
        memoryPercent: memPercent(metrics.memoryMb, metrics.memoryTotalMb) ?? 0,
      },
      thresholds,
      cooldownsRef.current,
      now,
      alertCooldownSec * 1000,
    );
    if (alerts.length === 0) return;

    cooldownsRef.current = {
      ...cooldownsRef.current,
      ...Object.fromEntries(alerts.map((alert) => [alert.metric, now])),
    };
    for (const alert of alerts) announce(alert, nativeAlertNotifications);
  });

  useEffect(
    () =>
      useSystemStore.subscribe(
        (s) => s.metrics,
        (metrics) => onMetrics(metrics),
      ),
    [],
  );
}
