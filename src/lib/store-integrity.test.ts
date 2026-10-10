import { toast } from "sonner";
import { beforeEach, describe, expect, it, vi } from "vitest";

const stores = vi.hoisted(() => {
  const fakeStore = () => ({
    entries: vi.fn(async (): Promise<Array<[string, unknown]>> => []),
    delete: vi.fn(async (_key: string) => true),
  });
  return {
    settingsStore: fakeStore(),
    snapshotsStore: fakeStore(),
    templatesStore: fakeStore(),
  };
});
const persisted = vi.hoisted(() => ({ removePersistedSetting: vi.fn() }));

vi.mock("#lib/tauri", () => ({ isTauri: () => true }));
vi.mock("#lib/lazy-store", () => stores);
vi.mock("#store/persisted", async () => {
  const z = await import("zod");
  return {
    persistedSettings: new Map([
      ["swarm:ui:paneSizes", { label: "Pane Sizes", schema: z.object({ main: z.number() }) }],
    ]),
    removePersistedSetting: persisted.removePersistedSetting,
  };
});

import { load } from "@tauri-apps/plugin-store";
import { validateStoreData } from "#lib/store-integrity";

const SESSION = "11111111-1111-4111-8111-111111111111";
const validSnapshot = {
  id: "22222222-2222-4222-8222-222222222222",
  sessionId: SESSION,
  timestamp: "2026-09-23T12:00:00Z",
  data: {},
};

describe("validateStoreData", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    for (const store of Object.values(stores)) store.entries.mockResolvedValue([]);
  });

  it("never opens swarm-config.json (or any file) through plugin-store's load()", async () => {
    await validateStoreData();
    expect(load).not.toHaveBeenCalled();
  });

  it("deletes only the invalid keys, leaves valid and unknown keys alone, and toasts once", async () => {
    stores.settingsStore.entries.mockResolvedValue([
      ["swarm:ui:paneSizes", { main: "wide" }],
      [
        "swarm:alerts:thresholds",
        { cpuWarning: 70, cpuCritical: 80, memoryWarning: 80, memoryCritical: 900 },
      ],
      ["swarm:tools:custom", []],
      ["swarm:ui:theme", { legacy: true }],
    ]);
    stores.snapshotsStore.entries.mockResolvedValue([
      [`swarm:snapshots:${SESSION}`, [validSnapshot]],
      ["swarm:snapshots:broken", [{ id: "nope" }]],
    ]);
    stores.templatesStore.entries.mockResolvedValue([["swarm:templates", "not-an-array"]]);
    using warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const results = await validateStoreData();

    expect(results.map(({ file, key, valid }) => [file, key, valid])).toStrictEqual([
      ["swarm-settings.json", "swarm:ui:paneSizes", false],
      ["swarm-settings.json", "swarm:alerts:thresholds", false],
      ["swarm-settings.json", "swarm:tools:custom", true],
      ["swarm-snapshots.json", `swarm:snapshots:${SESSION}`, true],
      ["swarm-snapshots.json", "swarm:snapshots:broken", false],
      ["swarm-templates.json", "swarm:templates", false],
    ]);
    expect(persisted.removePersistedSetting).toHaveBeenCalledExactlyOnceWith("swarm:ui:paneSizes");
    expect(stores.settingsStore.delete).toHaveBeenCalledExactlyOnceWith("swarm:alerts:thresholds");
    expect(stores.snapshotsStore.delete).toHaveBeenCalledExactlyOnceWith("swarm:snapshots:broken");
    expect(stores.templatesStore.delete).toHaveBeenCalledExactlyOnceWith("swarm:templates");
    expect(toast.warning).toHaveBeenCalledExactlyOnceWith(
      "Some Saved Data Was Corrupted And Has Been Reset.",
      { description: "Pane Sizes, Alert Thresholds, Session Snapshots, Session Templates" },
    );
    expect(warn).toHaveBeenCalledOnce();
  });

  it("stays quiet when everything is valid", async () => {
    stores.snapshotsStore.entries.mockResolvedValue([[`swarm:snapshots:${SESSION}`, []]]);

    const results = await validateStoreData();

    expect(results).toStrictEqual([
      { file: "swarm-snapshots.json", key: `swarm:snapshots:${SESSION}`, valid: true },
    ]);
    expect(toast.warning).not.toHaveBeenCalled();
  });

  it("reports an unreadable file and still checks the others", async () => {
    stores.settingsStore.entries.mockRejectedValue(new Error("EACCES"));
    stores.templatesStore.entries.mockResolvedValue([["swarm:templates", []]]);
    using _warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const results = await validateStoreData();

    expect(results).toStrictEqual([
      {
        file: "swarm-settings.json",
        key: "*",
        valid: false,
        error: "Store read failed: EACCES",
      },
      { file: "swarm-templates.json", key: "swarm:templates", valid: true },
    ]);
  });
});
