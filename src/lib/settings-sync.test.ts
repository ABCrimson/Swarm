// ── settings-sync ───────────────────────────────────
// The subscription itself, with no React: each former `useSettingsBridge`
// effect (log retention, the AI limiter and agent cap push, the worker
// registry cap, history workers, launch reconciliation with its cleanup,
// the update check) is driven through the jotai store. The acknowledgement
// rules are covered in src/hooks/useSettingsBridge.test.tsx.

import { getDefaultStore } from "jotai";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSettingsSync } from "#lib/settings-sync";
import { checkForUpdates } from "#lib/tauri";
import { useAiStore } from "#store/ai";
import { useLogStore } from "#store/logs";
import { useMessageHistoryStore } from "#store/message-history";
import { appSettingsAtom, DEFAULT_APP_SETTINGS, maxWorkersAtom } from "#store/ui";

const mockSetAgentConcurrency = vi.fn().mockResolvedValue(null);
const mockSetMaxWorkers = vi.fn().mockResolvedValue(null);
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
  setMaxWorkers: (...args: unknown[]) => mockSetMaxWorkers(...args),
}));

// The shared sonner mock (src/test/setup.ts) has no `dismiss`, which the
// acknowledged sync uses to clear a stale failure toast.
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
const stops: Array<() => void> = [];

/** Starts a fresh sync and remembers its stop function for cleanup. */
function start(): () => void {
  const stop = createSettingsSync(store).start();
  stops.push(stop);
  return stop;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockSetAgentConcurrency.mockReset().mockResolvedValue(null);
  mockSetMaxWorkers.mockReset().mockResolvedValue(null);
  mockReadConfig.mockReset().mockResolvedValue(null);
  mockHasTransport.mockReturnValue(false);
  mockHasCapability.mockReturnValue(true);
  mockIsTauri.mockReturnValue(false);
  store.set(appSettingsAtom, DEFAULT_APP_SETTINGS);
});

afterEach(() => {
  for (const stop of stops.splice(0)) stop();
  vi.useRealTimers();
  store.set(appSettingsAtom, DEFAULT_APP_SETTINGS);
});

describe("settings-sync — in-memory stores", () => {
  it("applies the current settings to the stores on start", () => {
    store.set(appSettingsAtom, {
      ...DEFAULT_APP_SETTINGS,
      logMaxEntries: 321,
      aiConcurrentLimit: 4,
      historyMaxWorkers: 12,
    });

    start();

    expect(useLogStore.getState().maxEntries).toBe(321);
    expect(useAiStore.getState().concurrentLimit).toBe(4);
    expect(useMessageHistoryStore.getState().maxWorkers).toBe(12);
  });

  it("follows a change of each field", () => {
    start();

    store.set(appSettingsAtom, {
      ...store.get(appSettingsAtom),
      logMaxEntries: 777,
      aiConcurrentLimit: 5,
      historyMaxWorkers: 9,
    });

    expect(useLogStore.getState().maxEntries).toBe(777);
    expect(useAiStore.getState().concurrentLimit).toBe(5);
    expect(useMessageHistoryStore.getState().maxWorkers).toBe(9);
  });
});

describe("settings-sync — backend caps", () => {
  it("does not push the agent cap it starts with, but pushes a later change", () => {
    start();
    expect(mockSetAgentConcurrency).not.toHaveBeenCalled();

    store.set(appSettingsAtom, { ...DEFAULT_APP_SETTINGS, aiConcurrentLimit: 8 });

    expect(mockSetAgentConcurrency.mock.calls).toStrictEqual([[8]]);
  });

  it("pushes a worker registry cap change and not the cap it starts with", () => {
    start();
    expect(mockSetMaxWorkers).not.toHaveBeenCalled();

    store.set(maxWorkersAtom, store.get(maxWorkersAtom) + 1);

    expect(mockSetMaxWorkers).toHaveBeenCalledTimes(1);
  });

  it("stops following the stores once stopped", () => {
    const stop = start();
    stop();

    store.set(appSettingsAtom, {
      ...DEFAULT_APP_SETTINGS,
      logMaxEntries: 555,
      aiConcurrentLimit: 9,
    });
    store.set(maxWorkersAtom, store.get(maxWorkersAtom) + 1);

    expect(useLogStore.getState().maxEntries).toBe(DEFAULT_APP_SETTINGS.logMaxEntries);
    expect(useAiStore.getState().concurrentLimit).toBe(DEFAULT_APP_SETTINGS.aiConcurrentLimit);
    expect(mockSetAgentConcurrency).not.toHaveBeenCalled();
    expect(mockSetMaxWorkers).not.toHaveBeenCalled();
  });
});

describe("settings-sync — launch reconciliation", () => {
  it("reads both caps once per instance, even across a stop and a restart", async () => {
    mockHasTransport.mockReturnValue(true);
    const sync = createSettingsSync(store);

    sync.start()();
    stops.push(sync.start());

    await vi.waitFor(() => expect(mockReadConfig).toHaveBeenCalledTimes(2));
    expect(mockReadConfig.mock.calls.map(([key]) => key).toSorted()).toStrictEqual([
      "agent_concurrency",
      "max_workers",
    ]);
  });

  it("cancels the acknowledgement timers when stopped", async () => {
    vi.useFakeTimers();
    mockSetAgentConcurrency.mockReturnValue(new Promise(() => {}));
    const stop = start();
    store.set(appSettingsAtom, { ...DEFAULT_APP_SETTINGS, aiConcurrentLimit: 6 });

    stop();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(toast.error).not.toHaveBeenCalled();
  });
});

describe("settings-sync — update check", () => {
  beforeEach(() => {
    store.set(appSettingsAtom, { ...DEFAULT_APP_SETTINGS, updateCheckOnLaunch: true });
    mockIsTauri.mockReturnValue(true);
  });

  it("checks once per instance across a stop and a restart", async () => {
    const sync = createSettingsSync(store);
    sync.start()();
    stops.push(sync.start());

    await vi.waitFor(() => expect(checkForUpdates).toHaveBeenCalledTimes(1));
  });

  it("toasts an available update", async () => {
    vi.mocked(checkForUpdates).mockResolvedValueOnce({ available: true, version: "9.9.9" });
    start();

    await vi.waitFor(() =>
      expect(toast.info).toHaveBeenCalledWith("Update Available: Version 9.9.9"),
    );
  });

  it("stays silent when the check fails", async () => {
    vi.mocked(checkForUpdates).mockRejectedValueOnce(new Error("offline"));
    start();

    await vi.waitFor(() => expect(checkForUpdates).toHaveBeenCalledTimes(1));
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("does not check when the setting is off, until it is turned on", async () => {
    store.set(appSettingsAtom, { ...DEFAULT_APP_SETTINGS, updateCheckOnLaunch: false });
    start();
    expect(checkForUpdates).not.toHaveBeenCalled();

    store.set(appSettingsAtom, { ...DEFAULT_APP_SETTINGS, updateCheckOnLaunch: true });

    await vi.waitFor(() => expect(checkForUpdates).toHaveBeenCalledTimes(1));
  });

  it("does not check without the autoUpdate capability or outside the desktop shell", () => {
    mockHasCapability.mockReturnValue(false);
    start();
    mockHasCapability.mockReturnValue(true);
    mockIsTauri.mockReturnValue(false);
    start();

    expect(checkForUpdates).not.toHaveBeenCalled();
  });
});
