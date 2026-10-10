// ModelSelector: a popover listbox opened by its trigger's popovertarget
// (top layer, light dismiss, Escape), keyboard-reachable with a roving
// focus, per-worker model pinning, and the Glasswing gating toast.

import "#test/dom-polyfills";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { getDefaultStore } from "jotai";
import { toast } from "sonner";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ModelSelector } from "#components/ai/ModelSelector";
import { selectedModelAtom } from "#store/ui";
import { useWorkerAgentStore } from "#store/worker-agents";

const store = getDefaultStore();
const WORKER_ID = "11111111-2222-3333-8444-555555555555";

const trigger = () => screen.getByRole("button", { name: /^AI Model: / });
const listbox = () => {
  const element = document.querySelector<HTMLElement>("[role='listbox']");
  if (!element) throw new Error("listbox not rendered");
  return element;
};
const isOpen = () => listbox().matches(":popover-open");

async function openWithKeyboard() {
  const user = userEvent.setup();
  trigger().focus();
  await user.keyboard("{Enter}");
  return user;
}

beforeEach(() => {
  store.set(selectedModelAtom, "sonnet");
  useWorkerAgentStore.setState({ metadata: new Map() });
  vi.mocked(toast.warning).mockClear();
  vi.mocked(toast.success).mockClear();
});

describe("ModelSelector", () => {
  it("names the current model on the trigger and opens a popover listbox", async () => {
    render(<ModelSelector />);
    expect(trigger()).toHaveAccessibleName("AI Model: Claude Sonnet 5.5");
    expect(trigger()).toHaveAttribute("aria-expanded", "false");
    expect(listbox()).toHaveAttribute("popover", "auto");

    await userEvent.setup().click(trigger());

    expect(isOpen()).toBe(true);
    expect(listbox()).toHaveAccessibleName("AI Model Options");
    expect(trigger()).toHaveAttribute("aria-expanded", "true");
  });

  it("focuses the selected option on open and moves a roving focus with the arrow keys", async () => {
    render(<ModelSelector />);
    const user = await openWithKeyboard();

    const sonnet = screen.getByRole("option", { name: /Claude Sonnet 5\.5/ });
    expect(sonnet).toHaveFocus();
    expect(sonnet).toHaveAttribute("tabindex", "0");

    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("option", { name: /Claude Haiku 5\.5/ })).toHaveFocus();
    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("option", { name: /Claude Fable 5\.1/ })).toHaveFocus();
    await user.keyboard("{End}");
    expect(screen.getByRole("option", { name: /Claude Haiku 5\.5/ })).toHaveFocus();
    await user.keyboard("{Home}{ArrowUp}");
    expect(screen.getByRole("option", { name: /Claude Haiku 5\.5/ })).toHaveFocus();
  });

  it("picks with Enter, closes, and returns focus to the trigger", async () => {
    render(<ModelSelector />);
    const user = await openWithKeyboard();

    await user.keyboard("{ArrowUp}{Enter}");

    expect(store.get(selectedModelAtom)).toBe("opus");
    expect(isOpen()).toBe(false);
    expect(trigger()).toHaveFocus();
    expect(trigger()).toHaveAccessibleName("AI Model: Claude Opus 5.5");
  });

  it("closes on Escape without changing the model", async () => {
    render(<ModelSelector />);
    const user = await openWithKeyboard();

    await user.keyboard("{ArrowDown}{Escape}");

    expect(isOpen()).toBe(false);
    expect(store.get(selectedModelAtom)).toBe("sonnet");
  });

  it("closes when focus leaves the listbox (Tab away)", async () => {
    render(
      <>
        <ModelSelector />
        <button type="button">Elsewhere</button>
      </>,
    );
    const user = await openWithKeyboard();

    await user.click(screen.getByRole("button", { name: "Elsewhere" }));

    expect(isOpen()).toBe(false);
  });

  it("shows the Glasswing badge and capability chips as Pills", async () => {
    render(<ModelSelector />);
    await openWithKeyboard();

    const mythos = screen.getByRole("option", { name: /Claude Mythos 5\.1/ });
    expect(
      within(mythos).getByText("Requires Project Glasswing").closest(".swarm-pill"),
    ).toHaveAttribute("data-tone", "warning");
    expect(within(mythos).getByText("Agentic Work").closest(".swarm-pill")).toHaveAttribute(
      "data-tone",
      "neutral",
    );
  });

  it("warns once, and never confirms, when the gated Mythos is picked", async () => {
    render(<ModelSelector />);
    const user = await openWithKeyboard();

    await user.click(screen.getByRole("option", { name: /Claude Mythos 5\.1/ }));

    expect(toast.warning).toHaveBeenCalledExactlyOnceWith(
      "Claude Mythos 5.1 Requires Project Glasswing Access",
    );
    expect(toast.success).not.toHaveBeenCalled();
  });

  describe("per-worker pinned model", () => {
    const pin = () =>
      useWorkerAgentStore.getState().setAgentMetadata(WORKER_ID, {
        role: "supervisor",
        model: "opus",
        systemPrompt: "You coordinate.",
      });

    it("shows the worker's pinned model, not the global selection", () => {
      pin();
      render(<ModelSelector workerId={WORKER_ID} />);
      expect(trigger()).toHaveAccessibleName("AI Model: Claude Opus 5.5");
    });

    it("writes a pick into that worker's metadata only, keeping its other fields", async () => {
      pin();
      render(<ModelSelector workerId={WORKER_ID} />);
      const user = await openWithKeyboard();

      await user.click(screen.getByRole("option", { name: /Claude Haiku 5\.5/ }));

      expect(useWorkerAgentStore.getState().metadata.get(WORKER_ID)).toEqual({
        role: "supervisor",
        model: "haiku",
        systemPrompt: "You coordinate.",
      });
      expect(store.get(selectedModelAtom)).toBe("sonnet");
    });

    it("uses the global selection for a worker without a pinned model", async () => {
      render(<ModelSelector workerId={WORKER_ID} />);
      const user = await openWithKeyboard();

      await user.click(screen.getByRole("option", { name: /Claude Opus 5\.5/ }));

      expect(store.get(selectedModelAtom)).toBe("opus");
      expect(useWorkerAgentStore.getState().metadata.has(WORKER_ID)).toBe(false);
    });
  });
});
