import { describe, expect, it } from "vitest";
import { generateCommitMessage, inferCommitType, shippableCandidatePaths } from "#lib/ship-message";
import type { ShipPreflight } from "#store/types";

function makePreflight(overrides: Partial<ShipPreflight> = {}): ShipPreflight {
  return {
    workerId: "11111111-2222-3333-8444-555555555555",
    branch: "swarm/agent-abcd1234",
    baseBranch: "main",
    remote: "https://github.com/example/repo.git",
    host: "github.com",
    hostSupportsCompare: true,
    upstream: null,
    ahead: 0,
    behind: 0,
    staged: [],
    unstaged: [],
    untracked: [],
    skipped: [],
    diffStat: { filesChanged: 0, insertions: 0, deletions: 0 },
    canShip: true,
    blockers: [],
    ...overrides,
  };
}

describe("inferCommitType", () => {
  it("returns feat for an empty path set", () => {
    expect(inferCommitType([])).toBe("feat");
  });

  it("returns docs when every path is under docs/ or is markdown", () => {
    expect(inferCommitType(["docs/guide.md", "docs/api.md"])).toBe("docs");
    expect(inferCommitType(["README.md", "CHANGELOG.md"])).toBe("docs");
  });

  it("returns chore when every path matches a known config/lockfile shape", () => {
    expect(inferCommitType(["package.json", "pnpm-lock.yaml"])).toBe("chore");
    expect(inferCommitType(["Cargo.toml", ".github/workflows/ci.yml"])).toBe("chore");
  });

  it("falls back to feat for a mixed or code-touching set", () => {
    expect(inferCommitType(["src/main.rs", "docs/guide.md"])).toBe("feat");
    expect(inferCommitType(["src/components/ship/ShipPanel.tsx"])).toBe("feat");
  });
});

describe("shippableCandidatePaths", () => {
  it("dedupes across staged/unstaged/untracked and excludes skipped paths", () => {
    const preflight = makePreflight({
      staged: ["a.ts", "b.ts"],
      unstaged: ["b.ts", "c.ts"],
      untracked: ["d.ts", ".env"],
      skipped: [{ path: ".env", reason: "Skipped — Looks Like A Credential" }],
    });
    expect(shippableCandidatePaths(preflight)).toEqual(["a.ts", "b.ts", "c.ts", "d.ts"]);
  });
});

describe("generateCommitMessage", () => {
  it("produces a lowercase Conventional Commit type prefix, never Title Case", () => {
    const preflight = makePreflight({
      staged: ["src/lib/ship-message.ts"],
      diffStat: { filesChanged: 1, insertions: 40, deletions: 2 },
    });
    const message = generateCommitMessage(preflight);
    expect(message.startsWith("feat: ")).toBe(true);
  });

  it("infers docs: for a docs-only change and includes the diff stat line", () => {
    const preflight = makePreflight({
      staged: ["docs/api.md"],
      diffStat: { filesChanged: 1, insertions: 12, deletions: 3 },
    });
    const message = generateCommitMessage(preflight);
    expect(message.startsWith("docs: ")).toBe(true);
    expect(message).toContain("+12/-3 across 1 file.");
  });

  it("lists changed files up to the cap, with a summary line beyond it", () => {
    const manyFiles = Array.from({ length: 25 }, (_, i) => `src/file-${i}.ts`);
    const preflight = makePreflight({
      untracked: manyFiles,
      diffStat: { filesChanged: 25, insertions: 25, deletions: 0 },
    });
    const message = generateCommitMessage(preflight);
    for (const file of manyFiles.slice(0, 20)) {
      expect(message).toContain(file);
    }
    expect(message).toContain("...and 5 more");
  });

  it("summarizes a single changed file by name", () => {
    const preflight = makePreflight({
      staged: ["src/lib/tauri.ts"],
      diffStat: { filesChanged: 1, insertions: 5, deletions: 1 },
    });
    const message = generateCommitMessage(preflight);
    expect(message).toContain("update src/lib/tauri.ts");
  });

  it("never includes a skipped file in the generated message", () => {
    const preflight = makePreflight({
      untracked: [".env", "safe.txt"],
      skipped: [{ path: ".env", reason: "Skipped — Looks Like A Credential" }],
      diffStat: { filesChanged: 1, insertions: 1, deletions: 0 },
    });
    const message = generateCommitMessage(preflight);
    expect(message).not.toContain(".env");
    expect(message).toContain("safe.txt");
  });
});
