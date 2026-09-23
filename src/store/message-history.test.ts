// The live message-history worker cap behind the Settings catalog.

import { beforeEach, describe, expect, it } from "vitest";
import { useMessageHistoryStore } from "#store/message-history";
import type { AiMessage } from "#store/types";

function makeMessage(): AiMessage {
  return {
    id: crypto.randomUUID(),
    role: "user",
    content: "hi",
    timestamp: new Date().toISOString(),
  };
}

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
