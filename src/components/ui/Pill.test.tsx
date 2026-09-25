import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Pill } from "#components/ui/Pill";

describe("Pill", () => {
  it("renders as a static span by default (label-only)", () => {
    const { container } = render(<Pill>Idle</Pill>);

    expect(container.firstElementChild?.tagName).toBe("SPAN");
  });

  it("renders as a real button when interactive", () => {
    render(<Pill interactive>Kill</Pill>);

    expect(screen.getByRole("button", { name: "Kill" })).toBeInTheDocument();
  });

  it("does not expose a button role when not interactive", () => {
    render(<Pill>Running</Pill>);

    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("fires click handlers when interactive", async () => {
    const user = userEvent.setup();
    const handleClick = vi.fn();

    render(
      <Pill interactive onClick={handleClick}>
        Kill
      </Pill>,
    );
    await user.click(screen.getByRole("button", { name: "Kill" }));

    expect(handleClick).toHaveBeenCalledTimes(1);
  });

  it("does not fire click when interactive and disabled", async () => {
    const user = userEvent.setup();
    const handleClick = vi.fn();

    render(
      <Pill interactive onClick={handleClick} disabled>
        Kill
      </Pill>,
    );
    await user.click(screen.getByRole("button", { name: "Kill" }));

    expect(handleClick).not.toHaveBeenCalled();
  });

  it("renders as disabled when interactive and disabled", () => {
    render(
      <Pill interactive disabled>
        Kill
      </Pill>,
    );

    expect(screen.getByRole("button", { name: "Kill" })).toBeDisabled();
  });

  it("sets type=button on the interactive button by default", () => {
    render(<Pill interactive>Kill</Pill>);

    expect(screen.getByRole("button", { name: "Kill" })).toHaveAttribute("type", "button");
  });

  it("accepts a custom type on the interactive button", () => {
    render(
      <Pill interactive type="submit">
        Submit
      </Pill>,
    );

    expect(screen.getByRole("button", { name: "Submit" })).toHaveAttribute("type", "submit");
  });

  it("applies the swarm-pill CSS class to the rendered element", () => {
    const { container } = render(<Pill>Idle</Pill>);

    expect(container.firstElementChild?.className).toContain("swarm-pill");
  });

  it("applies additional className when provided", () => {
    const { container } = render(<Pill className="extra-class">Idle</Pill>);

    expect(container.firstElementChild?.className).toContain("extra-class");
  });

  it("defaults to neutral tone and sm size", () => {
    const { container } = render(<Pill>Idle</Pill>);

    const pill = container.firstElementChild;
    expect(pill).toHaveAttribute("data-tone", "neutral");
    expect(pill).toHaveAttribute("data-size", "sm");
  });

  it.for(["neutral", "info", "success", "warning", "danger"] as const)(
    "applies the %s tone",
    (tone) => {
      const { container } = render(<Pill tone={tone}>{tone}</Pill>);
      expect(container.firstElementChild).toHaveAttribute("data-tone", tone);
    },
  );

  it("forwards a ref to the rendered element for both kinds (React 19 ref-as-prop)", () => {
    const spanRef = { current: null as HTMLSpanElement | null };
    const buttonRef = { current: null as HTMLButtonElement | null };
    render(
      <>
        <Pill ref={spanRef}>Label</Pill>
        <Pill interactive ref={buttonRef}>
          Act
        </Pill>
      </>,
    );

    expect(spanRef.current?.tagName).toBe("SPAN");
    expect(buttonRef.current).toBe(screen.getByRole("button", { name: "Act" }));
  });

  it("applies the md size", () => {
    const { container } = render(<Pill size="md">Medium</Pill>);

    expect(container.firstElementChild).toHaveAttribute("data-size", "md");
  });

  it("marks interactive pills with data-interactive", () => {
    render(<Pill interactive>Kill</Pill>);

    expect(screen.getByRole("button", { name: "Kill" })).toHaveAttribute(
      "data-interactive",
      "true",
    );
  });

  it("does not set data-interactive on label-only pills", () => {
    const { container } = render(<Pill>Idle</Pill>);

    expect(container.firstElementChild).not.toHaveAttribute("data-interactive");
  });

  it("passes through arbitrary data attributes (e.g. data-state)", () => {
    const { container } = render(<Pill data-state="running">Running</Pill>);

    expect(container.firstElementChild).toHaveAttribute("data-state", "running");
  });

  it("caps the label width and ellipsizes when maxWidth is set", () => {
    const longTag = "A very long user-generated tag name that should truncate";
    render(<Pill maxWidth={120}>{longTag}</Pill>);

    const label = screen.getByText(longTag);
    expect(label.className).toContain("swarm-pill-label");
    expect(label).toHaveStyle({ maxWidth: "120px" });
  });

  it("does not constrain label width when maxWidth is omitted", () => {
    render(<Pill>Short</Pill>);

    expect(screen.getByText("Short").style.maxWidth).toBe("");
  });

  it("lets an inline style override win over the tone's default color", () => {
    const { container } = render(
      <Pill tone="neutral" style={{ background: "oklch(0.5 0.2 30)" }}>
        Custom
      </Pill>,
    );

    expect(container.firstElementChild).toHaveStyle({ background: "oklch(0.5 0.2 30)" });
  });
});
