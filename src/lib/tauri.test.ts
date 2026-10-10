// #lib/tauri's command wrappers against a mocked Tauri `invoke`: the
// IPC payload each one sends, zod validation of every response, and the
// typed errors (with the original rejection as `cause`).

import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as z from "zod";
import {
  AgentSpawnCommandError,
  agentSpawn,
  checkForUpdates,
  createSession,
  gitPush,
  listSessions,
  listWorkers,
  readConfig,
  resizeWorker,
  ShipCommandError,
  sessionAddWorker,
  spawnWorker,
  validateRepoRoot,
} from "#lib/tauri";

const WORKER_UUID = "550e8400-e29b-41d4-a716-446655440000";
const SESSION_UUID = "6ba7b810-9dad-41d1-80b4-00c04fd430c8";

/** Sets the flag the desktop shell injects, so `isTauri()` is true and IPC is not short-circuited. */
function enableTauri(): void {
  vi.stubGlobal("isTauri", true);
}

function disableTauri(): void {
  vi.unstubAllGlobals();
}

beforeEach(() => {
  vi.mocked(tauriInvoke).mockReset();
  enableTauri();
});
afterEach(disableTauri);

describe("spawnWorker", () => {
  it("sends only name when shell/cwd/env are omitted", async () => {
    vi.mocked(tauriInvoke).mockResolvedValueOnce(WORKER_UUID);

    await spawnWorker({ name: "Agent" });

    expect(tauriInvoke).toHaveBeenCalledWith("spawn_worker", { config: { name: "Agent" } });
  });

  it("includes shell/cwd/env in the IPC payload when specified", async () => {
    vi.mocked(tauriInvoke).mockResolvedValueOnce(WORKER_UUID);

    await spawnWorker({
      name: "Agent",
      shell: "/bin/zsh",
      cwd: "/home/user/project",
      env: { FOO: "bar" },
    });

    expect(tauriInvoke).toHaveBeenCalledWith("spawn_worker", {
      config: {
        name: "Agent",
        shell: "/bin/zsh",
        cwd: "/home/user/project",
        env: { FOO: "bar" },
      },
    });
  });

  it("includes repoRoot/isolation in the IPC payload when specified", async () => {
    vi.mocked(tauriInvoke).mockResolvedValueOnce(WORKER_UUID);

    await spawnWorker({
      name: "Agent",
      repoRoot: "C:/Projects/swarm",
      isolation: "worktree",
    });

    expect(tauriInvoke).toHaveBeenCalledWith("spawn_worker", {
      config: {
        name: "Agent",
        repoRoot: "C:/Projects/swarm",
        isolation: "worktree",
      },
    });
  });

  it("omits repoRoot/isolation entirely when not specified — zero regression for existing callers", async () => {
    vi.mocked(tauriInvoke).mockResolvedValueOnce(WORKER_UUID);

    await spawnWorker({ name: "Agent" });

    const [, payload] = vi.mocked(tauriInvoke).mock.calls[0] as [string, { config: object }];
    expect(payload.config).not.toHaveProperty("repoRoot");
    expect(payload.config).not.toHaveProperty("isolation");
  });

  it("returns the worker id from a valid UUID response", async () => {
    vi.mocked(tauriInvoke).mockResolvedValueOnce(WORKER_UUID);

    const id = await spawnWorker({ name: "Agent" });

    expect(id).toBe(WORKER_UUID);
  });

  it("Zod-validates the response and throws instead of trusting a malformed reply", async () => {
    vi.mocked(tauriInvoke).mockResolvedValueOnce({ not: "a uuid" });

    await expect(spawnWorker({ name: "Agent" })).rejects.toThrow(/Invalid Worker ID/);
  });

  it("returns null without invoking IPC when there is no Tauri bridge", async () => {
    disableTauri();

    const id = await spawnWorker({ name: "Agent" });

    expect(id).toBeNull();
    expect(tauriInvoke).not.toHaveBeenCalled();
  });
});

