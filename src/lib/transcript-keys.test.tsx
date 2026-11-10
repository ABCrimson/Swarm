import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { onTranscriptKeyDown } from "#lib/transcript-keys";

function renderLog(): { log: HTMLElement; scrollTo: ReturnType<typeof vi.fn> } {
  render(
    // biome-ignore lint/a11y/noNoninteractiveTabindex: mirrors the transcript scroller, which must be keyboard-focusable.
    <div role="log" tabIndex={0} onKeyDown={onTranscriptKeyDown} />,
  );
  const log = screen.getByRole("log");
  Object.defineProperty(log, "scrollHeight", { value: 4000, configurable: true });
  const scrollTo = vi.fn();
  log.scrollTo = scrollTo as unknown as typeof log.scrollTo;
  return { log, scrollTo };
}

describe("onTranscriptKeyDown", () => {
  it("jumps Home to the oldest row and End to the newest in one press", () => {
    const { log, scrollTo } = renderLog();
    expect(fireEvent.keyDown(log, { key: "Home" })).toBe(false);
    expect(scrollTo).toHaveBeenLastCalledWith({ top: -4000, behavior: "instant" });
    expect(fireEvent.keyDown(log, { key: "End" })).toBe(false);
    expect(scrollTo).toHaveBeenLastCalledWith({ top: 0, behavior: "instant" });
  });

  it("leaves modified and other keys to the browser", () => {
    const { log, scrollTo } = renderLog();
    expect(fireEvent.keyDown(log, { key: "Home", shiftKey: true })).toBe(true);
    expect(fireEvent.keyDown(log, { key: "End", altKey: true })).toBe(true);
    expect(fireEvent.keyDown(log, { key: "End", metaKey: true })).toBe(true);
    expect(fireEvent.keyDown(log, { key: "PageUp" })).toBe(true);
    expect(scrollTo).not.toHaveBeenCalled();
  });
});
