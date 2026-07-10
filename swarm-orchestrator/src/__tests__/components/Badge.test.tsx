import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Badge, stateLabels } from "#components/ui/Badge";

describe("Badge", () => {
  it("renders children text", () => {
    render(<Badge state="idle">Idle</Badge>);

    expect(screen.getByText("Idle")).toBeInTheDocument();
  });

  it("sets data-state attribute to the worker state", () => {
    const { container } = render(<Badge state="running">Running</Badge>);

    expect(container.firstElementChild).toHaveAttribute("data-state", "running");
  });

  it("sets data-state for idle state", () => {
    const { container } = render(<Badge state="idle">Waiting</Badge>);

    expect(container.firstElementChild).toHaveAttribute("data-state", "idle");
  });

  it("sets data-state for paused state", () => {
    const { container } = render(<Badge state="paused">Paused</Badge>);

    expect(container.firstElementChild).toHaveAttribute("data-state", "paused");
  });

  it("sets data-state for error state", () => {
    const { container } = render(<Badge state="error">Error</Badge>);

    expect(container.firstElementChild).toHaveAttribute("data-state", "error");
  });

  it("maps each worker state to the correct semantic pill tone", () => {
    const expected: Record<string, string> = {
      idle: "neutral",
      running: "info",
      paused: "warning",
      error: "danger",
    };
    for (const [state, tone] of Object.entries(expected)) {
      const { container } = render(
        <Badge state={state as "idle" | "running" | "paused" | "error"}>{state}</Badge>,
      );
      expect(container.firstElementChild).toHaveAttribute("data-tone", tone);
    }
  });

  it("applies the swarm-pill CSS class (Badge delegates to the shared Pill component)", () => {
    const { container } = render(<Badge state="idle">Test</Badge>);

    expect(container.firstElementChild?.className).toContain("swarm-pill");
  });

  it("applies additional className when provided", () => {
    const { container } = render(
      <Badge state="idle" className="extra-class">
        Test
      </Badge>,
    );

    expect(container.firstElementChild?.className).toContain("extra-class");
  });

  it("renders complex children nodes", () => {
    render(
      <Badge state="running">
        <span data-testid="inner">Status</span>
      </Badge>,
    );

    expect(screen.getByTestId("inner")).toBeInTheDocument();
    expect(screen.getByTestId("inner")).toHaveTextContent("Status");
  });

  it("exports Title Case labels for every worker state", () => {
    expect(stateLabels).toEqual({
      idle: "Idle",
      running: "Running",
      paused: "Paused",
      error: "Error",
    });
  });
});
