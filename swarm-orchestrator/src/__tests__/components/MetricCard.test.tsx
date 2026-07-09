import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MetricCard } from "#components/metrics/MetricCard";

describe("MetricCard", () => {
  it("renders the label text", () => {
    render(<MetricCard label="CPU" value="75%" />);

    expect(screen.getByText("CPU")).toBeInTheDocument();
  });

  it("renders the value text", () => {
    render(<MetricCard label="Memory" value="1.2 GB" />);

    expect(screen.getByText("1.2 GB")).toBeInTheDocument();
  });

  it("sets the correct aria-label on the fieldset", () => {
    render(<MetricCard label="Workers" value="5" />);

    const fieldset = screen.getByRole("group", { name: "Workers: 5" });
    expect(fieldset).toBeInTheDocument();
  });

  it("applies the good severity color by default", () => {
    render(<MetricCard label="CPU" value="30%" />);

    const valueEl = screen.getByText("30%");
    expect(valueEl.style.color).toContain("oklch");
    // Good severity: oklch(0.78 0.18 140)
    expect(valueEl.style.color).toContain("140");
  });

  it("applies the warning severity color", () => {
    render(<MetricCard label="CPU" value="75%" severity="warning" />);

    const valueEl = screen.getByText("75%");
    // Warning severity: oklch(0.78 0.18 70)
    expect(valueEl.style.color).toContain("70");
  });

  it("applies the critical severity color", () => {
    render(<MetricCard label="CPU" value="95%" severity="critical" />);

    const valueEl = screen.getByText("95%");
    // Critical severity: oklch(0.68 0.22 15)
    expect(valueEl.style.color).toContain("15");
  });

  it("renders the stable trend arrow by default", () => {
    render(<MetricCard label="CPU" value="50%" />);

    // Stable trend symbol is a right arrow
    expect(screen.getByText("\u2192")).toBeInTheDocument();
  });

  it("renders the up trend arrow", () => {
    render(<MetricCard label="CPU" value="80%" trend="up" />);

    expect(screen.getByText("\u2191")).toBeInTheDocument();
  });

  it("renders the down trend arrow", () => {
    render(<MetricCard label="CPU" value="20%" trend="down" />);

    expect(screen.getByText("\u2193")).toBeInTheDocument();
  });
});
