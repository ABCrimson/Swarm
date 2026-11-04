import { render, screen } from "@testing-library/react";
import { createStore, Provider } from "jotai";
import { describe, expect, it } from "vitest";
import { TopBar } from "#components/layout/TopBar";
import { DEFAULT_KEYBINDINGS } from "#lib/keybindings";
import { keybindingsAtom } from "#store/ui";

function renderBar(store = createStore()) {
  render(
    <Provider store={store}>
      <TopBar />
    </Provider>,
  );
  return store;
}

describe("TopBar", () => {
  // The visible wordmark lives in the sidebar (aria-hidden); the banner
  // still names the product for assistive tech.
  it("names the product without a heading", () => {
    renderBar();

    const banner = screen.getByRole("banner");
    expect(banner).toHaveTextContent(/^SWARM Orchestrator/);
    expect(screen.queryByRole("heading")).not.toBeInTheDocument();
  });

  it("shows the command palette shortcut from the keybindings", () => {
    const store = createStore();
    store.set(keybindingsAtom, { ...DEFAULT_KEYBINDINGS, commandPalette: "ctrl+shift+p" });
    renderBar(store);

    expect(screen.getByText("Ctrl+Shift+P", { selector: "kbd" })).toBeInTheDocument();
  });
});
