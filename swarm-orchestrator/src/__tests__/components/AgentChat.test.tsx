// ── AgentChat transcript rendering ───────────────────
// Covers the follow-up UI-overhaul refinement: agent_turn_delta
// appends live to the in-progress bubble, a tool call renders as a
// labeled collapsible ToolCallDisplay block (name/input/result), a
// permission denial's denialSubclass maps to a Title Case label, the
// settled receipt shows cost/duration/turns, and the send button reads
// "Queue Next Turn" (not "Interrupt") when the session's Capabilities
// report no mid-turn interrupt.

import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Capabilities } from "#lib/agent-events";

type Handler = (e: { seq: number; payload: unknown }) => void;

const registered = new Map<string, Handler>();

vi.mock("#lib/event-bus", () => ({
  onEvent: (type: string, handler: Handler) => {
    registered.set(type, handler);
    return () => registered.delete(type);
  },
}));

vi.mock("#lib/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("#lib/tauri")>();
  return {
    ...actual,
    agentSendTurn: vi.fn().mockResolvedValue(undefined),
    agentCancel: vi.fn().mockResolvedValue(undefined),
  };
});

import { AgentChat } from "#components/ai/AgentChat";
import { agentSendTurn } from "#lib/tauri";
import { useAgentSessionStore } from "#store/agent-sessions";

// jsdom does not implement scrollTo — the transcript's auto-scroll
// effect calls it on mount.
Element.prototype.scrollTo = vi.fn();

const WORKER_ID = "11111111-2222-3333-8444-555555555555";

const CAPABILITIES_NO_INTERRUPT: Capabilities = {
  partialDeltas: true,
  resume: true,
  nativeCost: true,
  permissionModes: ["default", "dontAsk", "acceptEdits"],
  cancelGranularity: "kill_only",
  interruptMidturn: false,
  worktreeAware: true,
};

function fire(type: string, payload: unknown, seq = 1): void {
  act(() => {
    registered.get(type)?.({ seq, payload });
  });
}

function resetSessionStore(): void {
  for (const [id] of useAgentSessionStore.getState().sessions) {
    useAgentSessionStore.getState().removeSession(id);
  }
}

async function submit(text: string): Promise<void> {
  const input = screen.getByLabelText("Message Claude Code");
  fireEvent.change(input, { target: { value: text } });
  const form = input.closest("form");
  if (!form) throw new Error("chat form not found");
  await act(async () => {
    fireEvent.submit(form);
  });
}

