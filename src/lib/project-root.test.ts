// `read_config` returns arbitrary JSON for any key, so the persisted
// project root is validated at the seam instead of trusted.

import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getPersistedRepoRoot } from "#lib/project-root";

describe("getPersistedRepoRoot", () => {
  beforeEach(() => {
    vi.stubGlobal("isTauri", true);
    vi.mocked(tauriInvoke).mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reads the default_repo_root key and returns its string value", async () => {
    vi.mocked(tauriInvoke).mockResolvedValueOnce("C:/Projects/swarm-orchestrator");

    await expect(getPersistedRepoRoot()).resolves.toBe("C:/Projects/swarm-orchestrator");
    expect(tauriInvoke).toHaveBeenCalledExactlyOnceWith("read_config", {
      key: "default_repo_root",
    });
  });

  it("returns null when nothing is persisted", async () => {
    vi.mocked(tauriInvoke).mockResolvedValueOnce(null);

    await expect(getPersistedRepoRoot()).resolves.toBeNull();
  });

  it("returns null (never throws) for a non-string value", async () => {
    vi.mocked(tauriInvoke).mockResolvedValueOnce({ not: "a string" });

    await expect(getPersistedRepoRoot()).resolves.toBeNull();
  });

  it("returns null for an empty string", async () => {
    vi.mocked(tauriInvoke).mockResolvedValueOnce("");

    await expect(getPersistedRepoRoot()).resolves.toBeNull();
  });

  it("returns null outside the desktop shell, without a backend call", async () => {
    vi.stubGlobal("isTauri", false);

    await expect(getPersistedRepoRoot()).resolves.toBeNull();
    expect(tauriInvoke).not.toHaveBeenCalled();
  });
});
