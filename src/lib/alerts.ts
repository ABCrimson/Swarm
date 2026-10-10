// ── Alert Thresholds ────────────────────────────────
// User-configurable warning/critical thresholds evaluated against system
// metrics, persisted through the Tauri plugin-store.

import { atomWithStorage } from "jotai/utils";
import * as z from "zod";
import { settingsStore } from "#lib/lazy-store";
import type { Severity } from "#lib/severity";
import { severityFor } from "#lib/severity";
import { isTauri } from "#lib/tauri";

// ── Threshold configuration ────────────────────────

const Percent = z.number().min(0).max(100);

/** Warning and critical thresholds (percentages) for CPU and memory. */
const AlertThresholdsSchema = z.object({
  cpuWarning: Percent,
  cpuCritical: Percent,
  memoryWarning: Percent,
  memoryCritical: Percent,
});

/** Configurable warning and critical thresholds for system metrics. */
export type AlertThresholds = Readonly<z.infer<typeof AlertThresholdsSchema>>;

/** Thresholds used until (and unless) the user saves their own in Settings. */
export const DEFAULT_THRESHOLDS: AlertThresholds = {
  cpuWarning: 70,
  cpuCritical: 80,
  memoryWarning: 80,
  memoryCritical: 90,
};

/**
 * Shape accepted from disk: every field optional, so an older object that
 * lacks a field still hydrates the fields it has over the defaults. Any
 * present field must be a valid percentage, or the whole value is ignored.
 */
const PersistedThresholdsSchema = AlertThresholdsSchema.partial();

const STORAGE_KEY = "swarm:alerts:thresholds";

/**
 * Persisted thresholds via jotai's `atomWithStorage`, backed by the Tauri
 * plugin-store (a no-op outside Tauri). `getItem` answers synchronously
 * with the defaults so reads never suspend; the stored value hydrates
 * through `subscribe`, validated first — a malformed value keeps the
 * defaults instead of comparing metrics against `undefined` and silently
 * never alerting. Writes rely on the store's own debounced auto-save.
 */
export const alertThresholdsAtom = atomWithStorage<AlertThresholds>(
  STORAGE_KEY,
  DEFAULT_THRESHOLDS,
  {
    getItem: (_key, initialValue) => initialValue,
    setItem(key, value) {
      if (!isTauri()) return;
      settingsStore.set(key, value).catch((err: unknown) => {
        console.warn("[alerts] Failed to persist alert thresholds:", err);
      });
    },
    removeItem(key) {
      if (!isTauri()) return;
      settingsStore.delete(key).catch((err: unknown) => {
        console.warn("[alerts] Failed to reset alert thresholds:", err);
      });
    },
    subscribe(key, callback) {
      if (!isTauri()) return undefined;
      settingsStore
        .get<unknown>(key)
        .then((stored) => {
          if (stored == null) return;
          const parsed = PersistedThresholdsSchema.safeParse(stored);
          if (parsed.success) callback({ ...DEFAULT_THRESHOLDS, ...parsed.data });
          else console.warn("[alerts] Ignoring invalid stored alert thresholds:", parsed.error);
        })
        .catch((err: unknown) => {
          console.warn("[alerts] Failed to load alert thresholds:", err);
        });
      return undefined;
    },
  },
);

// ── Alert state ────────────────────────────────────

/** Severity level of a triggered alert (a non-`"good"` {@link Severity}). */
type AlertSeverity = Exclude<Severity, "good">;

/** Metric an alert can fire for; also the cooldown key. */
type AlertMetric = "cpu" | "memory";

/** A triggered alert with metric details and severity classification. */
export interface Alert {
  readonly metric: AlertMetric;
  readonly severity: AlertSeverity;
  readonly value: number;
  readonly threshold: number;
  readonly message: string;
  readonly timestamp: number;
}

/** Last alert time per metric, for cooldown enforcement. */
export type AlertCooldowns = Readonly<Partial<Record<AlertMetric, number>>>;

/**
 * Default cooldown period in ms — don't re-alert the same metric within 30s.
 * The live value comes from the Alert Cooldown setting (appSettingsAtom);
 * this constant remains as {@link evaluateThresholds}'s default.
 */
export const ALERT_COOLDOWN_MS = 30_000;

// ── Evaluation ─────────────────────────────────────

/** Point-in-time metrics snapshot used for threshold evaluation. */
export interface MetricsSnapshot {
  readonly cpuPercent: number;
  readonly memoryPercent: number;
}

/**
 * Evaluate metrics against thresholds and return any triggered alerts.
 * Pure function — does not fire toasts or mutate state. Banding is
 * `#lib/severity`'s `severityFor`, the same rule the metric cards use.
 */
export function evaluateThresholds(
  snapshot: MetricsSnapshot,
  thresholds: AlertThresholds,
  cooldowns: AlertCooldowns,
  now: number,
  cooldownMs: number = ALERT_COOLDOWN_MS,
): Alert[] {
  const candidates = [
    {
      metric: "cpu",
      label: "CPU Usage",
      value: snapshot.cpuPercent,
      warning: thresholds.cpuWarning,
      critical: thresholds.cpuCritical,
    },
    {
      metric: "memory",
      label: "Memory Usage",
      value: snapshot.memoryPercent,
      warning: thresholds.memoryWarning,
      critical: thresholds.memoryCritical,
    },
  ] as const;

  return candidates.flatMap(({ metric, label, value, warning, critical }): Alert[] => {
    if (now - (cooldowns[metric] ?? Number.NEGATIVE_INFINITY) < cooldownMs) return [];
    const severity = severityFor(value, { warning, critical });
    if (severity === "good") return [];
    const threshold = severity === "critical" ? critical : warning;
    const message =
      severity === "critical"
        ? `${label} Critically High: ${value.toFixed(1)}% (Threshold: ${threshold}%)`
        : `${label} Elevated: ${value.toFixed(1)}% (Threshold: ${threshold}%)`;
    return [{ metric, severity, value, threshold, message, timestamp: now }];
  });
}
