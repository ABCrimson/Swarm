import { beforeEach, describe, expect, it } from "vitest";
import { acquireStreamSlot, registerQueueAbort, releaseStreamSlot, useAiStore } from "#store/ai";
import type { AiQueueItem, TokenUsageRecord } from "#store/types";

function createQueueItem(overrides?: Partial<AiQueueItem>): AiQueueItem {
  return {
    id: crypto.randomUUID(),
    priority: "normal",
    workerId: crypto.randomUUID(),
    messages: [],
    status: "pending",
    ...overrides,
  };
}

describe("AiStore", () => {
  beforeEach(() => {
    useAiStore.setState(useAiStore.getInitialState(), true);
  });

  describe("enqueue", () => {
    it("adds an item to the queue", () => {
      const item = createQueueItem();
      useAiStore.getState().enqueue(item);

      expect(useAiStore.getState().queue).toHaveLength(1);
      expect(useAiStore.getState().queue[0].id).toBe(item.id);
    });

    it("maintains priority ordering: critical before high", () => {
      const high = createQueueItem({ priority: "high" });
      const critical = createQueueItem({ priority: "critical" });

      const { enqueue } = useAiStore.getState();
      enqueue(high);
      enqueue(critical);

      const queue = useAiStore.getState().queue;
      expect(queue[0].priority).toBe("critical");
      expect(queue[1].priority).toBe("high");
    });

    it("maintains priority ordering: high before normal before low", () => {
      const low = createQueueItem({ priority: "low" });
      const normal = createQueueItem({ priority: "normal" });
      const high = createQueueItem({ priority: "high" });

      const { enqueue } = useAiStore.getState();
      enqueue(low);
      enqueue(normal);
      enqueue(high);

      const queue = useAiStore.getState().queue;
      expect(queue[0].priority).toBe("high");
      expect(queue[1].priority).toBe("normal");
      expect(queue[2].priority).toBe("low");
    });

    it("inserts same-priority items in FIFO order", () => {
      const first = createQueueItem({ priority: "normal" });
      const second = createQueueItem({ priority: "normal" });

      const { enqueue } = useAiStore.getState();
      enqueue(first);
      enqueue(second);

      const queue = useAiStore.getState().queue;
      expect(queue[0].id).toBe(first.id);
      expect(queue[1].id).toBe(second.id);
    });

    it("handles all four priority levels correctly", () => {
      const items = [
        createQueueItem({ priority: "low" }),
        createQueueItem({ priority: "critical" }),
        createQueueItem({ priority: "normal" }),
        createQueueItem({ priority: "high" }),
      ];

      const { enqueue } = useAiStore.getState();
      for (const item of items) {
        enqueue(item);
      }

      const priorities = useAiStore.getState().queue.map((q) => q.priority);
      expect(priorities).toEqual(["critical", "high", "normal", "low"]);
    });
  });

  describe("dequeue", () => {
    it("removes an item by id", () => {
      const item = createQueueItem();
      const { enqueue, dequeue } = useAiStore.getState();
      enqueue(item);

      dequeue(item.id);

      expect(useAiStore.getState().queue).toHaveLength(0);
    });

    it("does not affect other items when dequeuing", () => {
      const a = createQueueItem({ priority: "high" });
      const b = createQueueItem({ priority: "normal" });
      const { enqueue, dequeue } = useAiStore.getState();
      enqueue(a);
      enqueue(b);

      dequeue(a.id);

      const queue = useAiStore.getState().queue;
      expect(queue).toHaveLength(1);
      expect(queue[0].id).toBe(b.id);
    });

    it("does nothing for a non-existent id", () => {
      const item = createQueueItem();
      const { enqueue, dequeue } = useAiStore.getState();
      enqueue(item);

      dequeue("non-existent");

      expect(useAiStore.getState().queue).toHaveLength(1);
    });
  });

  describe("updateItemStatus", () => {
    it("updates an item status to streaming", () => {
      const item = createQueueItem({ status: "pending" });
      const { enqueue, updateItemStatus } = useAiStore.getState();
      enqueue(item);

      updateItemStatus(item.id, "streaming");

      expect(useAiStore.getState().queue[0].status).toBe("streaming");
    });

    it("updates an item status to complete", () => {
      const item = createQueueItem({ status: "streaming" });
      const { enqueue, updateItemStatus } = useAiStore.getState();
      enqueue(item);

      updateItemStatus(item.id, "complete");

      expect(useAiStore.getState().queue[0].status).toBe("complete");
    });

    it("updates an item status to error", () => {
      const item = createQueueItem({ status: "streaming" });
      const { enqueue, updateItemStatus } = useAiStore.getState();
      enqueue(item);

      updateItemStatus(item.id, "error");

      expect(useAiStore.getState().queue[0].status).toBe("error");
    });

    it("does nothing for a non-existent item", () => {
      const item = createQueueItem();
      const { enqueue, updateItemStatus } = useAiStore.getState();
      enqueue(item);

      // Should not throw
      updateItemStatus("non-existent", "complete");

      expect(useAiStore.getState().queue[0].status).toBe("pending");
    });
  });

  describe("setConcurrentLimit", () => {
    it("updates the concurrent limit", () => {
      useAiStore.getState().setConcurrentLimit(5);
      expect(useAiStore.getState().concurrentLimit).toBe(5);
    });
  });

  describe("addTokenUsage", () => {
    const T0 = 1_000_000;

    function usageRecord(overrides?: Partial<TokenUsageRecord>): TokenUsageRecord {
      return {
        inputTokens: 100,
        outputTokens: 50,
        model: "claude-sonnet-5",
        provider: "anthropic",
        costUsd: 0.01,
        timestamp: T0,
        ...overrides,
      };
    }

    it("accumulates totals across records", () => {
      useAiStore.getState().addTokenUsage(usageRecord());
      useAiStore.getState().addTokenUsage(usageRecord({ inputTokens: 10, outputTokens: 5 }));

      const usage = useAiStore.getState().cumulativeUsage;
      expect(usage.totalInputTokens).toBe(110);
      expect(usage.totalOutputTokens).toBe(55);
      expect(usage.totalCostUsd).toBeCloseTo(0.02);
    });

    it("retains history records within the trailing rate window", () => {
      useAiStore.getState().addTokenUsage(usageRecord({ timestamp: T0 }));
      useAiStore.getState().addTokenUsage(usageRecord({ timestamp: T0 + 30_000 }));

      expect(useAiStore.getState().cumulativeUsage.history).toHaveLength(2);
    });

    it("prunes history records older than the rate window when a new record arrives", () => {
      useAiStore.getState().addTokenUsage(usageRecord({ timestamp: T0 }));
      // Exactly at the horizon (60s later) — the rate charts' strict `>`
      // cutoff already excludes it, so the store drops it too.
      useAiStore.getState().addTokenUsage(usageRecord({ timestamp: T0 + 60_000 }));

      const history = useAiStore.getState().cumulativeUsage.history;
      expect(history).toHaveLength(1);
      expect(history[0].timestamp).toBe(T0 + 60_000);
    });

    it("pruning does not touch the cumulative totals", () => {
      useAiStore.getState().addTokenUsage(usageRecord({ timestamp: T0 }));
      useAiStore.getState().addTokenUsage(usageRecord({ timestamp: T0 + 120_000 }));

      const usage = useAiStore.getState().cumulativeUsage;
      expect(usage.history).toHaveLength(1);
      expect(usage.totalInputTokens).toBe(200);
      expect(usage.totalOutputTokens).toBe(100);
    });
  });

  describe("stream slots", () => {
    function pending(id: string, priority: AiQueueItem["priority"] = "normal"): void {
      useAiStore.getState().enqueue(createQueueItem({ id, priority }));
    }

    it("grants a slot immediately when capacity is free and marks the item streaming", async () => {
      pending("a");
      await acquireStreamSlot("a", new AbortController().signal);

      expect(useAiStore.getState().activeStreams).toBe(1);
      expect(useAiStore.getState().queue[0]?.status).toBe("streaming");
      releaseStreamSlot("a");
      releaseStreamSlot("a");
      expect(useAiStore.getState().activeStreams).toBe(0);
    });

    it("makes a turn wait for a free slot, then starts it when one is released", async () => {
      useAiStore.getState().setConcurrentLimit(1);
      pending("first");
      pending("second");
      await acquireStreamSlot("first", new AbortController().signal);

      let started = false;
      const waiting = acquireStreamSlot("second", new AbortController().signal).then(() => {
        started = true;
      });
      await Promise.resolve();
      expect(started).toBe(false);

      releaseStreamSlot("first");
      useAiStore.getState().dequeue("first");
      await waiting;
      expect(started).toBe(true);
      releaseStreamSlot("second");
    });

    it("rejects a waiting acquire when its signal aborts", async () => {
      useAiStore.getState().setConcurrentLimit(0);
      pending("x");
      const controller = new AbortController();
      const waiting = acquireStreamSlot("x", controller.signal);
      controller.abort(new Error("stop"));
      await expect(waiting).rejects.toThrow("stop");
      expect(useAiStore.getState().activeStreams).toBe(0);
    });

    it("cancelItem aborts the running turn (not just its queue entry) and frees its slot", async () => {
      pending("run");
      const controller = new AbortController();
      const unregister = registerQueueAbort("run", controller);
      await acquireStreamSlot("run", controller.signal);

      useAiStore.getState().cancelItem("run");

      expect(controller.signal.aborted).toBe(true);
      expect(useAiStore.getState().queue).toHaveLength(0);
      expect(useAiStore.getState().activeStreams).toBe(0);
      unregister();
    });
  });
});
