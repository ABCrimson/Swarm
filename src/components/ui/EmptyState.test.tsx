import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { EmptyState } from "#components/ui/EmptyState";

describe("EmptyState", () => {
  // The title is a paragraph, not a heading, so the page's heading levels
  // stay unchanged wherever it renders.
  it("renders the title, body and action without adding a heading", () => {
    render(
      <EmptyState
        title="No Workers Running"
        body="Spawn A Worker To Watch The Swarm Come Alive"
        action={<button type="button">Spawn Worker</button>}
      />,
    );

    expect(screen.getByText("No Workers Running", { exact: true }).tagName).toBe("P");
    expect(screen.getByText("Spawn A Worker To Watch The Swarm Come Alive")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Spawn Worker" })).toBeInTheDocument();
    expect(screen.queryByRole("heading")).not.toBeInTheDocument();
  });

  // The ring is decoration: hidden from assistive tech, and its breathing
  // dot only animates when the viewer allows motion.
  it("hides the decorative ring and gates its pulse on motion-safe", () => {
    const { container } = render(<EmptyState title="No Sessions" />);

    const ring = container.querySelector('[aria-hidden="true"]');
    expect(ring).not.toBeNull();
    expect(ring?.firstElementChild).toHaveClass(
      "motion-safe:animate-[tool-pulse_3s_ease-in-out_infinite]",
    );
    expect(container).toHaveTextContent(/^No Sessions$/);
  });
});
