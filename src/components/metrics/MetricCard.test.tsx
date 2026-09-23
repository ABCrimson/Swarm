import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { Trend } from "#components/metrics/MetricCard";
import { MetricCard, MetricCardList, SEVERITY_COLOR } from "#components/metrics/MetricCard";
import type { Severity } from "#lib/severity";

function renderCard(props: {
  label: string;
  value: string;
  severity?: Severity;
  trend?: Trend;
}): void {
  render(
    <MetricCardList>
      <MetricCard {...props} />
    </MetricCardList>,
  );
}

describe("MetricCard", () => {
  it("renders the label as the term and the value as its description", () => {
    renderCard({ label: "CPU", value: "75%" });

    expect(screen.getByRole("term")).toHaveTextContent("CPU");
    expect(screen.getByRole("definition")).toHaveTextContent("75%");
  });

  it.each([
    ["good", undefined],
    ["good", "good"],
    ["warning", "warning"],
    ["critical", "critical"],
  ] as const)("colours the value with the exact %s token", (expected, severity) => {
    renderCard({ label: "CPU", value: "50%", severity });

    expect(screen.getByText("50%").style.color).toBe(SEVERITY_COLOR[expected]);
  });

  it("renders no trend arrow when no trend was measured", () => {
    renderCard({ label: "Workers", value: "3" });

    for (const arrow of ["↑", "↓", "→"]) {
      expect(screen.queryByText(arrow)).not.toBeInTheDocument();
    }
    expect(screen.getByRole("definition")).toHaveTextContent(/^3$/);
  });

  it.each([
    ["up", "↑", "Trending Up"],
    ["down", "↓", "Trending Down"],
    ["stable", "→", "Stable"],
  ] as const)(
    "renders the %s arrow hidden from assistive tech, with text for it",
    (trend, arrow, text) => {
      renderCard({ label: "CPU", value: "50%", trend });

      expect(screen.getByText(arrow)).toHaveAttribute("aria-hidden", "true");
      expect(screen.getByText(text)).toHaveClass("sr-only");
    },
  );
});
