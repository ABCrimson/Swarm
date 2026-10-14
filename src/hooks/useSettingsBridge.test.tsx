// ── useSettingsBridge — agent concurrency push ──────
//
// The backend persists its own agent concurrency cap and restores it at
// startup, so the bridge pushes only a change made during this launch:
// never the value it mounts with (which would be a redundant disk write
// and a scheduler down/up resize on every launch), not even under
// StrictMode's extra effect run.

import { act, cleanup, renderHook } from "@testing-library/react";
import { getDefaultStore } from "jotai";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AGENT_CONCURRENCY_ACK_TIMEOUT_MS, useSettingsBridge } from "#hooks/useSettingsBridge";
import { checkForUpdates } from "#lib/tauri";
import { agentConcurrencySyncAtom, appSettingsAtom, DEFAULT_APP_SETTINGS } from "#store/ui";

const mockSetAgentConcurrency = vi.fn().mockResolvedValue(undefined);
const mockReadConfig = vi.fn().mockResolvedValue(null);
const mockHasTransport = vi.fn(() => false);
const mockHasCapability = vi.fn(() => true);
const mockIsTauri = vi.fn(() => false);

vi.mock("#lib/tauri", () => ({
  isTauri: () => mockIsTauri(),
  hasTransport: () => mockHasTransport(),
  hasCapability: () => mockHasCapability(),
  readConfig: (...args: unknown[]) => mockReadConfig(...args),
  checkForUpdates: vi.fn().mockResolvedValue({ available: false }),
  setAgentConcurrency: (...args: unknown[]) => mockSetAgentConcurrency(...args),
}));

// The shared sonner mock (src/test/setup.ts) has no `dismiss`, which the
// bridge uses to clear a stale failure toast.
vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), {
    error: vi.fn(),
    success: vi.fn(),
    warning: vi.fn(),
    info: vi.fn(),
    dismiss: vi.fn(),
  }),
  Toaster: () => null,
}));

const store = getDefaultStore();
const DEFAULT_LIMIT = DEFAULT_APP_SETTINGS.aiConcurrentLimit;

beforeEach(() => {
  vi.clearAllMocks();
  mockSetAgentConcurrency.mockReset().mockResolvedValue(undefined);
  mockReadConfig.mockReset().mockResolvedValue(null);
  mockHasTransport.mockReturnValue(false);
  mockHasCapability.mockReturnValue(true);
  mockIsTauri.mockReturnValue(false);
  store.set(appSettingsAtom, DEFAULT_APP_SETTINGS);
  store.set(agentConcurrencySyncAtom, { status: "idle" });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  store.set(appSettingsAtom, DEFAULT_APP_SETTINGS);
});

/** The `action` of the most recent `toast.error` call. */
function lastToastAction(): { label: unknown; onClick: () => void } {
  const action = vi.mocked(toast.error).mock.lastCall?.[1]?.action;
  if (!action || typeof action !== "object" || !("onClick" in action)) {
    throw new Error("the last error toast has no action");
  }
  return action as { label: unknown; onClick: () => void };
}

function setLimit(limit: number): void {
  act(() => {
    store.set(appSettingsAtom, { ...DEFAULT_APP_SETTINGS, aiConcurrentLimit: limit });
  });
}

const limit = (): number => store.get(appSettingsAtom).aiConcurrentLimit;

describe("useSettingsBridge — agent concurrency push", () => {
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

    expect(mockSetAgentConcurrency.mock.calls).toStrictEqual([[8], [DEFAULT_LIMIT]]);
  });

  it("logs a rejected push instead of silently swallowing it", async () => {
    const failure = new Error("out of range");
    mockSetAgentConcurrency.mockRejectedValueOnce(failure);
    using consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

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
  });
});

