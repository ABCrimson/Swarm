// The approval prompt shows a worker's waiting AI tool calls and answers
// them: Allow Once, Allow For Session, Deny.

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ToolApprovalPrompt } from "#components/ai/ToolApprovalPrompt";

vi.mock("#lib/tauri", async (importOriginal) => ({
  ...(await importOriginal<typeof import("#lib/tauri")>()),
  invoke: vi.fn().mockResolvedValue("file text"),
}));

import { executeTool, getPendingToolApprovals, resetToolApprovals } from "#lib/tools";

const W = "11111111-2222-4333-8444-555555555555";
const OTHER = "66666666-7777-4888-8999-aaaaaaaaaaaa";

afterEach(() => {
  resetToolApprovals();
});

describe("ToolApprovalPrompt", () => {
  it("renders nothing while no call waits", () => {
    render(<ToolApprovalPrompt workerId={W} />);

    expect(screen.queryByRole("alert", { name: "Tool Approval" })).toBeNull();
  });

  it("shows a waiting call and runs it on Allow Once", async () => {
    const user = userEvent.setup();
    render(<ToolApprovalPrompt workerId={W} />);

    const result = executeTool(
      "read_file",
      { path: "/home/u/a.txt" },
      { originWorker: W, causeSeq: 1 },
    );

    const prompt = await screen.findByRole("alert", { name: "Tool Approval" });
    expect(prompt).toHaveTextContent("read_file");
    expect(prompt).toHaveTextContent("/home/u/a.txt");
    await user.click(screen.getByRole("button", { name: "Allow Once" }));

    expect((await result).success).toBe(true);
    expect(screen.queryByRole("alert", { name: "Tool Approval" })).toBeNull();
  });

  it("denies the call on Deny", async () => {
    const user = userEvent.setup();
    render(<ToolApprovalPrompt workerId={W} />);

    const result = executeTool(
      "run_command",
      { workerId: W, command: "ls" },
      { originWorker: W, causeSeq: 1 },
    );

    await user.click(await screen.findByRole("button", { name: "Deny" }));

    expect((await result).success).toBe(false);
    expect(getPendingToolApprovals()).toHaveLength(0);
  });

  it("runs the call and stops asking on Allow For Session", async () => {
    const user = userEvent.setup();
    render(<ToolApprovalPrompt workerId={W} />);
    const prov = { originWorker: W, causeSeq: 1 };

    const first = executeTool("read_file", { path: "/home/u/a.txt" }, prov);
    await user.click(await screen.findByRole("button", { name: "Allow For Session" }));
    expect((await first).success).toBe(true);

    expect((await executeTool("read_file", { path: "/home/u/b.txt" }, prov)).success).toBe(true);
    expect(screen.queryByRole("alert", { name: "Tool Approval" })).toBeNull();
  });

  it("does not show another worker's calls", async () => {
    render(<ToolApprovalPrompt workerId={W} />);

    void executeTool("read_file", { path: "/home/u/a.txt" }, { originWorker: OTHER, causeSeq: 1 });
    await vi.waitFor(() => expect(getPendingToolApprovals()).toHaveLength(1));

    expect(screen.queryByRole("alert", { name: "Tool Approval" })).toBeNull();
  });
});
