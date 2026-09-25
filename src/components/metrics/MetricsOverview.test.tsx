// ── MetricCards — severity follows the user's alert thresholds ───────
//
// Regression: the Dashboard/Metrics cards hard-coded CPU bands of 60/80
// (strict `>`) and memory bands of 70/90, while the alert toasts use the
// persisted, user-editable thresholds (defaults 70/80 and 80/90, `>=`).
// A card turned amber at 61% CPU with no alert, and Settings changes
// never reached the cards.

import { act, render, screen } from "@testing-library/react";
import { createStore, Provider } from "jotai";
import { beforeEach, describe, expect, it } from "vitest";
import { MetricCards, trendOf } from "#components/metrics/MetricsOverview";
import type { AlertThresholds } from "#lib/alerts";
import { alertThresholdsAtom, DEFAULT_THRESHOLDS } from "#lib/alerts";
import type { MetricsSample } from "#store/system";
import { useSystemStore } from "#store/system";

function record(values: Partial<MetricsSample>, time = 1): void {
  useSystemStore.getState().recordSample(
    {
      cpuPercent: 0,
      memoryMb: 0,
      memoryTotalMb: 1000,
      workerCount: 0,
      aiReqPerSec: 0,
      tokensPerSec: 0,
      ...values,
    },
    time,
  );
}

function renderCards(thresholds: AlertThresholds = DEFAULT_THRESHOLDS): void {
  const store = createStore();
  render(
    <Provider store={store}>
      <MetricCards />
    </Provider>,
  );
  // After mount, as in the app: atomWithStorage re-reads its storage (which
  // answers with the defaults) when first subscribed.
  act(() => store.set(alertThresholdsAtom, thresholds));
}

/** The `data-severity` of the tile whose term is `label`. */
function severityOf(label: string): string | null | undefined {
  return screen.getByText(label).closest("[data-severity]")?.getAttribute("data-severity");
}

describe("MetricCards", () => {
  beforeEach(() => {
    useSystemStore.setState(useSystemStore.getInitialState(), true);
  });

  it("keeps CPU 'good' below the default 70% warning threshold (old cards warned at 61%)", () => {
    record({ cpuPercent: 65 });
    renderCards();
    expect(severityOf("CPU Usage")).toBe("good");
  });

  it("bands CPU inclusively at the thresholds, like the alert toasts", () => {
    record({ cpuPercent: 70 });
    renderCards();
    expect(severityOf("CPU Usage")).toBe("warning");
  });

  it("bands memory by the memory thresholds (80% default, not the old 70%)", () => {
    record({ memoryMb: 750, memoryTotalMb: 1000 });
    renderCards();
    expect(severityOf("Memory")).toBe("good");
  });

  it("follows thresholds the user edited in Settings", () => {
    record({ cpuPercent: 55, memoryMb: 960, memoryTotalMb: 1000 });
    renderCards({ cpuWarning: 50, cpuCritical: 90, memoryWarning: 85, memoryCritical: 95 });
    expect(severityOf("CPU Usage")).toBe("warning");
    expect(severityOf("Memory")).toBe("critical");
  });

  it("never shows a memory warning while the total is unknown", () => {
    record({ memoryMb: 35_389, memoryTotalMb: 0 });
    renderCards();
    expect(severityOf("Memory")).toBe("good");
  });

  it("shows the derived Tokens/s value", () => {
    record({ tokensPerSec: 42 });
    renderCards();
    expect(screen.getByText("Tokens/s").closest("div")).toHaveTextContent("42");
  });
});

describe("trendOf", () => {
  it("needs at least four samples", () => {
    expect(trendOf([1, 50, 90])).toBeUndefined();
  });

  it("reads a rise of more than 3 points as up, a fall as down, else stable", () => {
    expect(trendOf([10, 11, 12, 14])).toBe("up");
    expect(trendOf([14, 12, 11, 10])).toBe("down");
    expect(trendOf([10, 12, 11, 13])).toBe("stable");
  });
});
