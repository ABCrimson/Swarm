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

  it("runs the call on Allow For Session and stops asking for that exact call only", async () => {
    const user = userEvent.setup();
    render(<ToolApprovalPrompt workerId={W} />);
    const prov = { originWorker: W, causeSeq: 1 };

    const first = executeTool("read_file", { path: "/home/u/a.txt" }, prov);
    await user.click(await screen.findByRole("button", { name: "Allow For Session" }));
    expect((await first).success).toBe(true);

    expect((await executeTool("read_file", { path: "/home/u/a.txt" }, prov)).success).toBe(true);
    expect(screen.queryByRole("alert", { name: "Tool Approval" })).toBeNull();

    void executeTool("read_file", { path: "/home/u/b.txt" }, prov);
    expect(await screen.findByRole("alert", { name: "Tool Approval" })).toHaveTextContent(
      "/home/u/b.txt",
    );
  });

  it("hides Allow For Session for write_file and shows its size", async () => {
    render(<ToolApprovalPrompt workerId={W} />);

    void executeTool(
      "write_file",
      { path: "/home/u/.swarm/x.txt", content: "h\u00e9llo" },
      { originWorker: W, causeSeq: 1 },
    );

    const prompt = await screen.findByRole("alert", { name: "Tool Approval" });
    expect(prompt).toHaveTextContent("6 bytes");
    expect(screen.queryByRole("button", { name: "Allow For Session" })).toBeNull();
    expect(screen.getByRole("button", { name: "Allow Once" })).toBeDefined();
  });

  it("renders a command with quotes, a newline and a bidi override literally escaped", async () => {
    render(<ToolApprovalPrompt workerId={W} />);
    const command = 'echo "a"\nrm -rf ~\u202E';

    void executeTool("run_command", { workerId: W, command }, { originWorker: W, causeSeq: 1 });

    const prompt = await screen.findByRole("alert", { name: "Tool Approval" });
    expect(prompt).toHaveTextContent('echo "a"\\nrm -rf ~\\u202E');
    expect(prompt.textContent).not.toContain("\u202E");
    expect(prompt.textContent).not.toContain("\n");
  });

  it("truncates a long value behind a Show All toggle", async () => {
    const user = userEvent.setup();
    render(<ToolApprovalPrompt workerId={W} />);
    const content = `${"x".repeat(1999)}END`;

    void executeTool(
      "write_file",
      { path: "/home/u/.swarm/x.txt", content },
      { originWorker: W, causeSeq: 1 },
    );

    const prompt = await screen.findByRole("alert", { name: "Tool Approval" });
    expect(prompt.textContent).not.toContain("END");
    await user.click(screen.getByRole("button", { name: "Show All" }));
    expect(prompt.textContent).toContain(content);
  });

  it("does not show another worker's calls", async () => {
    render(<ToolApprovalPrompt workerId={W} />);

    void executeTool("read_file", { path: "/home/u/a.txt" }, { originWorker: OTHER, causeSeq: 1 });
    await vi.waitFor(() => expect(getPendingToolApprovals()).toHaveLength(1));

    expect(screen.queryByRole("alert", { name: "Tool Approval" })).toBeNull();
  });
});
