// ── LogViewer — tail-follow, virtual window, filters, highlighting ─────
//
// jsdom has no layout, so the scroll container's geometry is stubbed per
// test: `scrollHeight` tracks the rendered track height (rows × 28px) the
// way a browser would, `clientHeight` is a fixed viewport, and
// `scrollTop` is jsdom's own writable property.

import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LOG_OVERSCAN, LOG_ROW_HEIGHT, LogViewer } from "#components/logs/LogViewer";
import type { LogLevel } from "#lib/log-store";
import { useLogStore } from "#lib/log-store";

const VIEWPORT_PX = 280;

class MockResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

function add(message: string, level: LogLevel = "info", source = "backend"): void {
  act(() => {
    useLogStore.getState().addEntry({ timestamp: 1_700_000_000_000, level, source, message });
  });
}

function logRegion(): HTMLElement {
  return screen.getByRole("log", { name: "Log Entries" });
}

describe("LogViewer", () => {
  beforeEach(() => {
    vi.stubGlobal("ResizeObserver", MockResizeObserver);
    useLogStore.setState(useLogStore.getInitialState(), true);
    Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
      configurable: true,
      get() {
        return (this as HTMLElement).getAttribute("role") === "log"
          ? useLogStore.getState().entries.length * LOG_ROW_HEIGHT
          : 0;
      },
    });
    Object.defineProperty(HTMLElement.prototype, "clientHeight", {
      configurable: true,
      get() {
        return (this as HTMLElement).getAttribute("role") === "log" ? VIEWPORT_PX : 0;
      },
    });
  });

  afterEach(() => {
    Reflect.deleteProperty(HTMLElement.prototype, "scrollHeight");
    Reflect.deleteProperty(HTMLElement.prototype, "clientHeight");
    vi.unstubAllGlobals();
  });

  it("follows new entries to the bottom while auto-scroll is on", () => {
    for (let i = 0; i < 30; i++) add(`boot ${i}`);
    render(<LogViewer />);
    const region = logRegion();
    expect(region.scrollTop).toBe(30 * LOG_ROW_HEIGHT);

    add("late arrival");

    expect(region.scrollTop).toBe(31 * LOG_ROW_HEIGHT);
  });

  it("keeps following at the retention cap, where the length stops changing", () => {
    act(() => useLogStore.getState().setMaxEntries(20));
    for (let i = 0; i < 20; i++) add(`m${i}`);
    render(<LogViewer />);
    const region = logRegion();
    act(() => {
      region.scrollTop = 0; // pretend the browser clamped the scroll position
    });

    add("m20");

    expect(region.scrollTop).toBe(20 * LOG_ROW_HEIGHT);
    expect(useLogStore.getState().entries).toHaveLength(20);
  });

  it("pauses on scroll-up and resumes from the Resume Auto-Scroll button", async () => {
    const user = userEvent.setup();
    for (let i = 0; i < 30; i++) add(`m${i}`);
    render(<LogViewer />);
    const region = logRegion();

    act(() => {
      region.scrollTop = 0;
      region.dispatchEvent(new Event("scroll"));
    });
    add("while scrolled up");

    expect(region.scrollTop).toBe(0);
    await user.click(screen.getByRole("button", { name: "Resume Auto-Scroll" }));
    expect(region.scrollTop).toBe(31 * LOG_ROW_HEIGHT);
    expect(screen.queryByRole("button", { name: "Resume Auto-Scroll" })).not.toBeInTheDocument();
  });

  it("renders only the overscanned window of rows, not the whole log", () => {
    for (let i = 0; i < 500; i++) add(`row ${i}`);
    render(<LogViewer />);
    const region = logRegion();

    act(() => {
      region.scrollTop = 200 * LOG_ROW_HEIGHT;
      region.dispatchEvent(new Event("scroll"));
    });

    // containerHeight is 0 under the no-op ResizeObserver, so the window
    // is exactly the overscan on each side of the first visible row.
    expect(within(region).queryByText("row 189")).not.toBeInTheDocument();
    expect(within(region).getByText("row 190")).toBeInTheDocument();
    expect(within(region).getByText(`row ${199 + LOG_OVERSCAN}`)).toBeInTheDocument();
    expect(within(region).queryByText(`row ${200 + LOG_OVERSCAN}`)).not.toBeInTheDocument();
  });

  it("filters by level toggle, exposing the toggle state via aria-pressed", async () => {
    const user = userEvent.setup();
    add("an info line", "info");
    add("a warning line", "warn");
    render(<LogViewer />);

    const infoToggle = screen.getByRole("button", { name: "Info" });
    expect(infoToggle).toHaveAttribute("aria-pressed", "true");
    await user.click(infoToggle);

    expect(infoToggle).toHaveAttribute("aria-pressed", "false");
    expect(screen.queryByText("an info line")).not.toBeInTheDocument();
    expect(screen.getByText("a warning line")).toBeInTheDocument();
  });

  it("filters by source", async () => {
    const user = userEvent.setup();
    add("from the backend", "info", "backend");
    add("from the ai", "info", "ai");
    render(<LogViewer />);

    await user.selectOptions(screen.getByRole("combobox", { name: "Filter By Source" }), "ai");

    expect(screen.queryByText("from the backend")).not.toBeInTheDocument();
    expect(screen.getByText("from the ai")).toBeInTheDocument();
  });

  it("searches case-insensitively and highlights the match", async () => {
    const user = userEvent.setup();
    add("Git Unavailable On This Host");
    add("worker spawned");
    render(<LogViewer />);

    await user.type(screen.getByRole("searchbox", { name: "Search Log Messages" }), "unavail");

    expect(screen.queryByText("worker spawned")).not.toBeInTheDocument();
    const mark = await screen.findByText("Unavail");
    expect(mark.tagName).toBe("MARK");
  });

  it("distinguishes an empty log from an over-filtered one", async () => {
    const user = userEvent.setup();
    const { unmount } = render(<LogViewer />);
    expect(screen.getByText("No Log Entries Yet")).toBeInTheDocument();
    unmount();

    add("something");
    render(<LogViewer />);
    await user.type(screen.getByRole("searchbox", { name: "Search Log Messages" }), "zzz");
    expect(await screen.findByText("No Entries Match Current Filters")).toBeInTheDocument();
  });
});
