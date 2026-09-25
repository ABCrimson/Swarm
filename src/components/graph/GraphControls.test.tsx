// ── GraphControls ───────────────────────────────────
//
// Zoom-key gating: GraphControls' document-level +/-/0 listener must stay
// quiet while the causality inspector is open (its keys still bubble to
// document), or typing "0" there would fit-view the canvas behind it.
//
// Workflow files: Export/Import need the Tauri dialog + fs plugins, so
// they only render in the desktop app; the dialog awaits sit inside the
// try, and an imported file is validated before it reaches the graph.
//
// `useReactFlow` is mocked (d3-zoom's animated viewport never settles
// deterministically under jsdom), so zoom assertions are on the calls.

import { open } from "@tauri-apps/plugin-dialog";
import { readTextFile } from "@tauri-apps/plugin-fs";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ReactFlowProvider } from "@xyflow/react";
import { createStore, Provider } from "jotai";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GraphControls } from "#components/graph/GraphControls";
import type { WorkflowDefinition } from "#lib/workflow";
import { causalityInspectorAtom } from "#store/ui";

const { zoomIn, zoomOut, fitView } = vi.hoisted(() => ({
  zoomIn: vi.fn(),
  zoomOut: vi.fn(),
  fitView: vi.fn(),
}));

vi.mock(import("@xyflow/react"), async (importOriginal) => ({
  ...(await importOriginal()),
  useReactFlow: (() => ({ zoomIn, zoomOut, fitView })) as never,
}));

const WORKFLOW: WorkflowDefinition = {
  id: "wf-1",
  name: "Saved",
  nodes: [{ id: "w-a", type: "worker", position: { x: 1, y: 2 }, data: {} }],
  edges: [],
};

function renderControls(onImport = vi.fn(() => "Placed 1 Of 1 Nodes, Added 0 Annotations")) {
  const store = createStore();
  render(
    <Provider store={store}>
      <ReactFlowProvider>
        <GraphControls onResetLayout={vi.fn()} getWorkflow={() => WORKFLOW} onImport={onImport} />
      </ReactFlowProvider>
    </Provider>,
  );
  return { store, onImport };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GraphControls — zoom-key gating", () => {
  it("responds to +/-/0 when the causality inspector is closed", async () => {
    const user = userEvent.setup();
    renderControls();

    await user.keyboard("+-0");

    expect(zoomIn).toHaveBeenCalledTimes(1);
    expect(zoomOut).toHaveBeenCalledTimes(1);
    expect(fitView).toHaveBeenCalledTimes(1);
  });

  it("ignores +/-/0 entirely while the causality inspector is open", async () => {
    const user = userEvent.setup();
    const { store } = renderControls();
    act(() => store.set(causalityInspectorAtom, { startSeq: 1 }));

    await user.keyboard("+-0");

    expect(zoomIn).not.toHaveBeenCalled();
    expect(zoomOut).not.toHaveBeenCalled();
    expect(fitView).not.toHaveBeenCalled();
  });

  it("resumes responding to zoom keys once the inspector closes (no re-subscription needed)", async () => {
    const user = userEvent.setup();
    const { store } = renderControls();
    act(() => store.set(causalityInspectorAtom, { startSeq: 1 }));
    act(() => store.set(causalityInspectorAtom, null));

    await user.keyboard("+");

    expect(zoomIn).toHaveBeenCalledTimes(1);
  });
});

describe("GraphControls — workflow files", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("hides Export/Import outside the desktop app (no Tauri dialog/fs plugins)", () => {
    renderControls();

    expect(screen.queryByRole("button", { name: "Export Workflow" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Import Workflow" })).not.toBeInTheDocument();
  });

  describe("in the desktop app", () => {
    beforeEach(() => {
      vi.stubGlobal("isTauri", true);
    });

    it("validates the file and hands a valid workflow to onImport", async () => {
      const user = userEvent.setup();
      vi.mocked(open).mockResolvedValueOnce("/tmp/wf.json");
      vi.mocked(readTextFile).mockResolvedValueOnce(JSON.stringify(WORKFLOW));
      const { onImport } = renderControls();

      await user.click(screen.getByRole("button", { name: "Import Workflow" }));

      await waitFor(() => expect(onImport).toHaveBeenCalledWith(WORKFLOW));
      expect(toast.success).toHaveBeenCalledWith("Workflow Imported", {
        description: "Placed 1 Of 1 Nodes, Added 0 Annotations",
      });
    });

    it("rejects a file that is not a workflow without touching the graph", async () => {
      const user = userEvent.setup();
      vi.mocked(open).mockResolvedValueOnce("/tmp/wf.json");
      vi.mocked(readTextFile).mockResolvedValueOnce(JSON.stringify({ name: "No Nodes" }));
      const { onImport } = renderControls();

      await user.click(screen.getByRole("button", { name: "Import Workflow" }));

      await waitFor(() => expect(toast.error).toHaveBeenCalled());
      expect(vi.mocked(toast.error).mock.calls[0]?.[0]).toBe("Import Failed");
      expect(onImport).not.toHaveBeenCalled();
    });

    it("reports a failing file dialog as a toast instead of an unhandled rejection", async () => {
      const user = userEvent.setup();
      vi.mocked(open).mockRejectedValueOnce(new Error("dialog unavailable"));
      renderControls();

      await user.click(screen.getByRole("button", { name: "Import Workflow" }));

      await waitFor(() =>
        expect(toast.error).toHaveBeenCalledWith("Import Failed", {
          description: "dialog unavailable",
        }),
      );
    });
  });
});