describe("sessionAddWorker", () => {
  it("invokes session_add_worker with camelCase sessionId/workerId", async () => {
    vi.mocked(tauriInvoke).mockResolvedValueOnce(undefined);

    await sessionAddWorker("session-1", "worker-1");

    expect(tauriInvoke).toHaveBeenCalledWith("session_add_worker", {
      sessionId: "session-1",
      workerId: "worker-1",
    });
  });
});

describe("resizeWorker", () => {
  it("invokes resize_worker with the id and size", async () => {
    vi.mocked(tauriInvoke).mockResolvedValueOnce(null);

    await resizeWorker(WORKER_UUID, 40, 120);

    expect(tauriInvoke).toHaveBeenCalledWith("resize_worker", {
      id: WORKER_UUID,
      rows: 40,
      cols: 120,
    });
  });
});

// ── createSession normalization ──────────────────────
//
// create_session requires its `config` argument (the registry rejects
// the call with "Invalid Arguments: missing field `config`" without
// it). Rust's Session has no `updatedAt` field and represents
// `createdAt` as Unix seconds, while the frontend's SessionSchema
// requires ISO-8601 strings for both, so a raw pass-through would
// leave `updatedAt` undefined in the store.

describe("createSession", () => {
  const RAW_SESSION = {
    id: "550e8400-e29b-41d4-a716-446655440000",
    name: "Research Session",
    workerIds: [],
    createdAt: 1_700_000_000, // unix seconds
    config: {},
  };

  it("sends config: {} alongside name — create_session requires it with no default", async () => {
    vi.mocked(tauriInvoke).mockResolvedValueOnce(RAW_SESSION);

    await createSession("Research Session");

    expect(tauriInvoke).toHaveBeenCalledWith("create_session", {
      name: "Research Session",
      config: {},
    });
  });

  it("normalizes Rust's Unix-seconds createdAt to an ISO string", async () => {
    vi.mocked(tauriInvoke).mockResolvedValueOnce(RAW_SESSION);

    const session = await createSession("Research Session");

    expect(session.createdAt).toBe(new Date(RAW_SESSION.createdAt * 1000).toISOString());
  });

  it("seeds updatedAt with the same ISO timestamp as createdAt — Rust has no updatedAt field", async () => {
    vi.mocked(tauriInvoke).mockResolvedValueOnce(RAW_SESSION);

    const session = await createSession("Research Session");

    expect(session.updatedAt).toBe(session.createdAt);
  });

  it("throws instead of returning a value that would fail SessionSchema downstream", async () => {
    vi.mocked(tauriInvoke).mockResolvedValueOnce({ id: "not-even-a-uuid" });

    await expect(createSession("Research Session")).rejects.toThrow(/Unexpected Shape/);
  });
});

// ── listSessions normalization ───────────────────────
//
// listSessions parses through the same SessionResponseSchema as
// createSession; useSessionEvents hydrates the store from it at startup.

describe("listSessions", () => {
  const RAW_SESSION_A = {
    id: "550e8400-e29b-41d4-a716-446655440000",
    name: "Session A",
    workerIds: [],
    createdAt: 1_700_000_000,
    config: {},
  };
  const RAW_SESSION_B = {
    id: "660e8400-e29b-41d4-a716-446655440001",
    name: "Session B",
    workerIds: ["770e8400-e29b-41d4-a716-446655440002"],
    createdAt: 1_700_000_100,
  };

  it("normalizes every session in the list the same way createSession does", async () => {
    vi.mocked(tauriInvoke).mockResolvedValueOnce([RAW_SESSION_A, RAW_SESSION_B]);

    const sessions = await listSessions();

    expect(sessions).toHaveLength(2);
    expect(sessions[0].createdAt).toBe(new Date(RAW_SESSION_A.createdAt * 1000).toISOString());
    expect(sessions[0].updatedAt).toBe(sessions[0].createdAt);
    expect(sessions[1].workerIds).toEqual(RAW_SESSION_B.workerIds);
    expect(sessions[1].updatedAt).toBe(sessions[1].createdAt);
  });

  it("throws instead of returning a list containing a malformed entry", async () => {
    vi.mocked(tauriInvoke).mockResolvedValueOnce([RAW_SESSION_A, { id: "not-a-uuid" }]);

    await expect(listSessions()).rejects.toThrow(/Unexpected Shape/);
  });

  it("returns an empty list without invoking IPC when there is no Tauri bridge", async () => {
    disableTauri();

    const sessions = await listSessions();

    expect(sessions).toEqual([]);
    expect(tauriInvoke).not.toHaveBeenCalled();
  });
});

