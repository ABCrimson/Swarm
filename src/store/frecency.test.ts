import { createStore } from "jotai";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("#lib/tauri", () => ({ isTauri: () => true }));
vi.mock("#lib/lazy-store", () => ({
  settingsStore: { entries: vi.fn(async () => []), set: vi.fn(async () => {}) },
}));

import { frecencyAtom } from "#store/frecency";
import { resetPersistedSettingsCache } from "#store/persisted";

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
  });
});
