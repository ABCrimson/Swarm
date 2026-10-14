import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionCard } from "#components/session/SessionCard";
import type { Session } from "#store/types";
import { useWorkerStore } from "#store/workers";

// jsdom implements neither the Popover API nor `popovertarget` invokers,
// and its UA sheet hides every `[popover]` (it cannot match
// `:popover-open`). This stand-in models what SessionCard relies on: open
// state (as `data-popover-open`, shown via an inline `display`), the
// `toggle` event React's `onToggle` reads, and a `popovertarget` click
// toggling its target. Light dismiss and focus restoration are the
// browser's job and are not simulated.
let uninstallPopover = () => {};
beforeAll(() => {
  const proto = HTMLElement.prototype;
  const originals = {
    showPopover: proto.showPopover,
    hidePopover: proto.hidePopover,
    togglePopover: proto.togglePopover,
  };
  const setOpen = (element: HTMLElement, open: boolean) => {
    if (element.hasAttribute("data-popover-open") === open) return;
    element.toggleAttribute("data-popover-open", open);
    element.style.display = open ? "block" : "";
    element.dispatchEvent(
      Object.assign(new Event("toggle"), {
        newState: open ? "open" : "closed",
        oldState: open ? "closed" : "open",
      }),
    );
  };
  proto.showPopover = function (this: HTMLElement) {
    setOpen(this, true);
  };
  proto.hidePopover = function (this: HTMLElement) {
    setOpen(this, false);
  };
  proto.togglePopover = function (this: HTMLElement) {
    setOpen(this, !this.hasAttribute("data-popover-open"));
    return this.hasAttribute("data-popover-open");
  };
  const onClick = (event: MouseEvent) => {
    const targetId = (event.target as Element)
      .closest("[popovertarget]")
      ?.getAttribute("popovertarget");
    if (targetId != null) document.getElementById(targetId)?.togglePopover();
  };
  document.addEventListener("click", onClick);
  uninstallPopover = () => {
    document.removeEventListener("click", onClick);
    Object.assign(proto, originals);
  };
});
afterAll(() => uninstallPopover());

const SESSION_ID = "0f0e0d0c-0b0a-4908-8706-050403020100";

function createSession(overrides?: Partial<Session>): Session {
  return {
    id: SESSION_ID,
    name: "Test Session",
    workerIds: [],
    createdAt: "2026-01-15T10:30:00.000Z",
    updatedAt: "2026-01-15T10:30:00.000Z",
    ...overrides,
  };
}

function renderCard(overrides: Partial<React.ComponentProps<typeof SessionCard>> = {}) {
  const props: React.ComponentProps<typeof SessionCard> = {
    session: createSession(),
    isActive: false,
    onActivate: vi.fn(),
    onExport: vi.fn(),
    onCreateTemplate: vi.fn(),
    onDelete: vi.fn(),
    ...overrides,
  };
  render(<SessionCard {...props} />);
  return props;
}

function resetWorkerStore(): void {
  for (const [id] of useWorkerStore.getState().workers) useWorkerStore.getState().removeWorker(id);
}

/** `true` makes the active transport report no workspace browsing (the `build:web` page). */
const web = vi.hoisted(() => ({ on: false }));
vi.mock(import("#lib/tauri"), async (importOriginal) => ({
  ...(await importOriginal()),
  hasCapability: () => !web.on,
}));

