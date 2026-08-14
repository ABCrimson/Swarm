import { render, screen } from "@testing-library/react";
import { ReactFlowProvider } from "@xyflow/react";
import { describe, expect, it } from "vitest";
import { GraphLegend } from "#components/graph/GraphLegend";
import type { GraphEdgeKind } from "#components/graph/ProvenanceEdge";

function renderLegend(presentKinds: ReadonlySet<GraphEdgeKind>) {
  return render(
    <ReactFlowProvider>
      <GraphLegend presentKinds={presentKinds} />
    </ReactFlowProvider>,
  );
}

describe("GraphLegend — gating", () => {
  it("renders nothing when no edge kinds are present", () => {
    const { container } = renderLegend(new Set());
    expect(container.querySelector(".react-flow__panel")).toBeNull();
  });

  it("renders exactly one row per present kind, in fixed order, Title Case", () => {
    renderLegend(new Set(["command", "spawn"]));

    expect(screen.getByText("Spawn")).toBeInTheDocument();
    expect(screen.getByText("Command")).toBeInTheDocument();
    expect(screen.queryByText("Kill")).not.toBeInTheDocument();
    expect(screen.queryByText("Message")).not.toBeInTheDocument();
    expect(screen.queryByText("Manual")).not.toBeInTheDocument();
  });

  it("gates the manual row separately from measured kinds", () => {
    renderLegend(new Set(["manual"]));

    expect(screen.getByText("Manual")).toBeInTheDocument();
    expect(screen.queryByText("Spawn")).not.toBeInTheDocument();
  });

  it("renders every row when every kind is present", () => {
    renderLegend(new Set(["spawn", "kill", "command", "message", "manual"]));

    for (const label of ["Spawn", "Kill", "Command", "Message", "Manual"]) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
  });
});
