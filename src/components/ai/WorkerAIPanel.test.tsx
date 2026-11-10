// WorkerAIPanel: the Inject Instruction dialog (a native modal <dialog>:
// showModal, Escape and a backdrop click close it, the instruction reaches the chat engine
// exactly once) and, on a transport without `localAiChat` (the build:web
// page), the desktop-only notice in place of the webview chat's model
// selector, Inject Instruction and Queue buttons and instruction input.

import "#test/dom-polyfills";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WorkerAIPanel } from "#components/ai/WorkerAIPanel";
import { injectInstruction } from "#lib/ai-chat";

vi.mock("#components/worker/WorkerTerminal", () => ({ WorkerTerminal: () => null }));
vi.mock("#components/layout/SplitPane", () => ({
  SplitPane: ({ primary, secondary }: { primary: React.ReactNode; secondary: React.ReactNode }) => (
    <>
      {primary}
      {secondary}
    </>
  ),
}));
/** `true` makes the active transport report no webview AI chat (the `build:web` page). */
const web = vi.hoisted(() => ({ on: false }));
vi.mock(import("#lib/tauri"), async (importOriginal) => ({
  ...(await importOriginal()),
  hasCapability: () => !web.on,
}));
vi.mock(import("#lib/ai-chat"), async (importOriginal) => ({
  ...(await importOriginal()),
  injectInstruction: vi.fn(() => "sent" as const),
}));

beforeEach(() => {
  web.on = false;
  vi.mocked(injectInstruction).mockClear();
});

describe("WorkerAIPanel inject dialog", () => {
  it("opens as a modal dialog and injects the instruction once", async () => {
    const user = userEvent.setup();
    render(<WorkerAIPanel workerId="w1" />);

    await user.click(screen.getByRole("button", { name: "Inject Instruction" }));
    const dialog = screen.getByRole("dialog", { name: "Inject Mid-Conversation Instruction" });
    expect(dialog).toHaveAttribute("open");

    await user.type(screen.getByRole("textbox", { name: "Instruction" }), "Be brief");
    await user.click(screen.getByRole("button", { name: "Inject" }));

    expect(injectInstruction).toHaveBeenCalledExactlyOnceWith("w1", "Be brief");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("sizes the instruction box to its content between a minimum and a maximum", async () => {
    const user = userEvent.setup();
    render(<WorkerAIPanel workerId="w1" />);

    await user.click(screen.getByRole("button", { name: "Inject Instruction" }));
    const box = screen.getByRole("textbox", { name: "Instruction" });

    expect(box).toHaveClass("[field-sizing:content]", "min-h-20", "max-h-60", "h-auto");
    expect(box.style.minHeight).toBe("");
  });

  it("closes on Escape without injecting", async () => {
    const user = userEvent.setup();
    render(<WorkerAIPanel workerId="w1" />);

    await user.click(screen.getByRole("button", { name: "Inject Instruction" }));
    await user.keyboard("{Escape}");

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(injectInstruction).not.toHaveBeenCalled();
  });

  it("closes on a backdrop click, where `closedby` is missing", async () => {
    const user = userEvent.setup();
    render(<WorkerAIPanel workerId="w1" />);

    await user.click(screen.getByRole("button", { name: "Inject Instruction" }));
    const dialog = screen.getByRole("dialog", { name: "Inject Mid-Conversation Instruction" });
    // A backdrop click targets the dialog at a point outside its box.
    act(() => {
      dialog.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: -1, clientY: -1 }));
    });

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(injectInstruction).not.toHaveBeenCalled();
  });
});

describe("WorkerAIPanel without the webview AI chat (the browser build)", () => {
  it("replaces the webview chat controls with the desktop-only notice", () => {
    web.on = true;
    render(<WorkerAIPanel workerId="w1" />);

    expect(screen.getByText("Available In The Desktop App Only")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Inject Instruction" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Queue" })).not.toBeInTheDocument();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^AI Model:/ })).not.toBeInTheDocument();
  });
});
