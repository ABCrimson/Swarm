import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.fn();
let tauriActive = false;

vi.mock("#lib/tauri", () => ({
  isTauri: () => tauriActive,
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

const storeGetMock = vi.fn();
const storeSetMock = vi.fn();
const storeSaveMock = vi.fn();
const loadMock = vi.fn(async (..._args: unknown[]) => ({
  get: storeGetMock,
  set: storeSetMock,
  save: storeSaveMock,
}));

vi.mock("@tauri-apps/plugin-store", () => ({
  load: (...args: unknown[]) => loadMock(...args),
}));

import { createKv } from "#lib/kv";

describe("kv", () => {
  beforeEach(() => {
    tauriActive = false;
    invokeMock.mockReset();
    storeGetMock.mockReset();
    storeSetMock.mockReset();
    storeSaveMock.mockReset();
    loadMock.mockClear();
  });

  describe("under Tauri (TauriStoreKv)", () => {
    beforeEach(() => {
      tauriActive = true;
    });

    it("get() loads the named store and reads the key, defaulting to null", async () => {
      storeGetMock.mockResolvedValue(undefined);
      const kv = createKv("templates");
      const result = await kv.get("nonexistent");
      expect(result).toBeNull();
      expect(loadMock).toHaveBeenCalledWith("templates");
      expect(storeGetMock).toHaveBeenCalledWith("nonexistent");
    });

    it("get() returns the stored value when present", async () => {
      storeGetMock.mockResolvedValue({ a: 1 });
      const kv = createKv("templates");
      await expect(kv.get("k")).resolves.toEqual({ a: 1 });
    });

    it("set() writes the value and saves the store", async () => {
      const kv = createKv("templates");
      await kv.set("k", { a: 1 });
      expect(storeSetMock).toHaveBeenCalledWith("k", { a: 1 });
      expect(storeSaveMock).toHaveBeenCalled();
    });

    it("never calls invoke (the daemon path) under Tauri", async () => {
      const kv = createKv("templates");
      await kv.get("k");
      await kv.set("k", 1);
      expect(invokeMock).not.toHaveBeenCalled();
    });
  });

  describe("without Tauri (DaemonConfigKv)", () => {
    it("get() reads through read_config, namespaced by store name", async () => {
      invokeMock.mockResolvedValueOnce(42);
      const kv = createKv("snapshots");
      const result = await kv.get<number>("count");
      expect(result).toBe(42);
      expect(invokeMock).toHaveBeenCalledWith("read_config", { key: "snapshots:count" });
    });

    it("get() defaults a null/absent value to null (not undefined)", async () => {
      invokeMock.mockResolvedValueOnce(null);
      const kv = createKv("snapshots");
      await expect(kv.get("missing")).resolves.toBeNull();
    });

    it("set() writes through write_config, namespaced by store name", async () => {
      invokeMock.mockResolvedValueOnce(undefined);
      const kv = createKv("store-integrity");
      await kv.set("hash", "abc123");
      expect(invokeMock).toHaveBeenCalledWith("write_config", {
        key: "store-integrity:hash",
        value: "abc123",
      });
    });

    it("two different store names never collide on the same key", async () => {
      invokeMock.mockResolvedValue(undefined);
      const kvA = createKv("lazy-store");
      const kvB = createKv("templates");
      await kvA.set("theme", "dark");
      await kvB.set("theme", "light");
      const keys = invokeMock.mock.calls.map((call) => (call[1] as { key: string }).key);
      expect(keys).toEqual(["lazy-store:theme", "templates:theme"]);
    });

    it("never touches tauri-plugin-store when Tauri is unavailable", async () => {
      invokeMock.mockResolvedValue(null);
      const kv = createKv("snapshots");
      await kv.get("k");
      expect(loadMock).not.toHaveBeenCalled();
    });
  });
});
