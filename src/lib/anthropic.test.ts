// streamMessage against the REAL @anthropic-ai/sdk — only `fetch` is
// stubbed, with canned SSE responses — so authentication, request
// wiring, stream accumulation and error mapping are all exercised the
// way they run in the app.

import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import type { ChatResponse, StreamDelta, StreamParams } from "#lib/anthropic";
import {
  AiRefusalError,
  AiRequestError,
  replayableContent,
  streamMessage,
  toolUseBlocks,
  withoutThinking,
  zodToTool,
} from "#lib/anthropic";
import { CLAUDE_MODELS } from "#lib/models";
import { useAiStore } from "#store/ai";

vi.mock("#lib/tauri", () => ({ readConfig: vi.fn() }));

import * as z from "zod";
import { readConfig } from "#lib/tauri";

const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>();

/** A distinct key per test forces a fresh SDK client, which captures the current `fetch` stub. */
let keySeq = 0;
function useFreshKey(): string {
  const key = `sk-ant-test-${++keySeq}`;
  vi.mocked(readConfig).mockResolvedValue(key);
  return key;
}

/** Serializes events as a `text/event-stream` response body. */
function sse(events: readonly Record<string, unknown>[]): Response {
  const body = events
    .map((event) => `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`)
    .join("");
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function jsonError(status: number, type: string, message: string): Response {
  return new Response(JSON.stringify({ type: "error", error: { type, message } }), {
    status,
    headers: {
      "content-type": "application/json",
      "request-id": "req_test",
      "x-should-retry": "false",
    },
  });
}

const USAGE = {
  input_tokens: 10,
  output_tokens: 5,
  cache_creation_input_tokens: null,
  cache_read_input_tokens: null,
};

function messageStart(model: string): Record<string, unknown> {
  return {
    type: "message_start",
    message: {
      id: "msg_1",
      type: "message",
      role: "assistant",
      model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      stop_details: null,
      usage: USAGE,
    },
  };
}

function messageEnd(
  stopReason: string,
  stopDetails: Record<string, unknown> | null = null,
): Record<string, unknown>[] {
  return [
    {
      type: "message_delta",
      delta: { stop_reason: stopReason, stop_sequence: null, stop_details: stopDetails },
      usage: { output_tokens: 5 },
    },
    { type: "message_stop" },
  ];
}

function textResponse(model: string, text: string): Response {
  return sse([
    messageStart(model),
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
    { type: "content_block_stop", index: 0 },
    ...messageEnd("end_turn"),
  ]);
}

/** Drives the generator to completion, returning its deltas and final message. */
async function run(
  params: StreamParams,
  signal?: AbortSignal,
): Promise<{ deltas: StreamDelta[]; final: ChatResponse }> {
  const gen = streamMessage(params, signal);
  const deltas: StreamDelta[] = [];
  for (;;) {
    const step = await gen.next();
    if (step.done) return { deltas, final: step.value };
    deltas.push(step.value);
  }
}

function sentBody(call = 0): Record<string, unknown> {
  const init = fetchMock.mock.calls[call]?.[1];
  return JSON.parse(String(init?.body)) as Record<string, unknown>;
}

function sentHeaders(call = 0): Headers {
  return new Headers(fetchMock.mock.calls[call]?.[1]?.headers);
}

const SONNET: StreamParams = {
  model: CLAUDE_MODELS.sonnet.id,
  maxTokens: 64_000,
  messages: [{ role: "user", content: "Hello" }],
};

describe("streamMessage", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    useAiStore.setState(useAiStore.getInitialState(), true);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe("authentication", () => {
    it("sends the configured API key as x-api-key on the request itself", async () => {
      const key = useFreshKey();
      fetchMock.mockResolvedValue(textResponse(CLAUDE_MODELS.sonnet.id, "Hi"));

      await run(SONNET);

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(sentHeaders().get("x-api-key")).toBe(key);
    });

    it("re-reads the key before every request, so a key changed in Settings applies immediately", async () => {
      const first = useFreshKey();
      fetchMock.mockImplementation(async () => textResponse(CLAUDE_MODELS.sonnet.id, "Hi"));
      await run(SONNET);
      const second = useFreshKey();
      await run(SONNET);

      expect(sentHeaders(0).get("x-api-key")).toBe(first);
      expect(sentHeaders(1).get("x-api-key")).toBe(second);
    });

    it("throws missing_key without any HTTP request when no key is configured", async () => {
      vi.mocked(readConfig).mockResolvedValue(null);

      await expect(run(SONNET)).rejects.toMatchObject({
        name: "AiRequestError",
        kind: "missing_key",
        message: "API Key Not Configured — Add It In Settings",
      });
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe("request body", () => {
    it("sends adaptive summarized thinking and effort, and never sampling parameters", async () => {
      useFreshKey();
      fetchMock.mockResolvedValue(textResponse(CLAUDE_MODELS.sonnet.id, "Hi"));

      await run({ ...SONNET, effort: "low", system: "Be terse.", cache: true });

      const body = sentBody();
      expect(body).toMatchObject({
        model: "claude-sonnet-5-5",
        max_tokens: 64_000,
        stream: true,
        system: "Be terse.",
        thinking: { type: "adaptive", display: "summarized" },
        output_config: { effort: "low" },
        cache_control: { type: "ephemeral" },
      });
      for (const sampling of ["temperature", "top_p", "top_k"]) {
        expect(body).not.toHaveProperty(sampling);
      }
      // Sonnet 5.5 has classifiers: it opts into server-side refusal fallbacks.
      expect(body).toMatchObject({ fallbacks: "default" });
      expect(sentHeaders().get("anthropic-beta")).toBe("server-side-fallback-2026-07-01");
    });

    it("sends thinking and effort for Haiku 5.5, clamps max_tokens to its 128K output limit and sends no fallbacks", async () => {
      useFreshKey();
      fetchMock.mockResolvedValue(textResponse(CLAUDE_MODELS.haiku.id, "Hi"));

      await run({ ...SONNET, model: CLAUDE_MODELS.haiku.id, maxTokens: 200_000, effort: "high" });

      const body = sentBody();
      expect(body.max_tokens).toBe(128_000);
      expect(body).toMatchObject({
        thinking: { type: "adaptive", display: "summarized" },
        output_config: { effort: "high" },
      });
      // Haiku 5.5 has no server-side fallback: `"default"` would leave a refusal standing.
      expect(body).not.toHaveProperty("fallbacks");
      expect(sentHeaders().get("anthropic-beta")).toBeNull();
    });

    it("drops thinking, effort and fallbacks for a model outside the catalog and keeps the caller's max_tokens", async () => {
      useFreshKey();
      fetchMock.mockResolvedValue(textResponse("claude-future-9", "Hi"));

      await run({ ...SONNET, model: "claude-future-9", maxTokens: 300_000, effort: "high" });

      const body = sentBody();
      expect(body.max_tokens).toBe(300_000);
      expect(body).not.toHaveProperty("thinking");
      expect(body).not.toHaveProperty("output_config");
      expect(body).not.toHaveProperty("fallbacks");
    });

    it("opts Opus 5.5 into server-side refusal fallbacks", async () => {
      useFreshKey();
      fetchMock.mockResolvedValue(textResponse(CLAUDE_MODELS.opus.id, "Hi"));

      await run({ ...SONNET, model: CLAUDE_MODELS.opus.id });

      expect(sentBody().fallbacks).toBe("default");
      expect(sentHeaders().get("anthropic-beta")).toContain("server-side-fallback-2026-07-01");
    });

    it("retries once without the fallback opt-in when the API rejects it, then stops sending it", async () => {
      useFreshKey();
      fetchMock
        .mockResolvedValueOnce(
          jsonError(400, "invalid_request_error", "fallbacks: not supported for this model"),
        )
        .mockImplementation(async () => textResponse(CLAUDE_MODELS.fable.id, "Hi"));

      const { final } = await run({ ...SONNET, model: CLAUDE_MODELS.fable.id });
      await run({ ...SONNET, model: CLAUDE_MODELS.fable.id });

      expect(final.content).toMatchObject([{ type: "text", text: "Hi" }]);
      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect(sentBody(0).fallbacks).toBe("default");
      expect(sentBody(1)).not.toHaveProperty("fallbacks");
      expect(sentBody(2)).not.toHaveProperty("fallbacks");
    });

    it("keeps the fallback opt-in after an unrelated 400 that the retry also gets", async () => {
      useFreshKey();
      const tooLong = () =>
        jsonError(400, "invalid_request_error", "prompt is too long: 300000 tokens > 200000");
      fetchMock
        .mockResolvedValueOnce(tooLong())
        .mockResolvedValueOnce(tooLong())
        .mockImplementation(async () => textResponse(CLAUDE_MODELS.mythos.id, "Hi"));
      const mythos = { ...SONNET, model: CLAUDE_MODELS.mythos.id };

      await expect(run(mythos)).rejects.toBeInstanceOf(AiRequestError);
      await run(mythos);

      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect(sentBody(0).fallbacks).toBe("default");
      expect(sentBody(1)).not.toHaveProperty("fallbacks");
      // The next request still opts in: the opt-in was never the problem.
      expect(sentBody(2).fallbacks).toBe("default");
    });

    it("marks every tool for eager input streaming", async () => {
      useFreshKey();
      fetchMock.mockResolvedValue(textResponse(CLAUDE_MODELS.sonnet.id, "Hi"));
      const tool = zodToTool("echo", "Echo text.", z.object({ text: z.string() }));

      await run({ ...SONNET, tools: [tool] });

      expect(sentBody().tools).toEqual([{ ...tool, eager_input_streaming: true }]);
    });
  });

  describe("streaming and the final message", () => {
    it("yields text and summarized thinking, and returns the full turn with signatures intact", async () => {
      useFreshKey();
      fetchMock.mockResolvedValue(
        sse([
          messageStart(CLAUDE_MODELS.sonnet.id),
          {
            type: "content_block_start",
            index: 0,
            content_block: { type: "thinking", thinking: "", signature: "" },
          },
          {
            type: "content_block_delta",
            index: 0,
            delta: { type: "thinking_delta", thinking: "Considering." },
          },
          {
            type: "content_block_delta",
            index: 0,
            delta: { type: "signature_delta", signature: "sig-abc" },
          },
          { type: "content_block_stop", index: 0 },
          { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
          { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Done." } },
          { type: "content_block_stop", index: 1 },
          ...messageEnd("end_turn"),
        ]),
      );

      const { deltas, final } = await run(SONNET);

      expect(deltas).toEqual([
        { type: "thinking", content: "", thinking: "Considering." },
        { type: "text", content: "Done." },
      ]);
      expect(final.stop_reason).toBe("end_turn");
      expect(final.content).toEqual([
        { type: "thinking", thinking: "Considering.", signature: "sig-abc" },
        { type: "text", text: "Done." },
      ]);
      expect(replayableContent(final)).toEqual(final.content);
    });

    it("streams tool_use input and returns the parsed block in model order", async () => {
      useFreshKey();
      fetchMock.mockResolvedValue(
        sse([
          messageStart(CLAUDE_MODELS.sonnet.id),
          {
            type: "content_block_start",
            index: 0,
            content_block: { type: "tool_use", id: "toolu_1", name: "echo", input: {} },
          },
          {
            type: "content_block_delta",
            index: 0,
            delta: { type: "input_json_delta", partial_json: '{"text":' },
          },
          {
            type: "content_block_delta",
            index: 0,
            delta: { type: "input_json_delta", partial_json: '"hi"}' },
          },
          { type: "content_block_stop", index: 0 },
          ...messageEnd("tool_use"),
        ]),
      );

      const { deltas, final } = await run(SONNET);

      expect(deltas.map((d) => d.toolUse)).toEqual([
        { id: "toolu_1", toolName: "echo", partialInput: "", complete: false },
        { id: "toolu_1", toolName: "echo", partialInput: '{"text":', complete: false },
        { id: "toolu_1", toolName: "echo", partialInput: '{"text":"hi"}', complete: false },
        { id: "toolu_1", toolName: "echo", partialInput: '{"text":"hi"}', complete: true },
      ]);
      expect(final.stop_reason).toBe("tool_use");
      expect(toolUseBlocks(final)).toEqual([
        { type: "tool_use", id: "toolu_1", name: "echo", input: { text: "hi" } },
      ]);
    });

    it("leaves max_tokens to the caller rather than treating it as an error", async () => {
      useFreshKey();
      fetchMock.mockResolvedValue(
        sse([
          messageStart(CLAUDE_MODELS.sonnet.id),
          { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
          { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Part" } },
          { type: "content_block_stop", index: 0 },
          ...messageEnd("max_tokens"),
        ]),
      );

      const { final } = await run(SONNET);

      expect(final.stop_reason).toBe("max_tokens");
    });

    it("records token usage and catalog-priced cost in the AI store", async () => {
      useFreshKey();
      fetchMock.mockResolvedValue(textResponse(CLAUDE_MODELS.sonnet.id, "Hi"));

      await run(SONNET);

      const usage = useAiStore.getState().cumulativeUsage;
      expect(usage.totalInputTokens).toBe(10);
      expect(usage.totalOutputTokens).toBe(5);
      // Sonnet 5.5 at $2/$10 per MTok.
      expect(usage.totalCostUsd).toBeCloseTo((10 * 2 + 5 * 10) / 1_000_000, 12);
    });
  });

  describe("per-attempt pricing", () => {
    it("prices a fallback attempt by the model that served it", async () => {
      useFreshKey();
      const attempt = (type: string, model: string, reads: number) => ({
        type,
        model,
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: reads,
      });
      fetchMock.mockResolvedValue(
        sse([
          messageStart(CLAUDE_MODELS.sonnet.id),
          { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
          { type: "content_block_stop", index: 0 },
          {
            type: "message_delta",
            delta: { stop_reason: "end_turn", stop_sequence: null, stop_details: null },
            usage: {
              output_tokens: 0,
              iterations: [
                attempt("message", CLAUDE_MODELS.sonnet.id, 1_000_000),
                attempt("fallback_message", "claude-sonnet-5", 1_000_000),
              ],
            },
          },
          { type: "message_stop" },
        ]),
      );

      await run(SONNET);

      // $0.10 per MTok of Sonnet 5.5 cache reads + $0.20 on the Sonnet 5 fallback.
      expect(useAiStore.getState().cumulativeUsage.totalCostUsd).toBeCloseTo(0.3, 10);
    });
  });

  describe("per-attempt pricing of Fable 5.1 fallbacks", () => {
    it("prices a Fable run rescued by Opus 5 at the Fable rate plus the Opus 5 rate", async () => {
      useFreshKey();
      const attempt = (type: string, model: string) => ({
        type,
        model,
        input_tokens: 1_000_000,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      });
      fetchMock.mockResolvedValue(
        sse([
          messageStart(CLAUDE_MODELS.fable.id),
          { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
          { type: "content_block_stop", index: 0 },
          {
            type: "message_delta",
            delta: { stop_reason: "end_turn", stop_sequence: null, stop_details: null },
            usage: {
              output_tokens: 0,
              iterations: [
                attempt("message", CLAUDE_MODELS.fable.id),
                attempt("fallback_message", "claude-opus-5"),
              ],
            },
          },
          { type: "message_stop" },
        ]),
      );

      await run({ ...SONNET, model: CLAUDE_MODELS.fable.id });

      // $10 per MTok of Fable 5.1 input + $5 per MTok of Opus 5 input.
      expect(useAiStore.getState().cumulativeUsage.totalCostUsd).toBeCloseTo(15, 10);
    });
  });

  describe("refusals", () => {
    it("throws AiRefusalError carrying stop_details when the model declines", async () => {
      useFreshKey();
      fetchMock.mockResolvedValue(
        sse([
          messageStart(CLAUDE_MODELS.sonnet.id),
          ...messageEnd("refusal", {
            type: "refusal",
            category: "cyber",
            explanation: "Exploit development.",
          }),
        ]),
      );

      const error = await run(SONNET).catch((err: unknown) => err);

      expect(error).toBeInstanceOf(AiRefusalError);
      expect(error).toMatchObject({
        kind: "refusal",
        message: "Request Declined (Cybersecurity)",
        category: "cyber",
        explanation: "Exploit development.",
      });
    });

    it("keeps only the declined partial's text before a fallback marker when replaying", async () => {
      useFreshKey();
      fetchMock.mockResolvedValue(
        sse([
          messageStart(CLAUDE_MODELS.opus.id),
          {
            type: "content_block_start",
            index: 0,
            content_block: { type: "thinking", thinking: "", signature: "" },
          },
          { type: "content_block_stop", index: 0 },
          { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
          { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Sure, " } },
          { type: "content_block_stop", index: 1 },
          {
            type: "content_block_start",
            index: 2,
            content_block: { type: "tool_use", id: "toolu_declined", name: "echo", input: {} },
          },
          { type: "content_block_stop", index: 2 },
          {
            type: "content_block_start",
            index: 3,
            content_block: {
              type: "fallback",
              from: { model: CLAUDE_MODELS.opus.id },
              to: { model: "claude-opus-5" },
              trigger: { type: "refusal", category: "bio" },
            },
          },
          { type: "content_block_stop", index: 3 },
          { type: "content_block_start", index: 4, content_block: { type: "text", text: "" } },
          { type: "content_block_delta", index: 4, delta: { type: "text_delta", text: "here." } },
          { type: "content_block_stop", index: 4 },
          ...messageEnd("end_turn"),
        ]),
      );

      const { deltas, final } = await run({ ...SONNET, model: CLAUDE_MODELS.opus.id });

      expect(deltas).toContainEqual({
        type: "fallback",
        content: "",
        from: CLAUDE_MODELS.opus.id,
        to: "claude-opus-5",
      });
      expect(replayableContent(final)).toEqual([
        { type: "text", text: "Sure, " },
        { type: "text", text: "here." },
      ]);
      expect(toolUseBlocks(final)).toEqual([]);
    });
  });

  describe("errors", () => {
    it.each([
      [401, "authentication_error", "auth", "API Key Rejected (401) — Update It In Settings"],
      [
        403,
        "permission_error",
        "permission",
        "Permission Denied (403) — This API Key Cannot Use This Model",
      ],
      [404, "not_found_error", "not_found", "Model Not Found (404) — Pick Another Model"],
      [429, "rate_limit_error", "rate_limit", "Rate Limited (429) — Retry Shortly"],
      [529, "overloaded_error", "overloaded", "Anthropic API Overloaded — Try Again Shortly"],
      [500, "api_error", "server", "Anthropic API Error (500) — Try Again Shortly"],
      [400, "invalid_request_error", "bad_request", "Request Rejected (400): prompt is too long"],
    ])("maps HTTP %i to the typed %s error", async (status, type, kind, message) => {
      useFreshKey();
      fetchMock.mockResolvedValue(jsonError(status, type, "prompt is too long"));

      // Haiku 5.5 sends no fallbacks opt-in, so a 400 is surfaced as-is rather than retried.
      const error = await run({ ...SONNET, model: CLAUDE_MODELS.haiku.id }).catch(
        (err: unknown) => err,
      );

      expect(error).toBeInstanceOf(AiRequestError);
      expect(error).toMatchObject({ kind, message, requestId: "req_test" });
      expect((error as Error).cause).toBeInstanceOf(Error);
    });

    it("maps a network failure to a retryable connection error", async () => {
      useFreshKey();
      fetchMock.mockRejectedValue(new TypeError("fetch failed"));

      const error = await run({ ...SONNET }).catch((err: unknown) => err);

      expect(error).toMatchObject({ kind: "connection", retryable: true });
    }, 30_000);

    it("reports a caller abort as aborted", async () => {
      useFreshKey();
      const controller = new AbortController();
      controller.abort();

      await expect(run(SONNET, controller.signal)).rejects.toMatchObject({ kind: "aborted" });
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });
});

describe("withoutThinking", () => {
  it("strips thinking and redacted thinking blocks and keeps everything else in order", () => {
    expect(
      withoutThinking([
        { type: "thinking", thinking: "x", signature: "s" },
        { type: "text", text: "a" },
        { type: "redacted_thinking", data: "d" },
        { type: "tool_use", id: "t", name: "n", input: {} },
      ]),
    ).toEqual([
      { type: "text", text: "a" },
      { type: "tool_use", id: "t", name: "n", input: {} },
    ]);
    expect(withoutThinking("plain")).toBe("plain");
  });
});

describe("zodToTool", () => {
  it("emits an object input schema without the $schema dialect marker", () => {
    const tool = zodToTool("echo", "Echo text.", z.object({ text: z.string() }));

    expect(tool).toEqual({
      name: "echo",
      description: "Echo text.",
      input_schema: {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
        additionalProperties: false,
      },
    });
  });

  it("offers no sampling parameters on StreamParams", () => {
    expectTypeOf<StreamParams>().not.toHaveProperty("temperature");
    expectTypeOf<StreamParams>().not.toHaveProperty("top_p");
    expectTypeOf<StreamParams>().not.toHaveProperty("top_k");
  });
});