describe("AgentChat", () => {
  beforeEach(() => {
    registered.clear();
    resetSessionStore();
    vi.mocked(agentSendTurn).mockClear();
  });

  afterEach(() => {
    resetSessionStore();
  });

  it("appends agent_turn_delta text live to the same in-progress bubble", () => {
    render(<AgentChat workerId={WORKER_ID} />);

    fire("agent_turn_delta", {
      workerId: WORKER_ID,
      turnId: "turn-1",
      blockIndex: 0,
      kind: "text",
      text: "Hello ",
    });
    fire("agent_turn_delta", {
      workerId: WORKER_ID,
      turnId: "turn-1",
      blockIndex: 0,
      kind: "text",
      text: "World",
    });

    expect(screen.getByText("Hello World")).toBeInTheDocument();
  });

  it("renders a tool call as a labeled collapsible block showing name, input, and result", async () => {
    const user = userEvent.setup();
    render(<AgentChat workerId={WORKER_ID} />);

    fire("agent_tool_call", {
      workerId: WORKER_ID,
      turnId: "turn-1",
      toolUseId: "tool-1",
      name: "run_command",
      input: { command: "ls" },
    });
    fire(
      "agent_tool_result",
      {
        workerId: WORKER_ID,
        turnId: "turn-1",
        toolUseId: "tool-1",
        isError: false,
        content: "file.txt",
      },
      2,
    );

    const toggle = screen.getByRole("button", { name: "Tool call: run_command" });
    expect(toggle).toBeInTheDocument();

    await user.click(toggle);

    expect(screen.getByText("Input")).toBeInTheDocument();
    expect(screen.getByText(/"command"/)).toBeInTheDocument();
    expect(screen.getByText("Result")).toBeInTheDocument();
    expect(screen.getByText("file.txt")).toBeInTheDocument();
  });

  it("shows an is_error tool result via the error status, not the success one", async () => {
    const user = userEvent.setup();
    render(<AgentChat workerId={WORKER_ID} />);

    fire("agent_tool_call", {
      workerId: WORKER_ID,
      turnId: "turn-1",
      toolUseId: "tool-2",
      name: "write_file",
      input: { path: "a.txt" },
    });
    fire(
      "agent_tool_result",
      {
        workerId: WORKER_ID,
        turnId: "turn-1",
        toolUseId: "tool-2",
        isError: true,
        content: "permission denied",
      },
      2,
    );

    await user.click(screen.getByRole("button", { name: "Tool call: write_file" }));

    expect(screen.getByLabelText("Error")).toBeInTheDocument();
    expect(screen.queryByLabelText("Complete")).not.toBeInTheDocument();
  });

  it("maps a permission denial's denialSubclass to its Title Case label", () => {
    render(<AgentChat workerId={WORKER_ID} />);

    fire("agent_permission_request", {
      workerId: WORKER_ID,
      turnId: "turn-1",
      requestId: "req-1",
      tool: "Write",
      input: {},
      denialSubclass: "ungranted_write",
      message: "you haven't granted Write yet",
    });

    expect(screen.getByText("Write Not Granted")).toBeInTheDocument();
    expect(screen.getByText("you haven't granted Write yet")).toBeInTheDocument();
  });

  it("falls back to a generic label for an unrecognized denialSubclass", () => {
    render(<AgentChat workerId={WORKER_ID} />);

    fire("agent_permission_request", {
      workerId: WORKER_ID,
      turnId: "turn-1",
      requestId: "req-1",
      tool: "Bash",
      input: {},
      denialSubclass: null,
      message: null,
    });

    expect(screen.getByText("Permission Denied")).toBeInTheDocument();
  });

  it("shows cost, duration, and turn count in the settled receipt when present", () => {
    render(<AgentChat workerId={WORKER_ID} />);

    fire("agent_turn_settled", {
      workerId: WORKER_ID,
      turnId: "turn-1",
      status: "ok",
      costUsd: 0.1234,
      durationMs: 1500,
      numTurns: 2,
    });

    expect(screen.getByText("Turn Complete · 1.5s · 2 Turns · $0.1234")).toBeInTheDocument();
  });

  it('labels the send button "Queue Next Turn" (not "Interrupt") when interruptMidturn is false, once busy', async () => {
    useAgentSessionStore.getState().setSession(WORKER_ID, {
      workerId: WORKER_ID,
      provider: "claude_code",
      sessionKey: WORKER_ID,
      model: "sonnet",
      cwd: "/repo",
      capabilities: CAPABILITIES_NO_INTERRUPT,
    });

    render(<AgentChat workerId={WORKER_ID} />);

    expect(screen.getByRole("button", { name: "Send" })).toBeInTheDocument();

    const input = screen.getByLabelText("Message Claude Code");
    fireEvent.change(input, { target: { value: "hello" } });
    const form = input.closest("form");
    if (!form) throw new Error("chat form not found");
    await act(async () => {
      fireEvent.submit(form);
    });

    expect(screen.getByRole("button", { name: "Queue Next Turn" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Interrupt" })).not.toBeInTheDocument();
    expect(
      screen.getByText(
        "This Provider Has No Mid-Turn Interrupt — Sending Now Queues Behind The Current Turn.",
      ),
    ).toBeInTheDocument();
  });

  it('labels the send button "Interrupt" when the session reports interruptMidturn true', async () => {
    useAgentSessionStore.getState().setSession(WORKER_ID, {
      workerId: WORKER_ID,
      provider: "claude_code",
      sessionKey: WORKER_ID,
      model: "sonnet",
      cwd: "/repo",
      capabilities: { ...CAPABILITIES_NO_INTERRUPT, interruptMidturn: true },
    });

    render(<AgentChat workerId={WORKER_ID} />);

    const input = screen.getByLabelText("Message Claude Code");
    fireEvent.change(input, { target: { value: "hello" } });
    const form = input.closest("form");
    if (!form) throw new Error("chat form not found");
    await act(async () => {
      fireEvent.submit(form);
    });

    expect(screen.getByRole("button", { name: "Interrupt" })).toBeInTheDocument();
  });

  it("still allows submitting a follow-up message while a turn is already in flight (queueing, not blocking)", async () => {
    render(<AgentChat workerId={WORKER_ID} />);

    const input = screen.getByLabelText("Message Claude Code");
    fireEvent.change(input, { target: { value: "first" } });
    const form = input.closest("form");
    if (!form) throw new Error("chat form not found");
    await act(async () => {
      fireEvent.submit(form);
    });

    expect(input).not.toBeDisabled();

    fireEvent.change(input, { target: { value: "second" } });
    await act(async () => {
      fireEvent.submit(form);
    });

    expect(agentSendTurn).toHaveBeenCalledTimes(2);
    expect(agentSendTurn).toHaveBeenNthCalledWith(1, WORKER_ID, "first");
    expect(agentSendTurn).toHaveBeenNthCalledWith(2, WORKER_ID, "second");
  });

  it("FIX-1: stays busy (Queue Next Turn label, Cancel visible) until BOTH of two queued turns settle, not just the first", async () => {
    render(<AgentChat workerId={WORKER_ID} />);

    await submit("first");
    await submit("second");

    // Both admitted, neither settled yet.
    expect(screen.getByRole("button", { name: "Queue Next Turn" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancel Turn" })).toBeInTheDocument();

    // turn-1 starts producing events, then settles — the FIRST of the
    // two outstanding turns.
    fire("agent_turn_delta", {
      workerId: WORKER_ID,
      turnId: "turn-1",
      blockIndex: 0,
      kind: "text",
      text: "working",
    });
    fire("agent_turn_settled", {
      workerId: WORKER_ID,
      turnId: "turn-1",
      status: "ok",
      durationMs: 100,
    });

    // The old boolean `busy` would have flipped to idle here even
    // though "second" is still outstanding — must still read busy.
    expect(screen.getByRole("button", { name: "Queue Next Turn" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Send" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancel Turn" })).toBeInTheDocument();

    // turn-2 (the actually-queued one) now settles too.
    fire("agent_turn_delta", {
      workerId: WORKER_ID,
      turnId: "turn-2",
      blockIndex: 0,
      kind: "text",
      text: "working",
    });
    fire("agent_turn_settled", {
      workerId: WORKER_ID,
      turnId: "turn-2",
      status: "ok",
      durationMs: 100,
    });

    expect(screen.getByRole("button", { name: "Send" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Cancel Turn" })).not.toBeInTheDocument();
  });

  it("FIX-2: an error on the FIRST of two queued turns marks the FIRST bubble failed, never the last", async () => {
    render(<AgentChat workerId={WORKER_ID} />);

    await submit("first");
    await submit("second");

    // turn-1 (correlates to "first", the oldest pending bubble) is the
    // one that errors — "second" is still queued behind it and has
    // produced no events of its own yet.
    fire("agent_turn_delta", {
      workerId: WORKER_ID,
      turnId: "turn-1",
      blockIndex: 0,
      kind: "text",
      text: "working",
    });
    fire("agent_turn_settled", {
      workerId: WORKER_ID,
      turnId: "turn-1",
      status: "error",
      error: "boom",
      durationMs: 100,
    });

    const firstBubble = screen.getByText("first");
    const secondBubble = screen.getByText("second");
    // userBubbleFailedStyle sets a red border; plain userBubbleStyle
    // does not — assert via the actual failed-state color rather than
    // a snapshot, so this fails loudly if the wrong bubble is marked.
    expect(firstBubble).toHaveStyle({ border: "1px solid oklch(0.45 0.18 25)" });
    expect(secondBubble).not.toHaveStyle({ border: "1px solid oklch(0.45 0.18 25)" });
  });
});
