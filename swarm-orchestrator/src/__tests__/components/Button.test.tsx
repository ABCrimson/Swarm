import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Button } from "#components/ui/Button";

describe("Button", () => {
  it("renders children text", () => {
    render(<Button>Click me</Button>);

    expect(screen.getByRole("button", { name: "Click me" })).toBeInTheDocument();
  });

  it("handles click events", async () => {
    const user = userEvent.setup();
    const handleClick = vi.fn();

    render(<Button onClick={handleClick}>Click</Button>);
    await user.click(screen.getByRole("button"));

    expect(handleClick).toHaveBeenCalledTimes(1);
  });

  it("does not fire click when disabled", async () => {
    const user = userEvent.setup();
    const handleClick = vi.fn();

    render(
      <Button onClick={handleClick} disabled>
        Click
      </Button>,
    );
    await user.click(screen.getByRole("button"));

    expect(handleClick).not.toHaveBeenCalled();
  });

  it("renders as disabled when disabled prop is true", () => {
    render(<Button disabled>Disabled</Button>);

    expect(screen.getByRole("button")).toBeDisabled();
  });

  it("renders as disabled when loading is true", () => {
    render(<Button loading>Loading</Button>);

    expect(screen.getByRole("button")).toBeDisabled();
  });

  it("sets aria-busy when loading", () => {
    render(<Button loading>Loading</Button>);

    expect(screen.getByRole("button")).toHaveAttribute("aria-busy", "true");
  });

  it("does not set aria-busy when not loading", () => {
    render(<Button>Normal</Button>);

    expect(screen.getByRole("button")).not.toHaveAttribute("aria-busy");
  });

  it("applies the primary variant by default", () => {
    render(<Button>Primary</Button>);

    expect(screen.getByRole("button")).toHaveAttribute("data-variant", "primary");
  });

  it("applies the secondary variant", () => {
    render(<Button variant="secondary">Secondary</Button>);

    expect(screen.getByRole("button")).toHaveAttribute("data-variant", "secondary");
  });

  it("applies the ghost variant", () => {
    render(<Button variant="ghost">Ghost</Button>);

    expect(screen.getByRole("button")).toHaveAttribute("data-variant", "ghost");
  });

  it("applies the danger variant", () => {
    render(<Button variant="danger">Danger</Button>);

    expect(screen.getByRole("button")).toHaveAttribute("data-variant", "danger");
  });

  it("applies the md size by default", () => {
    render(<Button>Medium</Button>);

    expect(screen.getByRole("button")).toHaveAttribute("data-size", "md");
  });

  it("applies the sm size", () => {
    render(<Button size="sm">Small</Button>);

    expect(screen.getByRole("button")).toHaveAttribute("data-size", "sm");
  });

  it("applies the lg size", () => {
    render(<Button size="lg">Large</Button>);

    expect(screen.getByRole("button")).toHaveAttribute("data-size", "lg");
  });

  it("shows a loading spinner when loading", () => {
    render(<Button loading>Saving</Button>);

    // The Spinner component renders an output element with aria-label "Loading"
    expect(screen.getByLabelText("Loading")).toBeInTheDocument();
  });

  it("sets type=button by default", () => {
    render(<Button>Default</Button>);

    expect(screen.getByRole("button")).toHaveAttribute("type", "button");
  });

  it("accepts a custom type", () => {
    render(<Button type="submit">Submit</Button>);

    expect(screen.getByRole("button")).toHaveAttribute("type", "submit");
  });

  it("applies the swarm-btn CSS class", () => {
    render(<Button>Styled</Button>);

    expect(screen.getByRole("button").className).toContain("swarm-btn");
  });
});
