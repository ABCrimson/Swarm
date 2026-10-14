import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { getDefaultStore } from "jotai";
import { toast } from "sonner";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useSettingsBridge } from "#hooks/useSettingsBridge";
import { alertThresholdsAtom } from "#lib/alerts";
import { CLAUDE_MODELS } from "#lib/models";
import {
  checkForUpdates,
  DESKTOP_ONLY_REASON,
  hasCapability,
  isTauri,
  readConfig,
  setAgentConcurrency,
  setMaxWorkers,
  writeConfig,
} from "#lib/tauri";
import { clampNumberInput, Settings, thresholdsError } from "#pages/Settings";
import {
  agentConcurrencySyncAtom,
  appSettingsAtom,
  DEFAULT_APP_SETTINGS,
  selectedModelAtom,
} from "#store/ui";

vi.mock(import("#lib/tauri"), async (importOriginal) => ({
  ...(await importOriginal()),
  isTauri: vi.fn(),
  hasCapability: vi.fn(),
  setAgentConcurrency: vi.fn(),
  readConfig: vi.fn(),
  writeConfig: vi.fn(),
  setMaxWorkers: vi.fn(),
  checkForUpdates: vi.fn(),
}));

// The shared sonner mock (src/test/setup.ts) has no `dismiss`, which the
// settings bridge uses to clear a stale failure toast.
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
const DEFAULT_THRESHOLDS = store.get(alertThresholdsAtom);

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(readConfig).mockResolvedValue(null);
  vi.mocked(writeConfig).mockResolvedValue(undefined);
  vi.mocked(setMaxWorkers).mockResolvedValue(null);
  vi.mocked(checkForUpdates).mockResolvedValue({ available: false });
  vi.mocked(hasCapability).mockReturnValue(true);
  vi.mocked(isTauri).mockReturnValue(false);
  vi.mocked(setAgentConcurrency).mockResolvedValue(null);
  store.set(agentConcurrencySyncAtom, { status: "idle" });
  store.set(alertThresholdsAtom, DEFAULT_THRESHOLDS);
  store.set(appSettingsAtom, DEFAULT_APP_SETTINGS);
  store.set(selectedModelAtom, "sonnet");
});

describe("clampNumberInput", () => {
  it.for([
    ["50", 50],
    ["150", 100],
    ["-3", 0],
    ["", 42],
    ["   ", 42],
    ["abc", 42],
  ] as const)("%j -> %d", ([raw, expected]) => {
    expect(clampNumberInput(raw, 0, 100, 42)).toBe(expected);
  });
});

describe("thresholdsError", () => {
  it("accepts warning below critical", () => {
    expect(thresholdsError(DEFAULT_THRESHOLDS)).toBeNull();
  });

  it("rejects an inverted or equal CPU pair and names only the CPU fields", () => {
    expect(thresholdsError({ ...DEFAULT_THRESHOLDS, cpuWarning: 90, cpuCritical: 90 })).toEqual({
      message: "CPU Warning Must Be Below CPU Critical",
      keys: new Set(["cpuWarning", "cpuCritical"]),
    });
  });

  it("rejects an inverted memory pair and names only the memory fields", () => {
    expect(
      thresholdsError({ ...DEFAULT_THRESHOLDS, memoryWarning: 95, memoryCritical: 50 }),
    ).toEqual({
      message: "Memory Warning Must Be Below Memory Critical",
      keys: new Set(["memoryWarning", "memoryCritical"]),
    });
  });
});

