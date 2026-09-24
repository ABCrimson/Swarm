// The webview chat engine (#lib/ai-chat) against a scripted streamMessage:
// whole assistant turns replayed verbatim (thinking + signatures), the
// tool loop, stop_reason handling, refusal/cancel/error rollback, queue
// cancellation, mid-turn injections, and model/prefix handling.

import { getDefaultStore } from "jotai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CHAT_MAX_TOKENS,
  cancelChatTurn,
  clearChat,
  injectInstruction,
  isChatTurnRunning,
  sendChatMessage,
} from "#lib/ai-chat";
import {
  AiRefusalError,
  AiRequestError,
  type ChatMessageParam,
  type ChatResponse,
  type StreamDelta,
  type StreamParams,
  streamMessage,
} from "#lib/anthropic";
import { agentTurnStarted } from "#lib/tauri";
import { executeTool, getAllAnthropicTools } from "#lib/tools";
import { useAiStore } from "#store/ai";
import { useMessageHistoryStore } from "#store/message-history";
import { selectedModelAtom } from "#store/ui";
import { useWorkerAgentStore } from "#store/worker-agents";

vi.mock("#lib/anthropic", async (importOriginal) => ({
  ...(await importOriginal<typeof import("#lib/anthropic")>()),
  streamMessage: vi.fn(),
}));
vi.mock("#lib/tools", async (importOriginal) => ({
  ...(await importOriginal<typeof import("#lib/tools")>()),
  executeTool: vi.fn(),
  getAllAnthropicTools: vi.fn(() => []),
}));
vi.mock("#lib/tauri", async (importOriginal) => ({
  ...(await importOriginal<typeof import("#lib/tauri")>()),
  agentTurnStarted: vi.fn(),
}));

// ── Scripted rounds ──────────────────────────────────

interface Round {
  readonly deltas?: readonly StreamDelta[];
  /** Resolves when the round may finish; rejects (like the SDK) on abort. */
  readonly hold?: (signal: AbortSignal | undefined) => Promise<void>;
  readonly result: ChatResponse | Error;
}

const rounds: Round[] = [];
const requests: StreamParams[] = [];

function response(
  content: ChatResponse["content"],
  stopReason: ChatResponse["stop_reason"],
  extra: Partial<ChatResponse> = {},
): ChatResponse {
  return {
    id: `msg_${requests.length}`,
    type: "message",
    role: "assistant",
    model: "claude-opus-5-5",
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 5 },
    ...extra,
  } as ChatResponse;
}

const THINKING = { type: "thinking", thinking: "Plan it.", signature: "sig-abc" } as const;

function text(t: string) {
  return { type: "text", text: t, citations: null } as const;
}

function toolUse(id: string, name: string, input: Record<string, unknown>) {
  return { type: "tool_use", id, name, input } as const;
}

/** An abortable wait the test releases by hand. */
function gate(): { hold: Round["hold"]; release: () => void } {
  const { promise, resolve } = Promise.withResolvers<void>();
  return {
    release: resolve,
    hold: (signal) =>
      new Promise<void>((res, rej) => {
        signal?.addEventListener("abort", () =>
          rej(new AiRequestError("aborted", "Request Cancelled")),
        );
        void promise.then(res);
      }),
  };
}

const W = "worker-1";

async function settle(workerId = W): Promise<void> {
  await vi.waitFor(() => expect(isChatTurnRunning(workerId)).toBe(false));
}

function thread() {
  const t = useMessageHistoryStore.getState().threads.get(W);
  if (!t) throw new Error("no thread");
  return t;
}

beforeEach(() => {
  rounds.length = 0;
  requests.length = 0;
  useMessageHistoryStore.setState(useMessageHistoryStore.getInitialState(), true);
  useAiStore.setState(useAiStore.getInitialState(), true);
  useWorkerAgentStore.setState({ metadata: new Map() });
  getDefaultStore().set(selectedModelAtom, "opus");
  vi.mocked(agentTurnStarted).mockResolvedValue(7);
  vi.mocked(getAllAnthropicTools).mockReturnValue([]);
  vi.mocked(executeTool).mockReset();
  vi.mocked(streamMessage).mockImplementation(async function* (params, signal) {
    requests.push(structuredClone(params));
    const round = rounds.shift();
    if (!round) throw new Error("unexpected request");
    for (const delta of round.deltas ?? []) yield delta;
    await round.hold?.(signal);
    if (Error.isError(round.result)) throw round.result;
    return round.result;
  });
});

afterEach(async () => {
  cancelChatTurn(W);
  await settle();
});

// ── Tests ────────────────────────────────────────────

