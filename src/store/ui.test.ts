import { createStore } from "jotai";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("#lib/tauri", () => ({ isTauri: () => true }));
vi.mock("#lib/lazy-store", () => ({
  settingsStore: { entries: vi.fn(async () => []), set: vi.fn(async () => {}) },
}));

import { frecencyAtom, frecencyScoreAtom } from "#store/frecency";
import { resetPersistedSettingsCache } from "#store/persisted";
import {
  appSettingsAtom,
  DEFAULT_APP_SETTINGS,
  keybindingsAtom,
  paneSizesAtom,
  selectedModelAtom,
  themeAtom,
} from "#store/ui";

describe("persisted UI settings", () => {
  beforeEach(() => {
    resetPersistedSettingsCache();
  });

  describe("appSettingsAtom", () => {
    it("clamps out-of-range numbers to the Settings page bounds instead of trusting them", () => {
      resetPersistedSettingsCache([
        [
          "swarm:settings:app",
          { ...DEFAULT_APP_SETTINGS, snapshotIntervalMin: 0, aiConcurrentLimit: 99 },
        ],
      ]);

      const settings = createStore().get(appSettingsAtom);
      expect(settings.snapshotIntervalMin).toBe(1);
      expect(settings.aiConcurrentLimit).toBe(10);
    });

    it("replaces a corrupt field with its own default and keeps the valid fields", () => {
      resetPersistedSettingsCache([
        [
          "swarm:settings:app",
          { snapshotIntervalMin: "5", logMaxEntries: null, alertCooldownSec: 45 },
        ],
      ]);

      expect(createStore().get(appSettingsAtom)).toStrictEqual({
        ...DEFAULT_APP_SETTINGS,
        alertCooldownSec: 45,
      });
    });

    it("fills keys a settings object from an older version lacks", () => {
      resetPersistedSettingsCache([["swarm:settings:app", { alertCooldownSec: 60 }]]);

      expect(createStore().get(appSettingsAtom)).toStrictEqual({
        ...DEFAULT_APP_SETTINGS,
        alertCooldownSec: 60,
      });
    });
  });

  describe("themeAtom", () => {
    it("carries particlesEnabled over from the legacy key and takes the new gpuOverlay default", () => {
      resetPersistedSettingsCache([
        ["swarm:ui:theme", { particlesEnabled: false, gpuOverlay: false }],
      ]);

      expect(createStore().get(themeAtom)).toStrictEqual({
        particlesEnabled: false,
        gpuOverlay: true,
      });
    });

    it("prefers the v2 key when it exists", () => {
      resetPersistedSettingsCache([
        ["swarm:ui:theme", { particlesEnabled: true }],
        ["swarm:ui:theme2", { particlesEnabled: false, gpuOverlay: false }],
      ]);

      expect(createStore().get(themeAtom)).toStrictEqual({
        particlesEnabled: false,
        gpuOverlay: false,
      });
    });
  });

  it("falls back to the default model when the persisted key left the catalog", () => {
    resetPersistedSettingsCache([["swarm:ai:model", "claude-2"]]);
    expect(createStore().get(selectedModelAtom)).toBe("sonnet");
  });

  it("restores a blanked keybinding to its default", () => {
    resetPersistedSettingsCache([
      ["swarm:settings:keybindings", { commandPalette: "", graphToggle: "ctrl+g", perfOverlay: 3 }],
    ]);

    expect(createStore().get(keybindingsAtom)).toStrictEqual({
      commandPalette: "ctrl+k",
      graphToggle: "ctrl+g",
      perfOverlay: "ctrl+shift+p",
    });
  });

  it("rejects pane sizes outside 0–100%", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    resetPersistedSettingsCache([["swarm:ui:paneSizes", { main: 160, detail: -60 }]]);

    expect(createStore().get(paneSizesAtom)).toStrictEqual({ main: 60, detail: 40 });
    warn.mockRestore();
  });
});

describe("frecencyAtom", () => {
  beforeEach(() => {
    resetPersistedSettingsCache();
  });

  it("drops malformed tuples on load and keeps the valid ones", () => {
    const lastUsed = Temporal.Now.instant().toString();
    resetPersistedSettingsCache([
      [
        "swarm:frecency",
        [
          ["palette.workers", { uses: 3, lastUsed }],
          ["palette.bad-date", { uses: 1, lastUsed: "yesterday" }],
          ["palette.bad-uses", { uses: -2, lastUsed }],
          "not-a-tuple",
        ],
      ],
    ]);

    const store = createStore();
    expect([...store.get(frecencyAtom).keys()]).toStrictEqual(["palette.workers"]);
    expect(store.get(frecencyScoreAtom)("palette.bad-date")).toBe(0);
  });

  it("halves a command's score every 72 hours", () => {
    const lastUsed = Temporal.Now.instant().subtract({ hours: 72 }).toString();
    resetPersistedSettingsCache([["swarm:frecency", [["cmd", { uses: 8, lastUsed }]]]]);

    expect(createStore().get(frecencyScoreAtom)("cmd")).toBeCloseTo(4, 3);
  });
});