describe("SessionCard", () => {
  // Unmount before the store reset, so the reset never re-renders a
  // still-mounted card outside act().
  // Save As Template writes a plugin-store file, which needs the Tauri bridge.
  beforeEach(() => {
    vi.stubGlobal("isTauri", true);
  });
  afterEach(() => {
    cleanup();
    resetWorkerStore();
    web.on = false;
    vi.unstubAllGlobals();
  });

  it("marks Save As Template unavailable, with the reason, without the Tauri bridge", async () => {
    vi.unstubAllGlobals();
    const user = userEvent.setup();
    const props = renderCard();

    await user.click(screen.getByRole("button", { name: 'Actions For Session "Test Session"' }));
    const item = screen.getByRole("menuitem", { name: "Save As Template" });

    expect(item).toHaveAttribute("aria-disabled", "true");
    expect(item).toHaveAccessibleDescription("Available In The Desktop App Only");
    await user.click(item);
    expect(props.onCreateTemplate).not.toHaveBeenCalled();
  });

  it("marks Export As JSON unavailable, with the reason, when the transport cannot browse files", async () => {
    web.on = true;
    const user = userEvent.setup();
    const props = renderCard();

    await user.click(screen.getByRole("button", { name: 'Actions For Session "Test Session"' }));
    const item = screen.getByRole("menuitem", { name: "Export As JSON" });

    expect(item).toHaveAttribute("aria-disabled", "true");
    expect(item).toHaveAccessibleDescription("Available In The Desktop App Only");
    expect(item).toHaveFocus();
    await user.click(item);
    expect(props.onExport).not.toHaveBeenCalled();
  });

  // ── live worker count ──
  // `session.workerIds` can name workers that are gone: pruning via
  // `session_remove_worker` is asynchronous and best-effort, and sessions
  // restored at startup list the previous run's workers. The card counts
  // only workers still in the live worker store.

  it("counts only the workerIds that still exist in the live worker store", () => {
    const liveId = "11111111-2222-4333-8444-555555555555";
    useWorkerStore.getState().addWorker({
      id: liveId,
      state: "running",
      name: "Still Running",
      startedAt: new Date().toISOString(),
    });

    renderCard({
      session: createSession({
        workerIds: [
          liveId,
          "22222222-3333-4444-8555-666666666666",
          "33333333-4444-4555-8666-777777777777",
        ],
      }),
    });

    expect(screen.getByText("1 Worker")).toBeInTheDocument();
    expect(screen.queryByText("3 Workers")).not.toBeInTheDocument();
  });

  it("shows zero when every worker in the session has since been killed", () => {
    renderCard({
      session: createSession({
        workerIds: ["11111111-2222-4333-8444-555555555555", "22222222-3333-4444-8555-666666666666"],
      }),
    });

    expect(screen.getByText("0 Workers")).toBeInTheDocument();
  });

  // ── activation ──

  it("activates the session on click and marks the active one with aria-current", async () => {
    const user = userEvent.setup();
    const props = renderCard({ isActive: true });

    const card = screen.getByRole("button", { name: /^Test Session/ });
    expect(card).toHaveAttribute("aria-current", "true");
    await user.click(card);
    expect(props.onActivate).toHaveBeenCalledExactlyOnceWith(SESSION_ID);
  });

  it("does not mark an inactive session as current", () => {
    renderCard();
    expect(screen.getByRole("button", { name: /^Test Session/ })).not.toHaveAttribute(
      "aria-current",
    );
  });

  // ── actions menu ──

  it("opens the actions menu from a keyboard-reachable button, focusing its first item", async () => {
    const user = userEvent.setup();
    renderCard();

    const trigger = screen.getByRole("button", { name: 'Actions For Session "Test Session"' });
    expect(trigger).toHaveAttribute("aria-haspopup", "menu");
    await user.click(trigger);

    const menu = screen.getByRole("menu", { name: 'Actions For Session "Test Session"' });
    expect(menu).toHaveAttribute("data-popover-open");
    expect(within(menu).getByRole("menuitem", { name: "Export As JSON" })).toHaveFocus();
  });

  it("moves focus with the arrow keys (wrapping), Home and End", async () => {
    const user = userEvent.setup();
    renderCard();
    await user.click(screen.getByRole("button", { name: /^Actions For Session/ }));
    const item = (name: string) => screen.getByRole("menuitem", { name });

    await user.keyboard("{ArrowDown}");
    expect(item("Save As Template")).toHaveFocus();
    await user.keyboard("{ArrowDown}");
    expect(item("Delete Session")).toHaveFocus();
    await user.keyboard("{ArrowDown}");
    expect(item("Export As JSON")).toHaveFocus();
    await user.keyboard("{ArrowUp}");
    expect(item("Delete Session")).toHaveFocus();
    await user.keyboard("{Home}");
    expect(item("Export As JSON")).toHaveFocus();
    await user.keyboard("{End}");
    expect(item("Delete Session")).toHaveFocus();
  });

  it("runs the chosen action for this session and closes the menu", async () => {
    const user = userEvent.setup();
    const props = renderCard();
    await user.click(screen.getByRole("button", { name: /^Actions For Session/ }));

    await user.keyboard("{End}{Enter}");

    expect(props.onDelete).toHaveBeenCalledExactlyOnceWith(SESSION_ID);
    expect(props.onExport).not.toHaveBeenCalled();
    expect(screen.getByRole("menu", { hidden: true })).not.toHaveAttribute("data-popover-open");
  });

  it("closes the menu on Tab", async () => {
    const user = userEvent.setup();
    renderCard();
    await user.click(screen.getByRole("button", { name: /^Actions For Session/ }));

    await user.keyboard("{Tab}");

    expect(screen.getByRole("menu", { hidden: true })).not.toHaveAttribute("data-popover-open");
  });

  it("opens the same menu on right-click", async () => {
    const user = userEvent.setup();
    const props = renderCard();

    fireEvent.contextMenu(screen.getByRole("button", { name: /^Test Session/ }));
    const menu = screen.getByRole("menu");
    expect(menu).toHaveAttribute("data-popover-open");

    await user.click(within(menu).getByRole("menuitem", { name: "Save As Template" }));
    expect(props.onCreateTemplate).toHaveBeenCalledExactlyOnceWith(SESSION_ID);
  });
});
