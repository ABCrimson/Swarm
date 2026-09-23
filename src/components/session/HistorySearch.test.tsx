import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HistorySearch } from "#components/session/HistorySearch";
import { useSessionStore } from "#store/sessions";
import type { Session } from "#store/types";

function addSession(name: string, updatedAt: string, metadata?: Session["metadata"]): Session {
  const session: Session = {
    id: crypto.randomUUID(),
    name,
    workerIds: [],
    createdAt: updatedAt,
    updatedAt,
    ...(metadata != null && { metadata }),
  };
  useSessionStore.getState().addSession(session);
  return session;
}

function resetStore(): void {
  for (const [id] of useSessionStore.getState().sessions) {
    useSessionStore.getState().removeSession(id);
  }
}

/** Result buttons, in order, by their visible name. */
function resultNames(): string[] {
  const results = screen.queryByRole("region", { name: "Search Results" });
  if (results == null) return [];
  return within(results)
    .queryAllByRole("button")
    .map((button) => button.querySelector("span")?.textContent ?? "");
}

beforeEach(resetStore);
afterEach(() => {
  cleanup();
  resetStore();
});

describe("HistorySearch", () => {
  it("names its search field and marks it up as a search landmark", () => {
    render(<HistorySearch onResultSelect={vi.fn()} />);

    const field = screen.getByRole("searchbox", { name: "Search Sessions" });
    // <search> is the search landmark (role=search in browsers; the
    // testing-library role table predates the element, so check the tag).
    expect(field.closest("search")).not.toBeNull();
  });

  it("matches name, tag or description case-insensitively, newest first", async () => {
    const user = userEvent.setup();
    addSession("Alpha Refactor", "2026-09-01T10:00:00.000Z");
    addSession("Beta", "2026-09-03T10:00:00.000Z", { tags: ["refactoring"] });
    addSession("Gamma", "2026-09-02T10:00:00.000Z", { description: "A big REFACTOR pass" });
    addSession("Delta", "2026-09-04T10:00:00.000Z");
    render(<HistorySearch onResultSelect={vi.fn()} />);

    await user.type(screen.getByRole("searchbox"), "refactor");

    expect(await screen.findByRole("status")).toHaveTextContent("3 Results");
    expect(resultNames()).toEqual(["Beta", "Gamma", "Alpha Refactor"]);
  });

  it("highlights every occurrence and shows the tags that matched", async () => {
    const user = userEvent.setup();
    addSession("Log Log", "2026-09-01T10:00:00.000Z", { tags: ["logging", "ui"] });
    render(<HistorySearch onResultSelect={vi.fn()} />);

    await user.type(screen.getByRole("searchbox"), "LOG");

    const result = await screen.findByRole("button", { name: /Log Log/ });
    expect(
      within(result)
        .getAllByText((_, element) => element?.tagName === "MARK")
        .map((mark) => mark.textContent),
    ).toEqual(["Log", "Log", "log"]);
    expect(within(result).getByText("ging")).toBeInTheDocument();
    expect(within(result).queryByText("ui")).not.toBeInTheDocument();
  });

  it("treats regex metacharacters in the query literally", async () => {
    const user = userEvent.setup();
    addSession("C++ (Legacy)", "2026-09-01T10:00:00.000Z");
    render(<HistorySearch onResultSelect={vi.fn()} />);

    await user.type(screen.getByRole("searchbox"), "++ (");

    expect(await screen.findByRole("status")).toHaveTextContent("1 Result");
  });

  it("filters by an inclusive date range, including the whole 'to' day", async () => {
    const user = userEvent.setup();
    addSession("Before", "2026-08-31T23:00:00");
    addSession("First Day", "2026-09-01T00:00:00");
    addSession("Last Day Late", "2026-09-03T23:59:00");
    addSession("After", "2026-09-04T00:00:00");
    render(<HistorySearch onResultSelect={vi.fn()} />);

    await user.type(screen.getByLabelText("From"), "2026-09-01");
    await user.type(screen.getByLabelText("To"), "2026-09-03");

    expect(resultNames()).toEqual(["Last Day Late", "First Day"]);

    await user.click(screen.getByRole("button", { name: "Clear Dates" }));
    expect(screen.queryByRole("region", { name: "Search Results" })).not.toBeInTheDocument();
  });

  it("reports the chosen result", async () => {
    const user = userEvent.setup();
    const onResultSelect = vi.fn();
    const session = addSession("Pick Me", "2026-09-01T10:00:00.000Z");
    render(<HistorySearch onResultSelect={onResultSelect} />);

    await user.type(screen.getByRole("searchbox"), "pick");
    await user.click(await screen.findByRole("button", { name: /Pick Me/ }));

    expect(onResultSelect).toHaveBeenCalledExactlyOnceWith(session.id);
  });

  it("says when nothing matches", async () => {
    const user = userEvent.setup();
    addSession("Alpha", "2026-09-01T10:00:00.000Z");
    render(<HistorySearch onResultSelect={vi.fn()} />);

    await user.type(screen.getByRole("searchbox"), "zzz");

    expect(await screen.findByText("No Matching Sessions Found.")).toBeInTheDocument();
  });
});
