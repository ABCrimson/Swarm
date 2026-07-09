import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Badge } from "#components/ui/Badge";

describe("Badge", () => {
  it("renders children text", () => {
    render(<Badge state="idle">Idle</Badge>);

    expect(screen.getByText("Idle")).toBeInTheDocument();
  });

  it("sets data-state attribute to the worker state", () => {
    render(<Badge state="running">Running</Badge>);

    const badge = screen.getByText("Running");
    expect(badge).toHaveAttribute("data-state", "running");
  });

  it("sets data-state for idle state", () => {
    render(<Badge state="idle">Waiting</Badge>);

    expect(screen.getByText("Waiting")).toHaveAttribute("data-state", "idle");
  });

  it("sets data-state for paused state", () => {
    render(<Badge state="paused">Paused</Badge>);

    expect(screen.getByText("Paused")).toHaveAttribute("data-state", "paused");
  });

  it("sets data-state for error state", () => {
    render(<Badge state="error">Error</Badge>);

    expect(screen.getByText("Error")).toHaveAttribute("data-state", "error");
  });

  it("applies the swarm-badge CSS class", () => {
    render(<Badge state="idle">Test</Badge>);

    const badge = screen.getByText("Test");
    expect(badge.className).toContain("swarm-badge");
  });

  it("applies additional className when provided", () => {
    render(
      <Badge state="idle" className="extra-class">
        Test
      </Badge>,
    );

    const badge = screen.getByText("Test");
    expect(badge.className).toContain("extra-class");
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
});
