import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { applyTemplate, UserTemplatesResult } from "#lib/templates";
import { BUILT_IN_TEMPLATES } from "#lib/templates";
import { Sessions } from "#pages/Sessions";
import { useSessionStore } from "#store/sessions";
import type { Session, SessionTemplate } from "#store/types";
import { useWorkerAgentStore } from "#store/worker-agents";
import { useWorkerStore } from "#store/workers";

const mockSaveUserTemplate = vi.fn<(template: SessionTemplate) => Promise<void>>();
const mockApplyTemplate = vi.fn<typeof applyTemplate>();
/** One promise per test, like the real cached resource (a fresh promise per call would re-suspend forever). */
let userTemplates: Promise<UserTemplatesResult>;
vi.mock(import("#lib/templates"), async (importOriginal) => ({
  ...(await importOriginal()),
  saveUserTemplate: (template) => mockSaveUserTemplate(template),
  applyTemplate: (template) => mockApplyTemplate(template),
  userTemplatesResource: () => userTemplates,
}));

/** `true` makes the active transport report no workspace browsing (the `build:web` page). */
const web = vi.hoisted(() => ({ on: false }));
vi.mock(import("#lib/tauri"), async (importOriginal) => ({
  ...(await importOriginal()),
  hasCapability: () => !web.on,
}));

const mockSaveToFile = vi.fn<(...args: unknown[]) => Promise<string | null>>();
vi.mock(import("#lib/export"), async (importOriginal) => ({
  ...(await importOriginal()),
  saveToFile: (...args) => mockSaveToFile(...args),
}));

// jsdom has no Popover API; the menu only needs these to exist here.
beforeAll(() => {
  HTMLElement.prototype.showPopover ??= () => {};
  HTMLElement.prototype.hidePopover ??= () => {};
});
afterAll(() => {
  Reflect.deleteProperty(HTMLElement.prototype, "showPopover");
  Reflect.deleteProperty(HTMLElement.prototype, "hidePopover");
});

const WORKER_ID = "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d";

function addSession(overrides: Partial<Session> = {}): Session {
  const session: Session = {
    id: crypto.randomUUID(),
    name: "Research Sprint",
    workerIds: [],
    createdAt: "2026-09-01T12:00:00.000Z",
    updatedAt: "2026-09-01T12:00:00.000Z",
    ...overrides,
  };
  useSessionStore.getState().addSession(session);
  return session;
}

function resetStores(): void {
  const sessions = useSessionStore.getState();
  for (const [id] of sessions.sessions) sessions.removeSession(id);
  sessions.setActiveSession(null);
  useWorkerStore.getState().removeWorker(WORKER_ID);
  useWorkerAgentStore.getState().removeAgentMetadata(WORKER_ID);
}

async function renderPage() {
  await act(async () => {
    render(<Sessions />);
  });
}

/** Opens a session card's menu item (the menu is a popover jsdom renders hidden). */
function chooseMenuItem(name: string): void {
  fireEvent.click(screen.getAllByRole("menuitem", { name, hidden: true })[0] as HTMLElement);
}

beforeEach(() => {
  web.on = false;
  vi.stubGlobal("isTauri", true);
  resetStores();
  vi.clearAllMocks();
  mockSaveUserTemplate.mockReset().mockResolvedValue(undefined);
  mockSaveToFile.mockReset().mockResolvedValue(null);
  mockApplyTemplate.mockReset();
  userTemplates = Promise.resolve({ templates: [], failed: false });
});
afterEach(() => {
  cleanup();
  resetStores();
  vi.unstubAllGlobals();
});

describe("Sessions — local stores need the Tauri bridge", () => {
  it("disables Snapshot and Save As Template, with the reason, without the bridge", async () => {
    vi.unstubAllGlobals();
    const session = addSession();
    useSessionStore.getState().setActiveSession(session.id);
    await renderPage();

    const snapshot = screen.getByRole("button", { name: "Snapshot" });
    expect(snapshot).toBeDisabled();
    expect(snapshot).toHaveAccessibleDescription("Available In The Desktop App Only");
    const item = screen.getAllByRole("menuitem", { name: "Save As Template", hidden: true })[0];
    expect(item).toHaveAttribute("aria-disabled", "true");
    chooseMenuItem("Save As Template");
    expect(screen.queryByRole("form")).not.toBeInTheDocument();
  });
});

