import { createStore } from "jotai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AlertThresholds, MetricsSnapshot } from "#lib/alerts";
import {
  alertThresholdsAtom,
  DEFAULT_THRESHOLDS,
  evaluateThresholds,
  thresholdsError,
} from "#lib/alerts";
import { settingsStore } from "#lib/lazy-store";
import { resetPersistedSettingsCache, settingsWritesSettled } from "#store/persisted";
import { DEFAULT_APP_SETTINGS } from "#store/ui";

vi.mock(import("#lib/tauri"), async (importOriginal) => ({
  ...(await importOriginal()),
  isTauri: () => true,
}));

vi.mock(import("#lib/lazy-store"), () => ({
  settingsStore: {
    set: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
  } as never,
}));

const BASE_NOW = 1_000_000;
/** The cooldown the app ships with (the Alert Cooldown setting's default). */
const COOLDOWN_MS = DEFAULT_APP_SETTINGS.alertCooldownSec * 1000;

describe("evaluateThresholds", () => {
  describe("warning triggers", () => {
    it("triggers a CPU warning at the warning threshold", () => {
      const snapshot: MetricsSnapshot = { cpuPercent: 70, memoryPercent: 50 };
      const alerts = evaluateThresholds(snapshot, DEFAULT_THRESHOLDS, {}, BASE_NOW, COOLDOWN_MS);

      const cpuAlert = alerts.find((a) => a.metric === "cpu");
      expect(cpuAlert).toBeDefined();
      expect(cpuAlert?.severity).toBe("warning");
      expect(cpuAlert?.value).toBe(70);
      expect(cpuAlert?.threshold).toBe(70);
    });

    it("triggers a memory warning when memory exceeds warning threshold", () => {
      const snapshot: MetricsSnapshot = { cpuPercent: 50, memoryPercent: 85 };
      const alerts = evaluateThresholds(snapshot, DEFAULT_THRESHOLDS, {}, BASE_NOW, COOLDOWN_MS);

      const memAlert = alerts.find((a) => a.metric === "memory");
      expect(memAlert).toBeDefined();
      expect(memAlert?.severity).toBe("warning");
    });
  });

  describe("critical triggers", () => {
    it("triggers a CPU critical alert at the critical threshold", () => {
      const snapshot: MetricsSnapshot = { cpuPercent: 80, memoryPercent: 50 };
      const alerts = evaluateThresholds(snapshot, DEFAULT_THRESHOLDS, {}, BASE_NOW, COOLDOWN_MS);

      const cpuAlert = alerts.find((a) => a.metric === "cpu");
      expect(cpuAlert).toBeDefined();
      expect(cpuAlert?.severity).toBe("critical");
      expect(cpuAlert?.threshold).toBe(80);
    });

    it("triggers a memory critical alert", () => {
      const snapshot: MetricsSnapshot = { cpuPercent: 50, memoryPercent: 95 };
      const alerts = evaluateThresholds(snapshot, DEFAULT_THRESHOLDS, {}, BASE_NOW, COOLDOWN_MS);

      const memAlert = alerts.find((a) => a.metric === "memory");
      expect(memAlert).toBeDefined();
      expect(memAlert?.severity).toBe("critical");
    });

    it("critical supersedes warning when both thresholds are exceeded", () => {
      // CPU at 90 exceeds both warning (70) and critical (80)
      const snapshot: MetricsSnapshot = { cpuPercent: 90, memoryPercent: 50 };
      const alerts = evaluateThresholds(snapshot, DEFAULT_THRESHOLDS, {}, BASE_NOW, COOLDOWN_MS);

      const cpuAlerts = alerts.filter((a) => a.metric === "cpu");
      expect(cpuAlerts).toHaveLength(1);
      expect(cpuAlerts[0].severity).toBe("critical");
    });
  });

  describe("no alerts", () => {
    it("returns empty array when all metrics are below thresholds", () => {
      const snapshot: MetricsSnapshot = { cpuPercent: 30, memoryPercent: 40 };
      const alerts = evaluateThresholds(snapshot, DEFAULT_THRESHOLDS, {}, BASE_NOW, COOLDOWN_MS);

      expect(alerts).toHaveLength(0);
    });
  });

  describe("cooldown enforcement", () => {
    it("suppresses an alert when within the cooldown window", () => {
      const snapshot: MetricsSnapshot = { cpuPercent: 85, memoryPercent: 50 };
      // Last alert was 10 seconds ago, inside the default cooldown
      const cooldowns = { cpu: BASE_NOW - 10_000 };

      const alerts = evaluateThresholds(
        snapshot,
        DEFAULT_THRESHOLDS,
        cooldowns,
        BASE_NOW,
        COOLDOWN_MS,
      );

      const cpuAlert = alerts.find((a) => a.metric === "cpu");
      expect(cpuAlert).toBeUndefined();
    });

    it("allows an alert after the cooldown has elapsed", () => {
      const snapshot: MetricsSnapshot = { cpuPercent: 85, memoryPercent: 50 };
      // Last alert was one second past the default cooldown
      const cooldowns = { cpu: BASE_NOW - COOLDOWN_MS - 1_000 };

      const alerts = evaluateThresholds(
        snapshot,
        DEFAULT_THRESHOLDS,
        cooldowns,
        BASE_NOW,
        COOLDOWN_MS,
      );

      const cpuAlert = alerts.find((a) => a.metric === "cpu");
      expect(cpuAlert).toBeDefined();
    });

    it("suppresses only the cooled-down metric, not others", () => {
      const snapshot: MetricsSnapshot = { cpuPercent: 85, memoryPercent: 92 };
      // CPU is in cooldown, memory is not
      const cooldowns = { cpu: BASE_NOW - 5_000 };

      const alerts = evaluateThresholds(
        snapshot,
        DEFAULT_THRESHOLDS,
        cooldowns,
        BASE_NOW,
        COOLDOWN_MS,
      );

      expect(alerts.find((a) => a.metric === "cpu")).toBeUndefined();
      expect(alerts.find((a) => a.metric === "memory")).toBeDefined();
    });

    it("alerts include timestamp matching the current time", () => {
      const snapshot: MetricsSnapshot = { cpuPercent: 75, memoryPercent: 50 };
      const alerts = evaluateThresholds(snapshot, DEFAULT_THRESHOLDS, {}, BASE_NOW, COOLDOWN_MS);

      expect(alerts[0].timestamp).toBe(BASE_NOW);
    });
  });

  describe("alert message format", () => {
    it("includes the metric label and value in warning messages", () => {
      const snapshot: MetricsSnapshot = { cpuPercent: 72.5, memoryPercent: 50 };
      const alerts = evaluateThresholds(snapshot, DEFAULT_THRESHOLDS, {}, BASE_NOW, COOLDOWN_MS);

      expect(alerts[0].message).toContain("CPU Usage");
      expect(alerts[0].message).toContain("72.5%");
      expect(alerts[0].message).toContain("Elevated");
      expect(alerts[0].message).toContain("(Threshold: 70%)");
    });

    it("includes 'Critically High' in critical messages", () => {
      const snapshot: MetricsSnapshot = { cpuPercent: 85, memoryPercent: 50 };
      const alerts = evaluateThresholds(snapshot, DEFAULT_THRESHOLDS, {}, BASE_NOW, COOLDOWN_MS);

      expect(alerts[0].message).toContain("Critically High");
    });
  });
});

