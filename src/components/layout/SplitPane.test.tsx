import { act, fireEvent, render, screen } from "@testing-library/react";
import { createStore, Provider } from "jotai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SplitPane } from "#components/layout/SplitPane";
import { paneSizesAtom } from "#store/ui";

function renderSplit(store = createStore(), direction: "horizontal" | "vertical" = "horizontal") {
  const writes: unknown[] = [];
  store.sub(paneSizesAtom, () => writes.push(store.get(paneSizesAtom)));
  const { container } = render(
    <Provider store={store}>
      <SplitPane direction={direction} primary={<p>Primary</p>} secondary={<p>Secondary</p>} />
    </Provider>,
  );
  const grid = container.firstElementChild as HTMLElement;
  // jsdom has no layout: give the container a 1000px box.
  vi.spyOn(grid, "getBoundingClientRect").mockReturnValue(
    DOMRect.fromRect({ width: 1000, height: 1000 }),
  );
  return { store, grid, writes, divider: screen.getByRole("separator") };
}

beforeEach(() => {
  // jsdom implements neither pointer capture method.
  HTMLElement.prototype.setPointerCapture = vi.fn();
  HTMLElement.prototype.releasePointerCapture = vi.fn();
});

describe("SplitPane", () => {
  it("lays out the panes from the persisted size", () => {
    const { grid, divider } = renderSplit();

    expect(grid.style.gridTemplate).toContain("60% 4px 1fr");
    expect(divider).toHaveAttribute("aria-valuenow", "60");
    expect(divider).toHaveAttribute("aria-controls", screen.getByText("Primary").parentElement?.id);
  });

  // A drag persists once, when the pointer capture ends, not on every pointermove.
  it("persists a drag once, when the pointer capture ends", () => {
    const { store, grid, writes, divider } = renderSplit();

    fireEvent.pointerDown(divider, { button: 0, pointerId: 1, clientX: 600 });
    for (const clientX of [550, 500, 450, 400]) {
      fireEvent.pointerMove(divider, { pointerId: 1, clientX });
    }
    expect(grid.style.gridTemplate).toContain("40% 4px 1fr");
    expect(writes).toHaveLength(0);

    fireEvent.lostPointerCapture(divider, { pointerId: 1 });

    expect(writes).toHaveLength(1);
    expect(store.get(paneSizesAtom)).toEqual({ main: 40, detail: 60 });
    expect(divider).not.toHaveAttribute("data-dragging");
  });

  it("clamps a drag to the limits", () => {
    const { store, divider } = renderSplit();

    fireEvent.pointerDown(divider, { button: 0, pointerId: 1, clientX: 600 });
    fireEvent.pointerMove(divider, { pointerId: 1, clientX: 990 });
    fireEvent.lostPointerCapture(divider, { pointerId: 1 });

    expect(store.get(paneSizesAtom).main).toBe(80);
  });

  it("ignores non-primary buttons and moves without a drag", () => {
    const { writes, grid, divider } = renderSplit();

    fireEvent.pointerDown(divider, { button: 2, pointerId: 1, clientX: 300 });
    fireEvent.pointerMove(divider, { pointerId: 1, clientX: 300 });
    fireEvent.lostPointerCapture(divider, { pointerId: 1 });

    expect(grid.style.gridTemplate).toContain("60% 4px 1fr");
    expect(writes).toHaveLength(0);
  });

  // A stored value outside [minPercent, maxPercent] (corrupt, or written by
  // another build) is clamped on read.
  it("clamps an out-of-range hydrated size", () => {
    const { store, grid } = renderSplit();
    act(() => store.set(paneSizesAtom, { main: 99, detail: 1 }));
    expect(grid.style.gridTemplate).toContain("80% 4px 1fr");
  });

  it("falls back to an even split when the hydrated size is not a number", () => {
    const { store, grid } = renderSplit();
    act(() => store.set(paneSizesAtom, { main: Number.NaN, detail: Number.NaN }));
    expect(grid.style.gridTemplate).toContain("50% 4px 1fr");
  });

  it.for([
    ["ArrowRight", 62],
    ["ArrowLeft", 58],
    ["Home", 20],
    ["End", 80],
  ] as const)("moves the divider with %s", ([key, expected]) => {
    const { store, divider } = renderSplit();

    fireEvent.keyDown(divider, { key });

    expect(store.get(paneSizesAtom).main).toBe(expected);
  });

  it("uses Up/Down for a vertical split", () => {
    const { store, grid, divider } = renderSplit(createStore(), "vertical");
    expect(grid.style.gridTemplate).toContain('"primary" 60%');

    fireEvent.keyDown(divider, { key: "ArrowDown" });
    expect(store.get(paneSizesAtom).main).toBe(62);
    fireEvent.keyDown(divider, { key: "ArrowRight" });
    expect(store.get(paneSizesAtom).main).toBe(62);
  });
});
