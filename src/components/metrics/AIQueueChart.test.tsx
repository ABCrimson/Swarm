import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { AIQueueChart, pendingByPriority } from "#components/metrics/AIQueueChart";
import { useAiStore } from "#store/ai";
import type { AiQueueItem } from "#store/types";

const item = (priority: AiQueueItem["priority"], status: AiQueueItem["status"]): AiQueueItem =>
  ({ priority, status }) as AiQueueItem;

afterEach(() => {
  useAiStore.setState(useAiStore.getInitialState(), true);
});

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

describe("AIQueueChart", () => {
  it("shows a plain line instead of empty axes when nothing is pending", () => {
    const { container } = render(<AIQueueChart />);

    expect(screen.getByText("No Pending Requests")).toBeInTheDocument();
    expect(container.querySelector(".recharts-cartesian-grid")).not.toBeInTheDocument();
  });

  it("drops the empty line once a request is pending", () => {
    useAiStore.getState().enqueue({
      id: crypto.randomUUID(),
      priority: "normal",
      workerId: crypto.randomUUID(),
      messages: [],
      status: "pending",
    });

    render(<AIQueueChart />);

    expect(screen.queryByText("No Pending Requests")).not.toBeInTheDocument();
  });
});
