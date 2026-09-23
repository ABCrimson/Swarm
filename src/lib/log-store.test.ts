// The live log-retention cap behind the Settings catalog.

import { beforeEach, describe, expect, it } from "vitest";
import { useLogStore } from "#lib/log-store";

describe("log store retention cap", () => {
  beforeEach(() => {
    useLogStore.getState().clear();
    useLogStore.getState().setMaxEntries(10_000);
  });

  it("evicts oldest entries when the cap shrinks below the current count", () => {
    const { addBatch, setMaxEntries } = useLogStore.getState();
    addBatch(
      Array.from({ length: 10 }, (_, i) => ({
        timestamp: i,
        level: "info" as const,
        source: "system",
        message: `entry ${i}`,
      })),
    );

    setMaxEntries(4);

    const entries = useLogStore.getState().entries;
    expect(entries).toHaveLength(4);
    expect(entries[0].message).toBe("entry 6");
    expect(entries.at(-1)?.message).toBe("entry 9");
  });

  it("applies the live cap to subsequent inserts", () => {
    const { setMaxEntries, addEntry } = useLogStore.getState();
    setMaxEntries(3);
    for (let i = 0; i < 5; i++) {
      addEntry({ timestamp: i, level: "info", source: "system", message: `m${i}` });
    }
    const entries = useLogStore.getState().entries;
    expect(entries).toHaveLength(3);
    expect(entries[0].message).toBe("m2");
  });
});
