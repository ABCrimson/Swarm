import { act, render, screen } from "@testing-library/react";
import { createStore, Provider, useAtomValue } from "jotai";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("#lib/tauri", () => ({ isTauri: () => true }));
vi.mock("#lib/lazy-store", () => ({
  settingsStore: { entries: vi.fn(async () => []), set: vi.fn(async () => {}) },
}));

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

  it("keeps a persisted model that is still in the catalog", () => {
    resetPersistedSettingsCache([["swarm:ai:model", "opus"]]);
    expect(createStore().get(selectedModelAtom)).toBe("opus");
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

describe("reducedMotionAtom", () => {
  /** A controllable `matchMedia` result: flip `matches`, then `emit` to notify listeners. */
  function stubReducedMotion(initial: boolean) {
    const listeners = new Set<(e: MediaQueryListEvent) => void>();
    const query = {
      matches: initial,
      addEventListener: (_type: string, fn: (e: MediaQueryListEvent) => void) => listeners.add(fn),
      removeEventListener: (_type: string, fn: (e: MediaQueryListEvent) => void) =>
        listeners.delete(fn),
    };
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => query),
    );
    return {
      query,
      listeners,
      emit: (matches: boolean) => {
        query.matches = matches;
        for (const fn of listeners) fn({ matches } as MediaQueryListEvent);
      },
    };
  }

  async function freshAtom() {
    vi.resetModules();
    return (await import("#store/ui")).reducedMotionAtom;
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("starts from the OS setting at module load", async () => {
    stubReducedMotion(true);
    expect(createStore().get(await freshAtom())).toBe(true);
  });

  it("every React subscriber sees the synchronous onMount correction (jotai 3.0.1 #3373)", async () => {
    const media = stubReducedMotion(false);
    const atom = await freshAtom();
    media.query.matches = true;

    const store = createStore();
    const Probe = ({ name }: { name: string }) =>
      createElement("output", { "aria-label": name }, String(useAtomValue(atom)));
    render(
      createElement(
        Provider,
        { store },
        createElement(Probe, { name: "a" }),
        createElement(Probe, { name: "b" }),
      ),
    );
    await act(async () => {});

    expect(screen.getByLabelText("a").textContent).toBe("true");
    expect(screen.getByLabelText("b").textContent).toBe("true");
  });

  it("follows OS changes while subscribed and detaches its listener on unmount", async () => {
    const media = stubReducedMotion(false);
    const atom = await freshAtom();

    const store = createStore();
    const unsub = store.sub(atom, () => {});
    expect(media.listeners.size).toBe(1);

    media.emit(true);
    expect(store.get(atom)).toBe(true);

    unsub();
    expect(media.listeners.size).toBe(0);
  });
});