describe("Settings — API key", () => {
  it("reads the anthropic_api_key config key on mount and shows the stored key", async () => {
    vi.mocked(readConfig).mockImplementation(async (key) =>
      key === "anthropic_api_key" ? "sk-ant-existing-key" : null,
    );
    render(<Settings />);

    const input = screen.getByLabelText<HTMLInputElement>("API Key");
    await waitFor(() => expect(input.value).toBe("sk-ant-existing-key"));
    expect(input.type).toBe("password");
  });

  it("enables Save only for a change, writes the key, and never logs it", async () => {
    const user = userEvent.setup();
    // Restored when the test ends, pass or fail (spies are Disposable).
    using spyStack = new DisposableStack();
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((method) =>
      spyStack.use(vi.spyOn(console, method).mockImplementation(() => {})),
    );
    render(<Settings />);

    const save = screen.getByRole("button", { name: "Save API Key" });
    expect(save).toBeDisabled();

    await user.type(screen.getByLabelText("API Key"), "sk-ant-brand-new-key");
    expect(save).toBeEnabled();
    await user.click(save);

    await waitFor(() =>
      expect(writeConfig).toHaveBeenCalledWith("anthropic_api_key", "sk-ant-brand-new-key"),
    );
    await waitFor(() => expect(save).toBeDisabled());
    expect(toast.success).toHaveBeenCalledWith("API Key Saved");
    for (const spy of spies) {
      for (const call of spy.mock.calls) {
        expect(call.map(String).join(" ")).not.toContain("sk-ant-brand-new-key");
      }
    }
  });

  it("keeps Save enabled and reports a failed write", async () => {
    const user = userEvent.setup();
    vi.mocked(writeConfig).mockRejectedValue(new Error("disk full"));
    render(<Settings />);

    await user.type(screen.getByLabelText("API Key"), "sk-ant-x");
    await user.keyboard("{Enter}");

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("Failed To Save API Key", {
        description: "disk full",
      }),
    );
    expect(screen.getByRole("button", { name: "Save API Key" })).toBeEnabled();
  });
});

describe("Settings — AI model", () => {
  it("is a single-choice radio group named by the model", async () => {
    const user = userEvent.setup();
    render(<Settings />);

    const group = screen.getByRole("radiogroup", { name: "AI Model" });
    const sonnet = within(group).getByRole("radio", { name: "Claude Sonnet 5.5" });
    const haiku = within(group).getByRole("radio", { name: "Claude Haiku 5.5" });
    expect(sonnet).toBeChecked();
    expect(haiku).toHaveAccessibleDescription(/Fastest/);

    await user.click(haiku);

    expect(haiku).toBeChecked();
    expect(sonnet).not.toBeChecked();
    expect(store.get(selectedModelAtom)).toBe("haiku");
    expect(toast.success).toHaveBeenCalledWith("Switched To Claude Haiku 5.5");
  });

  it("warns once, and does not also toast success, for the gated model", async () => {
    const user = userEvent.setup();
    render(<Settings />);

    // Looked up from the catalog so a relabel (e.g. a point release) cannot break this.
    const gated = Object.values(CLAUDE_MODELS).find((model) => model.gated !== undefined);
    if (!gated) throw new Error("the catalog has no gated model");
    await user.click(screen.getByRole("radio", { name: gated.label }));

    expect(toast.warning).toHaveBeenCalledTimes(1);
    expect(toast.warning).toHaveBeenCalledWith(`${gated.label} Requires Project Glasswing Access`);
    expect(toast.success).not.toHaveBeenCalled();
  });
});

describe("Settings — switches and number fields", () => {
  it("names each switch by its label and describes it by its description", async () => {
    const user = userEvent.setup();
    render(<Settings />);

    const toggle = screen.getByRole("switch", { name: "Check For Updates On Launch" });
    expect(toggle).toHaveAccessibleDescription(
      "Query The Update Endpoint Once Each Time The App Starts.",
    );
    expect(toggle).toHaveAttribute("aria-checked", "false");

    await user.click(toggle);

    expect(toggle).toHaveAttribute("aria-checked", "true");
    expect(store.get(appSettingsAtom).updateCheckOnLaunch).toBe(true);
  });

  it("commits a number field once, clamped, on blur — never per keystroke", async () => {
    const user = userEvent.setup();
    render(<Settings />);

    const retention = screen.getByLabelText("Log Retention");
    await user.clear(retention);
    await user.type(retention, "5");
    expect(store.get(appSettingsAtom).logMaxEntries).toBe(DEFAULT_APP_SETTINGS.logMaxEntries);

    await user.tab();

    expect(store.get(appSettingsAtom).logMaxEntries).toBe(100);
    expect(retention).toHaveValue(100);
  });

  it("restores the current value when a number field is left blank", async () => {
    const user = userEvent.setup();
    render(<Settings />);

    const cooldown = screen.getByLabelText("Alert Cooldown");
    await user.clear(cooldown);
    await user.tab();

    expect(cooldown).toHaveValue(DEFAULT_APP_SETTINGS.alertCooldownSec);
    expect(store.get(appSettingsAtom).alertCooldownSec).toBe(DEFAULT_APP_SETTINGS.alertCooldownSec);
  });
});

