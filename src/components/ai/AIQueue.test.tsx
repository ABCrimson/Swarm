// Cancel on a queue item aborts the turn and denies the worker's tool
// calls still waiting for approval, so the parked tool loop finishes
// instead of waiting on a prompt nobody will answer.

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AIQueue } from "#components/ai/AIQueue";

vi.mock("#lib/tauri", async (importOriginal) => ({
  ...(await importOriginal<typeof import("#lib/tauri")>()),
  invoke: vi.fn().mockResolvedValue("file text"),
}));

import { executeTool, getPendingToolApprovals, resetToolApprovals } from "#lib/tools";
import { useAiStore } from "#store/ai";

const W = "11111111-2222-4333-8444-555555555555";
const ITEM = "66666666-7777-4888-8999-aaaaaaaaaaaa";

beforeEach(() => {
  useAiStore.setState(useAiStore.getInitialState(), true);
});

afterEach(() => {
  resetToolApprovals();
});

describe("AIQueue", () => {
  it("Cancel denies the worker's waiting tool approvals and dequeues the item", async () => {
    const user = userEvent.setup();
    useAiStore.getState().enqueue({
      id: ITEM,
      priority: "normal",
      workerId: W,
      messages: [],
      status: "streaming",
    });
    render(<AIQueue workerId={W} />);
    const result = executeTool(
      "read_file",
      { path: "/home/u/a.txt" },
      { originWorker: W, causeSeq: 1 },
    );
    await vi.waitFor(() => expect(getPendingToolApprovals()).toHaveLength(1));

    await user.click(screen.getByRole("button", { name: "Cancel Queue Item 1" }));

    expect(await result).toEqual({
      success: false,
      error: "The User Denied read_file. It Was Not Run.",
    });
    expect(getPendingToolApprovals()).toHaveLength(0);
    expect(useAiStore.getState().queue).toHaveLength(0);
  });
});
