import { useEffect, useRef } from "react";
import type { StreamDelta, StreamParams } from "#lib/anthropic";
import { streamMessage } from "#lib/anthropic";
import { useAiStore } from "#store/ai";

/** Callback invoked for each streaming delta, including tool_use deltas. */
export type OnStreamDelta = (delta: StreamDelta) => void;

interface UseAiStreamReturn {
  /** Start streaming for a given queue item, with optional per-delta callback. */
  readonly startStream: (
    itemId: string,
    params: StreamParams,
    onDelta?: OnStreamDelta,
  ) => Promise<string>;
  /** Cancel an active stream. */
  readonly cancelStream: (itemId: string) => void;
  /** Whether the concurrent limit has been reached. */
  readonly atLimit: boolean;
}

/**
 * Hook wrapping the Anthropic streaming API with queue management.
 *
 * Connects to `useAiStore` for:
 * - Tracking active stream count against the concurrent limit
 * - Updating queue item status through the streaming lifecycle
 *
 * Supports an optional `onDelta` callback for handling structured
 * tool_use deltas alongside regular text deltas.
 *
 * Each stream is tracked with an AbortController for cleanup.
 */
export function useAiStream(): UseAiStreamReturn {
  const activeStreams = useAiStore((s) => s.activeStreams);
  const concurrentLimit = useAiStore((s) => s.concurrentLimit);
  const updateItemStatus = useAiStore((s) => s.updateItemStatus);
  const setActiveStreams = useAiStore((s) => s.setActiveStreams);

  const abortControllers = useRef(new Map<string, AbortController>());

  const atLimit = activeStreams >= concurrentLimit;

  const startStream = async (itemId: string, params: StreamParams, onDelta?: OnStreamDelta): Promise<string> => {
    if (useAiStore.getState().activeStreams >= useAiStore.getState().concurrentLimit) {
      throw new Error("Concurrent stream limit reached");
    }

    const controller = new AbortController();
    abortControllers.current.set(itemId, controller);

    // Increment active streams (functional updater via getState to avoid read-then-write race)
    useAiStore.setState((state) => ({ activeStreams: state.activeStreams + 1 }));
    updateItemStatus(itemId, "streaming");

    let fullContent = "";

    try {
      for await (const delta of streamMessage(params, controller.signal)) {
        // Check for abort
        if (controller.signal.aborted) {
          break;
        }

        // Forward delta to callback (includes tool_use deltas)
        onDelta?.(delta);

        // Accumulate text content (skip tool_use deltas for text output)
        if (!delta.toolUse) {
          fullContent += delta.content;
        }
      }

      if (!controller.signal.aborted) {
        updateItemStatus(itemId, "complete");
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        updateItemStatus(itemId, "error");
      }
      throw error;
    } finally {
      abortControllers.current.delete(itemId);
      useAiStore.setState((state) => ({ activeStreams: Math.max(0, state.activeStreams - 1) }));
    }

    return fullContent;
  };

  const cancelStream = (itemId: string) => {
    const controller = abortControllers.current.get(itemId);
    if (controller) {
      controller.abort();
      abortControllers.current.delete(itemId);
      updateItemStatus(itemId, "error");
      useAiStore.setState((state) => ({ activeStreams: Math.max(0, state.activeStreams - 1) }));
    }
  };

  // Abort all active streams on unmount to prevent dangling state
  useEffect(() => {
    return () => {
      for (const [, controller] of abortControllers.current) {
        controller.abort();
      }
      abortControllers.current.clear();
    };
  }, []);

  return { startStream, cancelStream, atLimit };
}
