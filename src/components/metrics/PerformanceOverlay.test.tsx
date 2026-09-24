import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createStore, Provider } from "jotai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PerformanceOverlay } from "#components/metrics/PerformanceOverlay";
import { gpuFrameTimeAtom, particleCountAtom, perfOverlayOpenAtom } from "#store/ui";

function renderOverlay() {
  const store = createStore();
  render(
    <Provider store={store}>
      <PerformanceOverlay />
    </Provider>,
  );
  return store;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("PerformanceOverlay", () => {
  it("toggles with Ctrl+Shift+P and shows GPU frame time and particle count", async () => {
    const user = userEvent.setup();
    const store = renderOverlay();
    act(() => {
      store.set(gpuFrameTimeAtom, 4.25);
      store.set(particleCountAtom, 12_000);
    });

    expect(screen.queryByRole("region", { name: "Performance Overlay" })).not.toBeInTheDocument();
    await user.keyboard("{Control>}{Shift>}P{/Shift}{/Control}");

    const overlay = screen.getByRole("region", { name: "Performance Overlay" });
    expect(overlay).toHaveTextContent("4.25ms");
    expect(overlay).toHaveTextContent((12_000).toLocaleString());
    // Not a live region: per-second updates must not be announced.
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    await user.keyboard("{Control>}{Shift>}P{/Shift}{/Control}");
    expect(store.get(perfOverlayOpenAtom)).toBe(false);
  });

  it("measures FPS only while open", () => {
    const raf = vi.spyOn(window, "requestAnimationFrame");
    const store = renderOverlay();

    expect(raf).not.toHaveBeenCalled();
    act(() => store.set(perfOverlayOpenAtom, true));
    expect(raf).toHaveBeenCalled();
  });

  it("renders and listens to nothing outside a development build", async () => {
    vi.stubEnv("DEV", false);
    const user = userEvent.setup();
    const addListener = vi.spyOn(document, "addEventListener");
    const store = renderOverlay();

    await user.keyboard("{Control>}{Shift>}P{/Shift}{/Control}");

    expect(store.get(perfOverlayOpenAtom)).toBe(false);
    expect(addListener.mock.calls.some(([type]) => type === "keydown")).toBe(false);
  });
});
