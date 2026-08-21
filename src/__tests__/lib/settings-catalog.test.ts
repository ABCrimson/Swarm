// Behaviors behind the Settings catalog: live log-retention cap,
// message-history LRU cap, and the parametrized alert cooldown.

import { beforeEach, describe, expect, it } from "vitest";
import type { AlertThresholds } from "#lib/alerts";
import { evaluateThresholds } from "#lib/alerts";
import { useLogStore } from "#lib/log-store";
import { useMessageHistoryStore } from "#store/message-history";
import type { AiMessage } from "#store/types";

const THRESHOLDS: AlertThresholds = {
  cpuWarning: 70,
  cpuCritical: 90,
  memoryWarning: 75,
  memoryCritical: 90,
};

function makeMessage(): AiMessage {
  return {
    id: crypto.randomUUID(),
    role: "user",
    content: "hi",
    timestamp: new Date().toISOString(),
  };
}

describe("alert cooldown (parametrized)", () => {
  const hotSnapshot = { cpuPercent: 95, memoryPercent: 10 };

  it("suppresses a repeat alert inside a custom cooldown window", () => {
    const cooldowns = { cpu: 10_000 };
    // 55s after the last alert, with a 60s cooldown — still suppressed.
    const alerts = evaluateThresholds(hotSnapshot, THRESHOLDS, cooldowns, 65_000, 60_000);
    expect(alerts).toHaveLength(0);
  });

  it("fires again once the custom cooldown has elapsed", () => {
    const cooldowns = { cpu: 10_000 };
    const alerts = evaluateThresholds(hotSnapshot, THRESHOLDS, cooldowns, 75_000, 60_000);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].severity).toBe("critical");
  });

  it("defaults to the 30s constant when no cooldown is passed", () => {
    const cooldowns = { cpu: 0 };
    expect(evaluateThresholds(hotSnapshot, THRESHOLDS, cooldowns, 29_000)).toHaveLength(0);
    expect(evaluateThresholds(hotSnapshot, THRESHOLDS, cooldowns, 31_000)).toHaveLength(1);
  });
});

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

describe("message history worker cap", () => {
  beforeEach(() => {
    useMessageHistoryStore.getState().clearAll();
    useMessageHistoryStore.getState().setMaxWorkers(50);
  });

  it("evicts least-recently-used workers when the cap shrinks", () => {
    const store = useMessageHistoryStore.getState();
    for (let i = 0; i < 5; i++) {
      store.addMessage(`worker-${i}`, makeMessage());
    }

    useMessageHistoryStore.getState().setMaxWorkers(2);

    const state = useMessageHistoryStore.getState();
    expect(state.lruOrder).toHaveLength(2);
    // Most recently added stay; oldest are gone.
    expect(state.history.has("worker-4")).toBe(true);
    expect(state.history.has("worker-3")).toBe(true);
    expect(state.history.has("worker-0")).toBe(false);
  });

  it("applies the live cap to subsequent adds", () => {
    useMessageHistoryStore.getState().setMaxWorkers(2);
    const store = useMessageHistoryStore.getState();
    store.addMessage("a", makeMessage());
    store.addMessage("b", makeMessage());
    store.addMessage("c", makeMessage());

    const state = useMessageHistoryStore.getState();
    expect(state.lruOrder).toEqual(["c", "b"]);
    expect(state.history.has("a")).toBe(false);
  });
});
