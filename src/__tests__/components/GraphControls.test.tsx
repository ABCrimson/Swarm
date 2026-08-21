// ── GraphControls — zoom-key gating on the causality inspector ───────
//
// The causality inspector's document-level Escape/focus-trap listeners
// live alongside GraphControls' own document-level +/-/0 zoom-key
// listener — without a gate, typing "0" to do nothing in particular
// inside the modal would also fit-view the canvas behind it. This pins
// the fix down: the atom being non-null suppresses the zoom shortcuts
// entirely.
//
// `useReactFlow` is mocked (real d3-zoom viewport animation doesn't
// settle deterministically under jsdom, matching this codebase's
// established practice of not chasing full XYFlow interaction fidelity
// in tests — see WorkerGraph.test.tsx's ResizeObserver doc) so this
// asserts directly on whether `zoomIn`/`zoomOut`/`fitView` were called,
// rather than on an animated viewport value that may never settle here.

import { act, render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ReactFlowProvider } from "@xyflow/react";
import { getDefaultStore } from "jotai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { causalityInspectorAtom } from "#store/ui";

const zoomInMock = vi.fn();
const zoomOutMock = vi.fn();
const fitViewMock = vi.fn();

vi.mock("@xyflow/react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@xyflow/react")>();
  return {
    ...actual,
    useReactFlow: () => ({
      zoomIn: zoomInMock,
      zoomOut: zoomOutMock,
      fitView: fitViewMock,
      setNodes: vi.fn(),
      setEdges: vi.fn(),
    }),
  };
});

import { GraphControls } from "#components/graph/GraphControls";

function renderControls() {
  return render(
    <ReactFlowProvider>
      <GraphControls onResetLayout={vi.fn()} />
    </ReactFlowProvider>,
  );
}

describe("GraphControls — zoom-key gating", () => {
  beforeEach(() => {
    zoomInMock.mockReset();
    zoomOutMock.mockReset();
    fitViewMock.mockReset();
  });

  afterEach(() => {
    getDefaultStore().set(causalityInspectorAtom, null);
  });

  it("responds to +/-/0 when the causality inspector is closed", async () => {
    const user = userEvent.setup();
    renderControls();

    await user.keyboard("+");
    await user.keyboard("-");
    await user.keyboard("0");

    expect(zoomInMock).toHaveBeenCalledTimes(1);
    expect(zoomOutMock).toHaveBeenCalledTimes(1);
    expect(fitViewMock).toHaveBeenCalledTimes(1);
  });

  it("ignores +/-/0 entirely while the causality inspector is open", async () => {
    const user = userEvent.setup();
    getDefaultStore().set(causalityInspectorAtom, { startSeq: 1 });
    renderControls();

    await user.keyboard("+");
    await user.keyboard("-");
    await user.keyboard("0");

    expect(zoomInMock).not.toHaveBeenCalled();
    expect(zoomOutMock).not.toHaveBeenCalled();
    expect(fitViewMock).not.toHaveBeenCalled();
  });

  it("resumes responding to zoom keys once the inspector closes", async () => {
    const user = userEvent.setup();
    getDefaultStore().set(causalityInspectorAtom, { startSeq: 1 });
    renderControls();

    act(() => {
      getDefaultStore().set(causalityInspectorAtom, null);
    });
    await user.keyboard("+");

    expect(zoomInMock).toHaveBeenCalledTimes(1);
  });
});
