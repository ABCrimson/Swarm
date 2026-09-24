// Per-worker chat threads: LRU cap (the Settings "Chat History Worker
// Cap"), eviction never dropping a thread with a turn in flight, the
// display-message cap, and stable selector snapshots.

import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import {
  type ChatMessage,
  EMPTY_THREAD,
  useChatThread,
  useMessageHistoryStore,
} from "#store/message-history";

function message(content = "hi"): ChatMessage {
  return {
    id: crypto.randomUUID(),
    role: "user",
    content,
    timestamp: Temporal.Now.instant().toString(),
  };
}

function addMessage(workerId: string, content?: string): void {
  useMessageHistoryStore
    .getState()
    .updateThread(workerId, (t) => ({ ...t, messages: [...t.messages, message(content)] }));
}

describe("message history", () => {
  beforeEach(() => {
    useMessageHistoryStore.setState(useMessageHistoryStore.getInitialState(), true);
  });

  it("evicts least-recently-used threads when the cap shrinks", () => {
    for (let i = 0; i < 5; i++) addMessage(`worker-${i}`);

    useMessageHistoryStore.getState().setMaxWorkers(2);

    const { threads, lruOrder } = useMessageHistoryStore.getState();
    expect(lruOrder).toEqual(["worker-4", "worker-3"]);
    expect([...threads.keys()].toSorted()).toEqual(["worker-3", "worker-4"]);
  });

  it("applies the live cap to later updates", () => {
    useMessageHistoryStore.getState().setMaxWorkers(2);
    addMessage("a");
    addMessage("b");
    addMessage("c");

    const { threads, lruOrder } = useMessageHistoryStore.getState();
    expect(lruOrder).toEqual(["c", "b"]);
    expect(threads.has("a")).toBe(false);
  });

  it("never evicts a thread whose turn is still running", () => {
    useMessageHistoryStore.getState().setMaxWorkers(1);
    useMessageHistoryStore.getState().updateThread("busy", (t) => ({
      ...t,
      live: { itemId: "q1", phase: "streaming", text: "", thinking: "", toolCalls: [] },
    }));
    addMessage("idle");

    const { threads } = useMessageHistoryStore.getState();
    expect(threads.has("busy")).toBe(true);
  });

  it("caps display messages per worker but keeps the newest", () => {
    for (let i = 0; i < 205; i++) addMessage("w", `m${i}`);

    const messages = useMessageHistoryStore.getState().getMessages("w");
    expect(messages).toHaveLength(200);
    expect(messages.at(-1)?.content).toBe("m204");
  });

  it("getMessages returns one stable empty array for unknown workers", () => {
    const { getMessages } = useMessageHistoryStore.getState();
    expect(getMessages("nope")).toBe(getMessages("other"));
  });

  it("useChatThread yields a stable snapshot for a worker with no thread (no render loop)", () => {
    const { result, rerender } = renderHook(() => useChatThread("ghost"));
    const first = result.current;
    rerender();
    expect(result.current).toBe(first);
    expect(first).toBe(EMPTY_THREAD);
  });

  it("clearWorker drops one thread", () => {
    addMessage("a");
    addMessage("b");
    useMessageHistoryStore.getState().clearWorker("a");

    const { threads, lruOrder } = useMessageHistoryStore.getState();
    expect(threads.has("a")).toBe(false);
    expect(lruOrder).toEqual(["b"]);
  });
});
