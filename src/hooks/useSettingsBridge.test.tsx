// ── useSettingsBridge — aiConcurrentLimit bridge gating (review fix-2) ──
//
// createTauriStorage's getItem (#store/ui) always returns the DEFAULT
// synchronously; the real persisted value only arrives later,
// asynchronously, via subscribe. Without a guard, the aiConcurrentLimit
// effect fired setAgentConcurrency on that pre-hydration default FIRST —
// silently clobbering a real custom value on disk if the app died (or
// hydration simply hadn't resolved yet) in that window, and feeding a
// spurious down/up resize cycle into the scheduler on every launch (the
// exact transition shape BLOCK-1's scheduler bug cared about). These
// tests pin the fix: the very first render must not call the bridge; a
// later value change (hydration completing, or a live user edit) must.

import { act, cleanup, renderHook } from "@testing-library/react";
import { getDefaultStore } from "jotai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSettingsBridge } from "#hooks/useSettingsBridge";
import { appSettingsAtom, DEFAULT_APP_SETTINGS } from "#store/ui";

const mockSetAgentConcurrency = vi.fn().mockResolvedValue(undefined);

vi.mock("#lib/tauri", () => ({
  isTauri: () => false,
  checkForUpdates: vi.fn().mockResolvedValue({ available: false }),
  setAgentConcurrency: (...args: unknown[]) => mockSetAgentConcurrency(...args),
}));

describe("useSettingsBridge — aiConcurrentLimit bridge gating", () => {
  const store = getDefaultStore();

  beforeEach(() => {
    mockSetAgentConcurrency.mockReset().mockResolvedValue(undefined);
    store.set(appSettingsAtom, DEFAULT_APP_SETTINGS);
  });

  afterEach(() => {
    cleanup();
    store.set(appSettingsAtom, DEFAULT_APP_SETTINGS);
  });

  it("does not call setAgentConcurrency on the first (pre-hydration-default) render", () => {
    renderHook(() => useSettingsBridge());

    expect(mockSetAgentConcurrency).not.toHaveBeenCalled();
  });

  it("calls setAgentConcurrency once the value changes after mount (hydration completing, or a live edit)", () => {
    renderHook(() => useSettingsBridge());
    expect(mockSetAgentConcurrency).not.toHaveBeenCalled();

    act(() => {
      store.set(appSettingsAtom, { ...DEFAULT_APP_SETTINGS, aiConcurrentLimit: 8 });
    });

    expect(mockSetAgentConcurrency).toHaveBeenCalledTimes(1);
    expect(mockSetAgentConcurrency).toHaveBeenCalledWith(8);
  });

  it("still calls setAgentConcurrency on a second real change, not just the first post-mount one", () => {
    renderHook(() => useSettingsBridge());

    act(() => {
      store.set(appSettingsAtom, { ...DEFAULT_APP_SETTINGS, aiConcurrentLimit: 8 });
    });
    act(() => {
      store.set(appSettingsAtom, { ...DEFAULT_APP_SETTINGS, aiConcurrentLimit: 2 });
    });

    expect(mockSetAgentConcurrency).toHaveBeenCalledTimes(2);
    expect(mockSetAgentConcurrency).toHaveBeenNthCalledWith(1, 8);
    expect(mockSetAgentConcurrency).toHaveBeenNthCalledWith(2, 2);
  });

  it("logs a rejected setAgentConcurrency call instead of silently swallowing it", async () => {
    mockSetAgentConcurrency.mockRejectedValueOnce(new Error("out of range"));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    renderHook(() => useSettingsBridge());
    act(() => {
      store.set(appSettingsAtom, { ...DEFAULT_APP_SETTINGS, aiConcurrentLimit: 99 });
    });

    await vi.waitFor(() => expect(consoleError).toHaveBeenCalled());
    consoleError.mockRestore();
  });
});
