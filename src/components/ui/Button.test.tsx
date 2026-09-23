import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Button } from "#components/ui/Button";

describe("Button", () => {
  it("renders children text", () => {
    render(<Button>Click Me</Button>);

    expect(screen.getByRole("button", { name: "Click Me" })).toBeInTheDocument();
  });

  it("handles click events", async () => {
    const user = userEvent.setup();
    const handleClick = vi.fn();

    render(<Button onClick={handleClick}>Click</Button>);
    await user.click(screen.getByRole("button"));

    expect(handleClick).toHaveBeenCalledOnce();
  });

  it("disables for real and ignores clicks when disabled", async () => {
    const user = userEvent.setup();
    const handleClick = vi.fn();

    render(
      <Button onClick={handleClick} disabled>
        Click
      </Button>,
    );
    await user.click(screen.getByRole("button"));

    expect(screen.getByRole("button")).toBeDisabled();
    expect(handleClick).not.toHaveBeenCalled();
  });

  it("marks a loading button busy and swallows clicks without disabling it", async () => {
    const user = userEvent.setup();
    const handleClick = vi.fn();

    render(
      <Button loading onClick={handleClick}>
        Saving
      </Button>,
    );
    const button = screen.getByRole("button", { name: "Saving" });
    await user.click(button);

    expect(button).toHaveAttribute("aria-busy", "true");
    expect(button).toHaveAttribute("aria-disabled", "true");
    expect(button).toBeEnabled();
    expect(handleClick).not.toHaveBeenCalled();
  });

  // Regression: `disabled` on the focused button dropped keyboard focus
  // to <body> the moment it started loading.
  it("keeps keyboard focus when it starts loading", () => {
    const { rerender } = render(<Button>Save</Button>);
    const button = screen.getByRole("button", { name: "Save" });
    button.focus();

    rerender(<Button loading>Save</Button>);

    expect(button).toHaveFocus();
  });

  it("does not submit its form while loading", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn((e: React.FormEvent) => e.preventDefault());

    render(
      <form onSubmit={onSubmit}>
        <Button type="submit" loading>
          Submit
        </Button>
      </form>,
    );
    await user.click(screen.getByRole("button"));

    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("shows a decorative spinner that stays out of the accessible name", () => {
    const { container } = render(<Button loading>Saving</Button>);

    expect(container.querySelector("svg.animate-spin")).toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(screen.getByRole("button")).toHaveAccessibleName("Saving");
  });

  it("does not set aria-busy when not loading", () => {
    render(<Button>Normal</Button>);

    expect(screen.getByRole("button")).not.toHaveAttribute("aria-busy");
  });

  it.for([
    ["primary", undefined],
    ["secondary", "secondary"],
    ["ghost", "ghost"],
    ["danger", "danger"],
  ] as const)("applies the %s variant", ([expected, variant]) => {
    render(<Button variant={variant}>Label</Button>);

    expect(screen.getByRole("button")).toHaveAttribute("data-variant", expected);
  });

  it.for([
    ["md", undefined],
    ["sm", "sm"],
    ["lg", "lg"],
  ] as const)("applies the %s size", ([expected, size]) => {
    render(<Button size={size}>Label</Button>);

    expect(screen.getByRole("button")).toHaveAttribute("data-size", expected);
  });

  it("sets type=button by default and accepts a custom type", () => {
    const { rerender } = render(<Button>Default</Button>);
    expect(screen.getByRole("button")).toHaveAttribute("type", "button");

    rerender(<Button type="submit">Submit</Button>);
    expect(screen.getByRole("button")).toHaveAttribute("type", "submit");
  });

  it("applies the swarm-btn class alongside a caller's class", () => {
    render(<Button className="w-full">Styled</Button>);

    expect(screen.getByRole("button")).toHaveClass("swarm-btn", "w-full");
  });

  it("forwards a ref to the underlying button (React 19 ref-as-prop)", () => {
    const ref = { current: null as HTMLButtonElement | null };
    render(<Button ref={ref}>Ref</Button>);

    expect(ref.current).toBe(screen.getByRole("button"));
  });
});
