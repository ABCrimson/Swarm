import { describe, expect, it } from "vitest";
import type { AlertThresholds, MetricsSnapshot } from "#lib/alerts";
import { ALERT_COOLDOWN_MS, evaluateThresholds } from "#lib/alerts";

const DEFAULT_THRESHOLDS: AlertThresholds = {
  cpuWarning: 70,
  cpuCritical: 80,
  memoryWarning: 80,
  memoryCritical: 90,
};

const BASE_NOW = 1_000_000;

describe("evaluateThresholds", () => {
  describe("warning triggers", () => {
    it("triggers a CPU warning at the warning threshold", () => {
      const snapshot: MetricsSnapshot = { cpuPercent: 70, memoryPercent: 50 };
      const alerts = evaluateThresholds(snapshot, DEFAULT_THRESHOLDS, {}, BASE_NOW);

      const cpuAlert = alerts.find((a) => a.metric === "cpu");
      expect(cpuAlert).toBeDefined();
      expect(cpuAlert?.severity).toBe("warning");
      expect(cpuAlert?.value).toBe(70);
      expect(cpuAlert?.threshold).toBe(70);
    });

    it("triggers a memory warning when memory exceeds warning threshold", () => {
      const snapshot: MetricsSnapshot = { cpuPercent: 50, memoryPercent: 85 };
      const alerts = evaluateThresholds(snapshot, DEFAULT_THRESHOLDS, {}, BASE_NOW);

      const memAlert = alerts.find((a) => a.metric === "memory");
      expect(memAlert).toBeDefined();
      expect(memAlert?.severity).toBe("warning");
    });
  });

  describe("critical triggers", () => {
    it("triggers a CPU critical alert at the critical threshold", () => {
      const snapshot: MetricsSnapshot = { cpuPercent: 80, memoryPercent: 50 };
      const alerts = evaluateThresholds(snapshot, DEFAULT_THRESHOLDS, {}, BASE_NOW);

      const cpuAlert = alerts.find((a) => a.metric === "cpu");
      expect(cpuAlert).toBeDefined();
      expect(cpuAlert?.severity).toBe("critical");
      expect(cpuAlert?.threshold).toBe(80);
    });

    it("triggers a memory critical alert", () => {
      const snapshot: MetricsSnapshot = { cpuPercent: 50, memoryPercent: 95 };
      const alerts = evaluateThresholds(snapshot, DEFAULT_THRESHOLDS, {}, BASE_NOW);

      const memAlert = alerts.find((a) => a.metric === "memory");
      expect(memAlert).toBeDefined();
      expect(memAlert?.severity).toBe("critical");
    });

    it("critical supersedes warning when both thresholds are exceeded", () => {
      // CPU at 90 exceeds both warning (70) and critical (80)
      const snapshot: MetricsSnapshot = { cpuPercent: 90, memoryPercent: 50 };
      const alerts = evaluateThresholds(snapshot, DEFAULT_THRESHOLDS, {}, BASE_NOW);

      const cpuAlerts = alerts.filter((a) => a.metric === "cpu");
      expect(cpuAlerts).toHaveLength(1);
      expect(cpuAlerts[0].severity).toBe("critical");
    });
  });

  describe("no alerts", () => {
    it("returns empty array when all metrics are below thresholds", () => {
      const snapshot: MetricsSnapshot = { cpuPercent: 30, memoryPercent: 40 };
      const alerts = evaluateThresholds(snapshot, DEFAULT_THRESHOLDS, {}, BASE_NOW);

      expect(alerts).toHaveLength(0);
    });
  });

  describe("cooldown enforcement", () => {
    it("suppresses an alert when within the cooldown window", () => {
      const snapshot: MetricsSnapshot = { cpuPercent: 85, memoryPercent: 50 };
      // Last alert was 10 seconds ago (within 30s cooldown)
      const cooldowns = { cpu: BASE_NOW - 10_000 };

      const alerts = evaluateThresholds(snapshot, DEFAULT_THRESHOLDS, cooldowns, BASE_NOW);

      const cpuAlert = alerts.find((a) => a.metric === "cpu");
      expect(cpuAlert).toBeUndefined();
    });

    it("allows an alert after the cooldown has elapsed", () => {
      const snapshot: MetricsSnapshot = { cpuPercent: 85, memoryPercent: 50 };
      // Last alert was 31 seconds ago (past the 30s cooldown)
      const cooldowns = { cpu: BASE_NOW - ALERT_COOLDOWN_MS - 1_000 };

      const alerts = evaluateThresholds(snapshot, DEFAULT_THRESHOLDS, cooldowns, BASE_NOW);

      const cpuAlert = alerts.find((a) => a.metric === "cpu");
      expect(cpuAlert).toBeDefined();
    });

    it("suppresses only the cooled-down metric, not others", () => {
      const snapshot: MetricsSnapshot = { cpuPercent: 85, memoryPercent: 92 };
      // CPU is in cooldown, memory is not
      const cooldowns = { cpu: BASE_NOW - 5_000 };

      const alerts = evaluateThresholds(snapshot, DEFAULT_THRESHOLDS, cooldowns, BASE_NOW);

      expect(alerts.find((a) => a.metric === "cpu")).toBeUndefined();
      expect(alerts.find((a) => a.metric === "memory")).toBeDefined();
    });

    it("alerts include timestamp matching the current time", () => {
      const snapshot: MetricsSnapshot = { cpuPercent: 75, memoryPercent: 50 };
      const alerts = evaluateThresholds(snapshot, DEFAULT_THRESHOLDS, {}, BASE_NOW);

      expect(alerts[0].timestamp).toBe(BASE_NOW);
    });
  });

  describe("alert message format", () => {
    it("includes the metric label and value in warning messages", () => {
      const snapshot: MetricsSnapshot = { cpuPercent: 72.5, memoryPercent: 50 };
      const alerts = evaluateThresholds(snapshot, DEFAULT_THRESHOLDS, {}, BASE_NOW);

      expect(alerts[0].message).toContain("CPU Usage");
      expect(alerts[0].message).toContain("72.5%");
      expect(alerts[0].message).toContain("Elevated");
    });

    it("includes 'Critically High' in critical messages", () => {
      const snapshot: MetricsSnapshot = { cpuPercent: 85, memoryPercent: 50 };
      const alerts = evaluateThresholds(snapshot, DEFAULT_THRESHOLDS, {}, BASE_NOW);

      expect(alerts[0].message).toContain("Critically High");
    });
  });
});
