// CommandPalette: the open shortcut is live before the first paint, Spawn
// Worker and Kill <worker> go to the real backend wrappers (no phantom
// store-only workers, no reused names, kill only after confirmation),
// the graph/list shortcut is left to the Workers page, and selections
// feed modern-cmdk's frecency engine through the persisted frecency atom.

import "#test/dom-polyfills";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { getDefaultStore } from "jotai";
import { useLayoutEffect } from "react";
import { toast } from "sonner";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CommandPalette } from "#components/command/CommandPalette";
import { killWorker } from "#lib/tauri";
import { spawnWorkerFromSpec } from "#lib/worker-spawn";
import { frecencyAtom } from "#store/frecency";
import { commandPaletteOpenAtom, currentPageAtom, graphViewAtom } from "#store/ui";
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
  store.set(graphViewAtom, "graph");
  store.set(frecencyAtom, new Map());
  useWorkerStore.setState(useWorkerStore.getInitialState(), true);
  vi.mocked(spawnWorkerFromSpec).mockReset().mockResolvedValue("new-id");
  vi.mocked(killWorker).mockReset().mockResolvedValue(undefined);
  vi.mocked(toast.warning).mockClear();
});

function palette() {
  return screen.findByRole("dialog", { name: "SWARM Command Palette" });
}

function addWorker(id: string, name: string): void {
  useWorkerStore.getState().addWorker({
    id,
    name,
    state: "running",
    startedAt: Temporal.Now.instant().toString(),
  });
}

/** Presses Ctrl+K from a layout effect: after the palette's commit, before any passive effect (and before paint). */
function CtrlKBeforePaint(): null {
  useLayoutEffect(() => {
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true, cancelable: true }),
    );
  }, []);
  return null;
}

/** Selects "Kill <name>" and runs the confirmation toast's Kill action. */
async function killFromPalette(name: string): Promise<void> {
  const user = userEvent.setup();
  render(<CommandPalette />);
  act(() => store.set(commandPaletteOpenAtom, true));
  await user.click(await screen.findByRole("option", { name: `Kill ${name}` }));

  await vi.waitFor(() => expect(toast.warning).toHaveBeenCalledOnce());
  expect(killWorker).not.toHaveBeenCalled();
  const options = vi.mocked(toast.warning).mock.lastCall?.[1];
  const action = options?.action as { onClick: () => void } | undefined;
  action?.onClick();
}

describe("CommandPalette", () => {
  it("handles a Ctrl+K pressed in the first commit's layout phase, before passive effects or paint", () => {
    // The probe is a later sibling, so its layout effect runs after the
    // palette's and before every passive effect of the commit: a
    // useEffect-registered listener would not exist yet and miss it.
    render(
      <>
        <CommandPalette />
        <CtrlKBeforePaint />
      </>,
    );
    expect(store.get(commandPaletteOpenAtom)).toBe(true);
  });

  it("toggles on a plain Ctrl+K once mounted", () => {
    render(<CommandPalette />);
    fireEvent.keyDown(document, { key: "k", ctrlKey: true });
    expect(store.get(commandPaletteOpenAtom)).toBe(true);
    fireEvent.keyDown(document, { key: "k", ctrlKey: true });
    expect(store.get(commandPaletteOpenAtom)).toBe(false);
  });

  it("leaves the graph/list shortcut to the Workers page (one press, one toggle)", () => {
    render(<CommandPalette />);
    fireEvent.keyDown(document, { key: "G", ctrlKey: true, shiftKey: true });
    expect(store.get(graphViewAtom)).toBe("graph");
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

  it("names a new worker with the first free Worker N, never a live worker's name", async () => {
    // Two workers after "Worker 2" was killed: a size-based name would reuse "Worker 3".
    addWorker("w-1", "Worker 1");
    addWorker("w-3", "Worker 3");
    const user = userEvent.setup();
    render(<CommandPalette />);
    act(() => store.set(commandPaletteOpenAtom, true));

    await user.click(await screen.findByRole("option", { name: "Spawn Worker" }));

    await vi.waitFor(() =>
      expect(spawnWorkerFromSpec).toHaveBeenCalledExactlyOnceWith({ name: "Worker 2" }),
    );
  });

  it("Kill <worker> asks first, then kills the backend process before dropping the worker", async () => {
    addWorker("w-1", "Builder");

    await killFromPalette("Builder");

    expect(vi.mocked(toast.warning).mock.lastCall?.[0]).toBe("Kill Builder?");
    await vi.waitFor(() => expect(killWorker).toHaveBeenCalledExactlyOnceWith("w-1"));
    await vi.waitFor(() => expect(useWorkerStore.getState().workers.has("w-1")).toBe(false));
  });

  it("keeps the worker when the backend kill fails", async () => {
    vi.mocked(killWorker).mockRejectedValueOnce(new Error("no such worker"));
    addWorker("w-2", "Keeper");

    await killFromPalette("Keeper");

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
