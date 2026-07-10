// ── Alert Thresholds ────────────────────────────────
// Configurable alert thresholds evaluated against system metrics.
// Cooldown prevents re-alerting the same metric within 30s.

import { atom } from "jotai";
import { atomWithStorage } from "jotai/utils";

import { settingsStore } from "#lib/lazy-store";
import { isTauri } from "#lib/tauri";

// ── Threshold configuration ────────────────────────

/** Configurable warning and critical thresholds for system metrics. */
export interface AlertThresholds {
  readonly cpuWarning: number;
  readonly cpuCritical: number;
  readonly memoryWarning: number;
  readonly memoryCritical: number;
}

const DEFAULT_THRESHOLDS: AlertThresholds = {
  cpuWarning: 70,
  cpuCritical: 80,
  memoryWarning: 80,
  memoryCritical: 90,
};

/** Persisted thresholds via Jotai atomWithStorage backed by Tauri plugin-store. */
export const alertThresholdsAtom = atomWithStorage<AlertThresholds>(
  "swarm:alerts:thresholds",
  DEFAULT_THRESHOLDS,
  {
    getItem(_key, initialValue) {
      return initialValue;
    },
    setItem(key, value) {
      if (!isTauri()) return;
      void settingsStore.set(key, value).then(() => settingsStore.save());
    },
    removeItem(key) {
      if (!isTauri()) return;
      void settingsStore.delete(key).then(() => settingsStore.save());
    },
    subscribe(key, callback, _initialValue) {
      if (!isTauri()) return () => {};
      void settingsStore
        .get<AlertThresholds>(key)
        .then((v) => {
          if (v != null) callback(v);
        })
        .catch(() => {});
      return () => {};
    },
  },
);

// ── Alert state ────────────────────────────────────

/** Severity level of a triggered alert. */
export type AlertSeverity = "warning" | "critical";

/** A triggered alert with metric details and severity classification. */
export interface Alert {
  readonly metric: string;
  readonly severity: AlertSeverity;
  readonly value: number;
  readonly threshold: number;
  readonly message: string;
  readonly timestamp: number;
}

/** Tracks last alert time per metric key for cooldown enforcement. */
export const alertCooldownsAtom = atom<Record<string, number>>({});

/** Cooldown period in ms — don't re-alert same metric within 30s. */
export const ALERT_COOLDOWN_MS = 30_000;

// ── Evaluation ─────────────────────────────────────

/** Point-in-time metrics snapshot used for threshold evaluation. */
export interface MetricsSnapshot {
  readonly cpuPercent: number;
  readonly memoryPercent: number;
}

/**
 * Evaluate metrics against thresholds and return any triggered alerts.
 * Pure function — does not fire toasts or mutate state.
 */
export function evaluateThresholds(
  snapshot: MetricsSnapshot,
  thresholds: AlertThresholds,
  cooldowns: Record<string, number>,
  now: number,
): Alert[] {
  const alerts: Alert[] = [];

  const check = (
    metric: string,
    value: number,
    warningThreshold: number,
    criticalThreshold: number,
    label: string,
  ): void => {
    const lastAlert = cooldowns[metric] ?? 0;
    if (now - lastAlert < ALERT_COOLDOWN_MS) return;

    if (value >= criticalThreshold) {
      alerts.push({
        metric,
        severity: "critical",
        value,
        threshold: criticalThreshold,
        message: `${label} Critically High: ${value.toFixed(1)}% (Threshold: ${criticalThreshold}%)`,
        timestamp: now,
      });
    } else if (value >= warningThreshold) {
      alerts.push({
        metric,
        severity: "warning",
        value,
        threshold: warningThreshold,
        message: `${label} Elevated: ${value.toFixed(1)}% (Threshold: ${warningThreshold}%)`,
        timestamp: now,
      });
    }
  };

  check("cpu", snapshot.cpuPercent, thresholds.cpuWarning, thresholds.cpuCritical, "CPU Usage");
  check(
    "memory",
    snapshot.memoryPercent,
    thresholds.memoryWarning,
    thresholds.memoryCritical,
    "Memory Usage",
  );

  return alerts;
}