describe("Sessions — Save As Template", () => {
  // A saved template carries the session's reproducible workers in workerConfigs; an empty
  // list would make every apply report "0 Of 0 Workers Spawned".
  it("saves a template carrying the session's workers", async () => {
    const user = userEvent.setup();
    useWorkerStore.getState().addWorker({
      id: WORKER_ID,
      state: "running",
      name: "Analyst",
      startedAt: "2026-09-01T12:00:00.000Z",
    });
    useWorkerAgentStore
      .getState()
      .setAgentMetadata(WORKER_ID, { role: "analyst", model: "opus", systemPrompt: "Analyze." });
    addSession({ workerIds: [WORKER_ID] });
    await renderPage();

    chooseMenuItem("Save As Template");
    const form = screen.getByRole("form", { name: 'Save "Research Sprint" As A Template' });
    const name = within(form).getByRole("textbox", { name: "Template Name" });
    expect(name).toHaveValue("Research Sprint");
    expect(name).toHaveFocus();

    await user.type(within(form).getByRole("textbox", { name: "Description" }), "Mine");
    await user.click(within(form).getByRole("button", { name: "Save Template" }));

    expect(mockSaveUserTemplate).toHaveBeenCalledOnce();
    expect(mockSaveUserTemplate.mock.calls[0]?.[0]).toMatchObject({
      name: "Research Sprint",
      description: "Mine",
      builtIn: false,
      workerConfigs: [
        { name: "Analyst", role: "analyst", model: "opus", systemPrompt: "Analyze." },
      ],
    });
    expect(toast.success).toHaveBeenCalledWith('Template "Research Sprint" Saved');
    expect(screen.queryByRole("form")).not.toBeInTheDocument();
  });

  it("refuses to save a session with no reproducible workers, saying why", async () => {
    const user = userEvent.setup();
    addSession({ workerIds: ["0a0b0c0d-0e0f-4a1b-8c2d-3e4f5a6b7c8d"] });
    await renderPage();

    chooseMenuItem("Save As Template");
    await user.click(screen.getByRole("button", { name: "Save Template" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "This Session Has No Workers To Save As A Template.",
    );
    expect(mockSaveUserTemplate).not.toHaveBeenCalled();
    expect(screen.getByRole("textbox", { name: "Template Name" })).toHaveAttribute(
      "aria-invalid",
      "true",
    );
  });

  it("saves once when Enter and a click race while the save is pending", async () => {
    const user = userEvent.setup();
    const pending = Promise.withResolvers<void>();
    mockSaveUserTemplate.mockReturnValue(pending.promise);
    useWorkerStore.getState().addWorker({
      id: WORKER_ID,
      state: "running",
      name: "Analyst",
      startedAt: "2026-09-01T12:00:00.000Z",
    });
    addSession({ workerIds: [WORKER_ID] });
    await renderPage();

    chooseMenuItem("Save As Template");
    await user.type(screen.getByRole("textbox", { name: "Template Name" }), "{Enter}");
    await user.click(screen.getByRole("button", { name: /Save Template/ }));

    expect(mockSaveUserTemplate).toHaveBeenCalledOnce();
    await act(async () => {
      pending.resolve();
    });
    expect(mockSaveUserTemplate).toHaveBeenCalledOnce();
  });

  it("returns focus to the menu trigger when the form closes", async () => {
    const user = userEvent.setup();
    addSession();
    await renderPage();

    const trigger = screen.getByRole("button", { name: 'Actions For Session "Research Sprint"' });
    trigger.focus();
    chooseMenuItem("Save As Template");
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("form")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();

    trigger.focus();
    chooseMenuItem("Save As Template");
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("form")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });
});

describe("Sessions — views", () => {
  it("marks the active view with aria-pressed", async () => {
    const user = userEvent.setup();
    await renderPage();

    expect(screen.getByRole("button", { name: "List" })).toHaveAttribute("aria-pressed", "true");
    await user.click(screen.getByRole("button", { name: "Search" }));
    expect(screen.getByRole("button", { name: "Search" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "List" })).toHaveAttribute("aria-pressed", "false");
  });

  it("keeps a search query across a round trip through another view", async () => {
    const user = userEvent.setup();
    await renderPage();

    await user.click(screen.getByRole("button", { name: "Search" }));
    await user.type(screen.getByRole("searchbox", { name: "Search Sessions" }), "sprint");
    await user.click(screen.getByRole("button", { name: "List" }));
    await user.click(screen.getByRole("button", { name: "Search" }));

    expect(screen.getByRole("searchbox", { name: "Search Sessions" })).toHaveValue("sprint");
  });
});

describe("Sessions — export and templates", () => {
  it("disables every file export and says why when the transport cannot browse files", async () => {
    web.on = true;
    const user = userEvent.setup();
    const session = addSession();
    useSessionStore.getState().setActiveSession(session.id);
    await renderPage();

    for (const name of ["Export MD", "Export JSON", "Export Metrics"]) {
      const button = screen.getByRole("button", { name });
      expect(button).toBeDisabled();
      expect(button).toHaveAccessibleDescription("Available In The Desktop App Only");
      await user.click(button);
    }
    chooseMenuItem("Export As JSON");
    expect(
      screen.getAllByRole("menuitem", { name: "Export As JSON", hidden: true })[0],
    ).toHaveAttribute("aria-disabled", "true");
    expect(mockSaveToFile).not.toHaveBeenCalled();
  });

  it("exports the metrics history as CSV", async () => {
    const user = userEvent.setup();
    await renderPage();

    await user.click(screen.getByRole("button", { name: "Export Metrics" }));

    expect(mockSaveToFile).toHaveBeenCalledExactlyOnceWith(
      expect.stringMatching(/^time,cpu,memory,workerCount/),
      "swarm-metrics.csv",
      "CSV",
      "csv",
    );
  });

  it("exports the active session as Markdown under a filesystem-safe name", async () => {
    const user = userEvent.setup();
    const session = addSession({ name: 'Q3: "Big" Plan' });
    useSessionStore.getState().setActiveSession(session.id);
    mockSaveToFile.mockResolvedValue("C:\\out\\q3-big-plan.md");
    await renderPage();

    await user.click(screen.getByRole("button", { name: "Export MD" }));

    expect(mockSaveToFile).toHaveBeenCalledWith(
      expect.stringContaining('# Session: Q3: "Big" Plan'),
      "q3-big-plan.md",
      "Markdown",
      "md",
    );
    expect(toast.success).toHaveBeenCalledWith("Session Exported To C:\\out\\q3-big-plan.md");
  });

  function appliedSession(): Session {
    return {
      id: crypto.randomUUID(),
      name: "Applied",
      workerIds: [],
      createdAt: "2026-09-01T12:00:00.000Z",
      updatedAt: "2026-09-01T12:00:00.000Z",
    };
  }

  it("reports a template whose workers all failed to spawn as a failure, and activates its session", async () => {
    const user = userEvent.setup();
    const session = appliedSession();
    mockApplyTemplate.mockResolvedValue({
      session,
      workerIds: [],
      failures: ["Coder: Worker Limit Reached"],
    });
    const template = BUILT_IN_TEMPLATES[0] as SessionTemplate;
    await renderPage();

    await user.click(screen.getByRole("button", { name: "Templates" }));
    await user.click(screen.getByRole("button", { name: new RegExp(`^${template.name}`) }));

    await vi.waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith(
        `Template "${template.name}" Failed — 0 Of ${template.workerConfigs.length} Workers Spawned`,
        { description: "Coder: Worker Limit Reached" },
      );
    });
    expect(useSessionStore.getState().activeSessionId).toBe(session.id);
  });

  it("reports a template with no workers as an empty session, not a spawn failure", async () => {
    const user = userEvent.setup();
    const empty: SessionTemplate = {
      id: "6e5d4c3b-2a19-4807-8f6e-5d4c3b2a1908",
      name: "Legacy Empty",
      description: "Saved By An Older Build",
      workerConfigs: [],
      builtIn: false,
    };
    userTemplates = Promise.resolve({ templates: [empty], failed: false });
    mockApplyTemplate.mockResolvedValue({
      session: appliedSession(),
      workerIds: [],
      failures: [],
    });
    await renderPage();

    await user.click(screen.getByRole("button", { name: "Templates" }));
    await user.click(await screen.findByRole("button", { name: /^Legacy Empty/ }));

    await vi.waitFor(() => {
      expect(toast.warning).toHaveBeenCalledWith(
        'Template "Legacy Empty" Has No Workers — Created An Empty Session',
      );
    });
    expect(toast.error).not.toHaveBeenCalled();
  });
});
