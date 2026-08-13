// ── WorkerConfig naming-collision fix (Phase 0, Task 2) ─────
//
// spawnWorker used to send only {name}, silently dropping any
// shell/cwd/env a caller specified — this proves the IPC payload now
// includes them when present (and omits them when absent, matching
// Rust's #[serde(default)] fields), and that the raw response is
// Zod-validated (a bare worker UUID) rather than cast, matching the
// event-bus's safeParse-at-the-seam discipline.

import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sessionAddWorker, spawnWorker } from "#lib/tauri";

const WORKER_UUID = "550e8400-e29b-41d4-a716-446655440000";

/** Forces isTauri() true so #lib/tauri's invoke() wrapper doesn't short-circuit. */
function enableTauri(): void {
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
}

function disableTauri(): void {
  Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
}

describe("spawnWorker", () => {
  beforeEach(() => {
    vi.mocked(tauriInvoke).mockReset();
    enableTauri();
  });
  afterEach(disableTauri);

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

  it("returns the worker id from a valid UUID response", async () => {
    vi.mocked(tauriInvoke).mockResolvedValueOnce(WORKER_UUID);

    const id = await spawnWorker({ name: "Agent" });

    expect(id).toBe(WORKER_UUID);
  });

  it("Zod-validates the response and throws instead of trusting a malformed reply", async () => {
    vi.mocked(tauriInvoke).mockResolvedValueOnce({ not: "a uuid" });

    await expect(spawnWorker({ name: "Agent" })).rejects.toThrow(/Invalid Worker ID/);
  });
});

describe("sessionAddWorker", () => {
  beforeEach(() => {
    vi.mocked(tauriInvoke).mockReset();
    enableTauri();
  });
  afterEach(disableTauri);

  it("invokes session_add_worker with camelCase sessionId/workerId", async () => {
    vi.mocked(tauriInvoke).mockResolvedValueOnce(undefined);

    await sessionAddWorker("session-1", "worker-1");

    expect(tauriInvoke).toHaveBeenCalledWith("session_add_worker", {
      sessionId: "session-1",
      workerId: "worker-1",
    });
  });
});
