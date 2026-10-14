// ── Alert Thresholds ────────────────────────────────
// User-configurable warning/critical thresholds evaluated against system
// metrics, persisted in swarm-settings.json via atomWithSettings.

import * as z from "zod";
import type { Severity } from "#lib/severity";
import { severityFor } from "#lib/severity";
import { atomWithSettings } from "#store/persisted";

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

/** An unusable pair of alert thresholds: what is wrong, and which fields. */
export interface ThresholdsProblem {
  readonly message: string;
  /** The fields to mark invalid (the offending warning/critical pair). */
  readonly keys: ReadonlySet<keyof AlertThresholds>;
}

/**
 * The first warning/critical pair whose warning level is not below its
 * critical level, or `null` when every pair is valid.
 */
export function thresholdsError(thresholds: AlertThresholds): ThresholdsProblem | null {
  if (thresholds.cpuWarning >= thresholds.cpuCritical) {
    return {
      message: "CPU Warning Must Be Below CPU Critical",
      keys: new Set(["cpuWarning", "cpuCritical"]),
    };
  }
  if (thresholds.memoryWarning >= thresholds.memoryCritical) {
    return {
      message: "Memory Warning Must Be Below Memory Critical",
      keys: new Set(["memoryWarning", "memoryCritical"]),
    };
  }
  return null;
}

/**
 * Shape accepted from disk: every field optional, so an older object that
 * lacks a field still hydrates the fields it has over the defaults. Any
 * present field must be a valid percentage, or the whole value is ignored.
 */
const PersistedThresholdsSchema = AlertThresholdsSchema.partial();

/**
 * Persisted thresholds, stored under `swarm:alerts:thresholds` by
 * `atomWithSettings`. The value is read from the preloaded settings file
 * on first use, so the first render already shows the saved thresholds.
 * Fields missing from an older stored object take their defaults; a
 * present but invalid field makes the whole stored value fall back to
 * {@link DEFAULT_THRESHOLDS}, so metrics are never compared against
 * `undefined`.
 */
export const alertThresholdsAtom = atomWithSettings<AlertThresholds>(
  "swarm:alerts:thresholds",
  DEFAULT_THRESHOLDS,
  {
    label: "Alert Thresholds",
    schema: PersistedThresholdsSchema.transform((persisted) => ({
      ...DEFAULT_THRESHOLDS,
      ...persisted,
    })),
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
  cooldownMs: number,
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