describe("Settings — worker registry cap", () => {
  it("applies a new cap through set_max_workers", async () => {
    const user = userEvent.setup();
    render(<Settings />);

    const cap = screen.getByLabelText("Worker Registry Cap");
    await user.clear(cap);
    await user.type(cap, "12{Enter}");

    await waitFor(() => expect(setMaxWorkers).toHaveBeenCalledWith(12));
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith("Worker Registry Cap Set To 12"),
    );
    expect(cap).toHaveValue(12);
  });

  it("rolls the shown cap back when the backend refuses it", async () => {
    const user = userEvent.setup();
    vi.mocked(setMaxWorkers).mockRejectedValue(new Error("refused"));
    render(<Settings />);

    const cap = screen.getByLabelText("Worker Registry Cap");
    await user.clear(cap);
    await user.type(cap, "12{Enter}");

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("Failed To Update Worker Registry Cap", {
        description: "refused",
      }),
    );
    await waitFor(() => expect(cap).toHaveValue(64));
  });
});

describe("Settings — alert thresholds", () => {
  async function startEditing(user: ReturnType<typeof userEvent.setup>): Promise<void> {
    await user.click(screen.getByRole("button", { name: "Edit Thresholds" }));
  }

  it("clamps typed values to 0–100 and restores blank fields on blur", async () => {
    const user = userEvent.setup();
    render(<Settings />);
    await startEditing(user);

    const cpuCritical = screen.getByLabelText("CPU Critical");
    await user.clear(cpuCritical);
    await user.type(cpuCritical, "250");
    await user.tab();
    expect(cpuCritical).toHaveValue(100);

    const memoryWarning = screen.getByLabelText("Memory Warning");
    await user.clear(memoryWarning);
    await user.tab();
    expect(memoryWarning).toHaveValue(DEFAULT_THRESHOLDS.memoryWarning);

    await user.click(screen.getByRole("button", { name: "Save Thresholds" }));

    expect(store.get(alertThresholdsAtom)).toEqual({ ...DEFAULT_THRESHOLDS, cpuCritical: 100 });
    expect(toast.success).toHaveBeenCalledWith("Alert Thresholds Updated");
  });

  it("never saves a blank field as 0, even when submitted without blurring", async () => {
    const user = userEvent.setup();
    render(<Settings />);
    await startEditing(user);

    const cpuWarning = screen.getByLabelText("CPU Warning");
    await user.clear(cpuWarning);
    await user.keyboard("{Enter}");
    expect(toast.success).toHaveBeenCalledWith("Alert Thresholds Updated");
    expect(screen.getByRole("button", { name: "Edit Thresholds" })).toBeInTheDocument();

    expect(store.get(alertThresholdsAtom).cpuWarning).toBe(DEFAULT_THRESHOLDS.cpuWarning);
  });

  it("refuses a warning level at or above its critical level", async () => {
    const user = userEvent.setup();
    render(<Settings />);
    await startEditing(user);

    const cpuWarning = screen.getByLabelText("CPU Warning");
    await user.clear(cpuWarning);
    await user.type(cpuWarning, "95");
    await user.click(screen.getByRole("button", { name: "Save Thresholds" }));

    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("CPU Warning Must Be Below CPU Critical");
    // Only the offending pair is invalid, and each names the message.
    for (const label of ["CPU Warning", "CPU Critical"]) {
      const input = screen.getByLabelText(label);
      expect(input).toHaveAttribute("aria-invalid", "true");
      expect(input).toHaveAccessibleDescription("CPU Warning Must Be Below CPU Critical");
    }
    for (const label of ["Memory Warning", "Memory Critical"]) {
      expect(screen.getByLabelText(label)).not.toHaveAttribute("aria-invalid");
      expect(screen.getByLabelText(label)).not.toHaveAttribute("aria-describedby");
    }
    expect(toast.error).toHaveBeenCalledWith("CPU Warning Must Be Below CPU Critical");
    expect(store.get(alertThresholdsAtom)).toEqual(DEFAULT_THRESHOLDS);
    // Still editing, with the typed value kept for correction.
    expect(cpuWarning).toBeEnabled();
    expect(cpuWarning).toHaveValue(95);
  });

  it("discards drafts on Cancel", async () => {
    const user = userEvent.setup();
    render(<Settings />);
    await startEditing(user);

    const cpuWarning = screen.getByLabelText("CPU Warning");
    await user.clear(cpuWarning);
    await user.type(cpuWarning, "10");
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    expect(cpuWarning).toBeDisabled();
    expect(cpuWarning).toHaveValue(DEFAULT_THRESHOLDS.cpuWarning);
    expect(store.get(alertThresholdsAtom)).toEqual(DEFAULT_THRESHOLDS);
  });
});

