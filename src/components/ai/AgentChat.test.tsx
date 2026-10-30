// AgentChat + the agent_* transcript reducer (#store/agent-sessions, fed
// by #hooks/useAgentSessionEvents): live deltas, tool calls, permission
// reports vs. interactive requests answered over agent_permission_respond,
// settled receipts, queued-turn accounting, and a transcript that
// outlives the component.

import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AgentChat } from "#components/ai/AgentChat";
import { useAgentSessionEvents } from "#hooks/useAgentSessionEvents";
import type { Capabilities, ProviderId } from "#lib/agent-events";
import { agentCancel, agentPermissionRespond, agentSendTurn } from "#lib/tauri";
import { useAgentSessionStore } from "#store/agent-sessions";

type Handler = (e: { seq: number; payload: unknown }) => void;

const registered = new Map<string, Handler>();

vi.mock("#lib/event-bus", () => ({
  onEvent: (type: string, handler: Handler) => {
    registered.set(type, handler);
    return () => registered.delete(type);
  },
}));

vi.mock("#lib/tauri", async (importOriginal) => ({
  ...(await importOriginal<typeof import("#lib/tauri")>()),
  agentSendTurn: vi.fn(),
  agentCancel: vi.fn(),
  agentPermissionRespond: vi.fn(),
}));

const WORKER_ID = "11111111-2222-3333-8444-555555555555";

const CAPABILITIES: Capabilities = {
  partialDeltas: true,
  resume: true,
  nativeCost: true,
  permissionModes: ["default", "dontAsk", "acceptEdits"],
  cancelGranularity: "kill_only",
  interruptMidturn: false,
  worktreeAware: true,
  interactivePermissions: false,
};

/** Each event gets its own, increasing seq — exactly as the bus delivers them. */
let seq = 0;
function fire(type: string, payload: Record<string, unknown>): void {
  act(() => {
    registered.get(type)?.({ seq: ++seq, payload: { workerId: WORKER_ID, ...payload } });
  });
}

function startSession(provider: ProviderId, capabilities: Partial<Capabilities> = {}): void {
  fire("agent_session_started", {
    provider,
    sessionKey: WORKER_ID,
    model: "claude-sonnet-5",
    cwd: "/repo",
    capabilities: { ...CAPABILITIES, ...capabilities },
  });
}

function Harness(): React.ReactElement {
  useAgentSessionEvents();
  return <AgentChat workerId={WORKER_ID} />;
}

/** The session-event subscription alone, mounted apart from any chat. */
function Events(): null {
  useAgentSessionEvents();
  return null;
}

async function submit(text: string): Promise<void> {
  const user = userEvent.setup();
  const input = screen.getByRole("textbox", { name: /^Message / });
  // React resets the form via form.reset(), which user-event's own
  // tracked input value does not observe; clear it explicitly.
  await user.clear(input);
  await user.type(input, text);
  await user.click(screen.getByRole("button", { name: /^(Send|Queue Next Turn|Interrupt)$/ }));
}

beforeEach(() => {
  registered.clear();
  useAgentSessionStore.setState(useAgentSessionStore.getInitialState(), true);
  vi.mocked(agentSendTurn).mockReset().mockResolvedValue(undefined);
  vi.mocked(agentCancel).mockReset().mockResolvedValue(undefined);
  vi.mocked(agentPermissionRespond).mockReset().mockResolvedValue(undefined);
});

