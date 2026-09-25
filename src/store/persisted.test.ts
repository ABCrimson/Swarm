import { createStore } from "jotai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as z from "zod";

const tauri = vi.hoisted(() => ({ active: true }));
const settingsStore = vi.hoisted(() => ({
  entries: vi.fn(async (): Promise<Array<[string, unknown]>> => []),
  set: vi.fn(async (_key: string, _value: unknown) => {}),
  delete: vi.fn(async (_key: string) => true),
  save: vi.fn(async () => {}),
}));

vi.mock("#lib/tauri", () => ({ isTauri: () => tauri.active }));
vi.mock("#lib/lazy-store", () => ({ settingsStore }));

import {
  atomWithSettings,
  persistedSettings,
  preloadSettings,
  readPersistedRaw,
  removePersistedSetting,
  resetPersistedSettingsCache,
  settingsWritesSettled,
} from "#store/persisted";

const counterAtom = atomWithSettings("test:counter", 1, {
  label: "Counter",
  schema: z.int().positive(),
});

const legacyAwareAtom = atomWithSettings("test:v2", "fresh", {
  label: "Legacy Aware",
  schema: z.string(),
  migrate: (_initial, readRaw) => {
    const legacy = readRaw("test:v1");
    return typeof legacy === "string" ? `migrated:${legacy}` : undefined;
  },
});

const setAtom = atomWithSettings<ReadonlySet<string>>("test:set", new Set(), {
  label: "Set",
  schema: z.array(z.string()).transform((items) => new Set(items)),
  serialize: (value) => [...value],
});

describe("#store/persisted", () => {
  beforeEach(() => {
    tauri.active = true;
    vi.clearAllMocks();
    resetPersistedSettingsCache();
  });

  it("preloads swarm-settings.json so the first read already sees the persisted value", async () => {
    settingsStore.entries.mockResolvedValueOnce([["test:counter", 7]]);
    await preloadSettings();

    expect(createStore().get(counterAtom)).toBe(7);
    expect(readPersistedRaw("test:counter")).toBe(7);
  });

  it("never rejects when the file cannot be read, and falls back to defaults", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    settingsStore.entries.mockRejectedValueOnce(new Error("disk gone"));

    await expect(preloadSettings()).resolves.toBeUndefined();
    expect(createStore().get(counterAtom)).toBe(1);
    expect(warn).toHaveBeenCalledWith(
      "[settings] Could not read swarm-settings.json; using defaults.",
      expect.any(Error),
    );
    warn.mockRestore();
  });

  it("does not touch plugin-store outside the desktop shell", async () => {
    tauri.active = false;
    await preloadSettings();
    const store = createStore();
    store.set(counterAtom, 5);

    expect(store.get(counterAtom)).toBe(5);
    await settingsWritesSettled();
    expect(settingsStore.entries).not.toHaveBeenCalled();
    expect(settingsStore.set).not.toHaveBeenCalled();
    // Nothing persisted, so a fresh jotai store starts from the default.
    expect(createStore().get(counterAtom)).toBe(1);
  });

  it("falls back to the initial value when the persisted value fails its schema", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    resetPersistedSettingsCache([["test:counter", -3]]);

    expect(createStore().get(counterAtom)).toBe(1);
    expect(warn).toHaveBeenCalledWith(
      '[settings] Ignoring invalid persisted "test:counter".',
      expect.any(Array),
    );
    warn.mockRestore();
  });

  it("migrates from a legacy key only when the key itself was never written", () => {
    resetPersistedSettingsCache([["test:v1", "old"]]);
    expect(createStore().get(legacyAwareAtom)).toBe("migrated:old");

    resetPersistedSettingsCache([
      ["test:v1", "old"],
      ["test:v2", "current"],
    ]);
    expect(createStore().get(legacyAwareAtom)).toBe("current");
  });

  it("queues serialized writes to plugin-store in order and relies on its auto-save", async () => {
    const store = createStore();
    store.set(setAtom, new Set(["a"]));
    store.set(setAtom, (current) => new Set([...current, "b"]));
    await settingsWritesSettled();

    expect(settingsStore.set.mock.calls).toStrictEqual([
      ["test:set", ["a"]],
      ["test:set", ["a", "b"]],
    ]);
    expect(settingsStore.save).not.toHaveBeenCalled();
    expect(readPersistedRaw("test:set")).toStrictEqual(["a", "b"]);
  });

  it("keeps a validated value's identity across reads", () => {
    resetPersistedSettingsCache([["test:set", ["x"]]]);
    const store = createStore();

    expect(store.get(setAtom)).toBe(store.get(setAtom));
    expect([...store.get(setAtom)]).toStrictEqual(["x"]);
  });

  it("logs a failed write instead of rejecting, and later writes still run", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    settingsStore.set.mockRejectedValueOnce(new Error("locked"));
    const store = createStore();
    store.set(counterAtom, 2);
    store.set(counterAtom, 3);
    await settingsWritesSettled();

    expect(warn).toHaveBeenCalledWith("[settings] write test:counter failed:", expect.any(Error));
    expect(settingsStore.set).toHaveBeenLastCalledWith("test:counter", 3);
    warn.mockRestore();
  });

  it("removes a key from memory and from disk", async () => {
    resetPersistedSettingsCache([["test:counter", 9]]);
    removePersistedSetting("test:counter");
    await settingsWritesSettled();

    expect(readPersistedRaw("test:counter")).toBeUndefined();
    expect(settingsStore.delete).toHaveBeenCalledWith("test:counter");
    expect(createStore().get(counterAtom)).toBe(1);
  });

  it("registers every key with its label and schema for the integrity check", () => {
    expect(persistedSettings.get("test:counter")?.label).toBe("Counter");
    expect(persistedSettings.get("test:set")?.schema.safeParse(["ok"]).success).toBe(true);
  });
});