describe("useSettingsBridge — agent concurrency acknowledgement", () => {
  it("marks a push pending until the backend acknowledges it", async () => {
    let acknowledge: () => void = () => {};
    mockSetAgentConcurrency.mockReturnValueOnce(new Promise<void>((r) => (acknowledge = r)));
    renderHook(() => useSettingsBridge());

    setLimit(8);
    expect(store.get(agentConcurrencySyncAtom)).toStrictEqual({ status: "pending", requested: 8 });

    await act(async () => acknowledge());
    expect(store.get(agentConcurrencySyncAtom)).toStrictEqual({ status: "idle" });
    expect(limit()).toBe(8);
  });

  it("rolls a rejected push back to the last acknowledged value and offers Retry", async () => {
    using _consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    mockSetAgentConcurrency.mockRejectedValueOnce(new Error("limit out of range"));
    renderHook(() => useSettingsBridge());

    setLimit(9);

    await vi.waitFor(() =>
      expect(store.get(agentConcurrencySyncAtom)).toStrictEqual({
        status: "failed",
        requested: 9,
        message: "limit out of range",
      }),
    );
    expect(limit()).toBe(DEFAULT_LIMIT);
    // The rollback is not itself a change to push.
    expect(mockSetAgentConcurrency.mock.calls).toStrictEqual([[9]]);
    expect(toast.error).toHaveBeenCalledWith(
      "Agent Concurrency Not Applied",
      expect.objectContaining({ description: "limit out of range" }),
    );
    expect(lastToastAction().label).toBe("Retry");
  });

  it("pushes the requested value again on Retry and clears the error on success", async () => {
    using _consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    mockSetAgentConcurrency.mockRejectedValueOnce(new Error("busy"));
    renderHook(() => useSettingsBridge());
    setLimit(9);
    await vi.waitFor(() => expect(store.get(agentConcurrencySyncAtom).status).toBe("failed"));

    await act(async () => lastToastAction().onClick());

    expect(mockSetAgentConcurrency.mock.calls).toStrictEqual([[9], [9]]);
    await vi.waitFor(() =>
      expect(store.get(agentConcurrencySyncAtom)).toStrictEqual({ status: "idle" }),
    );
    expect(limit()).toBe(9);
  });

  it("fails a push that never settles after the ack timeout, then adopts a late resolve", async () => {
    vi.useFakeTimers();
    using _consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    let acknowledge: () => void = () => {};
    mockSetAgentConcurrency.mockReturnValueOnce(new Promise<void>((r) => (acknowledge = r)));
    renderHook(() => useSettingsBridge());
    setLimit(8);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(AGENT_CONCURRENCY_ACK_TIMEOUT_MS - 1);
    });
    expect(store.get(agentConcurrencySyncAtom).status).toBe("pending");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(store.get(agentConcurrencySyncAtom).status).toBe("failed");
    expect(limit()).toBe(DEFAULT_LIMIT);
    expect(mockSetAgentConcurrency).toHaveBeenCalledTimes(1);

    await act(async () => acknowledge());
    expect(limit()).toBe(8);
    expect(store.get(agentConcurrencySyncAtom)).toStrictEqual({ status: "idle" });
    expect(mockSetAgentConcurrency).toHaveBeenCalledTimes(1);
  });

  it("never lets a stale push override a newer one", async () => {
    let rejectFirst: (reason: Error) => void = () => {};
    mockSetAgentConcurrency.mockReturnValueOnce(
      new Promise<void>((_, reject) => (rejectFirst = reject)),
    );
    using _consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    renderHook(() => useSettingsBridge());

    setLimit(8);
    setLimit(9);
    await vi.waitFor(() =>
      expect(store.get(agentConcurrencySyncAtom)).toStrictEqual({ status: "idle" }),
    );

    await act(async () => rejectFirst(new Error("late")));

    expect(store.get(agentConcurrencySyncAtom)).toStrictEqual({ status: "idle" });
    expect(limit()).toBe(9);
    expect(toast.error).not.toHaveBeenCalled();
  });
});