describe("Settings — keybindings", () => {
  it("captures a new binding once, even after the parent re-renders", async () => {
    const user = userEvent.setup();
    render(<Settings />);

    const chip = screen.getByRole("button", { name: "Change Shortcut For Performance Overlay" });
    await user.click(chip);
    expect(chip).toHaveTextContent("Press Keys…");
    await user.keyboard("{Alt>}j{/Alt}");

    expect(chip).toHaveTextContent("Alt+J");
    expect(toast.success).toHaveBeenCalledTimes(1);
    expect(toast.success).toHaveBeenCalledWith("Performance Overlay Bound To Alt+J");
  });

  it("rejects a binding another shortcut already uses", async () => {
    const user = userEvent.setup();
    render(<Settings />);

    const chip = screen.getByRole("button", { name: "Change Shortcut For Graph / List Toggle" });
    await user.click(chip);
    await user.keyboard("{Control>}k{/Control}");

    expect(toast.error).toHaveBeenCalledWith("Ctrl+K Is Already Assigned To Another Shortcut");
    expect(chip).toHaveTextContent("Ctrl+Shift+G");
  });
});

describe("Settings — updates", () => {
  it.for([
    [{ available: true, version: "9.9.9" }, "info", "Update Available: Version 9.9.9"],
    [{ available: false }, "success", "You Are On The Latest Version"],
  ] as const)("reports %j", async ([result, level, message]) => {
    const user = userEvent.setup();
    vi.mocked(checkForUpdates).mockResolvedValue(result);
    render(<Settings />);

    await user.click(screen.getByRole("button", { name: "Check For Updates" }));

    await waitFor(() => expect(toast[level]).toHaveBeenCalledWith(message));
  });

  it("reports why the update check failed", async () => {
    const user = userEvent.setup();
    vi.mocked(checkForUpdates).mockRejectedValue(new Error("offline"));
    render(<Settings />);

    await user.click(screen.getByRole("button", { name: "Check For Updates" }));

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("Update Check Failed", { description: "offline" }),
    );
  });
});

/** The page with the app-root bridge that applies and acknowledges its backend pushes. */
function SettingsWithBridge(): React.ReactElement {
  useSettingsBridge();
  return <Settings />;
}

