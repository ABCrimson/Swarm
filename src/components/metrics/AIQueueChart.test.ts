import { describe, expect, it } from "vitest";
import { pendingByPriority } from "#components/metrics/AIQueueChart";
import type { AiQueueItem } from "#store/types";

const item = (priority: AiQueueItem["priority"], status: AiQueueItem["status"]): AiQueueItem =>
  ({ priority, status }) as AiQueueItem;

describe("pendingByPriority", () => {
  it("counts only pending items, with every priority present", () => {
    expect(
      pendingByPriority([
        item("high", "pending"),
        item("high", "pending"),
        item("low", "streaming"),
        item("critical", "pending"),
      ]),
    ).toEqual({ critical: 1, high: 2, normal: 0, low: 0 });
  });
});
