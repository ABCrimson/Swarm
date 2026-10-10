// Cancel on a queue item aborts the turn registered for it and dequeues the
// item. The abort is what denies the turn's waiting tool calls (covered in
// ai-chat.test.ts), so the button needs no denial of its own.

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { AIQueue } from "#components/ai/AIQueue";

import { registerQueueAbort, useAiStore } from "#store/ai";

const W = "11111111-2222-4333-8444-555555555555";
const ITEM = "66666666-7777-4888-8999-aaaaaaaaaaaa";

beforeEach(() => {
  useAiStore.setState(useAiStore.getInitialState(), true);
});

describe("AIQueue", () => {
  it("Cancel aborts the item's turn and dequeues it", async () => {
    const user = userEvent.setup();
    useAiStore.getState().enqueue({
      id: ITEM,
      priority: "normal",
      workerId: W,
      messages: [],
      status: "streaming",
    });
    const controller = new AbortController();
    registerQueueAbort(ITEM, controller);
    render(<AIQueue workerId={W} />);

    await user.click(screen.getByRole("button", { name: "Cancel Queue Item 1" }));

    expect(controller.signal.aborted).toBe(true);
    expect(useAiStore.getState().queue).toHaveLength(0);
  });
});
