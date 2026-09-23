import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ShipProgress } from "#components/ship/ShipProgress";

describe("ShipProgress", () => {
  it("shows one row per step — its latest status — in first-seen order", () => {
    render(
      <ShipProgress
        rows={[
          { step: "staging", status: "running", detail: null },
          { step: "staging", status: "ok", detail: "0 Skipped" },
          { step: "commit", status: "running", detail: null },
          { step: "commit", status: "error", detail: "hook failed" },
        ]}
      />,
    );

    const list = screen.getByRole("list", { name: "Ship Progress" });
    const rows = within(list).getAllByRole("listitem");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent("Staging — Done");
    expect(rows[0]).toHaveTextContent("0 Skipped");
    expect(rows[1]).toHaveTextContent("Commit — Failed");
    expect(rows[1]).toHaveTextContent("hook failed");
  });

  it("is a polite live region, so each step's outcome is announced", () => {
    render(<ShipProgress rows={[{ step: "push", status: "running", detail: null }]} />);

    const list = screen.getByRole("list", { name: "Ship Progress" });
    expect(list).toHaveAttribute("aria-live", "polite");
    expect(list).toHaveTextContent("Push — In Progress");
  });

  it("falls back to the raw step name for a step it has no label for", () => {
    render(<ShipProgress rows={[{ step: "verify", status: "ok", detail: null }]} />);
    expect(screen.getByRole("listitem")).toHaveTextContent("verify — Done");
  });
});