describe("ai-chat engine", () => {
  it("commits a text reply and keeps the whole assistant turn — thinking and signature included — for replay", async () => {
    rounds.push({
      deltas: [
        { type: "thinking", content: "", thinking: "Plan it." },
        { type: "text", content: "Hello" },
      ],
      result: response([THINKING, text("Hello")], "end_turn"),
    });

    expect(sendChatMessage(W, "  hi  ")).toBe(true);
    await settle();

    const t = thread();
    expect(t.messages.map((m) => [m.role, m.content])).toEqual([
      ["user", "hi"],
      ["assistant", "Hello"],
    ]);
    expect(t.messages[1]?.thinking).toBe("Plan it.");
    expect(t.transcript).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: [THINKING, text("Hello")] },
    ]);
    expect(t.live).toBeNull();
    expect(requests[0]).toMatchObject({
      model: "claude-opus-5-5",
      maxTokens: CHAT_MAX_TOKENS,
      effort: "medium",
      cache: true,
    });
  });

  it("sends the previous turns — full content blocks, not empty strings — on a follow-up", async () => {
    rounds.push({ result: response([THINKING, text("One")], "end_turn") });
    rounds.push({ result: response([text("Two")], "end_turn") });

    sendChatMessage(W, "first");
    await settle();
    sendChatMessage(W, "second");
    await settle();

    expect(requests[1]?.messages).toEqual([
      { role: "user", content: "first" },
      { role: "assistant", content: [THINKING, text("One")] },
      { role: "user", content: "second" },
    ]);
  });

  it("runs the tool loop: replays the tool_use turn verbatim and answers it with tool_result", async () => {
    vi.mocked(executeTool).mockResolvedValue({ success: true, data: { ok: 1 } });
    const round1 = [THINKING, text("Spawning."), toolUse("tu_1", "spawn_worker", { name: "a" })];
    rounds.push({
      deltas: [
        {
          type: "tool_use",
          content: "",
          toolUse: { id: "tu_1", toolName: "spawn_worker", partialInput: "", complete: false },
        },
        {
          type: "tool_use",
          content: "",
          toolUse: {
            id: "tu_1",
            toolName: "spawn_worker",
            partialInput: '{"name":"a"}',
            complete: true,
          },
        },
      ],
      result: response(round1, "tool_use"),
    });
    rounds.push({ result: response([text("Done.")], "end_turn") });

    sendChatMessage(W, "spawn one");
    await settle();

    expect(executeTool).toHaveBeenCalledWith(
      "spawn_worker",
      { name: "a" },
      {
        originWorker: W,
        causeSeq: 7,
      },
    );
    expect(requests[1]?.messages).toEqual([
      { role: "user", content: "spawn one" },
      { role: "assistant", content: round1 },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "tu_1", content: '{"ok":1}', is_error: false },
        ],
      },
    ]);
    const reply = thread().messages.at(-1);
    expect(reply?.toolCalls).toEqual([
      {
        id: "tu_1",
        name: "spawn_worker",
        input: { name: "a" },
        result: '{"ok":1}',
        isError: false,
      },
    ]);
  });

  it("continues a pause_turn without inventing a user message", async () => {
    rounds.push({ result: response([text("Part one.")], "pause_turn") });
    rounds.push({ result: response([text("Part two.")], "end_turn") });

    sendChatMessage(W, "go");
    await settle();

    expect(requests).toHaveLength(2);
    expect(requests[1]?.messages.at(-1)).toEqual({
      role: "assistant",
      content: [text("Part one.")],
    });
  });

  it("flags a reply cut off at max_tokens", async () => {
    rounds.push({ result: response([text("Partial")], "max_tokens") });

    sendChatMessage(W, "long");
    await settle();

    expect(thread().messages.at(-1)?.notice).toEqual({
      tone: "warning",
      text: "Reply Cut Off At The Output Token Limit",
    });
  });

  it("rolls a refused turn out of the replay history and shows the refusal category", async () => {
    const declined = response([text("I can")], "refusal", {
      stop_details: { type: "refusal", category: "cyber", explanation: "Policy." },
    } as Partial<ChatResponse>);
    rounds.push({ result: new AiRefusalError(declined) });

    sendChatMessage(W, "bad");
    await settle();

    expect(thread().transcript).toEqual([]);
    expect(thread().messages.at(-1)?.notice).toEqual({
      tone: "error",
      text: "Request Declined (Cybersecurity): Policy.",
    });
  });

  it("rolls back a failed request and surfaces its Title Case error", async () => {
    rounds.push({
      result: new AiRequestError("auth", "API Key Rejected (401) — Update It In Settings"),
    });

    sendChatMessage(W, "hi");
    await settle();

    expect(thread().transcript).toEqual([]);
    expect(thread().error).toBe("API Key Rejected (401) — Update It In Settings");
  });

  it("cancels a streaming turn and keeps the transcript valid", async () => {
    const g = gate();
    rounds.push({
      deltas: [{ type: "text", content: "Hel" }],
      hold: g.hold,
      result: response([], "end_turn"),
    });

    sendChatMessage(W, "hi");
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    cancelChatTurn(W);
    await settle();

    expect(thread().transcript).toEqual([]);
    expect(thread().messages.at(-1)?.notice).toEqual({ tone: "info", text: "Cancelled" });
    expect(thread().error).toBeNull();
  });

  it("keeps tool calls that already ran when cancelled mid-tools, closing every open tool_use", async () => {
    const { promise: toolDone, resolve: finishTool } = Promise.withResolvers<{
      success: true;
      data: string;
    }>();
    vi.mocked(executeTool).mockReturnValue(toolDone);
    rounds.push({ result: response([toolUse("tu_9", "get_metrics", {})], "tool_use") });

    sendChatMessage(W, "metrics");
    await vi.waitFor(() => expect(executeTool).toHaveBeenCalled());
    cancelChatTurn(W);
    finishTool({ success: true, data: "cpu 3%" });
    await settle();

    const t = thread();
    expect(t.messages.at(-1)?.toolCalls).toEqual([
      { id: "tu_9", name: "get_metrics", input: {}, result: "cpu 3%", isError: false },
    ]);
    expect(t.transcript.at(-1)).toEqual({
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "tu_9",
          content: "Not Run — The Turn Ended Before This Call Executed.",
          is_error: true,
        },
      ],
    });
  });

  it("AIQueue's cancelItem aborts the stream itself, not just the queue entry", async () => {
    const g = gate();
    rounds.push({ hold: g.hold, result: response([text("x")], "end_turn") });

    sendChatMessage(W, "hi");
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    expect(useAiStore.getState().queue[0]?.status).toBe("streaming");
    const signal = vi.mocked(streamMessage).mock.lastCall?.[1];
    useAiStore.getState().cancelItem(useAiStore.getState().queue[0]?.id ?? "");
    await settle();

    expect(signal?.aborted).toBe(true);
    expect(useAiStore.getState().activeStreams).toBe(0);
  });

  it("refuses a second send while a turn is running", async () => {
    const g = gate();
    rounds.push({ hold: g.hold, result: response([text("x")], "end_turn") });

    expect(sendChatMessage(W, "one")).toBe(true);
    expect(sendChatMessage(W, "two")).toBe(false);
    expect(sendChatMessage("other", "   ")).toBe(false);
    g.release();
    await settle();
  });

  it("delivers a mid-turn injection exactly once, with the next tool results, as a system message", async () => {
    const { promise: toolDone, resolve: finishTool } = Promise.withResolvers<{
      success: true;
      data: string;
    }>();
    vi.mocked(executeTool).mockReturnValue(toolDone);
    rounds.push({ result: response([toolUse("tu_1", "get_metrics", {})], "tool_use") });
    rounds.push({ result: response([text("Noted.")], "end_turn") });

    sendChatMessage(W, "go");
    await vi.waitFor(() => expect(executeTool).toHaveBeenCalled());
    expect(injectInstruction(W, "Be brief")).toBe("queued");
    finishTool({ success: true, data: "ok" });
    await settle();

    expect(requests[1]?.messages.at(-1)).toEqual({ role: "system", content: "Be brief" });
    expect(requests).toHaveLength(2);
    expect(thread().injections).toEqual([]);
  });

  it("folds an injection into user text for models without mid-conversation system messages", async () => {
    getDefaultStore().set(selectedModelAtom, "sonnet");
    vi.mocked(executeTool).mockResolvedValue({ success: true, data: "ok" });
    const g = gate();
    rounds.push({
      hold: g.hold,
      result: response([toolUse("tu_1", "get_metrics", {})], "tool_use"),
    });
    rounds.push({ result: response([text("Noted.")], "end_turn") });

    sendChatMessage(W, "go");
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    injectInstruction(W, "Be brief");
    g.release();
    await settle();

    const last = requests[1]?.messages.at(-1) as ChatMessageParam;
    expect(last.role).toBe("user");
    expect(last.content).toContainEqual({ type: "text", text: "Be brief" });
    expect(requests[1]?.model).toBe("claude-sonnet-5");
  });

  it("sends an injection straight away when no turn is running", async () => {
    rounds.push({ result: response([text("Ok.")], "end_turn") });

    expect(injectInstruction(W, "Status?")).toBe("sent");
    await settle();

    expect(requests[0]?.messages).toEqual([{ role: "user", content: "Status?" }]);
  });

  it("uses the worker's template-pinned model and system prompt", async () => {
    useWorkerAgentStore
      .getState()
      .setAgentMetadata(W, { model: "haiku", systemPrompt: "Be terse." });
    rounds.push({ result: response([text("Ok.")], "end_turn") });

    sendChatMessage(W, "hi");
    await settle();

    expect(requests[0]).toMatchObject({ model: "claude-haiku-4-5", system: "Be terse." });
  });

  it("strips thinking blocks from history once the system prompt changes", async () => {
    rounds.push({ result: response([THINKING, text("One")], "end_turn") });
    rounds.push({ result: response([text("Two")], "end_turn") });

    sendChatMessage(W, "first");
    await settle();
    useWorkerAgentStore.getState().setAgentMetadata(W, { systemPrompt: "New rules." });
    sendChatMessage(W, "second");
    await settle();

    expect(requests[1]?.messages[1]).toEqual({ role: "assistant", content: [text("One")] });
  });

  it("clearChat forgets an idle conversation", async () => {
    rounds.push({ result: response([text("Background reply")], "end_turn") });
    sendChatMessage(W, "hi");
    await settle();
    expect(clearChat(W)).toBe(true);
    expect(useMessageHistoryStore.getState().threads.has(W)).toBe(false);
  });
});
