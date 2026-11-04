import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ChartPanel } from "#components/metrics/ChartPanel";

/** The waiting dot's infinite pulse animation. */
const PULSE = '[class*="tool-pulse"]';

describe("ChartPanel", () => {
  it.each([0, 1])("shows the waiting line instead of the chart with %i samples", (sampleCount) => {
    const { container } = render(
      <ChartPanel title="CPU Usage" sampleCount={sampleCount}>
        <span>Chart Body</span>
      </ChartPanel>,
    );

    expect(screen.getByText("Waiting For Samples")).toBeInTheDocument();
    expect(screen.queryByText("Chart Body")).not.toBeInTheDocument();
    // Waiting is a live state, so it carries the pulsing dot.
    expect(container.querySelector(PULSE)).toBeInTheDocument();
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

  it("shows the empty line, without the pulse, for a snapshot chart with nothing to plot", () => {
    const { container } = render(
      <ChartPanel title="AI Queue By Priority" empty="No Pending Requests">
        <span>Chart Body</span>
      </ChartPanel>,
    );
    expect(screen.getByText("No Pending Requests")).toBeInTheDocument();
    expect(screen.queryByText("Chart Body")).not.toBeInTheDocument();
    // An empty queue is a resting state: no infinite pulse.
    expect(container.querySelector(PULSE)).not.toBeInTheDocument();
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