// The parametrized cooldown behind the Settings catalog's alert-cooldown field.
describe("alert cooldown (parametrized)", () => {
  const thresholds: AlertThresholds = {
    cpuWarning: 70,
    cpuCritical: 90,
    memoryWarning: 75,
    memoryCritical: 90,
  };
  const hotSnapshot: MetricsSnapshot = { cpuPercent: 95, memoryPercent: 10 };

  it("suppresses a repeat alert inside a custom cooldown window", () => {
    const cooldowns = { cpu: 10_000 };
    // 55s after the last alert, with a 60s cooldown — still suppressed.
    const alerts = evaluateThresholds(hotSnapshot, thresholds, cooldowns, 65_000, 60_000);
    expect(alerts).toHaveLength(0);
  });

  it("fires again once the custom cooldown has elapsed", () => {
    const cooldowns = { cpu: 10_000 };
    const alerts = evaluateThresholds(hotSnapshot, thresholds, cooldowns, 75_000, 60_000);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].severity).toBe("critical");
  });

  it("fires exactly when the cooldown has just elapsed", () => {
    expect(
      evaluateThresholds(hotSnapshot, thresholds, { cpu: 10_000 }, 70_000, 60_000),
    ).toHaveLength(1);
  });

  it("applies the Settings default cooldown", () => {
    const cooldowns = { cpu: 0 };
    expect(
      evaluateThresholds(hotSnapshot, thresholds, cooldowns, COOLDOWN_MS - 1_000, COOLDOWN_MS),
    ).toHaveLength(0);
    expect(
      evaluateThresholds(hotSnapshot, thresholds, cooldowns, COOLDOWN_MS + 1_000, COOLDOWN_MS),
    ).toHaveLength(1);
  });
});

