// ── useAlerts ───────────────────────────────────────
//
// The hook subscribes to the system store once and reads thresholds and
// settings through an Effect Event. Cooldowns are written to a ref at
// alert time, so two metric ticks that land before a re-render fire a
// given alert once, not as duplicate toasts.

import { act, renderHook } from "@testing-library/react";
import { createStore, Provider } from "jotai";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAlerts } from "#hooks/useAlerts";
import { alertThresholdsAtom, DEFAULT_THRESHOLDS } from "#lib/alerts";
import { sendNotification } from "#lib/tauri";
import { useSystemStore } from "#store/system";
import { appSettingsAtom } from "#store/ui";

/** `true` makes the active transport report no native notifications (the `build:web` page). */
const web = vi.hoisted(() => ({ on: false }));
vi.mock(import("#lib/tauri"), async (importOriginal) => ({
  ...(await importOriginal()),
  hasCapability: () => !web.on,
  sendNotification: vi.fn().mockResolvedValue(undefined),
}));

function tick(cpuPercent: number): void {
  useSystemStore.getState().recordSample(
    {
      cpuPercent,
      memoryMb: 0,
      memoryTotalMb: 0,
      workerCount: 0,
      tokensPerSec: 0,
    },
    Date.now(),
  );
}

function renderAlerts() {
  const store = createStore();
  renderHook(() => useAlerts(), {
    wrapper: ({ children }) => <Provider store={store}>{children}</Provider>,
  });
  return store;
}

describe("useAlerts", () => {
  beforeEach(() => {
    useSystemStore.setState(useSystemStore.getInitialState(), true);
    vi.mocked(toast.error).mockClear();
    vi.mocked(toast.warning).mockClear();
    vi.mocked(sendNotification).mockClear();
    web.on = false;
    vi.stubGlobal("isTauri", true);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("mirrors an alert as a native notification when the setting is on", () => {
    const store = renderAlerts();
    act(() =>
      store.set(appSettingsAtom, { ...store.get(appSettingsAtom), nativeAlertNotifications: true }),
    );
    act(() => tick(95));
    expect(sendNotification).toHaveBeenCalledTimes(1);
  });

  it("still toasts but sends no native notification when the transport has none", () => {
    web.on = true;
    const store = renderAlerts();
    act(() =>
      store.set(appSettingsAtom, { ...store.get(appSettingsAtom), nativeAlertNotifications: true }),
    );
    act(() => tick(95));
    expect(toast.error).toHaveBeenCalledTimes(1);
    expect(sendNotification).not.toHaveBeenCalled();
  });

  it("fires one critical toast for a critical CPU reading", () => {
    renderAlerts();
    act(() => tick(95));
    expect(toast.error).toHaveBeenCalledTimes(1);
    expect(vi.mocked(toast.error).mock.calls[0]?.[0]).toContain("CPU Usage Critically High");
  });

  it("does not fire twice for two ticks that land before any re-render", () => {
    renderAlerts();
    act(() => {
      tick(95);
      tick(96);
    });
    expect(toast.error).toHaveBeenCalledTimes(1);
  });

  it("uses thresholds changed after mount without re-subscribing", () => {
    const store = renderAlerts();
    act(() => tick(60));
    expect(toast.warning).not.toHaveBeenCalled();

    act(() => {
      store.set(alertThresholdsAtom, { ...DEFAULT_THRESHOLDS, cpuWarning: 50 });
    });
    act(() => tick(60));
    expect(toast.warning).toHaveBeenCalledTimes(1);
  });

  it("stays quiet below the thresholds", () => {
    renderAlerts();
    act(() => tick(10));
    expect(toast.error).not.toHaveBeenCalled();
    expect(toast.warning).not.toHaveBeenCalled();
  });
});
