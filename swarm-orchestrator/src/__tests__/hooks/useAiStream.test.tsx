import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAiStream } from "#hooks/useAiStream";
import { useAiStore } from "#store/ai";

// Mock the anthropic streaming module
const mockStreamMessage = vi.fn();
vi.mock("#lib/anthropic", () => ({
  streamMessage: (...args: unknown[]) => mockStreamMessage(...args),
}));

/**
 * Helper: creates an async generator yielding the given deltas.
 */
async function* fakeStream(
  deltas: Array<{ content: string; toolUse?: unknown }>,
): AsyncGenerator<{ content: string; toolUse?: unknown }> {
  for (const d of deltas) {
    yield d;
  }
}

/** Resets the AI store to defaults between tests. */
function resetAiStore(): void {
  act(() => {
    const state = useAiStore.getState();
    state.setActiveStreams(0);
    state.setConcurrentLimit(3);
    // Drain any leftover queue items
    for (const item of state.queue) {
      state.dequeue(item.id);
    }
  });
}

const STREAM_PARAMS = {
  model: "claude-sonnet-4-20250514",
  maxTokens: 1024,
  messages: [{ role: "user" as const, content: "Hello" }],
};

describe("useAiStream", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStreamMessage.mockReset();
    resetAiStore();
  });

  it("should initialize with idle state", () => {
    const { result } = renderHook(() => useAiStream());

    expect(typeof result.current.startStream).toBe("function");
    expect(typeof result.current.cancelStream).toBe("function");
    expect(result.current.atLimit).toBe(false);
  });

  it("should start streaming and return accumulated content", async () => {
    mockStreamMessage.mockImplementation(() =>
      fakeStream([{ content: "Hello" }, { content: " from" }, { content: " Claude" }]),
    );

    // Enqueue an item so updateItemStatus has something to operate on
    act(() => {
      useAiStore.getState().enqueue({
        id: "item-1",
        priority: "normal",
        workerId: "worker-1",
        messages: [],
        status: "pending",
      });
    });

    const { result } = renderHook(() => useAiStream());

    let content = "";
    await act(async () => {
      content = await result.current.startStream("item-1", STREAM_PARAMS);
    });

    expect(content).toBe("Hello from Claude");

    // The item status should have been updated to "streaming" then "complete"
    const item = useAiStore.getState().queue.find((q) => q.id === "item-1");
    expect(item?.status).toBe("complete");
  });

  it("should increment and decrement active streams", async () => {
    mockStreamMessage.mockImplementation(() => fakeStream([{ content: "data" }]));

    act(() => {
      useAiStore.getState().enqueue({
        id: "item-2",
        priority: "normal",
        workerId: "worker-1",
        messages: [],
        status: "pending",
      });
    });

    const { result } = renderHook(() => useAiStream());

    await act(async () => {
      await result.current.startStream("item-2", STREAM_PARAMS);
    });

    // After completion, active streams should be back to 0
    expect(useAiStore.getState().activeStreams).toBe(0);
  });

  it("should cancel active stream", async () => {
    // Create a stream that hangs until cancelled
    let resolve: (() => void) | undefined;
    const blocker = new Promise<void>((r) => {
      resolve = r;
    });

    mockStreamMessage.mockImplementation(async function* () {
      yield { content: "partial" };
      await blocker;
    });

    act(() => {
      useAiStore.getState().enqueue({
        id: "item-3",
        priority: "normal",
        workerId: "worker-1",
        messages: [],
        status: "pending",
      });
    });

    const { result } = renderHook(() => useAiStream());

    // Start the stream but don't await it (it will block)
    let streamPromise: Promise<string> | undefined;
    act(() => {
      streamPromise = result.current.startStream("item-3", STREAM_PARAMS);
    });

    // Give it a tick to start
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });

    // Cancel the stream
    act(() => {
      result.current.cancelStream("item-3");
    });

    // Unblock the generator
    resolve?.();

    // Wait for the promise to settle (it will throw due to abort but that's expected)
    try {
      await streamPromise;
    } catch {
      // Expected — the stream was aborted
    }

    // Active streams should be back to 0
    expect(useAiStore.getState().activeStreams).toBe(0);
  });

  it("should handle errors gracefully", async () => {
    mockStreamMessage.mockImplementation(async function* () {
      // Immediately-thrown async generator, matching the real streamMessage
      // signature. The `for await` consumer never receives a yielded value
      // since throwing happens on the first `.next()` call.
      if (Date.now() < 0) yield undefined as never;
      throw new Error("Network failure");
    });

    act(() => {
      useAiStore.getState().enqueue({
        id: "item-4",
        priority: "normal",
        workerId: "worker-1",
        messages: [],
        status: "pending",
      });
    });

    const { result } = renderHook(() => useAiStream());

    await expect(
      act(async () => {
        await result.current.startStream("item-4", STREAM_PARAMS);
      }),
    ).rejects.toThrow("Network failure");

    // Item status should be "error"
    const item = useAiStore.getState().queue.find((q) => q.id === "item-4");
    expect(item?.status).toBe("error");

    // Active streams should be decremented back to 0
    expect(useAiStore.getState().activeStreams).toBe(0);
  });

  it("should clean up on unmount", async () => {
    let resolve: (() => void) | undefined;
    const blocker = new Promise<void>((r) => {
      resolve = r;
    });

    mockStreamMessage.mockImplementation(async function* () {
      yield { content: "data" };
      await blocker;
    });

    act(() => {
      useAiStore.getState().enqueue({
        id: "item-5",
        priority: "normal",
        workerId: "worker-1",
        messages: [],
        status: "pending",
      });
    });

    const { result, unmount } = renderHook(() => useAiStream());

    // Start a stream without awaiting
    act(() => {
      result.current.startStream("item-5", STREAM_PARAMS);
    });

    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });

    // Unmount should abort all active streams via the useEffect cleanup
    unmount();

    // Unblock the generator
    resolve?.();
  });

  it("should skip tool_use deltas for text accumulation", async () => {
    mockStreamMessage.mockImplementation(() =>
      fakeStream([
        { content: "Before tool. " },
        {
          content: "",
          toolUse: {
            toolName: "read_file",
            partialInput: '{"path": "/test"}',
            complete: true,
          },
        },
        { content: "After tool." },
      ]),
    );

    act(() => {
      useAiStore.getState().enqueue({
        id: "item-6",
        priority: "normal",
        workerId: "worker-1",
        messages: [],
        status: "pending",
      });
    });

    const { result } = renderHook(() => useAiStream());

    const deltas: unknown[] = [];
    let content = "";
    await act(async () => {
      content = await result.current.startStream("item-6", STREAM_PARAMS, (delta) =>
        deltas.push(delta),
      );
    });

    // Text content should exclude the tool_use delta's empty content
    expect(content).toBe("Before tool. After tool.");

    // onDelta callback should have been invoked for all 3 deltas
    expect(deltas).toHaveLength(3);
  });

  it("should enforce concurrent stream limit", async () => {
    // Set limit to 1
    act(() => {
      useAiStore.getState().setConcurrentLimit(1);
      useAiStore.getState().setActiveStreams(1);
    });

    const { result } = renderHook(() => useAiStream());

    // atLimit should be true
    expect(result.current.atLimit).toBe(true);

    // Attempting to start should throw
    await expect(
      act(async () => {
        await result.current.startStream("item-7", STREAM_PARAMS);
      }),
    ).rejects.toThrow("Concurrent Stream Limit Reached");
  });
});
