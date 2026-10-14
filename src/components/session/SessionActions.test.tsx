import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionActions } from "#components/session/SessionActions";
import { useSessionStore } from "#store/sessions";
import type { Session } from "#store/types";

/** `true` makes the active transport report no workspace browsing (the `build:web` page). */
const web = vi.hoisted(() => ({ on: false }));
vi.mock(import("#lib/tauri"), async (importOriginal) => ({
  ...(await importOriginal()),
  hasCapability: () => !web.on,
}));

const mockCreateAndActivate = vi.fn<(name: string) => Promise<Session>>();
const mockImport = vi.fn<() => Promise<Session | null>>();
vi.mock(import("#lib/session-lifecycle"), async (importOriginal) => ({
  ...(await importOriginal()),
  createAndActivateSession: (name) => mockCreateAndActivate(name),
  importSessionFromFile: () => mockImport(),
}));

function makeSession(name: string): Session {
  return {
    id: crypto.randomUUID(),
    name,
    workerIds: [],
    createdAt: "2026-09-01T12:00:00.000Z",
    updatedAt: "2026-09-01T12:00:00.000Z",
  };
}

beforeEach(() => {
  web.on = false;
  vi.clearAllMocks();
  mockCreateAndActivate.mockReset().mockImplementation(async (name) => makeSession(name));
  mockImport.mockReset();
});
afterEach(() => {
  cleanup();
  for (const [id] of useSessionStore.getState().sessions) {
    useSessionStore.getState().removeSession(id);
  }
});

async function openForm(user: ReturnType<typeof userEvent.setup>) {
  render(<SessionActions />);
  await user.click(screen.getByRole("button", { name: "New Session" }));
  return screen.getByRole("textbox", { name: "Session Name" });
}

describe("SessionActions — import", () => {
  it("disables Import and says why when the transport cannot browse files", async () => {
    web.on = true;
    const user = userEvent.setup();
    render(<SessionActions />);

    const button = screen.getByRole("button", { name: "Import" });
    expect(button).toBeDisabled();
    expect(button).toHaveAccessibleDescription("Available In The Desktop App Only");
    await user.click(button);
    expect(mockImport).not.toHaveBeenCalled();
  });
});

describe("SessionActions — new session", () => {
  it("opens a labelled, focused name field and creates the session on Enter", async () => {
    const user = userEvent.setup();
    const input = await openForm(user);
    expect(input).toHaveFocus();

    await user.type(input, "  Alpha  {Enter}");

    expect(mockCreateAndActivate).toHaveBeenCalledExactlyOnceWith("Alpha");
    expect(toast.success).toHaveBeenCalledWith('Session "Alpha" Created');
    expect(screen.queryByRole("textbox", { name: "Session Name" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "New Session" })).toBeInTheDocument();
  });

  // Regression: Enter called the create handler on every keydown, so a
  // held or double-pressed Enter sent several create_session calls.
  it("creates once however often Enter is pressed while the create is pending", async () => {
    const user = userEvent.setup();
    const pending = Promise.withResolvers<Session>();
    mockCreateAndActivate.mockReturnValue(pending.promise);
    const input = await openForm(user);

    await user.type(input, "Beta{Enter}{Enter}{Enter}");
    await user.click(screen.getByRole("button", { name: /Create/ }));

    expect(mockCreateAndActivate).toHaveBeenCalledOnce();
    // A loading Button stays focusable: busy and aria-disabled, and it
    // swallows the clicks (implicit submission included) instead.
    expect(screen.getByRole("button", { name: /Create/ })).toHaveAttribute("aria-disabled", "true");

    await act(async () => {
      pending.resolve(makeSession("Beta"));
    });
    expect(mockCreateAndActivate).toHaveBeenCalledOnce();
  });

  it("shows a failure under the field and keeps what was typed", async () => {
    const user = userEvent.setup();
    mockCreateAndActivate.mockRejectedValue(new Error("backend down"));
    const input = await openForm(user);

    await user.type(input, "Gamma{Enter}");

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Failed To Create Session: backend down",
    );
    const field = screen.getByRole("textbox", { name: "Session Name" });
    expect(field).toHaveValue("Gamma");
    expect(field).toHaveAttribute("aria-invalid", "true");
    expect(field).toHaveAccessibleDescription("Failed To Create Session: backend down");
  });

  it("refuses a whitespace-only name without calling the backend", async () => {
    const user = userEvent.setup();
    const input = await openForm(user);

    await user.type(input, "   {Enter}");

    expect(await screen.findByRole("alert")).toHaveTextContent("Enter A Session Name.");
    expect(mockCreateAndActivate).not.toHaveBeenCalled();
  });

  it("closes on Escape and on Cancel", async () => {
    const user = userEvent.setup();
    await openForm(user);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("textbox", { name: "Session Name" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "New Session" }));
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("textbox", { name: "Session Name" })).not.toBeInTheDocument();
  });

  it("returns focus to New Session when the form closes", async () => {
    const user = userEvent.setup();
    await openForm(user);
    await user.keyboard("{Escape}");
    expect(screen.getByRole("button", { name: "New Session" })).toHaveFocus();

    await user.click(screen.getByRole("button", { name: "New Session" }));
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByRole("button", { name: "New Session" })).toHaveFocus();
  });
});

describe("SessionActions — import", () => {
  it("toasts the imported session's name", async () => {
    const user = userEvent.setup();
    mockImport.mockResolvedValue(makeSession("Imported One"));
    render(<SessionActions />);

    await user.click(screen.getByRole("button", { name: "Import" }));

    await vi.waitFor(() => {
      expect(toast.success).toHaveBeenCalledWith('Session "Imported One" Imported');
    });
  });

  it("stays quiet when the dialog is cancelled", async () => {
    const user = userEvent.setup();
    mockImport.mockResolvedValue(null);
    render(<SessionActions />);

    await user.click(screen.getByRole("button", { name: "Import" }));

    await vi.waitFor(() => expect(mockImport).toHaveBeenCalledOnce());
    expect(toast.success).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("toasts a failed import", async () => {
    const user = userEvent.setup();
    mockImport.mockRejectedValue(new Error("Invalid Session File Format"));
    render(<SessionActions />);

    await user.click(screen.getByRole("button", { name: "Import" }));

    await vi.waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith("Import Failed: Invalid Session File Format");
    });
  });
});
