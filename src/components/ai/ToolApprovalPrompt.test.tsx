// The approval prompt shows a worker's waiting AI tool calls and answers
// them: Allow Once, Allow For Session, Deny.

import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ToolApprovalPrompt } from "#components/ai/ToolApprovalPrompt";

vi.mock("#lib/tauri", async (importOriginal) => ({
  ...(await importOriginal<typeof import("#lib/tauri")>()),
  invoke: vi.fn().mockResolvedValue("file text"),
}));

vi.mock("#lib/tools", async (io) => {
  const a = await io<typeof import("#lib/tools")>();
  return { ...a, getPendingToolApprovals: vi.fn(a.getPendingToolApprovals) };
});

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

  it("calls onResolved when a focused button answers, whether or not a row remains", async () => {
    const user = userEvent.setup();
    const onResolved = vi.fn();
    render(<ToolApprovalPrompt workerId={W} onResolved={onResolved} />);
    const prov = { originWorker: W, causeSeq: 1 };

    const first = executeTool("read_file", { path: "/home/u/a.txt" }, prov);
    const second = executeTool("read_file", { path: "/home/u/b.txt" }, prov);
    await screen.findAllByRole("button", { name: "Deny" });
    screen.getAllByRole("button", { name: "Deny" })[0]?.focus();
    await user.keyboard("{Enter}");
    expect((await first).success).toBe(false);
    expect(onResolved).toHaveBeenCalledTimes(1);

    screen.getByRole("button", { name: "Deny" }).focus();
    await user.keyboard("{Enter}");
    expect((await second).success).toBe(false);
    expect(onResolved).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("alert", { name: "Tool Approval" })).toBeNull();
  });

  it("does not call onResolved for an answer that did not come from a focused button", async () => {
    const onResolved = vi.fn();
    render(<ToolApprovalPrompt workerId={W} onResolved={onResolved} />);

    void executeTool("read_file", { path: "/home/u/a.txt" }, { originWorker: W, causeSeq: 1 });
    fireEvent.click(await screen.findByRole("button", { name: "Deny" }));

    expect(onResolved).not.toHaveBeenCalled();
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

  it("renders an input key with a bidi override as escaped data", () => {
    // A provider-reported request keeps keys the tool schemas would strip.
    const p = vi.mocked(getPendingToolApprovals);
    p.mockReturnValue([
      {
        id: "r2",
        tool: "future_tool",
        input: { "a\u202Eb": "v" },
        sessionAllowed: true,
        workerId: W,
      },
    ]);
    try {
      render(<ToolApprovalPrompt workerId={W} />);
      const prompt = screen.getByRole("alert", { name: "Tool Approval" });
      expect(prompt).toHaveTextContent("A\\u202Eb");
      expect(prompt.textContent).not.toContain("\u202E");
    } finally {
      p.mockReset();
    }
  });

  it("renders tag characters, variation selectors and other default-ignorables visibly", async () => {
    render(<ToolApprovalPrompt workerId={W} />);
    const command = "a\u{E0041}️ ­b";

    void executeTool("run_command", { workerId: W, command }, { originWorker: W, causeSeq: 1 });

    const prompt = await screen.findByRole("alert", { name: "Tool Approval" });
    expect(prompt).toHaveTextContent("a\\u{E0041}\\uFE0F\\u2028\\u00ADb");
    for (const raw of ["\u{E0041}", "️", " ", "­"]) {
      expect(prompt.textContent).not.toContain(raw);
    }
  });

  it("renders a literal backslash-n differently from a real newline", async () => {
    render(<ToolApprovalPrompt workerId={W} />);
    const prov = { originWorker: W, causeSeq: 1 };

    void executeTool("run_command", { workerId: W, command: "echo done\nrm -rf ~" }, prov);
    void executeTool("run_command", { workerId: W, command: "echo done\\nrm -rf ~" }, prov);

    await vi.waitFor(() => expect(screen.getAllByRole("group")).toHaveLength(2));
    const [real, literal] = screen.getAllByRole("group").map((row) => row.textContent);
    expect(real).toContain("echo done\\nrm -rf ~");
    expect(literal).toContain("echo done\\\\nrm -rf ~");
    expect(real).not.toEqual(literal);
  });

  it("shows every field of the parsed input, humanizing the key", async () => {
    render(<ToolApprovalPrompt workerId={W} />);

    void executeTool(
      "read_file",
      { path: "/home/u/a.txt", maxLines: 7 },
      { originWorker: W, causeSeq: 1 },
    );
    const prompt = await screen.findByRole("alert", { name: "Tool Approval" });
    expect(prompt).toHaveTextContent("Path/home/u/a.txt");
    expect(prompt).toHaveTextContent("Max Lines7");
  });

  it("shows a spawn_worker name", async () => {
    render(<ToolApprovalPrompt workerId={W} />);

    void executeTool("spawn_worker", { name: "builder" }, { originWorker: W, causeSeq: 1 });

    expect(await screen.findByRole("alert", { name: "Tool Approval" })).toHaveTextContent(
      "Namebuilder",
    );
  });

  it("cuts a long value, counts what is hidden, and keeps Allow off until Show All", async () => {
    const user = userEvent.setup();
    render(<ToolApprovalPrompt workerId={W} />);
    const content = `${"x".repeat(1997)}END`;

    void executeTool(
      "write_file",
      { path: "/home/u/.swarm/x.txt", content },
      { originWorker: W, causeSeq: 1 },
    );

    const prompt = await screen.findByRole("alert", { name: "Tool Approval" });
    expect(prompt.textContent).not.toContain("END");
    expect(prompt).toHaveTextContent("… 1500 more characters");
    const allow = screen.getByRole("button", { name: "Allow Once" });
    expect(allow).toBeDisabled();
    expect(allow).toHaveAccessibleDescription(/Show All/);
    expect(screen.getByRole("button", { name: "Deny" })).toBeEnabled();

    await user.click(screen.getByRole("button", { name: "Show All" }));

    expect(prompt.textContent).toContain(content);
    expect(screen.getByRole("button", { name: "Allow Once" })).toBeEnabled();

    await user.click(screen.getByRole("button", { name: "Show Less" }));

    expect(prompt).toHaveTextContent("… 1500 more characters");
    expect(screen.getByRole("button", { name: "Allow Once" })).toBeEnabled();
  });

  it("cuts the raw value before escaping, never inside an escape or a surrogate pair", async () => {
    render(<ToolApprovalPrompt workerId={W} />);
    const content = `${"x".repeat(498)}‮${"y".repeat(1500)}`;

    void executeTool(
      "write_file",
      { path: "/home/u/.swarm/x.txt", content },
      { originWorker: W, causeSeq: 1 },
    );

    const prompt = await screen.findByRole("alert", { name: "Tool Approval" });
    expect(prompt).toHaveTextContent("x\\u202Ey");
    expect(prompt).toHaveTextContent("… 1499 more characters");
  });

  it("never cuts between the halves of a surrogate pair", async () => {
    render(<ToolApprovalPrompt workerId={W} />);
    const content = `${"x".repeat(499)}\u{1F600}${"z".repeat(600)}`;

    void executeTool(
      "write_file",
      { path: "/home/u/.swarm/x.txt", content },
      { originWorker: W, causeSeq: 1 },
    );

    const prompt = await screen.findByRole("alert", { name: "Tool Approval" });
    expect(prompt.textContent).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    expect(prompt).toHaveTextContent("… 601 more characters");
  });

  it("never truncates a run_command command", async () => {
    render(<ToolApprovalPrompt workerId={W} />);
    const command = `${"a".repeat(1999)}END`;

    void executeTool("run_command", { workerId: W, command }, { originWorker: W, causeSeq: 1 });

    const prompt = await screen.findByRole("alert", { name: "Tool Approval" });
    expect(prompt.textContent).toContain(command);
    expect(screen.queryByRole("button", { name: "Show All" })).toBeNull();
    expect(screen.getByRole("button", { name: "Allow Once" })).toBeEnabled();
  });

  it("renders a nested object as canonical JSON", () => {
    const p = vi.mocked(getPendingToolApprovals);
    p.mockReturnValue([
      {
        id: "r1",
        tool: "future_tool",
        input: { zeta: "z", options: { b: 2, a: { d: 4, c: 3 } }, list: [3, 1] },
        sessionAllowed: true,
        workerId: W,
      },
    ]);
    try {
      render(<ToolApprovalPrompt workerId={W} />);
      const el = screen.getByRole("alert", { name: "Tool Approval" });
      expect(el).toHaveTextContent('Options{"a":{"c":3,"d":4},"b":2}');
      expect(el).toHaveTextContent("Zetaz");
      expect(el).toHaveTextContent("List[3,1]");
    } finally {
      p.mockReset();
    }
  });

  it("keeps Allow For Session off until Show All on a long spawn_worker name", async () => {
    const user = userEvent.setup();
    render(<ToolApprovalPrompt workerId={W} />);

    void executeTool("spawn_worker", { name: "n".repeat(2000) }, { originWorker: W, causeSeq: 1 });

    await screen.findByRole("alert", { name: "Tool Approval" });
    const session = screen.getByRole("button", { name: "Allow For Session" });
    expect(session).toBeDisabled();
    expect(session).toHaveAccessibleDescription(/Show All/);

    await user.click(screen.getByRole("button", { name: "Show All" }));

    expect(screen.getByRole("button", { name: "Allow For Session" })).toBeEnabled();
  });

  it("never truncates a file path", async () => {
    render(<ToolApprovalPrompt workerId={W} />);
    const path = `/home/u/${"d".repeat(600)}/x.txt`;

    void executeTool("write_file", { path, content: "hi" }, { originWorker: W, causeSeq: 1 });

    const prompt = await screen.findByRole("alert", { name: "Tool Approval" });
    expect(prompt.textContent).toContain(path);
    expect(screen.queryByRole("button", { name: "Show All" })).toBeNull();
    expect(screen.getByRole("button", { name: "Allow Once" })).toBeEnabled();
  });

  it("does not show another worker's calls", async () => {
    render(<ToolApprovalPrompt workerId={W} />);

    void executeTool("read_file", { path: "/home/u/a.txt" }, { originWorker: OTHER, causeSeq: 1 });
    await vi.waitFor(() => expect(getPendingToolApprovals()).toHaveLength(1));

    expect(screen.queryByRole("alert", { name: "Tool Approval" })).toBeNull();
  });
});