describe("Settings — AI concurrent stream limit acknowledgement", () => {
  it("rolls the field back to the last acknowledged value and offers Retry when the push is rejected", async () => {
    const user = userEvent.setup();
    using _consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(setAgentConcurrency).mockRejectedValueOnce(new Error("limit out of range"));
    render(<SettingsWithBridge />);

    const field = screen.getByLabelText("AI Concurrent Stream Limit");
    await user.clear(field);
    await user.type(field, "8{Enter}");

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Could Not Apply 8 Streams");
    expect(alert).toHaveTextContent("limit out of range");
    expect(field).toHaveValue(DEFAULT_APP_SETTINGS.aiConcurrentLimit);
    expect(field).toHaveAccessibleDescription(/limit out of range/);

    await user.click(within(alert).getByRole("button", { name: "Retry" }));

    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
    expect(vi.mocked(setAgentConcurrency).mock.calls).toStrictEqual([[8], [8]]);
    expect(field).toHaveValue(8);
  });

  it("marks the field busy and says it is applying until the backend answers", async () => {
    const user = userEvent.setup();
    let acknowledge: (cap: number | null) => void = () => {};
    vi.mocked(setAgentConcurrency).mockReturnValueOnce(
      new Promise<number | null>((r) => (acknowledge = r)),
    );
    render(<SettingsWithBridge />);

    const field = screen.getByLabelText("AI Concurrent Stream Limit");
    await user.clear(field);
    await user.type(field, "6{Enter}");

    expect(field).toHaveAttribute("aria-busy", "true");
    expect(screen.getByText("Applying…")).toHaveAttribute("role", "status");

    acknowledge(null);
    await waitFor(() => expect(field).not.toHaveAttribute("aria-busy"));
    expect(screen.queryByText("Applying…")).not.toBeInTheDocument();
  });
});

describe("Settings — in the browser build", () => {
  beforeEach(() => {
    vi.mocked(hasCapability).mockReturnValue(false);
  });

  it("disables Check For Updates with the desktop-only reason, so the check cannot report up to date", async () => {
    const user = userEvent.setup();
    render(<Settings />);

    const button = screen.getByRole("button", { name: "Check For Updates" });
    expect(button).toBeDisabled();
    expect(button).toHaveAccessibleDescription(DESKTOP_ONLY_REASON);

    await user.click(button);

    expect(checkForUpdates).not.toHaveBeenCalled();
    expect(toast.success).not.toHaveBeenCalledWith("You Are On The Latest Version");
  });

  it("disables the API key field and Save with the desktop-only reason, and never touches the key", async () => {
    const user = userEvent.setup();
    render(<Settings />);

    const input = screen.getByLabelText("API Key");
    expect(input).toBeDisabled();
    expect(input).toHaveAccessibleDescription(new RegExp(DESKTOP_ONLY_REASON));
    expect(screen.getByRole("button", { name: "Save API Key" })).toBeDisabled();

    await user.click(input);
    await user.keyboard("{Enter}");

    expect(readConfig).not.toHaveBeenCalledWith("anthropic_api_key", expect.anything());
    expect(writeConfig).not.toHaveBeenCalled();
  });

  it.for(["Check For Updates On Launch", "Native Alert Notifications"] as const)(
    "disables the %s switch with the desktop-only reason",
    async (name) => {
      const user = userEvent.setup();
      render(<Settings />);

      const toggle = screen.getByRole("switch", { name });
      expect(toggle).toBeDisabled();
      expect(toggle).toHaveAccessibleDescription(new RegExp(DESKTOP_ONLY_REASON));

      await user.click(toggle);

      expect(toggle).toHaveAttribute("aria-checked", "false");
    },
  );
});

describe("Settings — auto-snapshot interval", () => {
  it("is disabled with the desktop-only reason in the browser build", () => {
    vi.mocked(hasCapability).mockReturnValue(false);
    render(<Settings />);

    const field = screen.getByLabelText("Auto-Snapshot Interval");
    expect(field).toBeDisabled();
    expect(field).toHaveAccessibleDescription(new RegExp(DESKTOP_ONLY_REASON));
  });

  it("is editable when the transport offers local stores", () => {
    render(<Settings />);

    const field = screen.getByLabelText("Auto-Snapshot Interval");
    expect(field).toBeEnabled();
    expect(field).not.toHaveAccessibleDescription(new RegExp(DESKTOP_ONLY_REASON));
  });
});
