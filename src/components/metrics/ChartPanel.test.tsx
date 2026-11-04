import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ChartPanel } from "#components/metrics/ChartPanel";

describe("ChartPanel", () => {
  it.each([0, 1])("shows the waiting line instead of the chart with %i samples", (sampleCount) => {
    render(
      <ChartPanel title="CPU Usage" sampleCount={sampleCount}>
        <span>Chart Body</span>
      </ChartPanel>,
    );

    expect(screen.getByText("Waiting For Samples")).toBeInTheDocument();
    expect(screen.queryByText("Chart Body")).not.toBeInTheDocument();
  });

  it("draws the chart once two samples exist, and for a snapshot chart with no count", () => {
    const { rerender } = render(
      <ChartPanel title="CPU Usage" sampleCount={2}>
        <span>Chart Body</span>
      </ChartPanel>,
    );
    expect(screen.getByText("Chart Body")).toBeInTheDocument();

    rerender(
      <ChartPanel title="AI Queue By Priority">
        <span>Chart Body</span>
      </ChartPanel>,
    );
    expect(screen.getByText("Chart Body")).toBeInTheDocument();
    expect(screen.queryByText("Waiting For Samples")).not.toBeInTheDocument();
  });

  it("spans every grid column only when span is full", () => {
    const { rerender } = render(
      <ChartPanel title="System Metrics" span="full">
        <span>Chart Body</span>
      </ChartPanel>,
    );
    expect(screen.getByRole("figure").style.gridColumn).toBe("1 / -1");

    rerender(
      <ChartPanel title="CPU Usage">
        <span>Chart Body</span>
      </ChartPanel>,
    );
    expect(screen.getByRole("figure").style.gridColumn).toBe("");
  });
});
