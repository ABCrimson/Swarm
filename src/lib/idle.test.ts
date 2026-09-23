import { afterEach, describe, expect, it, vi } from "vitest";
import { onIdle } from "#lib/idle";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("onIdle", () => {
  it("schedules through requestIdleCallback when the webview has it", () => {
    const requestIdleCallback = vi.fn((_cb: IdleRequestCallback) => 7);
    const cancelIdleCallback = vi.fn();
    vi.stubGlobal("requestIdleCallback", requestIdleCallback);
    vi.stubGlobal("cancelIdleCallback", cancelIdleCallback);
    const callback = vi.fn();

    const cancel = onIdle(callback);
    expect(requestIdleCallback).toHaveBeenCalledOnce();

    requestIdleCallback.mock.calls[0]?.[0]({ didTimeout: false, timeRemaining: () => 10 });
    expect(callback).toHaveBeenCalledOnce();

    cancel();
    expect(cancelIdleCallback).toHaveBeenCalledWith(7);
  });

  // WKWebView / WebKitGTK: calling the missing global used to throw a
  // ReferenceError from App's mount effect and take down the root boundary.
  it("falls back to a macrotask when requestIdleCallback is missing (WebKit)", () => {
    vi.useFakeTimers();
    vi.stubGlobal("requestIdleCallback", undefined);
    const callback = vi.fn();

    expect(() => onIdle(callback)).not.toThrow();
    expect(callback).not.toHaveBeenCalled();

    vi.runAllTimers();
    expect(callback).toHaveBeenCalledOnce();
  });

  it("cancels the fallback timer", () => {
    vi.useFakeTimers();
    vi.stubGlobal("requestIdleCallback", undefined);
    const callback = vi.fn();

    onIdle(callback)();
    vi.runAllTimers();

    expect(callback).not.toHaveBeenCalled();
  });
});
