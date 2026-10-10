// The live log-retention cap behind the Settings catalog.

import { beforeEach, describe, expect, it } from "vitest";
import type { LogEntry } from "#lib/log-store";
import { useLogStore } from "#lib/log-store";

function add(message: string, source = "system"): void {
  useLogStore.getState().addEntry({ timestamp: 0, level: "info", source, message });
}

const messages = (entries: readonly LogEntry[]): string[] => entries.map((e) => e.message);

describe("log store retention cap", () => {
  beforeEach(() => {
    useLogStore.setState(useLogStore.getInitialState(), true);
  });

  it("evicts oldest entries when the cap shrinks below the current count", () => {
    for (let i = 0; i < 10; i++) add(`entry ${i}`);

    useLogStore.getState().setMaxEntries(4);

    expect(messages(useLogStore.getState().entries)).toEqual([
      "entry 6",
      "entry 7",
      "entry 8",
      "entry 9",
    ]);
  });

  it("applies the live cap to subsequent inserts", () => {
    useLogStore.getState().setMaxEntries(3);
    for (let i = 0; i < 5; i++) add(`m${i}`);

    expect(messages(useLogStore.getState().entries)).toEqual(["m2", "m3", "m4"]);
  });

  it("enforces a cap of 1", () => {
    useLogStore.getState().setMaxEntries(1);
    for (let i = 0; i < 3; i++) add(`m${i}`);

    expect(messages(useLogStore.getState().entries)).toEqual(["m2"]);
  });

  it("keeps nothing under a cap of 0", () => {
    add("before");
    useLogStore.getState().setMaxEntries(0);
    add("after");

    expect(useLogStore.getState().entries).toEqual([]);
  });
});

describe("log store sources", () => {
  beforeEach(() => {
    useLogStore.setState(useLogStore.getInitialState(), true);
  });

  it("tracks each distinct source once", () => {
    add("a", "backend");
    add("b", "ai");
    add("c", "backend");

    expect([...useLogStore.getState().sources]).toEqual(["backend", "ai"]);
  });

  it("keeps the same sources set instance when no new source appears", () => {
    add("a", "backend");
    const before = useLogStore.getState().sources;

    add("b", "backend");

    expect(useLogStore.getState().sources).toBe(before);
  });

  it("clear() empties entries and sources", () => {
    add("a", "backend");

    useLogStore.getState().clear();

    expect(useLogStore.getState().entries).toEqual([]);
    expect(useLogStore.getState().sources.size).toBe(0);
  });
});
