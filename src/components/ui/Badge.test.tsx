import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Badge, stateLabels } from "#components/ui/Badge";

describe("Badge", () => {
  it("renders children text", () => {
    render(<Badge state="idle">Idle</Badge>);

    expect(screen.getByText("Idle")).toBeInTheDocument();
  });

  it.for([
    ["idle", "neutral"],
    ["running", "info"],
    ["paused", "warning"],
    ["error", "danger"],
  ] as const)("renders the %s state with data-state and the %s tone", ([state, tone]) => {
    const { container } = render(<Badge state={state}>{stateLabels[state]}</Badge>);

    expect(container.firstElementChild).toHaveAttribute("data-state", state);
    expect(container.firstElementChild).toHaveAttribute("data-tone", tone);
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
