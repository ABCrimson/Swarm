// ── ModelSelector Portal Tests ───────────────────────
//
// Covers batch-1 task 6: the model dropdown used to render inline
// inside WorkerAIPanel's `backdrop-filter` toolbar, which creates a CSS
// stacking context that trapped the dropdown's z-index inside it — the
// panel rendered behind the rest of the app regardless of its own
// z-index. It's now portaled to document.body via `createPortal`,
// positioned from the trigger's `getBoundingClientRect()`.
//
// These tests assert: (a) the open panel actually escapes the toolbar
// subtree, (b) it receives position styles derived from the trigger's
// rect, (c) portal-aware click-outside/click-inside-panel behavior —
// the classic portal regression, where a DOM-containment check against
// the trigger's local container incorrectly closes a portaled panel —
// and (d) keyboard selection still works end-to-end.

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { getDefaultStore } from "jotai";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ModelSelector } from "#components/ai/ModelSelector";
import { selectedModelAtom } from "#store/ui";
import { useWorkerAgentStore } from "#store/worker-agents";

const TRIGGER_RECT = DOMRect.fromRect({ x: 50, y: 200, width: 100, height: 30 });

async function openDropdown(): Promise<ReturnType<typeof userEvent.setup>> {
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Select AI Model" }));
  return user;
}

