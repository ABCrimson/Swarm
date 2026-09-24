// CommandPalette: the open shortcut is live before the first paint, Spawn
// Worker and Kill <worker> go to the real backend wrappers (no phantom
// store-only workers), and selections feed modern-cmdk's frecency engine
// through the persisted frecency atom.

import "#test/dom-polyfills";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { getDefaultStore } from "jotai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CommandPalette } from "#components/command/CommandPalette";
import { killWorker } from "#lib/tauri";
import { spawnWorkerFromSpec } from "#lib/worker-spawn";
import { frecencyAtom } from "#store/frecency";
import { commandPaletteOpenAtom, currentPageAtom } from "#store/ui";
import { useWorkerStore } from "#store/workers";

vi.mock("#lib/worker-spawn", () => ({ spawnWorkerFromSpec: vi.fn() }));
vi.mock("#lib/tauri", async (importOriginal) => ({
  ...(await importOriginal<typeof import("#lib/tauri")>()),
  killWorker: vi.fn(),
}));

const store = getDefaultStore();

beforeEach(() => {
  store.set(commandPaletteOpenAtom, false);
  store.set(currentPageAtom, "dashboard");
  store.set(frecencyAtom, new Map());
  useWorkerStore.setState(useWorkerStore.getInitialState(), true);
  vi.mocked(spawnWorkerFromSpec).mockReset().mockResolvedValue("new-id");
  vi.mocked(killWorker).mockReset().mockResolvedValue(undefined);
});

function palette() {
  return screen.findByRole("dialog", { name: "SWARM Command Palette" });
}

describe("CommandPalette", () => {
  it("opens on a Ctrl+K pressed in the same task as the first render", () => {
    // No act() flush between render and the key press: the listener must
    // already exist when render() returns (layout effect, not passive).
    render(<CommandPalette />);
    fireEvent.keyDown(document, { key: "k", ctrlKey: true });
    expect(store.get(commandPaletteOpenAtom)).toBe(true);
  });

  it("Spawn Worker spawns through the backend, never a store-only worker", async () => {
    const user = userEvent.setup();
    render(<CommandPalette />);
    act(() => store.set(commandPaletteOpenAtom, true));

    await user.click(await screen.findByRole("option", { name: "Spawn Worker" }));

    await vi.waitFor(() =>
      expect(spawnWorkerFromSpec).toHaveBeenCalledExactlyOnceWith({ name: "Worker 1" }),
    );
    expect(useWorkerStore.getState().workers.size).toBe(0);
    expect(store.get(commandPaletteOpenAtom)).toBe(false);
  });

  it("Kill <worker> kills the backend process before dropping the worker", async () => {
    useWorkerStore.getState().addWorker({
      id: "w-1",
      name: "Builder",
      state: "running",
      startedAt: Temporal.Now.instant().toString(),
    });
    const user = userEvent.setup();
    render(<CommandPalette />);
    act(() => store.set(commandPaletteOpenAtom, true));

    await user.click(await screen.findByRole("option", { name: "Kill Builder" }));

    await vi.waitFor(() => expect(killWorker).toHaveBeenCalledExactlyOnceWith("w-1"));
    await vi.waitFor(() => expect(useWorkerStore.getState().workers.has("w-1")).toBe(false));
  });

  it("keeps the worker when the backend kill fails", async () => {
    vi.mocked(killWorker).mockRejectedValueOnce(new Error("no such worker"));
    useWorkerStore.getState().addWorker({
      id: "w-2",
      name: "Keeper",
      state: "running",
      startedAt: Temporal.Now.instant().toString(),
    });
    const user = userEvent.setup();
    render(<CommandPalette />);
    act(() => store.set(commandPaletteOpenAtom, true));

    await user.click(await screen.findByRole("option", { name: "Kill Keeper" }));

    await vi.waitFor(() => expect(killWorker).toHaveBeenCalled());
    expect(useWorkerStore.getState().workers.has("w-2")).toBe(true);
  });

  it("records a selection in the persisted frecency atom when the palette closes", async () => {
    const user = userEvent.setup();
    render(<CommandPalette />);
    act(() => store.set(commandPaletteOpenAtom, true));

    await user.click(await screen.findByRole("option", { name: "Go To Workers" }));

    await vi.waitFor(() => expect(store.get(currentPageAtom)).toBe("workers"));
    await vi.waitFor(() => expect(store.get(frecencyAtom).get("nav:workers")?.uses).toBe(1));

    act(() => store.set(commandPaletteOpenAtom, true));
    const reopened = await palette();
    const [first] = await within(reopened).findAllByRole("option");
    expect(first).toHaveTextContent(/^Go To Workers1$/);
  });
});