// ── validateRepoRoot ─────────────────────────────────
//
// The Project Root picker must confirm a directory is a real git repo
// via a live Rust round-trip before persisting it — otherwise a typo
// or a moved/deleted repo silently poisons default_repo_root and every
// subsequent isolated spawn hard-fails with a raw git error.

describe("validateRepoRoot", () => {
  it("returns the toplevel path on success", async () => {
    vi.mocked(tauriInvoke).mockResolvedValueOnce("C:/Projects/swarm-orchestrator");

    const toplevel = await validateRepoRoot("C:/Projects/swarm-orchestrator/src-tauri");

    expect(tauriInvoke).toHaveBeenCalledWith("validate_repo_root", {
      path: "C:/Projects/swarm-orchestrator/src-tauri",
    });
    expect(toplevel).toBe("C:/Projects/swarm-orchestrator");
  });

  it("rejects when the backend reports the path is not a git repository", async () => {
    vi.mocked(tauriInvoke).mockRejectedValueOnce(
      new Error("C:/tmp is not inside a git repository"),
    );

    await expect(validateRepoRoot("C:/tmp")).rejects.toThrow(/not inside a git repository/);
  });

  it("Zod-validates the response and throws instead of trusting a malformed reply", async () => {
    vi.mocked(tauriInvoke).mockResolvedValueOnce({ not: "a path" });

    await expect(validateRepoRoot("C:/Projects/x")).rejects.toThrow(/Invalid Response/);
  });

  it("throws (never silently returns null) when there is no Tauri IPC bridge", async () => {
    disableTauri();

    await expect(validateRepoRoot("C:/Projects/x")).rejects.toThrow(
      "Validate Repo Root Returned An Invalid Response.",
    );
    expect(tauriInvoke).not.toHaveBeenCalled();
  });
});

describe("listWorkers", () => {
  it("maps Rust WorkerInfo rows onto Worker, seconds to ISO, nulls omitted", async () => {
    vi.mocked(tauriInvoke).mockResolvedValueOnce([
      {
        id: WORKER_UUID,
        state: "paused",
        name: "Agent",
        pid: 4242,
        startedAt: 1_758_585_600,
        worktreePath: "/wt/agent",
        branch: "swarm/agent-550e8400",
        lastShippedSeq: null,
        lastShippedCommit: null,
      },
      { id: SESSION_UUID, state: "running", name: "Shell", pid: null, startedAt: 0 },
    ]);

    await expect(listWorkers()).resolves.toStrictEqual([
      {
        id: WORKER_UUID,
        state: "paused",
        name: "Agent",
        pid: 4242,
        startedAt: "2025-09-23T00:00:00.000Z",
        worktreePath: "/wt/agent",
        branch: "swarm/agent-550e8400",
      },
      { id: SESSION_UUID, state: "running", name: "Shell", startedAt: "1970-01-01T00:00:00.000Z" },
    ]);
    expect(tauriInvoke).toHaveBeenCalledExactlyOnceWith("list_workers", undefined);
  });

  it("rejects an unexpected shape, keeping the zod error as the cause", async () => {
    vi.mocked(tauriInvoke).mockResolvedValueOnce([{ id: "nope" }]);

    const err = await listWorkers().catch((e: unknown) => e);

    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe("List Workers Returned An Unexpected Shape.");
    expect((err as Error).cause).toBeInstanceOf(z.ZodError);
  });

  it("returns [] without a backend", async () => {
    disableTauri();

    await expect(listWorkers()).resolves.toStrictEqual([]);
    expect(tauriInvoke).not.toHaveBeenCalled();
  });
});

