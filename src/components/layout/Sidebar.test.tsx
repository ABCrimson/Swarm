import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createStore, Provider } from "jotai";
import { describe, expect, it } from "vitest";
import { Sidebar } from "#components/layout/Sidebar";
import type { PageId } from "#hooks/useNavigate";
import { currentPageAtom, sidebarCollapsedAtom } from "#store/ui";

const PAGES = [
  "Dashboard",
  "Workers",
  "Sessions",
  "Metrics",
  "Logs",
  "Tools",
  "Workspace",
  "Settings",
] as const;

function renderSidebar(page: PageId = "dashboard") {
  const store = createStore();
  store.set(currentPageAtom, page);
  render(
    <Provider store={store}>
      <Sidebar />
    </Provider>,
  );
  const nav = screen.getByRole("navigation", { name: "Page Navigation" });
  return { store, nav, buttons: () => screen.getAllByRole("button") };
}

describe("Sidebar", () => {
  it("lists every page, in order", () => {
    const { buttons } = renderSidebar();

    expect(buttons().map((b) => b.textContent)).toEqual([...PAGES]);
  });

  it("marks the current page with aria-current", () => {
    renderSidebar("metrics");

    expect(screen.getByRole("button", { name: "Metrics" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("button", { name: "Dashboard" })).not.toHaveAttribute("aria-current");
  });

  // The nav is exactly one Tab stop, on the current page's button,
  // whichever page is current.
  it.for(["logs", "tools", "workspace", "dashboard"] as const)(
    "has exactly one Tab stop, on the current page (%s)",
    (page) => {
      const { buttons } = renderSidebar(page);

      const stops = buttons().filter((b) => b.tabIndex === 0);
      expect(stops).toHaveLength(1);
      expect(stops[0]).toHaveAttribute("aria-current", "page");
    },
  );

  it("navigates when a button is clicked", async () => {
    const user = userEvent.setup();
    const { store } = renderSidebar();

    await user.click(screen.getByRole("button", { name: "Workspace" }));

    expect(store.get(currentPageAtom)).toBe("workspace");
    expect(screen.getByRole("button", { name: "Workspace" })).toHaveAttribute(
      "aria-current",
      "page",
    );
  });

  it("moves focus with Arrow keys, Home and End, wrapping at the ends", async () => {
    const user = userEvent.setup();
    const { buttons } = renderSidebar();
    const all = buttons();

    act(() => all[0]?.focus());
    await user.keyboard("{ArrowDown}");
    expect(all[1]).toHaveFocus();
    await user.keyboard("{End}");
    expect(all.at(-1)).toHaveFocus();
    await user.keyboard("{ArrowDown}");
    expect(all[0]).toHaveFocus();
    await user.keyboard("{ArrowUp}");
    expect(all.at(-1)).toHaveFocus();
    await user.keyboard("{Home}");
    expect(all[0]).toHaveFocus();
  });

  it("keeps an accessible name on every button when collapsed to icons", () => {
    const store = createStore();
    store.set(sidebarCollapsedAtom, true);
    render(
      <Provider store={store}>
        <Sidebar />
      </Provider>,
    );

    // Collapsed buttons show only the icon, so the name must come from aria-label.
    for (const name of PAGES) {
      const button = screen.getByRole("button", { name });
      expect(button).toHaveAttribute("aria-label", name);
      expect(button).not.toHaveTextContent(name);
    }
  });
});
