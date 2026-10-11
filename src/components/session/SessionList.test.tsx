import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionList } from "#components/session/SessionList";
import { useSessionStore } from "#store/sessions";
import type { Session } from "#store/types";

function addSession(name: string, updatedAt: string, tags?: string[]): Session {
  const session: Session = {
    id: crypto.randomUUID(),
    name,
    workerIds: [],
    createdAt: updatedAt,
    updatedAt,
    ...(tags != null && { metadata: { tags } }),
  };
  useSessionStore.getState().addSession(session);
  return session;
}

afterEach(() => {
  cleanup();
  const state = useSessionStore.getState();
  for (const [id] of state.sessions) state.removeSession(id);
  state.setActiveSession(null);
});

function renderList() {
  render(<SessionList onDelete={vi.fn()} onExport={vi.fn()} onCreateTemplate={vi.fn()} />);
}

describe("SessionList", () => {
  it("shows the empty state when there are no sessions", () => {
    renderList();
    expect(screen.getByText("No Sessions Yet")).toBeInTheDocument();
  });

  it("lists every session, most recently updated first, marking the active one", () => {
    addSession("Old", "2026-09-01T10:00:00.000Z");
    const newest = addSession("Newest", "2026-09-03T10:00:00.000Z");
    addSession("Middle", "2026-09-02T10:00:00.000Z");
    useSessionStore.getState().setActiveSession(newest.id);
    renderList();

    const rows = within(screen.getByRole("list", { name: "Sessions" })).getAllByRole("listitem");
    expect(rows.map((row) => row.querySelector("button")?.textContent)).toEqual([
      expect.stringContaining("Newest"),
      expect.stringContaining("Middle"),
      expect.stringContaining("Old"),
    ]);
    expect(within(rows[0] as HTMLElement).getByRole("button", { name: /^Newest/ })).toHaveAttribute(
      "aria-current",
      "true",
    );
  });

  // Rows must stay in normal flow and size to their card. An absolutely
  // positioned row of fixed height would let a card with a wrapping tag
  // row overflow into the next card's clickable area.
  it("lays rows out in normal flow, sized by their content", () => {
    addSession("Tagged", "2026-09-01T10:00:00.000Z", ["one", "two", "three", "four", "five"]);
    addSession("Plain", "2026-09-02T10:00:00.000Z");
    renderList();

    for (const row of screen.getAllByRole("listitem")) {
      expect(row).not.toHaveAttribute("style");
      expect(row.className).not.toMatch(
        /(?:^|\s)(?:[^\s:]+:)*-?(?:absolute|fixed|sticky|top-\S+|translate-\S+|max-h-\S+|h-\S+|size-\S+|\[(?:height|max-height|position|top|transform):[^\]]*\])!?(?=\s|$)/,
      );
    }
  });
});