describe("AgentChat", () => {
  it("pins the transcript to the newest row with a column-reverse scroller around one in-order column", () => {
    render(<Harness />);

    // jsdom has no layout, so this pins the mechanism: a reversed flex
    // scroller starts (and stays, until the user scrolls up) at its end.
    const log = screen.getByRole("log");
    expect(log).toHaveStyle({
      display: "flex",
      flexDirection: "column-reverse",
      overflowY: "auto",
    });
    // A single child: the reversal moves the scroll anchor, never the message order.
    expect(log.children).toHaveLength(1);
    expect(log.firstElementChild).toHaveStyle({ flexDirection: "column" });
  });

  it("appends agent_turn_delta text live to the same in-progress bubble", () => {
    render(<Harness />);

    fire("agent_turn_delta", { turnId: "t1", blockIndex: 0, kind: "text", text: "Hello " });
    fire("agent_turn_delta", { turnId: "t1", blockIndex: 0, kind: "text", text: "World" });

    expect(screen.getByText("Hello World")).toBeInTheDocument();
  });

  it("drops a settled turn's unfinalized streaming bubble", () => {
    render(<Harness />);

    fire("agent_turn_delta", { turnId: "t1", blockIndex: 0, kind: "text", text: "Half a" });
    fire("agent_turn_settled", {
      turnId: "t1",
      status: "error",
      error: "Cancelled",
      durationMs: 5,
    });

    expect(screen.queryByText("Half a")).not.toBeInTheDocument();
    expect(screen.getByText("Turn Failed: Cancelled · 5ms")).toBeInTheDocument();
  });

  it("renders a tool call as a labeled collapsible block showing name, input, and result", async () => {
    const user = userEvent.setup();
    render(<Harness />);

    fire("agent_tool_call", {
      turnId: "t1",
      toolUseId: "tool-1",
      name: "run_command",
      input: { command: "ls" },
    });
    fire("agent_tool_result", {
      turnId: "t1",
      toolUseId: "tool-1",
      isError: false,
      content: "file.txt",
    });

    await user.click(screen.getByRole("button", { name: "Tool Call: run_command, Complete" }));

    expect(screen.getByText("Input")).toBeInTheDocument();
    expect(screen.getByText(/"command"/)).toBeInTheDocument();
    expect(screen.getByText("file.txt")).toBeInTheDocument();
  });

  it("shows an is_error tool result via the error status", () => {
    render(<Harness />);

    fire("agent_tool_call", { turnId: "t1", toolUseId: "tool-2", name: "write_file", input: {} });
    fire("agent_tool_result", {
      turnId: "t1",
      toolUseId: "tool-2",
      isError: true,
      content: "nope",
    });

    expect(
      screen.getByRole("button", { name: "Tool Call: write_file, Error" }),
    ).toBeInTheDocument();
  });

  it("reports a Claude Code denial with its Title Case subclass and no answer buttons", () => {
    render(<Harness />);
    startSession("claude_code");

    fire("agent_permission_request", {
      turnId: "t1",
      requestId: "req-1",
      tool: "Write",
      input: {},
      suggestedDecision: "deny",
      denialSubclass: "ungranted_write",
      message: "you haven't granted Write yet",
    });

    expect(screen.getByText("Write Not Granted")).toBeInTheDocument();
    expect(screen.getByText("you haven't granted Write yet")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Allow" })).not.toBeInTheDocument();
  });

  it("falls back to a generic label for an unclassified report", () => {
    render(<Harness />);

    fire("agent_permission_request", {
      turnId: "t1",
      requestId: "req-1",
      tool: "Bash",
      input: {},
      suggestedDecision: "deny",
      denialSubclass: null,
      message: null,
    });

    expect(screen.getByText("Permission Denied")).toBeInTheDocument();
  });

  // A request that carries a suggestedDecision is a decision the provider
  // already made (here an unclassified Claude Code denial, known only from
  // result.permission_denials), so even an interactive session shows it as a
  // read-only report with no Allow/Deny to answer.
  it("keeps a denial report read-only in an interactive session", () => {
    render(<Harness />);
    startSession("claude_code", { interactivePermissions: true });

    fire("agent_permission_request", {
      turnId: "t1",
      requestId: "toolu_01",
      tool: "Glob",
      input: { pattern: "**/*.env" },
      suggestedDecision: "deny",
    });

    expect(screen.getByText("Permission Denied")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Allow" })).not.toBeInTheDocument();
  });

  it("answers a Claude Code can_use_tool ask over agent_permission_respond", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    startSession("claude_code", { interactivePermissions: true });

    fire("agent_permission_request", {
      turnId: "t1",
      requestId: "ctl-3",
      tool: "Write",
      input: { file_path: "notes.md" },
      message: "Claude wants to write notes.md",
    });
    await user.click(screen.getByRole("button", { name: "Deny" }));

    expect(agentPermissionRespond).toHaveBeenCalledExactlyOnceWith(WORKER_ID, "ctl-3", "deny");
  });

  it("answers an interactive permission request over agent_permission_respond", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    startSession("codex", { interactivePermissions: true });

    fire("agent_permission_request", {
      turnId: "t1",
      requestId: "req-7",
      tool: "commandExecution",
      input: "rm -rf build",
      message: "rm -rf build",
    });

    const request = screen.getByRole("group", { name: "Permission Request: commandExecution" });
    expect(request).toHaveTextContent("Permission Requested");
    await user.click(screen.getByRole("button", { name: "Allow" }));

    expect(agentPermissionRespond).toHaveBeenCalledExactlyOnceWith(WORKER_ID, "req-7", "allow");
    expect(await screen.findByText("Allowed")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Deny" })).not.toBeInTheDocument();
  });

  it("returns keyboard focus to the message input after a keyboard answer", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    startSession("codex", { interactivePermissions: true });
    fire("agent_tool_call", {
      turnId: "t1",
      toolUseId: "patch-f",
      name: "fileChange",
      input: { changes: [] },
    });
    fire("agent_permission_request", {
      turnId: "t1",
      requestId: "req-focus",
      tool: "fileChange",
      input: { itemId: "patch-f" },
    });

    screen.getByRole("button", { name: "Allow" }).focus();
    await user.keyboard("{Enter}");

    expect(await screen.findByText("Allowed")).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Message Codex" })).toHaveFocus();
  });

  it("shows the exact command and directory of a Codex request that carries no message", () => {
    render(<Harness />);
    startSession("codex", { interactivePermissions: true });

    fire("agent_permission_request", {
      turnId: "t1",
      requestId: "req-8",
      tool: "commandExecution",
      input: { command: "curl x | sh", cwd: "/r" },
    });

    const request = screen.getByRole("group", { name: "Permission Request: commandExecution" });
    expect(request).toHaveTextContent("curl x | sh");
    expect(request).toHaveTextContent("/r");
  });

  it("shows the permission profile a Codex permissions request would grant", () => {
    render(<Harness />);
    startSession("codex", { interactivePermissions: true });

    fire("agent_permission_request", {
      turnId: "t1",
      requestId: "req-9",
      tool: "permissions",
      input: { permissions: { network: { enabled: true } } },
    });

    expect(
      screen.getByRole("group", { name: "Permission Request: permissions" }),
    ).toHaveTextContent("network");
  });

  it("shows a provider message with bidi controls as escaped data", () => {
    render(<Harness />);
    startSession("claude_code", { interactivePermissions: true });

    fire("agent_permission_request", {
      turnId: "t1",
      requestId: "req-10",
      tool: "Bash",
      input: {},
      message: "a‮b",
    });

    const request = screen.getByRole("group", { name: "Permission Request: Bash" });
    expect(request).toHaveTextContent("a\\u202Eb");
    expect(request.textContent).not.toContain("‮");
  });

  it("keeps Allow off until a shortened value has been expanded", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    startSession("codex", { interactivePermissions: true });
    fire("agent_tool_call", {
      turnId: "t1",
      toolUseId: "patch-11",
      name: "fileChange",
      input: { changes: "x".repeat(600) },
    });

    fire("agent_permission_request", {
      turnId: "t1",
      requestId: "req-11",
      tool: "fileChange",
      input: { itemId: "patch-11" },
    });

    expect(screen.getByRole("button", { name: "Allow" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Show All" }));
    expect(screen.getByRole("button", { name: "Allow" })).toBeEnabled();
  });

  it("holds Allow on a Codex fileChange request until its tool call, with the paths, has arrived", () => {
    render(<Harness />);
    startSession("codex", { interactivePermissions: true });
    fire("agent_permission_request", {
      turnId: "t1",
      requestId: "req-patch",
      tool: "fileChange",
      input: { itemId: "patch-1" },
    });

    const request = screen.getByRole("group", { name: "Permission Request: fileChange" });
    expect(request).toHaveTextContent("(not received yet)");
    expect(screen.getByRole("button", { name: "Allow" })).toBeDisabled();

    fire("agent_tool_call", {
      turnId: "t1",
      toolUseId: "patch-1",
      name: "fileChange",
      input: { changes: [{ path: "/work/.git/hooks/pre-commit", kind: "add" }] },
    });

    expect(request).toHaveTextContent("/work/.git/hooks/pre-commit");
    expect(request).not.toHaveTextContent("(not received yet)");
    expect(screen.getByRole("button", { name: "Allow" })).toBeEnabled();
  });

  it("keeps a request answerable when the answer fails, and expires it when its turn settles", async () => {
    vi.mocked(agentPermissionRespond).mockRejectedValueOnce(new Error("stdin closed"));
    const user = userEvent.setup();
    render(<Harness />);
    startSession("codex", { interactivePermissions: true });
    fire("agent_permission_request", {
      turnId: "t1",
      requestId: "r",
      tool: "fileChange",
      input: {},
    });

    await user.click(screen.getByRole("button", { name: "Deny" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Deny" })).not.toHaveAttribute("aria-disabled"),
    );

    fire("agent_turn_settled", { turnId: "t1", status: "ok", durationMs: 1 });
    expect(screen.getByText("Expired Unanswered")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Deny" })).not.toBeInTheDocument();
  });

  it("leaves a request expired when its turn settles while the answer is in flight", async () => {
    const answered = Promise.withResolvers<undefined>();
    vi.mocked(agentPermissionRespond).mockReturnValueOnce(answered.promise);
    const user = userEvent.setup();
    render(<Harness />);
    startSession("codex", { interactivePermissions: true });
    fire("agent_tool_call", {
      turnId: "t1",
      toolUseId: "patch-r",
      name: "fileChange",
      input: { changes: [] },
    });
    fire("agent_permission_request", {
      turnId: "t1",
      requestId: "r",
      tool: "fileChange",
      input: { itemId: "patch-r" },
    });

    await user.click(screen.getByRole("button", { name: "Allow" }));
    fire("agent_turn_settled", { turnId: "t1", status: "ok", durationMs: 1 });
    await act(async () => {
      answered.resolve(undefined);
      await answered.promise;
    });

    expect(screen.getByText("Expired Unanswered")).toBeInTheDocument();
    expect(screen.queryByText("Allowed")).not.toBeInTheDocument();
  });

  it("names the session's own provider in the input", () => {
    render(<Harness />);
    startSession("codex");

    expect(screen.getByRole("textbox", { name: "Message Codex" })).toBeInTheDocument();
    expect(screen.getByRole("log", { name: "Codex Chat" })).toBeInTheDocument();
  });

  it("shows cost, duration, and turn count in the settled receipt", () => {
    render(<Harness />);

    fire("agent_turn_settled", {
      turnId: "t1",
      status: "ok",
      costUsd: 0.1234,
      durationMs: 1500,
      numTurns: 2,
    });

    expect(screen.getByText("Turn Complete · 1.5s · 2 Turns · $0.1234")).toBeInTheDocument();
  });

  it('labels the send button "Queue Next Turn" when the provider cannot interrupt, once busy', async () => {
    render(<Harness />);
    startSession("claude_code");

    await submit("hello");

    expect(screen.getByRole("button", { name: "Queue Next Turn" })).toBeInTheDocument();
    expect(
      screen.getByText(
        "This Provider Has No Mid-Turn Interrupt — Sending Now Queues Behind The Current Turn.",
      ),
    ).toBeInTheDocument();
  });

  it('labels the send button "Interrupt" when the session reports interruptMidturn', async () => {
    render(<Harness />);
    startSession("claude_code", { interruptMidturn: true });

    await submit("hello");

    expect(screen.getByRole("button", { name: "Interrupt" })).toBeInTheDocument();
  });

  it("queues follow-ups instead of blocking, and clears the input after each send", async () => {
    render(<Harness />);

    await submit("first");
    expect(screen.getByRole("textbox", { name: /^Message / })).toHaveValue("");
    await submit("second");

    expect(screen.getByRole("textbox", { name: /^Message / })).toHaveValue("");
    expect(agentSendTurn).toHaveBeenNthCalledWith(1, WORKER_ID, "first");
    expect(agentSendTurn).toHaveBeenNthCalledWith(2, WORKER_ID, "second");
  });

  it("stays busy until every queued turn settles, and Cancel targets the running turn", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await submit("first");
    await submit("second");

    fire("agent_turn_delta", { turnId: "t1", blockIndex: 0, kind: "text", text: "working" });
    await user.click(screen.getByRole("button", { name: "Cancel Turn" }));
    expect(agentCancel).toHaveBeenCalledWith(WORKER_ID, "t1");

    fire("agent_turn_settled", { turnId: "t1", status: "ok", durationMs: 100 });
    expect(screen.getByRole("button", { name: "Queue Next Turn" })).toBeInTheDocument();

    fire("agent_turn_settled", { turnId: "t2", status: "ok", durationMs: 100 });
    expect(screen.getByRole("button", { name: "Send" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Cancel Turn" })).not.toBeInTheDocument();
  });

  it("marks the bubble of the turn that failed — the first of two queued — never the last", async () => {
    render(<Harness />);
    await submit("first");
    await submit("second");

    fire("agent_turn_delta", { turnId: "t1", blockIndex: 0, kind: "text", text: "working" });
    fire("agent_turn_settled", { turnId: "t1", status: "error", error: "boom", durationMs: 100 });

    const failed = { border: "1px solid oklch(0.45 0.18 25)" };
    expect(screen.getByText("first")).toHaveStyle(failed);
    expect(screen.getByText("second")).not.toHaveStyle(failed);
    expect(screen.getAllByText("Not Sent")).toHaveLength(1);
  });

  it("fails the bubble of a send the backend never admitted", async () => {
    vi.mocked(agentSendTurn).mockRejectedValueOnce(new Error("queue full"));
    render(<Harness />);

    await submit("hello");

    await vi.waitFor(() =>
      expect(screen.getByText("hello")).toHaveStyle({ border: "1px solid oklch(0.45 0.18 25)" }),
    );
    expect(screen.getByText("Not Sent")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send" })).toBeInTheDocument();
  });

  it("keeps the transcript when the chat unmounts (tab switch)", () => {
    render(<Events />);
    const chat = render(<AgentChat workerId={WORKER_ID} />);
    fire("agent_block", {
      turnId: "t1",
      blockIndex: 0,
      kind: "text",
      content: { type: "text", text: "Persisted answer" },
    });
    chat.unmount();

    render(<AgentChat workerId={WORKER_ID} />);
    expect(screen.getByText("Persisted answer")).toBeInTheDocument();
  });
});

describe("AgentChat — Trojan Source", () => {
  it("shows a permission request's tool name with a bidi override as escaped data", () => {
    render(<Harness />);
    startSession("claude_code", { interactivePermissions: true });

    fire("agent_permission_request", {
      turnId: "t1",
      requestId: "req-rlo",
      tool: "Ba\u202Esh",
      input: {},
    });

    const request = screen.getByRole("group", { name: String.raw`Permission Request: Ba\u202Esh` });
    expect(request).toHaveTextContent(String.raw`Ba\u202Esh`);
    expect(request.textContent).not.toContain("\u202E");
  });

  it("shows a tool call's name with a bidi override as escaped data", () => {
    render(<Harness />);

    fire("agent_tool_call", { turnId: "t1", toolUseId: "tool-rlo", name: "ru\u202En", input: {} });
    fire("agent_tool_result", {
      turnId: "t1",
      toolUseId: "tool-rlo",
      isError: false,
      content: "ok",
    });

    const call = screen.getByRole("button", { name: String.raw`Tool Call: ru\u202En, Complete` });
    expect(call).toHaveTextContent(String.raw`ru\u202En`);
    expect(call.textContent).not.toContain("\u202E");
  });
});
