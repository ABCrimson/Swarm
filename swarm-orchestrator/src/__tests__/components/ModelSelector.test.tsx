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

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { getDefaultStore } from "jotai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ModelSelector } from "#components/ai/ModelSelector";
import { selectedModelAtom } from "#store/ui";

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
});
