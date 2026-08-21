// ── AIChat cancel-during-agentTurnStarted-await (provenance review fix) ──
//
// agent_turn_started's round-trip (webview → Rust → writer thread → back)
// happens BEFORE the first streaming round starts, and before any
// streaming content exists — which means the visible Cancel button
// (rendered only once streamingContent/liveToolCalls are non-empty) isn't
// reachable yet. The realistic way a turn gets cancelled during that
// window is unmount (e.g. the user navigates away): the cleanup effect
// flips TurnToken.cancelled, and doSend must re-check that flag
// immediately after the await settles — otherwise a cancelled turn falls
// through into startStream and burns a full round of tokens for a
// response nobody will see.

import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AIChat } from "#components/ai/AIChat";

const startStreamMock = vi.fn();
const cancelStreamMock = vi.fn();

vi.mock("#hooks/useAiStream", () => ({
  useAiStream: () => ({
    startStream: (...args: unknown[]) => startStreamMock(...args),
    cancelStream: (...args: unknown[]) => cancelStreamMock(...args),
    atLimit: false,
  }),
}));

// Partial mock: only override agentTurnStarted, keep every other real
// export (isTauri, invoke, spawnWorker, ...) so #lib/tools/#lib/worker-spawn
// — imported transitively by AIChat.tsx — keep working exactly as they do
// outside a Tauri webview (isTauri() -> false, invoke() -> no-op).
vi.mock("#lib/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("#lib/tauri")>();
  return {
    ...actual,
    agentTurnStarted: vi.fn(),
  };
});

import { agentTurnStarted } from "#lib/tauri";

// jsdom does not implement scrollIntoView — AIChat's auto-scroll effect
// calls it on every render.
Element.prototype.scrollIntoView = vi.fn();

function submitMessage(text: string): void {
  const textarea = screen.getByPlaceholderText(/Type A Message/i);
  fireEvent.change(textarea, { target: { value: text } });
  const form = textarea.closest("form");
  if (!form) throw new Error("chat form not found");
  fireEvent.submit(form);
}

describe("AIChat — cancel during the agentTurnStarted await", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    startStreamMock.mockReset();
    cancelStreamMock.mockReset();
    vi.mocked(agentTurnStarted).mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("never calls startStream when the component unmounts (cancelling the turn) while agentTurnStarted is still pending", async () => {
    let resolveAgentTurnStarted: (seq: number) => void = () => {};
    vi.mocked(agentTurnStarted).mockImplementation(
      () =>
        new Promise<number>((resolve) => {
          resolveAgentTurnStarted = resolve;
        }),
    );
    startStreamMock.mockResolvedValue("");

    const { unmount } = render(<AIChat workerId="worker-1" />);

    await act(async () => {
      submitMessage("hello");
    });

    // agentTurnStarted has been called and its promise is still pending —
    // doSend is parked at `await agentTurnStarted(...)`.
    expect(agentTurnStarted).toHaveBeenCalledTimes(1);
    expect(startStreamMock).not.toHaveBeenCalled();

    // Unmount while the round-trip is in flight — the cleanup effect
    // flips TurnToken.cancelled = true.
    unmount();

    // Now let the pending agentTurnStarted promise resolve and flush
    // every pending microtask.
    await act(async () => {
      resolveAgentTurnStarted(42);
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(startStreamMock).not.toHaveBeenCalled();
  });

  it("DOES call startStream when the turn is NOT cancelled during the agentTurnStarted await (control case)", async () => {
    let resolveAgentTurnStarted: (seq: number) => void = () => {};
    vi.mocked(agentTurnStarted).mockImplementation(
      () =>
        new Promise<number>((resolve) => {
          resolveAgentTurnStarted = resolve;
        }),
    );
    startStreamMock.mockResolvedValue("");

    render(<AIChat workerId="worker-1" />);

    await act(async () => {
      submitMessage("hello");
    });

    expect(agentTurnStarted).toHaveBeenCalledTimes(1);
    expect(startStreamMock).not.toHaveBeenCalled();

    // No cancellation this time — resolve normally and confirm the loop
    // proceeds into startStream, proving the guard above is specific to
    // the cancelled case, not a blanket regression that always skips it.
    await act(async () => {
      resolveAgentTurnStarted(42);
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(startStreamMock).toHaveBeenCalledTimes(1);
  });
});
