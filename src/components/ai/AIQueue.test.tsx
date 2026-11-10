// Cancel on a queue item aborts the turn registered for it and dequeues the
// item. The abort is what denies the turn's waiting tool calls (covered in
// ai-chat.test.ts), so the button needs no denial of its own.

import { act, fireEvent, render, screen } from "@testing-library/react";
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

  it("sets the Active count's numbers in mono and its word in the text face", () => {
    render(<AIQueue workerId={W} />);
    const count = screen.getByText((_, el) =>
      Boolean(el?.matches("span.font-sans") && /^\d+\/\d+ Active/.test(el.textContent ?? "")),
    );
    expect(count.querySelector(".font-mono")?.textContent).toMatch(/^\d+\/\d+$/);
  });

  it("names a pending item's place in the whole queue", () => {
    for (const id of ["aaaaaaaa-1111-4111-8111-111111111111", ITEM]) {
      useAiStore
        .getState()
        .enqueue({ id, priority: "normal", workerId: W, messages: [], status: "pending" });
    }
    render(<AIQueue workerId={W} />);

    expect(screen.getByText("Waiting, #2 In Line")).toBeInTheDocument();
  });

  it("keeps a removed row mounted, exiting, until its transition ends", () => {
    useAiStore
      .getState()
      .enqueue({ id: ITEM, priority: "normal", workerId: W, messages: [], status: "streaming" });
    render(<AIQueue workerId={W} />);
    const row = screen.getByText("Running").closest("[class*='transition']");

    act(() => useAiStore.getState().cancelItem(ITEM));

    expect(useAiStore.getState().queue).toHaveLength(0);
    expect(screen.getByText("Running")).toBeInTheDocument();
    expect(row).toHaveAttribute("data-exiting", "true");
    expect(screen.queryByRole("button", { name: /Cancel Queue Item/ })).not.toBeInTheDocument();

    fireEvent.transitionEnd(row as Element);

    expect(screen.queryByText("Running")).not.toBeInTheDocument();
    expect(screen.getByText("No Items In Queue")).toBeInTheDocument();
  });

  it("drops an exiting row at once when no leave transition runs", () => {
    const original = Object.getOwnPropertyDescriptor(Element.prototype, "getAnimations");
    Element.prototype.getAnimations = () => [];
    try {
      useAiStore
        .getState()
        .enqueue({ id: ITEM, priority: "normal", workerId: W, messages: [], status: "streaming" });
      render(<AIQueue workerId={W} />);

      act(() => useAiStore.getState().cancelItem(ITEM));

      expect(screen.queryByText("Running")).not.toBeInTheDocument();
      expect(screen.getByText("No Items In Queue")).toBeInTheDocument();
    } finally {
      if (original) Object.defineProperty(Element.prototype, "getAnimations", original);
      else Reflect.deleteProperty(Element.prototype, "getAnimations");
    }
  });
});