describe("readConfig", () => {
  it("returns the value when it matches the schema", async () => {
    vi.mocked(tauriInvoke).mockResolvedValueOnce(8);

    await expect(readConfig("max_workers", z.int().positive())).resolves.toBe(8);
    expect(tauriInvoke).toHaveBeenCalledExactlyOnceWith("read_config", { key: "max_workers" });
  });

  it("returns null and logs the issues for a value that does not match the schema", async () => {
    using warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.mocked(tauriInvoke).mockResolvedValueOnce("eight");

    await expect(readConfig("max_workers", z.int())).resolves.toBeNull();
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining("max_workers"),
      expect.arrayContaining([expect.objectContaining({ code: "invalid_type" })]),
    );
    expect(JSON.stringify(warn.mock.calls)).not.toContain("eight");
  });

  it("returns null without a backend (invoke resolves undefined)", async () => {
    disableTauri();

    await expect(readConfig("max_workers", z.int())).resolves.toBeNull();
    expect(tauriInvoke).not.toHaveBeenCalled();
  });
});

describe("typed command errors", () => {
  it("turns a structured ship rejection into a ShipCommandError with the raw value as cause", async () => {
    const shipError = { kind: "pushRejected", message: "Rejected.", remedy: "fetchAndRebase" };
    vi.mocked(tauriInvoke).mockRejectedValueOnce(shipError);

    const err = await gitPush(WORKER_UUID, SESSION_UUID, true).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ShipCommandError);
    expect((err as ShipCommandError).shipError).toStrictEqual(shipError);
    expect((err as ShipCommandError).message).toBe("Rejected.");
    expect((err as ShipCommandError).cause).toBe(shipError);
  });

  it("wraps a plain string rejection in an Error that keeps it as the cause", async () => {
    vi.mocked(tauriInvoke).mockRejectedValueOnce("git exited with 128");

    const err = await gitPush(WORKER_UUID, SESSION_UUID, true).catch((e: unknown) => e);

    expect(err).not.toBeInstanceOf(ShipCommandError);
    expect((err as Error).message).toBe("git exited with 128");
    expect((err as Error).cause).toBe("git exited with 128");
  });

  it("turns an agent_spawn attach failure into an AgentSpawnCommandError carrying the worker id", async () => {
    const raw = { workerId: WORKER_UUID, message: "Claude Code Is Not Signed In." };
    vi.mocked(tauriInvoke).mockRejectedValueOnce(raw);

    const err = await agentSpawn({ name: "Agent" }, "claude_code", undefined, undefined).catch(
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(AgentSpawnCommandError);
    expect((err as AgentSpawnCommandError).workerId).toBe(WORKER_UUID);
    expect((err as AgentSpawnCommandError).message).toBe("Claude Code Is Not Signed In.");
    expect((err as AgentSpawnCommandError).cause).toBe(raw);
  });
});

describe("checkForUpdates", () => {
  it("accepts the updater's null body/date", async () => {
    vi.mocked(tauriInvoke).mockResolvedValueOnce({
      available: true,
      version: "0.9.0",
      body: null,
      date: null,
    });

    await expect(checkForUpdates()).resolves.toStrictEqual({
      available: true,
      version: "0.9.0",
      body: null,
      date: null,
    });
  });

  it("rejects a response without `available`", async () => {
    vi.mocked(tauriInvoke).mockResolvedValueOnce({ version: "0.9.0" });

    await expect(checkForUpdates()).rejects.toThrow("Update Check Returned An Unexpected Shape.");
  });

  it("resolves { available: false } outside the desktop shell", async () => {
    disableTauri();

    await expect(checkForUpdates()).resolves.toStrictEqual({ available: false });
    expect(tauriInvoke).not.toHaveBeenCalled();
  });
});