describe("ModelSelector portal", () => {
  const store = getDefaultStore();

  beforeEach(() => {
    store.set(selectedModelAtom, "sonnet");
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(TRIGGER_RECT);
  });

  afterEach(() => {
    cleanup();
    store.set(selectedModelAtom, "sonnet");
    vi.restoreAllMocks();
  });

  it("mounts the open panel outside the toolbar subtree, as a direct child of document.body", async () => {
    render(
      <div data-testid="toolbar">
        <ModelSelector />
      </div>,
    );

    await openDropdown();

    const panel = screen.getByRole("listbox", { name: "AI Model Options" });
    expect(panel.closest('[data-testid="toolbar"]')).toBeNull();
    expect(panel.parentElement).toBe(document.body);
  });

  it("positions the panel from the trigger's bounding rect", async () => {
    render(<ModelSelector />);

    await openDropdown();

    const panel = screen.getByRole("listbox", { name: "AI Model Options" });
    expect(panel).toHaveStyle({
      position: "fixed",
      top: "234px", // rect.bottom (230) + 4
      left: "50px", // rect.left
      width: "100px", // rect.width
    });
  });

  it("closes on an outside click but stays open for a click inside the panel", async () => {
    render(<ModelSelector />);
    const outside = document.createElement("div");
    document.body.appendChild(outside);

    await openDropdown();
    expect(screen.getByRole("listbox")).toBeInTheDocument();

    // Click inside the portaled panel, not on any option — must not close.
    // (Pre-fix, this DOM node isn't a descendant of the trigger's local
    // container, so a naive containment check against that container
    // alone would have wrongly treated this as an outside click.)
    fireEvent.mouseDown(screen.getByRole("listbox"));
    expect(screen.getByRole("listbox")).toBeInTheDocument();

    // Click truly outside both the trigger and the portaled panel — must
    // close. The `open` state (and aria-expanded) flips synchronously;
    // the panel's own DOM node lingers briefly for its exit animation
    // (AnimatePresence), so wait for that to finish unmounting it.
    fireEvent.mouseDown(outside);
    expect(screen.getByRole("button", { name: "Select AI Model" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    await waitFor(() => {
      expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    });

    document.body.removeChild(outside);
  });

  it("selects a model via keyboard (focus + Enter) and closes the panel", async () => {
    render(<ModelSelector />);
    const user = await openDropdown();

    const option = screen.getByRole("option", { name: /Claude Opus 4\.8/ });
    option.focus();
    await user.keyboard("{Enter}");

    expect(screen.getByRole("button", { name: "Select AI Model" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    expect(store.get(selectedModelAtom)).toBe("opus");
    await waitFor(() => {
      expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    });
    expect(screen.getByRole("button", { name: "Select AI Model" })).toHaveTextContent(
      "Claude Opus 4.8",
    );
  });

  it("still shows the Requires Project Glasswing badge for the gated Mythos option", async () => {
    render(<ModelSelector />);

    await openDropdown();

    const option = screen.getByRole("option", { name: /Claude Mythos 5/ });
    expect(option).toHaveTextContent("Requires Project Glasswing");
  });

  it("renders the gated badge and capability chips via the shared Pill component (batch-1 task 7)", async () => {
    render(<ModelSelector />);

    await openDropdown();

    const option = screen.getByRole("option", { name: /Claude Mythos 5/ });
    const gatedBadge = within(option).getByText("Requires Project Glasswing");
    expect(gatedBadge.closest(".swarm-pill")).toHaveAttribute("data-tone", "warning");

    const capabilityChip = within(option).getByText("Agentic Work");
    expect(capabilityChip.closest(".swarm-pill")).toHaveAttribute("data-tone", "neutral");
  });

  it("closes the panel when keyboard focus moves outside it (tab-away), without stealing focus back to the trigger", async () => {
    render(<ModelSelector />);
    const outside = document.createElement("button");
    outside.textContent = "outside";
    document.body.appendChild(outside);

    await openDropdown();
    expect(screen.getByRole("listbox")).toBeInTheDocument();

    // Simulate tab-away past the last option: focus lands on an element
    // outside both the trigger's container and the portaled panel.
    outside.focus();
    fireEvent.focusIn(outside);

    expect(screen.getByRole("button", { name: "Select AI Model" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    await waitFor(() => {
      expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    });
    // Unlike Escape, tab-driven focus-out must not force focus back onto
    // the trigger — that would fight native tab order.
    expect(document.activeElement).toBe(outside);

    document.body.removeChild(outside);
  });

  it("does not close the panel when focus moves within it (e.g. onto an option)", async () => {
    render(<ModelSelector />);

    await openDropdown();
    expect(screen.getByRole("listbox")).toBeInTheDocument();

    const option = screen.getByRole("option", { name: /Claude Opus 4\.8/ });
    option.focus();
    fireEvent.focusIn(option);

    expect(screen.getByRole("listbox")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Select AI Model" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
  });

  describe("Mythos gating toast (Task 8 item 2)", () => {
    beforeEach(() => {
      vi.mocked(toast.warning).mockClear();
      vi.mocked(toast.success).mockClear();
    });

    it("fires exactly one toast.warning, and no toast.success, when Mythos is selected", async () => {
      render(<ModelSelector />);
      const user = await openDropdown();

      const option = screen.getByRole("option", { name: /Claude Mythos 5/ });
      option.focus();
      await user.keyboard("{Enter}");

      expect(toast.warning).toHaveBeenCalledTimes(1);
      expect(toast.warning).toHaveBeenCalledWith(
        "Claude Mythos 5 Requires Project Glasswing Access",
      );
      expect(toast.success).not.toHaveBeenCalled();
    });

    it("fires no toast for a non-gated selection (unchanged behavior)", async () => {
      render(<ModelSelector />);
      const user = await openDropdown();

      const option = screen.getByRole("option", { name: /Claude Opus 4\.8/ });
      option.focus();
      await user.keyboard("{Enter}");

      expect(toast.warning).not.toHaveBeenCalled();
      expect(toast.success).not.toHaveBeenCalled();
    });
  });

  describe("per-worker model override (fix wave, item NEW-2)", () => {
    const WORKER_ID = "11111111-2222-3333-8444-555555555555";

    afterEach(() => {
      useWorkerAgentStore.getState().removeAgentMetadata(WORKER_ID);
    });

    it("displays the worker's pinned model instead of the global selection", async () => {
      // Global selection is sonnet (see outer beforeEach), but this
      // worker was spawned from a template pinning opus — the trigger
      // must show what requests actually use, not the global atom.
      useWorkerAgentStore.getState().setAgentMetadata(WORKER_ID, {
        role: "supervisor",
        model: "opus",
        systemPrompt: "You coordinate.",
      });

      render(<ModelSelector workerId={WORKER_ID} />);

      expect(screen.getByRole("button", { name: "Select AI Model" })).toHaveTextContent(
        "Claude Opus 4.8",
      );
      expect(store.get(selectedModelAtom)).toBe("sonnet");
    });

    it("writes a manual pick into the worker's own metadata entry, not the global atom", async () => {
      useWorkerAgentStore.getState().setAgentMetadata(WORKER_ID, {
        role: "supervisor",
        model: "opus",
        systemPrompt: "You coordinate.",
      });

      render(<ModelSelector workerId={WORKER_ID} />);
      const user = await openDropdown();

      const option = screen.getByRole("option", { name: /Claude Haiku 4\.5/ });
      option.focus();
      await user.keyboard("{Enter}");

      // The exact entry AIChat reads (agentMetadata.model) to resolve
      // this worker's effective model for its next request.
      expect(useWorkerAgentStore.getState().metadata.get(WORKER_ID)?.model).toBe("haiku");
      // Every other worker's chat and Settings share this atom — a pick
      // for one worker must never leak into it.
      expect(store.get(selectedModelAtom)).toBe("sonnet");
      expect(screen.getByRole("button", { name: "Select AI Model" })).toHaveTextContent(
        "Claude Haiku 4.5",
      );
    });

    it("keeps the systemPrompt/role untouched when only the model is picked", async () => {
      useWorkerAgentStore.getState().setAgentMetadata(WORKER_ID, {
        role: "supervisor",
        model: "opus",
        systemPrompt: "You coordinate.",
      });

      render(<ModelSelector workerId={WORKER_ID} />);
      const user = await openDropdown();
      const option = screen.getByRole("option", { name: /Claude Haiku 4\.5/ });
      option.focus();
      await user.keyboard("{Enter}");

      const metadata = useWorkerAgentStore.getState().metadata.get(WORKER_ID);
      expect(metadata?.role).toBe("supervisor");
      expect(metadata?.systemPrompt).toBe("You coordinate.");
    });

    it("falls back to the global atom for a worker with no agent metadata (non-templated worker)", async () => {
      render(<ModelSelector workerId={WORKER_ID} />);
      const user = await openDropdown();

      expect(screen.getByRole("button", { name: "Select AI Model" })).toHaveTextContent(
        "Claude Sonnet 5",
      );

      const option = screen.getByRole("option", { name: /Claude Opus 4\.8/ });
      option.focus();
      await user.keyboard("{Enter}");

      expect(store.get(selectedModelAtom)).toBe("opus");
      expect(useWorkerAgentStore.getState().metadata.has(WORKER_ID)).toBe(false);
    });
  });
});
