import { ask, open, save } from "@tauri-apps/plugin-dialog";
import { readTextFile, rename, writeTextFile } from "@tauri-apps/plugin-fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { exportAsJSON, parseSessionExport } from "#lib/export";
import {
  createAndActivateSession,
  deleteSessionAfterConfirm,
  exportSessionToFile,
  importSessionFromFile,
} from "#lib/session-lifecycle";
import { useSessionStore } from "#store/sessions";
import type { Session } from "#store/types";

vi.mock(import("@tauri-apps/plugin-dialog"), () => ({
  ask: vi.fn(),
  open: vi.fn(),
  save: vi.fn(),
}));

const mockCreateSession = vi.fn<(name: string) => Promise<Session>>();
const mockDeleteSession = vi.fn<(id: string) => Promise<void>>();
vi.mock(import("#lib/tauri"), async (importOriginal) => ({
  ...(await importOriginal()),
  createSession: (name) => mockCreateSession(name),
  deleteSession: (id) => mockDeleteSession(id),
}));

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: crypto.randomUUID(),
    name: "Research Sprint",
    workerIds: [],
    createdAt: "2026-09-01T12:00:00.000Z",
    updatedAt: "2026-09-01T12:00:00.000Z",
    ...overrides,
  };
}

function resetStore(): void {
  const state = useSessionStore.getState();
  for (const [id] of state.sessions) state.removeSession(id);
  state.setActiveSession(null);
}

beforeEach(() => {
  resetStore();
  vi.clearAllMocks();
  mockCreateSession.mockImplementation(async (name) => makeSession({ name }));
  mockDeleteSession.mockResolvedValue(undefined);
});
afterEach(resetStore);

describe("createAndActivateSession", () => {
  it("creates the backend session, adds it to the store and makes it active", async () => {
    const session = await createAndActivateSession("Alpha");

    expect(mockCreateSession).toHaveBeenCalledExactlyOnceWith("Alpha");
    expect(useSessionStore.getState().sessions.get(session.id)).toEqual(session);
    expect(useSessionStore.getState().activeSessionId).toBe(session.id);
  });
});

describe("exportSessionToFile", () => {
  // The export writes the dialog-chosen path directly: an atomic
  // `.tmp`-then-rename helper's `.tmp` sibling is outside both the
  // dialog's one-file grant and the static fs scope, so every
  // destination outside $APPDATA / ~/.swarm would fail with a
  // forbidden-path error.
  it("writes exactly the dialog-chosen path, with no temp sibling or base directory", async () => {
    vi.mocked(save).mockResolvedValue("D:\\Exports\\research-sprint.json");
    const session = makeSession();

    const path = await exportSessionToFile(session);

    expect(path).toBe("D:\\Exports\\research-sprint.json");
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({ defaultPath: "research-sprint.json" }),
    );
    expect(writeTextFile).toHaveBeenCalledExactlyOnceWith(
      "D:\\Exports\\research-sprint.json",
      expect.any(String),
    );
    expect(rename).not.toHaveBeenCalled();
  });

  it("writes the format import reads back", async () => {
    vi.mocked(save).mockResolvedValue("/tmp/s.json");
    const session = makeSession({ metadata: { tags: ["a"] } });

    await exportSessionToFile(session);

    const written = vi.mocked(writeTextFile).mock.calls[0]?.[1];
    expect(typeof written).toBe("string");
    expect(parseSessionExport(written as string)).toEqual(session);
  });

  it("writes nothing when the dialog is cancelled", async () => {
    vi.mocked(save).mockResolvedValue(null);

    expect(await exportSessionToFile(makeSession())).toBeNull();
    expect(writeTextFile).not.toHaveBeenCalled();
  });
});

describe("importSessionFromFile", () => {
  it("returns null when the dialog is cancelled", async () => {
    vi.mocked(open).mockResolvedValue(null);

    expect(await importSessionFromFile()).toBeNull();
    expect(mockCreateSession).not.toHaveBeenCalled();
  });

  // Import creates a real backend session: a store-only session with a
  // random id is unknown to the backend, so deleting it would always fail.
  it("imports an exported file as a new backend session, keeping metadata but not another run's ids", async () => {
    const original = makeSession({
      name: "Exported",
      workerIds: [crypto.randomUUID()],
      snapshotIds: [crypto.randomUUID()],
      metadata: { description: "Kept", tags: ["x"] },
    });
    vi.mocked(open).mockResolvedValue("C:\\in.json");
    vi.mocked(readTextFile).mockResolvedValue(exportAsJSON(original));

    const imported = await importSessionFromFile();

    expect(mockCreateSession).toHaveBeenCalledExactlyOnceWith("Exported");
    expect(imported?.id).not.toBe(original.id);
    expect(imported?.workerIds).toEqual([]);
    expect(imported?.snapshotIds).toBeUndefined();
    expect(imported?.metadata).toEqual({ description: "Kept", tags: ["x"] });
    expect(useSessionStore.getState().sessions.get(imported?.id ?? "")).toEqual(imported);
  });

  it("also reads the bare-session shape older exports wrote", async () => {
    vi.mocked(open).mockResolvedValue("C:\\old.json");
    vi.mocked(readTextFile).mockResolvedValue(JSON.stringify(makeSession({ name: "Old Shape" })));

    expect((await importSessionFromFile())?.name).toBe("Old Shape");
  });

  it("rejects a file that is neither shape, creating nothing", async () => {
    vi.mocked(open).mockResolvedValue("C:\\junk.json");
    vi.mocked(readTextFile).mockResolvedValue('{"hello":"world"}');

    await expect(importSessionFromFile()).rejects.toThrow("Invalid Session File Format");
    expect(mockCreateSession).not.toHaveBeenCalled();
  });
});

describe("deleteSessionAfterConfirm", () => {
  it("does nothing when the user declines", async () => {
    vi.mocked(ask).mockResolvedValue(false);
    const session = makeSession();
    useSessionStore.getState().addSession(session);

    expect(await deleteSessionAfterConfirm(session)).toBe(false);
    expect(mockDeleteSession).not.toHaveBeenCalled();
    expect(useSessionStore.getState().sessions.has(session.id)).toBe(true);
  });

  it("deletes from the backend, then the store", async () => {
    vi.mocked(ask).mockResolvedValue(true);
    const session = makeSession();
    useSessionStore.getState().addSession(session);

    expect(await deleteSessionAfterConfirm(session)).toBe(true);
    expect(ask).toHaveBeenCalledWith(expect.stringContaining('"Research Sprint"'), {
      title: "Delete Session",
      kind: "warning",
    });
    expect(mockDeleteSession).toHaveBeenCalledExactlyOnceWith(session.id);
    expect(useSessionStore.getState().sessions.has(session.id)).toBe(false);
  });

  it("keeps the session in the store when the backend refuses", async () => {
    vi.mocked(ask).mockResolvedValue(true);
    mockDeleteSession.mockRejectedValue(new Error("Session not found"));
    const session = makeSession();
    useSessionStore.getState().addSession(session);

    await expect(deleteSessionAfterConfirm(session)).rejects.toThrow("Session not found");
    expect(useSessionStore.getState().sessions.has(session.id)).toBe(true);
  });
});
