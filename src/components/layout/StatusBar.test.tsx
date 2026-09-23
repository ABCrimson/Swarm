import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createStore, Provider } from "jotai";
import { afterEach, describe, expect, it } from "vitest";
import { StatusBar } from "#components/layout/StatusBar";
import { useAiStore } from "#store/ai";
import { useSystemStore } from "#store/system";
import { gpuFrameTimeAtom, themeAtom } from "#store/ui";

function renderBar(store = createStore()) {
  render(
    <Provider store={store}>
      <StatusBar />
    </Provider>,
  );
  return store;
}

afterEach(() => {
  act(() => {
    useSystemStore.setState((s) => ({ metrics: { ...s.metrics, cpuPercent: 0, workerCount: 0 } }));
    useAiStore.setState((s) => ({ cumulativeUsage: { ...s.cumulativeUsage, totalCostUsd: 0 } }));
  });
});

describe("StatusBar", () => {
  // Regression: the whole bar (numbers that change twice a second and a
  // button) was one polite live region, so screen readers kept re-reading it.
  it("announces only the health label", () => {
    renderBar();

    const status = screen.getByRole("status");
    expect(status).toHaveTextContent(/^Nominal$/);
    expect(status.closest("footer")).not.toHaveAttribute("aria-live");
    expect(screen.getByRole("contentinfo")).not.toHaveAttribute("aria-live");
  });

  it.for([
    [30, "Nominal"],
    [65, "Moderate"],
    [95, "High Load"],
  ] as const)("labels %d%% CPU as %s", ([cpuPercent, label]) => {
    act(() => useSystemStore.setState((s) => ({ metrics: { ...s.metrics, cpuPercent } })));
    renderBar();

    expect(screen.getByRole("status")).toHaveTextContent(label);
  });

  it("shows the recorded AI spend instead of a projection", () => {
    act(() =>
      useAiStore.setState((s) => ({
        cumulativeUsage: { ...s.cumulativeUsage, totalCostUsd: 1.234 },
      })),
    );
    renderBar();

    expect(screen.getByText("AI Spend $1.23")).toBeInTheDocument();
  });

  it("toggles the GPU readout through the shared theme setting", async () => {
    const user = userEvent.setup();
    const store = createStore();
    store.set(gpuFrameTimeAtom, 3.25);
    renderBar(store);

    expect(screen.getByText("GPU 3.3ms")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Hide GPU Frame Time" }));
    expect(screen.queryByText(/^GPU /)).not.toBeInTheDocument();
    expect(store.get(themeAtom).gpuOverlay).toBe(false);

    await user.click(screen.getByRole("button", { name: "Show GPU Frame Time" }));
    expect(store.get(themeAtom).gpuOverlay).toBe(true);
    expect(store.get(themeAtom).particlesEnabled).toBe(true);
  });
});