describe("useSettingsBridge — older push acknowledged after the newest", () => {
  it("rolls a failed push back to an older push the backend acknowledged", async () => {
    using _consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const first = Promise.withResolvers<void>();
    const second = Promise.withResolvers<void>();
    mockSetAgentConcurrency.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    renderHook(() => useSettingsBridge());

    setLimit(8);
    setLimit(9);
    await act(async () => first.resolve());
    await act(async () => second.reject(new Error("disk full")));

    expect(limit()).toBe(8);
    expect(store.get(agentConcurrencySyncAtom).status).toBe("failed");
  });

  it("shows an older push's late acknowledgement after the newest failed", async () => {
    using _consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const first = Promise.withResolvers<void>();
    const second = Promise.withResolvers<void>();
    mockSetAgentConcurrency.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    renderHook(() => useSettingsBridge());

    setLimit(8);
    setLimit(9);
    await act(async () => second.reject(new Error("disk full")));
    expect(limit()).toBe(DEFAULT_LIMIT);
    await act(async () => first.resolve());

    expect(limit()).toBe(8);
    expect(mockSetAgentConcurrency).toHaveBeenCalledTimes(2);
  });
});

describe("useSettingsBridge — launch reconciliation", () => {
  it("adopts the backend's persisted cap without pushing it back", async () => {
    mockHasTransport.mockReturnValue(true);
    mockReadConfig.mockResolvedValue(6);
    renderHook(() => useSettingsBridge(), { reactStrictMode: true });

    await vi.waitFor(() => expect(limit()).toBe(6));
    expect(mockReadConfig).toHaveBeenCalledWith("agent_concurrency", expect.anything());
    expect(mockSetAgentConcurrency).not.toHaveBeenCalled();
  });

  it("treats an unset key as the scheduler default", async () => {
    mockHasTransport.mockReturnValue(true);
    mockReadConfig.mockResolvedValue(null);
    store.set(appSettingsAtom, { ...DEFAULT_APP_SETTINGS, aiConcurrentLimit: 7 });
    renderHook(() => useSettingsBridge());

    await vi.waitFor(() => expect(limit()).toBe(3));
    expect(mockSetAgentConcurrency).not.toHaveBeenCalled();
  });

  it("keeps the field and logs when the backend value is outside the UI range", async () => {
    mockHasTransport.mockReturnValue(true);
    mockReadConfig.mockResolvedValue(14);
    using consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
    renderHook(() => useSettingsBridge());

    await vi.waitFor(() => expect(consoleWarn).toHaveBeenCalled());
    expect(limit()).toBe(DEFAULT_LIMIT);
  });

  it("leaves the field alone and logs when the read fails", async () => {
    mockHasTransport.mockReturnValue(true);
    mockReadConfig.mockRejectedValue(new Error("no answer"));
    using consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
    renderHook(() => useSettingsBridge());

    await vi.waitFor(() => expect(consoleWarn).toHaveBeenCalled());
    expect(limit()).toBe(DEFAULT_LIMIT);
  });

  it("does not read without a backend", () => {
    renderHook(() => useSettingsBridge());

    expect(mockReadConfig).not.toHaveBeenCalled();
  });

  it("rolls a later failed push back to the reconciled value", async () => {
    mockHasTransport.mockReturnValue(true);
    mockReadConfig.mockResolvedValue(6);
    using _consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    renderHook(() => useSettingsBridge());
    await vi.waitFor(() => expect(limit()).toBe(6));

    mockSetAgentConcurrency.mockRejectedValueOnce(new Error("nope"));
    setLimit(2);

    await vi.waitFor(() => expect(limit()).toBe(6));
  });
});

describe("useSettingsBridge — update check on launch", () => {
  beforeEach(() => {
    store.set(appSettingsAtom, { ...DEFAULT_APP_SETTINGS, updateCheckOnLaunch: true });
  });

  it("checks once when the desktop updater is available", async () => {
    mockIsTauri.mockReturnValue(true);
    renderHook(() => useSettingsBridge(), { reactStrictMode: true });

    await vi.waitFor(() => expect(checkForUpdates).toHaveBeenCalledTimes(1));
  });

  it("does not check without the autoUpdate capability", () => {
    mockIsTauri.mockReturnValue(true);
    mockHasCapability.mockReturnValue(false);
    renderHook(() => useSettingsBridge(), { reactStrictMode: true });

    expect(checkForUpdates).not.toHaveBeenCalled();
  });
});
