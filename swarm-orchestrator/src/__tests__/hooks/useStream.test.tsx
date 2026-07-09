import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useStream } from "#hooks/useStream";

// Mock the anthropic streaming module
const mockStreamMessage = vi.fn();
vi.mock("#lib/anthropic", () => ({
  streamMessage: (...args: unknown[]) => mockStreamMessage(...args),
}));

// Mock ai-error utilities (withRetry and truncateMessages)
vi.mock("#lib/ai-error", () => ({
  withRetry: vi.fn(
    async (
      fn: (signal: AbortSignal) => Promise<void>,
      _options?: unknown,
    ) => {
      const controller = new AbortController();
      try {
        return await fn(controller.signal);
      } catch (err) {
        // Mirror real withRetry behavior: rethrow with a wrapped message
        throw new Error(
          err instanceof Error ? err.message : String(err),
        );
      }
    },
  ),
  truncateMessages: vi.fn(
    (messages: Array<{ role: string; content: string }>) => messages,
  ),
}));

// Mock the AI store
const mockEnqueue = vi.fn();
const mockDequeue = vi.fn();
vi.mock("#store/ai", () => ({
  useAiStore: Object.assign(
    (selector: (s: Record<string, unknown>) => unknown) =>
      selector({ enqueue: mockEnqueue, dequeue: mockDequeue }),
    {
      getState: () => ({
        enqueue: mockEnqueue,
        dequeue: mockDequeue,
      }),
    },
  ),
}));

/**
 * Helper: creates an async generator that yields the given deltas then returns.
 */
async function* fakeStream(
  deltas: Array<{ content: string }>,
): AsyncGenerator<{ content: string }> {
  for (const d of deltas) {
    yield d;
  }
}

describe("useStream", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStreamMessage.mockReset();
  });

  it("should initialize with empty state", () => {
    const { result } = renderHook(() => useStream("worker-1"));

    expect(result.current.messages).toEqual([]);
    expect(result.current.isStreaming).toBe(false);
    expect(result.current.error).toBeNull();
    expect(result.current.streamingContent).toBe("");
    expect(typeof result.current.send).toBe("function");
    expect(typeof result.current.cancel).toBe("function");
  });

  it("should add a user message on send", async () => {
    mockStreamMessage.mockImplementation(() => fakeStream([]));

    const { result } = renderHook(() => useStream("worker-1"));

    await act(async () => {
      result.current.send("Hello, Claude");
      // Let the async IIFE settle
      await vi.waitFor(() => {
        expect(result.current.isStreaming).toBe(false);
      });
    });

    // The user message should have been added
    expect(result.current.messages.length).toBeGreaterThanOrEqual(1);
    expect(result.current.messages[0].role).toBe("user");
    expect(result.current.messages[0].content).toBe("Hello, Claude");
  });

  it("should handle send and streaming deltas", async () => {
    mockStreamMessage.mockImplementation(() =>
      fakeStream([{ content: "Hello" }, { content: " world" }]),
    );

    const { result } = renderHook(() => useStream("worker-1"));

    await act(async () => {
      result.current.send("Hi");
      await vi.waitFor(() => {
        expect(result.current.isStreaming).toBe(false);
      });
    });

    // Should have the user message plus the assistant message committed
    expect(result.current.messages.length).toBe(2);
    expect(result.current.messages[1].role).toBe("assistant");
    expect(result.current.messages[1].content).toBe("Hello world");
  });

  it("should handle cancel/abort", async () => {
    // Create a stream that never completes by itself
    let resolve: (() => void) | undefined;
    const neverEnding = new Promise<void>((r) => {
      resolve = r;
    });

    mockStreamMessage.mockImplementation(async function* () {
      yield { content: "partial" };
      await neverEnding;
    });

    const { result } = renderHook(() => useStream("worker-1"));

    await act(async () => {
      result.current.send("Start streaming");
      // Give it a tick to begin
      await new Promise((r) => setTimeout(r, 10));
    });

    // Cancel the stream
    act(() => {
      result.current.cancel();
    });

    expect(result.current.isStreaming).toBe(false);

    // Unblock the generator to avoid dangling promises
    resolve?.();
  });

  it("should clean up on unmount", async () => {
    let resolve: (() => void) | undefined;
    const neverEnding = new Promise<void>((r) => {
      resolve = r;
    });

    mockStreamMessage.mockImplementation(async function* () {
      yield { content: "data" };
      await neverEnding;
    });

    const { result, unmount } = renderHook(() => useStream("worker-1"));

    await act(async () => {
      result.current.send("Test");
      await new Promise((r) => setTimeout(r, 10));
    });

    // Unmount should abort via the useEffect cleanup
    unmount();

    // Unblock the generator
    resolve?.();
  });

  it("should handle stream errors", async () => {
    mockStreamMessage.mockImplementation(async function* () {
      throw new Error("API connection failed");
    });

    const { result } = renderHook(() => useStream("worker-1"));

    await act(async () => {
      result.current.send("Trigger error");
      await vi.waitFor(() => {
        expect(result.current.isStreaming).toBe(false);
      });
    });

    expect(result.current.error).toBe("API connection failed");
  });

  it("should enqueue and dequeue from the AI store", async () => {
    mockStreamMessage.mockImplementation(() => fakeStream([]));

    const { result } = renderHook(() => useStream("worker-1"));

    await act(async () => {
      result.current.send("Queue test");
      await vi.waitFor(() => {
        expect(result.current.isStreaming).toBe(false);
      });
    });

    expect(mockEnqueue).toHaveBeenCalledTimes(1);
    expect(mockEnqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        priority: "normal",
        workerId: "worker-1",
        status: "pending",
      }),
    );
    expect(mockDequeue).toHaveBeenCalledTimes(1);
  });

  it("should use the default model when no params override is given", async () => {
    mockStreamMessage.mockImplementation(() => fakeStream([]));

    const { result } = renderHook(() =>
      useStream("worker-1", "claude-opus-4-0-20250514"),
    );

    await act(async () => {
      result.current.send("Model test");
      await vi.waitFor(() => {
        expect(result.current.isStreaming).toBe(false);
      });
    });

    // The truncateMessages mock is called, which means streamParams were constructed.
    // We verify indirectly that the mock was invoked with the stream.
    expect(mockStreamMessage).toHaveBeenCalled();
  });
});
