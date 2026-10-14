// The menu is a native popover (see the shim's header).
import "#test/top-layer-shim";

import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GraphContextMenu } from "#components/graph/GraphContextMenu";
import { useWorkerStore } from "#store/workers";

const ipc = vi.hoisted(() => ({
  pauseWorker: vi.fn(async (_id: string) => {}),
  resumeWorker: vi.fn(async (_id: string) => {}),
  killWorker: vi.fn(async (_id: string) => {}),
}));
vi.mock(import("#lib/tauri"), async (importOriginal) => ({ ...(await importOriginal()), ...ipc }));

const tick = () => act(() => new Promise((resolve) => setTimeout(resolve, 10)));

function renderMenu(strict = false) {
  const onClose = vi.fn();
  const onInspect = vi.fn();
  const menu = (
    <GraphContextMenu x={10} y={20} workerId="w-a" onInspect={onInspect} onClose={onClose} />
  );
  render(strict ? <StrictMode>{menu}</StrictMode> : menu);
  return { onClose, onInspect };
}

describe("GraphContextMenu", () => {
  beforeEach(() => {
    act(() =>
      useWorkerStore.getState().addWorker({
        id: "w-a",
        name: "Alpha",
        state: "paused",
        startedAt: new Date(0).toISOString(),
      }),
    );
  });
  afterEach(() => {
    act(() => useWorkerStore.getState().removeWorker("w-a"));
    vi.clearAllMocks();
  });

  it("stays open under StrictMode's effect replay", async () => {
    const { onClose } = renderMenu(true);

    await tick();

    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("menu", { name: "Alpha" })).toBeVisible();
  });

  it("with a button still held, opens only after the release (so the release cannot dismiss it)", async () => {
    const onClose = vi.fn();
    render(
      <GraphContextMenu
        x={10}
        y={20}
        workerId="w-a"
        openOnRelease
        onInspect={vi.fn()}
        onClose={onClose}
      />,
    );

    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    act(() => {
      window.dispatchEvent(new Event("pointerup"));
    });
    await tick();

    expect(screen.getByRole("menu", { name: "Alpha" })).toBeVisible();
    expect(screen.getByRole("menuitem", { name: "Pause" })).toHaveFocus();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("offers the actions the worker's state allows", () => {
    renderMenu();

    expect(screen.getByRole("menuitem", { name: "Pause" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    expect(screen.getByRole("menuitem", { name: "Resume" })).not.toHaveAttribute("aria-disabled");
  });

  it("Resume closes the menu and reaches the resume IPC", async () => {
    const user = userEvent.setup();
    const { onClose } = renderMenu();

    await user.click(screen.getByRole("menuitem", { name: "Resume" }));
    await tick();

    expect(ipc.resumeWorker).toHaveBeenCalledWith("w-a");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("a disabled item does nothing", async () => {
    const user = userEvent.setup();
    const { onClose } = renderMenu();

    await user.click(screen.getByRole("menuitem", { name: "Pause" }));
    await tick();

    expect(ipc.pauseWorker).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("Home/End and wrapping arrows move focus; Enter activates the focused item", async () => {
    const user = userEvent.setup();
    const { onClose, onInspect } = renderMenu();

    await user.keyboard("{End}");
    expect(screen.getByRole("menuitem", { name: "Kill" })).toHaveFocus();
    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("menuitem", { name: "Pause" })).toHaveFocus();
    await user.keyboard("{Home}{ArrowDown}{ArrowDown}{Enter}");
    expect(onInspect).toHaveBeenCalledTimes(1);
    await tick();
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe("GraphContextMenu — Trojan Source", () => {
  it("names the menu with the worker name's bidi override escaped", async () => {
    act(() =>
      useWorkerStore.getState().addWorker({
        id: "w-rlo",
        name: "a\u202Eb",
        state: "paused",
        startedAt: new Date(0).toISOString(),
      }),
    );
    render(<GraphContextMenu x={1} y={2} workerId="w-rlo" onInspect={vi.fn()} onClose={vi.fn()} />);
    await tick();

    expect(screen.getByRole("menu", { name: String.raw`a\u202Eb` })).toBeVisible();
    act(() => useWorkerStore.getState().removeWorker("w-rlo"));
  });
});