describe("thresholdsError", () => {
  it("accepts warning below critical", () => {
    expect(thresholdsError(DEFAULT_THRESHOLDS)).toBeNull();
  });

  it("rejects an inverted or equal CPU pair and names only the CPU fields", () => {
    expect(thresholdsError({ ...DEFAULT_THRESHOLDS, cpuWarning: 90, cpuCritical: 90 })).toEqual({
      message: "CPU Warning Must Be Below CPU Critical",
      keys: new Set(["cpuWarning", "cpuCritical"]),
    });
  });

  it("rejects an inverted memory pair and names only the memory fields", () => {
    expect(
      thresholdsError({ ...DEFAULT_THRESHOLDS, memoryWarning: 95, memoryCritical: 50 }),
    ).toEqual({
      message: "Memory Warning Must Be Below Memory Critical",
      keys: new Set(["memoryWarning", "memoryCritical"]),
    });
  });
});

// Stored thresholds are validated on read: a malformed or partial object
// must never leave a field undefined, which would silently disable alerts.
describe("alertThresholdsAtom hydration", () => {
  afterEach(() => {
    resetPersistedSettingsCache();
  });

  function hydrate(stored: unknown): AlertThresholds {
    resetPersistedSettingsCache(stored == null ? [] : [["swarm:alerts:thresholds", stored]]);
    return createStore().get(alertThresholdsAtom);
  }

  it("hydrates a valid stored value", () => {
    const saved = { cpuWarning: 50, cpuCritical: 60, memoryWarning: 70, memoryCritical: 75 };
    expect(hydrate(saved)).toEqual(saved);
  });

  it("fills fields an older stored object lacks from the defaults", () => {
    expect(hydrate({ cpuWarning: 55 })).toEqual({ ...DEFAULT_THRESHOLDS, cpuWarning: 55 });
  });

  it("keeps the defaults when the stored value is malformed", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(hydrate({ cpuWarning: "high", memoryCritical: 400 })).toEqual(DEFAULT_THRESHOLDS);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("keeps the defaults when nothing is stored", () => {
    expect(hydrate(null)).toEqual(DEFAULT_THRESHOLDS);
  });
});

describe("alertThresholdsAtom persistence", () => {
  it("writes a changed value to the settings store under its key", async () => {
    const next = { cpuWarning: 50, cpuCritical: 60, memoryWarning: 70, memoryCritical: 75 };
    createStore().set(alertThresholdsAtom, next);
    // atomWithSettings hands writes to plugin-store through an ordered queue.
    await settingsWritesSettled();
    expect(settingsStore.set).toHaveBeenCalledWith("swarm:alerts:thresholds", next);
  });
});
