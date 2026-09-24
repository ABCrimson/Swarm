import { render, screen, within } from "@testing-library/react";
import { ReactFlowProvider } from "@xyflow/react";
import { describe, expect, it } from "vitest";
import { GraphLegend } from "#components/graph/GraphLegend";
import type { GraphEdgeKind } from "#components/graph/ProvenanceEdge";
import { KIND_STYLE } from "#components/graph/ProvenanceEdge";

function renderLegend(presentKinds: ReadonlySet<GraphEdgeKind>) {
  return render(
    <ReactFlowProvider>
      <GraphLegend presentKinds={presentKinds} />
    </ReactFlowProvider>,
  );
}

const legend = () => screen.getByRole("note", { name: "Edge Legend" });

describe("GraphLegend — gating", () => {
  it("renders nothing when no edge kinds are present", () => {
    renderLegend(new Set());
    expect(screen.queryByRole("note", { name: "Edge Legend" })).not.toBeInTheDocument();
  });

  it("renders exactly one row per present kind, in fixed order, Title Case", () => {
    renderLegend(new Set(["command", "spawn"]));

    const rows = within(legend()).getAllByText(/^(Spawn|Kill|Command|Message|Manual)$/);
    expect(rows.map((row) => row.textContent)).toEqual(["Spawn", "Command"]);
  });

  it("gates the manual row separately from measured kinds", () => {
    renderLegend(new Set(["manual"]));

    expect(within(legend()).getByText("Manual")).toBeInTheDocument();
    expect(within(legend()).queryByText("Spawn")).not.toBeInTheDocument();
  });

  it("renders every row when every kind is present", () => {
    renderLegend(new Set(["spawn", "kill", "command", "message", "manual"]));

    for (const label of ["Spawn", "Kill", "Command", "Message", "Manual"]) {
      expect(within(legend()).getByText(label)).toBeInTheDocument();
    }
  });

  it("draws each swatch with the canvas edge's own stroke and dash", () => {
    renderLegend(new Set(["kill"]));

    const line = legend().querySelector("line");
    expect(line).toHaveAttribute("stroke", KIND_STYLE.kill.stroke);
    expect(line).toHaveAttribute("stroke-dasharray", KIND_STYLE.kill.dash);
  });

  // ── Visual separation of measured facts from user annotations ──────
  // Same row/style for "Manual" next to "Spawn" would only ASSERT the
  // never-merge claim in prose while looking, on screen, like one more
  // measured kind — these pin down that the separation is visible, not
  // just documented.

  it('shows an "Annotation" group header above the Manual row when manual edges are present', () => {
    renderLegend(new Set(["manual"]));

    expect(within(legend()).getByText("Annotation")).toBeInTheDocument();
  });

  it("draws a separator between measured rows and the Manual row when both are present", () => {
    renderLegend(new Set(["spawn", "manual"]));

    expect(within(legend()).getByRole("separator")).toBeInTheDocument();
    expect(within(legend()).getByText("Annotation")).toBeInTheDocument();
  });

  it("omits the separator when only measured kinds are present (no Manual row to separate from)", () => {
    renderLegend(new Set(["spawn", "command"]));

    expect(within(legend()).queryByRole("separator")).not.toBeInTheDocument();
    expect(within(legend()).queryByText("Annotation")).not.toBeInTheDocument();
  });

  it("omits the separator when only the Manual row is present (nothing above it to separate from)", () => {
    renderLegend(new Set(["manual"]));

    expect(within(legend()).queryByRole("separator")).not.toBeInTheDocument();
  });
});
