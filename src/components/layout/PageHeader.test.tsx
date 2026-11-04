import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { PageHeader } from "#components/layout/PageHeader";

describe("PageHeader", () => {
  it("renders the page's one h1 with its subtitle and actions", () => {
    render(
      <PageHeader
        title="Sessions"
        subtitle="Saved Conversations"
        actions={<button type="button">New Session</button>}
      />,
    );

    const header = screen.getByRole("banner");
    expect(screen.getByRole("heading", { level: 1, name: "Sessions" })).toBeInTheDocument();
    expect(screen.getAllByRole("heading")).toHaveLength(1);
    expect(header).toHaveTextContent("Saved Conversations");
    expect(screen.getByRole("button", { name: "New Session" }).parentElement).toBe(header);
  });

  it("omits the subtitle line when none is given", () => {
    render(<PageHeader title="Logs" />);

    const header = screen.getByRole("banner");
    expect(header.querySelector("p")).toBeNull();
    expect(header).toHaveTextContent(/^Logs$/);
  });
});
