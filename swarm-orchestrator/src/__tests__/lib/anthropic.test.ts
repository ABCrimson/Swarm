import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StreamParams } from "#lib/anthropic";
import { resetClient, streamMessage } from "#lib/anthropic";

// ── Mock the Anthropic SDK ───────────────────────────
// `mockAnthropicStream` backs `client.messages.stream()`. Tests configure
// its return value per-case with a fake async-iterable of SSE-shaped
// events, matching the SDK's `RawMessageStreamEvent` union. Naming starts
// with "mock" so Vitest's vi.mock hoisting allows referencing it inside the
// factory below — same convention as useAiStream.test.tsx / useStream.test.tsx.
const mockAnthropicStream = vi.fn();

vi.mock("@anthropic-ai/sdk", () => {
  class MockAnthropicClient {
    messages = { stream: mockAnthropicStream };
  }
  return { default: MockAnthropicClient };
});

// The mocked SDK constructor above never invokes the `apiKey` callback
// (no real HTTP call happens), so #lib/tauri's readConfig is never called
// in these tests. Stub it anyway for isolation from the global
// @tauri-apps/api/core mock in setup.ts.
vi.mock("#lib/tauri", () => ({
  readConfig: vi.fn().mockResolvedValue("test-api-key"),
}));

/** Wraps a fixed array of fake SSE events as an async-iterable stream. */
async function* fakeAnthropicStream(events: unknown[]): AsyncGenerator<unknown> {
  for (const event of events) {
    yield event;
  }
}

/** Drains an async generator into an array of its yielded values. */
async function drain<T>(gen: AsyncGenerator<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const value of gen) {
    out.push(value);
  }
  return out;
}

const BASIC_PARAMS: StreamParams = {
  model: "claude-opus-4-8",
  maxTokens: 1024,
  messages: [{ role: "user", content: "Hello" }],
};

describe("streamMessage — refusal stop_reason handling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAnthropicStream.mockReset();
    resetClient();
  });

  it("throws the exact refusal message when message_delta carries stop_reason: refusal", async () => {
    mockAnthropicStream.mockReturnValue(
      fakeAnthropicStream([
        {
          type: "message_delta",
          delta: {
            stop_reason: "refusal",
            stop_sequence: null,
            container: null,
            stop_details: null,
          },
          usage: {},
        },
      ]),
    );

    await expect(drain(streamMessage(BASIC_PARAMS))).rejects.toThrow(
      "Request Declined By Safety Classifiers",
    );
  });

  it("does not throw for non-refusal stop reasons (end_turn)", async () => {
    mockAnthropicStream.mockReturnValue(
      fakeAnthropicStream([
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "All good" },
        },
        {
          type: "message_delta",
          delta: {
            stop_reason: "end_turn",
            stop_sequence: null,
            container: null,
            stop_details: null,
          },
          usage: {},
        },
      ]),
    );

    const deltas = await drain(streamMessage(BASIC_PARAMS));
    expect(deltas.map((d) => d.content)).toEqual(["All good", ""]);
  });

  it("does not yield a completed result when partial text precedes a refusal", async () => {
    mockAnthropicStream.mockReturnValue(
      fakeAnthropicStream([
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "Partial answer before the block " },
        },
        {
          type: "message_delta",
          delta: {
            stop_reason: "refusal",
            stop_sequence: null,
            container: null,
            stop_details: null,
          },
          usage: {},
        },
      ]),
    );

    const gen = streamMessage(BASIC_PARAMS);
    const yielded: string[] = [];

    await expect(
      (async () => {
        for await (const delta of gen) {
          yielded.push(delta.content);
        }
      })(),
    ).rejects.toThrow("Request Declined By Safety Classifiers");

    // The partial text streamed before the refusal was yielded (so a live
    // UI could have rendered it)...
    expect(yielded).toEqual(["Partial answer before the block "]);
    // ...but the generator never reaches a normal, completed exit — the
    // consumer's `for await` loop is broken by the thrown error, so no
    // caller can treat the partial text as a valid final reply.
    // (Equivalent assertion: draining the same events end-to-end rejects,
    // it never resolves.)
  });

  it("propagates the refusal from the generator so callers cannot swallow it silently", async () => {
    mockAnthropicStream.mockReturnValue(
      fakeAnthropicStream([
        {
          type: "message_delta",
          delta: {
            stop_reason: "refusal",
            stop_sequence: null,
            container: null,
            stop_details: null,
          },
          usage: {},
        },
      ]),
    );

    const gen = streamMessage(BASIC_PARAMS);
    let threw = false;
    let message = "";
    try {
      for await (const _delta of gen) {
        // no-op — draining only for the throw
      }
    } catch (err) {
      threw = true;
      message = err instanceof Error ? err.message : String(err);
    }

    expect(threw).toBe(true);
    expect(message).toBe("Request Declined By Safety Classifiers");
  });
});

describe("streamMessage — temperature is never forwarded", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAnthropicStream.mockReset();
    resetClient();
  });

  it("request body has no temperature field for a normal call", async () => {
    mockAnthropicStream.mockReturnValue(fakeAnthropicStream([]));

    await drain(streamMessage(BASIC_PARAMS));

    expect(mockAnthropicStream).toHaveBeenCalledTimes(1);
    const [requestBody] = mockAnthropicStream.mock.calls[0] as [Record<string, unknown>];
    expect(requestBody).not.toHaveProperty("temperature");
  });

  it("request body has no temperature field even when a caller still supplies one", async () => {
    mockAnthropicStream.mockReturnValue(fakeAnthropicStream([]));

    // StreamParams no longer declares `temperature` — simulate a stale
    // caller (untyped JS, or a future regression) supplying it anyway via
    // an unsafe cast, and assert it is still never placed in the request
    // body. Mirrors the Rust side's `build_request_body` invariant:
    // temperature is never sent, for any model, no matter what the caller
    // passes in.
    const paramsWithTemperature = {
      ...BASIC_PARAMS,
      temperature: 0.9,
    } as StreamParams & { temperature: number };

    await drain(streamMessage(paramsWithTemperature));

    expect(mockAnthropicStream).toHaveBeenCalledTimes(1);
    const [requestBody] = mockAnthropicStream.mock.calls[0] as [Record<string, unknown>];
    expect(requestBody).not.toHaveProperty("temperature");
  });

  it("StreamParams no longer declares a temperature field (type-level regression guard)", () => {
    // @ts-expect-error — `temperature` must not exist on StreamParams. If
    // this stops erroring (field re-added), `pnpm typecheck` fails on the
    // now-unused `@ts-expect-error` directive, catching the regression.
    const _params: StreamParams = { ...BASIC_PARAMS, temperature: 0.5 };
    expect(true).toBe(true);
  });
});
