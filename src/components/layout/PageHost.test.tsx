import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createStore, Provider } from "jotai";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { PageHost } from "#components/layout/PageHost";
import { currentPageAtom } from "#store/ui";

/** A stand-in page with local state, to prove state survives navigation. */
function fakePage(title: string) {
  return function FakePage(): React.ReactElement {
    const [clicks, setClicks] = useState(0);
    return (
      <section>
        <h1>{title}</h1>
        <button type="button" onClick={() => setClicks((n) => n + 1)}>
          {title} Clicked {clicks}
        </button>
      </section>
    );
  };
}

vi.mock("#pages/Dashboard", () => ({ Dashboard: fakePage("Dashboard") }));
vi.mock("#pages/Workers", () => ({ Workers: fakePage("Workers") }));
vi.mock("#pages/Sessions", () => ({ Sessions: fakePage("Sessions") }));
vi.mock("#pages/Metrics", () => ({ Metrics: fakePage("Metrics") }));
vi.mock("#pages/Logs", () => ({ Logs: fakePage("Logs") }));
vi.mock("#pages/Tools", () => ({ Tools: fakePage("Tools") }));
vi.mock("#pages/Workspace", () => ({ Workspace: fakePage("Workspace") }));
vi.mock("#pages/Settings", () => ({
  Settings: () => {
    throw new Error("Settings Exploded");
  },
}));

async function renderHost() {
  const store = createStore();
  render(
    <Provider store={store}>
      <PageHost />
    </Provider>,
  );
  await screen.findByRole("heading", { name: "Dashboard" });
  return store;
}

describe("PageHost", () => {
  it("renders the current page", async () => {
    await renderHost();

    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Dashboard");
  });

  it("keeps a visited page mounted but hidden, with its state intact", async () => {
    const user = userEvent.setup();
    const store = await renderHost();

    await user.click(screen.getByRole("button", { name: "Dashboard Clicked 0" }));
    act(() => store.set(currentPageAtom, "workers"));
    await screen.findByRole("heading", { name: "Workers" });

    // Hidden by <Activity>: out of the accessibility tree, still in the DOM.
    expect(screen.queryByRole("heading", { name: "Dashboard" })).not.toBeInTheDocument();
    expect(screen.getByText("Dashboard Clicked 1", { ignore: false })).not.toBeVisible();

    act(() => store.set(currentPageAtom, "dashboard"));
    expect(await screen.findByRole("button", { name: "Dashboard Clicked 1" })).toBeVisible();
  });

  it("mounts a page only once it is visited", async () => {
    await renderHost();

    expect(screen.queryByText(/Workers/)).not.toBeInTheDocument();
  });

  it("contains a crashing page to its own error boundary", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const store = await renderHost();

    act(() => store.set(currentPageAtom, "settings"));

    expect(await screen.findByRole("alert")).toHaveTextContent("Settings Exploded");
    act(() => store.set(currentPageAtom, "dashboard"));
    expect(await screen.findByRole("heading", { name: "Dashboard" })).toBeVisible();
    vi.restoreAllMocks();
  });
});
