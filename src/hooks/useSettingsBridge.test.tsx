// ── useSettingsBridge — agent concurrency push ──────
//
// The backend persists its own agent concurrency cap and restores it at
// startup, so the bridge pushes only a change made during this launch:
// never the value it mounts with (which would be a redundant disk write
// and a scheduler down/up resize on every launch), not even under
// StrictMode's extra effect run.

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

describe("useSettingsBridge — agent concurrency push", () => {
  const store = getDefaultStore();

  beforeEach(() => {
    mockSetAgentConcurrency.mockReset().mockResolvedValue(undefined);
    store.set(appSettingsAtom, DEFAULT_APP_SETTINGS);
  });

  afterEach(() => {
    cleanup();
    store.set(appSettingsAtom, DEFAULT_APP_SETTINGS);
  });

  it("does not push the value it mounts with", () => {
    renderHook(() => useSettingsBridge());

    expect(mockSetAgentConcurrency).not.toHaveBeenCalled();
  });

  it("does not push on mount under StrictMode's double effect run either", () => {
    store.set(appSettingsAtom, { ...DEFAULT_APP_SETTINGS, aiConcurrentLimit: 7 });
    renderHook(() => useSettingsBridge(), { reactStrictMode: true });

    expect(mockSetAgentConcurrency).not.toHaveBeenCalled();
  });

  it("pushes a change made after mount", () => {
    renderHook(() => useSettingsBridge(), { reactStrictMode: true });

    act(() => {
      store.set(appSettingsAtom, { ...DEFAULT_APP_SETTINGS, aiConcurrentLimit: 8 });
    });

    expect(mockSetAgentConcurrency.mock.calls).toStrictEqual([[8]]);
  });

  it("pushes every later change, including a change back to the mount value", () => {
    renderHook(() => useSettingsBridge());

    act(() => {
      store.set(appSettingsAtom, { ...DEFAULT_APP_SETTINGS, aiConcurrentLimit: 8 });
    });
    act(() => {
      store.set(appSettingsAtom, DEFAULT_APP_SETTINGS);
    });

    expect(mockSetAgentConcurrency.mock.calls).toStrictEqual([
      [8],
      [DEFAULT_APP_SETTINGS.aiConcurrentLimit],
    ]);
  });

  it("logs a rejected push instead of silently swallowing it", async () => {
    const failure = new Error("out of range");
    mockSetAgentConcurrency.mockRejectedValueOnce(failure);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    renderHook(() => useSettingsBridge());
    act(() => {
      store.set(appSettingsAtom, { ...DEFAULT_APP_SETTINGS, aiConcurrentLimit: 9 });
    });

    await vi.waitFor(() =>
      expect(consoleError).toHaveBeenCalledWith(
        "useSettingsBridge: setAgentConcurrency failed",
        failure,
      ),
    );
    consoleError.mockRestore();
  });
});
