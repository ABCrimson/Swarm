// ── getPersistedRepoRoot Zod-at-the-seam (adversarial review F5) ──
//
// read_config returns arbitrary JSON for any key — getPersistedRepoRoot
// must validate the raw response is a non-empty string rather than
// trusting it, matching this codebase's safeParse-at-the-seam
// discipline (see #lib/event-bus, spawnWorker's response validation).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getPersistedRepoRoot } from "#lib/project-root";

const readConfigMock = vi.fn();

vi.mock("#lib/tauri", () => ({
  readConfig: (...args: unknown[]) => readConfigMock(...args),
}));

describe("getPersistedRepoRoot", () => {
  beforeEach(() => {
    readConfigMock.mockReset();
  });
  afterEach(() => {
    readConfigMock.mockReset();
  });

  it("returns the persisted string value", async () => {
    readConfigMock.mockResolvedValueOnce("C:/Projects/swarm-orchestrator");

    await expect(getPersistedRepoRoot()).resolves.toBe("C:/Projects/swarm-orchestrator");
  });

  it("returns null when nothing is persisted", async () => {
    readConfigMock.mockResolvedValueOnce(null);

    await expect(getPersistedRepoRoot()).resolves.toBeNull();
  });

  it("returns null (never throws) for a malformed non-string value", async () => {
    readConfigMock.mockResolvedValueOnce({ not: "a string" });

    await expect(getPersistedRepoRoot()).resolves.toBeNull();
  });

  it("returns null for an empty string rather than a falsy-but-truthy config value", async () => {
    readConfigMock.mockResolvedValueOnce("");

    await expect(getPersistedRepoRoot()).resolves.toBeNull();
  });

  it("reads the default_repo_root key", async () => {
    readConfigMock.mockResolvedValueOnce(null);

    await getPersistedRepoRoot();

    expect(readConfigMock).toHaveBeenCalledWith("default_repo_root");
  });
});
