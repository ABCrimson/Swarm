import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Settings } from "#pages/Settings";

// Mock the Tauri config IPC wrapper used by the API Key field.
const mockReadConfig = vi.fn();
const mockWriteConfig = vi.fn();

vi.mock("#lib/tauri", () => ({
  isTauri: () => false,
  readConfig: (...args: unknown[]) => mockReadConfig(...args),
  writeConfig: (...args: unknown[]) => mockWriteConfig(...args),
}));

describe("Settings — API Key field", () => {
  beforeEach(() => {
    mockReadConfig.mockReset().mockResolvedValue(null);
    mockWriteConfig.mockReset().mockResolvedValue(undefined);
  });

  it("reads the anthropic_api_key config key on mount", async () => {
    render(<Settings />);

    await waitFor(() => expect(mockReadConfig).toHaveBeenCalledWith("anthropic_api_key"));
  });

  it("populates the field with the persisted key once loaded", async () => {
    mockReadConfig.mockResolvedValue("sk-ant-existing-key");
    render(<Settings />);

    const input = screen.getByLabelText("API Key") as HTMLInputElement;
    await waitFor(() => expect(input.value).toBe("sk-ant-existing-key"));
  });

  it("renders the API key input as a masked (password-type) field", () => {
    render(<Settings />);

    const input = screen.getByLabelText("API Key") as HTMLInputElement;
    expect(input.type).toBe("password");
  });

  it("disables Save until the field is changed", () => {
    render(<Settings />);

    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  });

  it("writes the key via write_config when Save is clicked, and never logs it", async () => {
    const user = userEvent.setup();
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    render(<Settings />);

    const input = screen.getByLabelText("API Key");
    await user.type(input, "sk-ant-brand-new-key");
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(mockWriteConfig).toHaveBeenCalledWith("anthropic_api_key", "sk-ant-brand-new-key"),
    );

    // The secret must never be routed through console.log.
    for (const call of consoleSpy.mock.calls) {
      expect(call.join(" ")).not.toContain("sk-ant-brand-new-key");
    }
    consoleSpy.mockRestore();
  });

  it("re-disables Save after a successful save (no pending changes)", async () => {
    const user = userEvent.setup();
    render(<Settings />);

    const input = screen.getByLabelText("API Key");
    await user.type(input, "sk-ant-another-key");
    const saveButton = screen.getByRole("button", { name: "Save" });
    await user.click(saveButton);

    await waitFor(() => expect(saveButton).toBeDisabled());
  });
});

describe("Settings — AI Model selection (Task 8 item 2)", () => {
  beforeEach(() => {
    mockReadConfig.mockReset().mockResolvedValue(null);
    mockWriteConfig.mockReset().mockResolvedValue(undefined);
    vi.mocked(toast.warning).mockClear();
    vi.mocked(toast.success).mockClear();
  });

  it("fires exactly one toast.warning, and no toast.success, when the gated Mythos card is selected", async () => {
    const user = userEvent.setup();
    render(<Settings />);

    await user.click(screen.getByRole("button", { name: /Claude Mythos 5/ }));

    expect(toast.warning).toHaveBeenCalledTimes(1);
    expect(toast.warning).toHaveBeenCalledWith("Claude Mythos 5 Requires Project Glasswing Access");
    expect(toast.success).not.toHaveBeenCalled();
  });

  it("keeps the plain success toast for a non-gated card (unchanged behavior)", async () => {
    const user = userEvent.setup();
    render(<Settings />);

    await user.click(screen.getByRole("button", { name: /Claude Opus 4\.8/ }));

    expect(toast.success).toHaveBeenCalledTimes(1);
    expect(toast.success).toHaveBeenCalledWith("Switched To Claude Opus 4.8");
    expect(toast.warning).not.toHaveBeenCalled();
  });
});
