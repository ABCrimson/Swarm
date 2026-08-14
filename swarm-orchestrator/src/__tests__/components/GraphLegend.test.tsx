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

  // ── Visual separation of measured facts from user annotations ──────
  // Same row/style for "Manual" next to "Spawn" would only ASSERT the
  // never-merge claim in prose while looking, on screen, like one more
  // measured kind — these pin down that the separation is visible, not
  // just documented.

  it('shows an "Annotation" group header above the Manual row when manual edges are present', () => {
    renderLegend(new Set(["manual"]));

    expect(screen.getByText("Annotation")).toBeInTheDocument();
  });

  it("draws a separator between measured rows and the Manual row when both are present", () => {
    const { container } = renderLegend(new Set(["spawn", "manual"]));

    expect(container.querySelector("hr")).not.toBeNull();
    expect(screen.getByText("Annotation")).toBeInTheDocument();
  });

  it("omits the separator when only measured kinds are present (no Manual row to separate from)", () => {
    const { container } = renderLegend(new Set(["spawn", "command"]));

    expect(container.querySelector("hr")).toBeNull();
    expect(screen.queryByText("Annotation")).not.toBeInTheDocument();
  });

  it("omits the separator when only the Manual row is present (nothing above it to separate from)", () => {
    const { container } = renderLegend(new Set(["manual"]));

    expect(container.querySelector("hr")).toBeNull();
  });
});
