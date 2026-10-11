// AIChat renders a worker's thread from #store/message-history while the
// turn runs in #lib/ai-chat — so the conversation, and a turn still in
// flight, survive the component unmounting (a tab switch).

import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { getDefaultStore } from "jotai";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AIChat } from "#components/ai/AIChat";
import { cancelChatTurn, isChatTurnRunning } from "#lib/ai-chat";
import { type ChatResponse, streamMessage } from "#lib/anthropic";
import { agentTurnStarted } from "#lib/tauri";
import { executeTool, resetToolApprovals } from "#lib/tools";
import { useAiStore } from "#store/ai";
import { useMessageHistoryStore } from "#store/message-history";
import { selectedModelAtom } from "#store/ui";

vi.mock("#lib/anthropic", async (importOriginal) => ({
  ...(await importOriginal<typeof import("#lib/anthropic")>()),
  streamMessage: vi.fn(),
}));
vi.mock("#lib/tauri", async (importOriginal) => ({
  ...(await importOriginal<typeof import("#lib/tauri")>()),
  agentTurnStarted: vi.fn(),
}));

const W = "worker-1";

function reply(text: string): ChatResponse {
  return {
    id: "msg_1",
    type: "message",
    role: "assistant",
    model: "claude-opus-5-5",
    content: [{ type: "text", text, citations: null }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  } as ChatResponse;
}

/** Streams `text`, then waits for `release` before finishing. */
function scriptReply(text: string) {
  const { promise, resolve } = Promise.withResolvers<void>();
  vi.mocked(streamMessage).mockImplementationOnce(async function* (_params, signal) {
    yield { type: "text", content: text };
    await new Promise<void>((res, rej) => {
      signal?.addEventListener("abort", () => rej(signal.reason));
      void promise.then(res);
    });
    return reply(text);
  });
  return resolve;
}

async function send(text: string): Promise<void> {
  const user = userEvent.setup();
  await user.type(screen.getByRole("textbox", { name: /^Message Claude/ }), text);
  await user.keyboard("{Enter}");
}

beforeEach(() => {
  cancelChatTurn(W);
  useMessageHistoryStore.setState(useMessageHistoryStore.getInitialState(), true);
  useAiStore.setState(useAiStore.getInitialState(), true);
  getDefaultStore().set(selectedModelAtom, "opus");
  vi.mocked(agentTurnStarted).mockResolvedValue(1);
  vi.mocked(streamMessage).mockReset();
});

afterEach(() => {
  resetToolApprovals();
});

describe("AIChat", () => {
  it("keeps the transcript and the running turn across an unmount (tab switch)", async () => {
    const release = scriptReply("Hello there");
    const { unmount } = render(<AIChat workerId={W} />);

    await send("hi");
    const log = screen.getByRole("log", { name: /^AI Chat With Claude/ });
    await within(log).findByText("Hello there");

    unmount();
    expect(isChatTurnRunning(W)).toBe(true);
    await act(async () => release());
    await vi.waitFor(() => expect(isChatTurnRunning(W)).toBe(false));

    render(<AIChat workerId={W} />);
    const remounted = screen.getByRole("log");
    expect(within(remounted).getByText("hi")).toBeInTheDocument();
    expect(within(remounted).getByText("Hello there")).toBeInTheDocument();
  });

  it("renders exactly one assistant bubble per reply under StrictMode", async () => {
    const release = scriptReply("Only once");
    render(
      <StrictMode>
        <AIChat workerId={W} />
      </StrictMode>,
    );

    await send("hi");
    await act(async () => release());
    await vi.waitFor(() => expect(isChatTurnRunning(W)).toBe(false));

    expect(screen.getAllByText("Only once")).toHaveLength(1);
    expect(useMessageHistoryStore.getState().getMessages(W)).toHaveLength(2);
  });

  it("keeps keyboard focus on the button when Send becomes Stop", async () => {
    scriptReply("Streaming…");
    const user = userEvent.setup();
    render(<AIChat workerId={W} />);

    await user.type(screen.getByRole("textbox", { name: /Message/ }), "hi");
    screen.getByRole("button", { name: "Send" }).focus();
    await user.keyboard("{Enter}");

    const stop = await screen.findByRole("button", { name: "Stop" });
    expect(stop).toHaveFocus();
    await user.click(stop);
    await vi.waitFor(() => expect(isChatTurnRunning(W)).toBe(false));
  });

  it("Stop cancels the running turn and clears the input on send", async () => {
    scriptReply("Streaming…");
    render(<AIChat workerId={W} />);

    await send("hi");
    expect(screen.getByRole("textbox", { name: /Message/ })).toHaveValue("");
    await userEvent.setup().click(await screen.findByRole("button", { name: "Stop" }));
    await vi.waitFor(() => expect(isChatTurnRunning(W)).toBe(false));

    expect(await screen.findByText("Cancelled")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
  });

  it("announces a failed request as an alert", async () => {
    vi.mocked(streamMessage).mockImplementationOnce(async function* () {
      yield* [];
      throw new Error("boom");
    });
    render(<AIChat workerId={W} />);

    await send("hi");

    expect(await screen.findByRole("alert")).toHaveTextContent("boom");
  });

  it("New Chat forgets the conversation", async () => {
    const release = scriptReply("Answer");
    render(<AIChat workerId={W} />);
    await send("hi");
    await act(async () => release());
    await vi.waitFor(() => expect(isChatTurnRunning(W)).toBe(false));

    await userEvent.setup().click(screen.getByRole("button", { name: "New Chat" }));

    expect(screen.queryByText("Answer")).not.toBeInTheDocument();
    expect(screen.getByText("Send A Message To Start Chatting")).toBeInTheDocument();
  });

  it("returns focus to the message box after a tool approval is answered from the keyboard", async () => {
    const user = userEvent.setup();
    render(<AIChat workerId={W} />);
    const call = executeTool(
      "read_file",
      { path: "/home/u/a.txt" },
      { originWorker: W, causeSeq: 1 },
    );

    (await screen.findByRole("button", { name: "Deny" })).focus();
    await user.keyboard("{Enter}");

    expect((await call).success).toBe(false);
    expect(screen.getByRole("textbox", { name: /^Message Claude/ })).toHaveFocus();
  });
});
