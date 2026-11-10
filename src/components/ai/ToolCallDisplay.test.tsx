import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { ToolCallDisplay } from "#components/ai/ToolCallDisplay";

describe("ToolCallDisplay", () => {
  it.each([
    ["complete", "Complete", "text-lime"],
    ["error", "Error", "text-rose"],
  ] as const)("draws the %s status as a line icon, not a text glyph", (status, label, tone) => {
    render(<ToolCallDisplay name="read_file" input={{ path: "a.ts" }} status={status} />);

    const header = screen.getByRole("button", { name: `Tool Call: read_file, ${label}` });
    const icon = header.querySelector("svg");
    expect(icon).toHaveAttribute("stroke", "currentColor");
    expect(icon).toHaveAttribute("aria-hidden", "true");
    expect(icon).toHaveClass(tone);
    expect(header).not.toHaveTextContent(/[✓✗]/);
  });

  it("draws its focus ring inside the card, which clips overflow", () => {
    render(<ToolCallDisplay name="read_file" input={{}} status="executing" />);

    expect(screen.getByRole("button", { name: /^Tool Call: read_file/ })).toHaveClass(
      "-outline-offset-2",
    );
  });

  it("fades the body in with the open state", async () => {
    const user = userEvent.setup();
    const { container } = render(
      <ToolCallDisplay name="read_file" input={{ path: "a.ts" }} result="{}" status="complete" />,
    );
    const details = container.querySelector("details");
    const body = details?.querySelector(":scope > div");
    expect(details).toHaveClass("group");
    expect(body).toHaveClass("opacity-0", "group-open:opacity-100", "transition-opacity");
    expect(details).not.toHaveAttribute("open");

    await user.click(screen.getByRole("button", { name: /^Tool Call: read_file/ }));

    expect(details).toHaveAttribute("open");
    expect(body).toHaveTextContent("Input");
  });
});
