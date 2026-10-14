// ── Session templates ────────────────────────────────
//
// applyTemplate creates a session, spawns one worker per workerConfigs
// entry, and wires each into the session. User templates live in a
// plugin-store file; building one from a session must capture that
// session's workers (an empty workerConfigs would apply as a session
// with no workers).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyTemplate,
  BUILT_IN_TEMPLATES,
  createTemplateFromSession,
  invalidateUserTemplates,
  loadUserTemplates,
  saveUserTemplate,
  subscribeUserTemplates,
  userTemplatesResource,
  workerSpecsForSession,
} from "#lib/templates";
import { useSessionStore } from "#store/sessions";
import type { Session, SessionTemplate } from "#store/types";
import { useWorkerAgentStore } from "#store/worker-agents";
import { useWorkerStore } from "#store/workers";

const createSessionMock = vi.fn();
const spawnWorkerMock = vi.fn();
const sessionAddWorkerMock = vi.fn();
const readConfigMock = vi.fn();

/** `true` makes the active transport report no capabilities (the swarmd `--serve-ui` page). */
const web = vi.hoisted(() => ({ on: false }));

vi.mock(import("#lib/tauri"), () => ({
  DESKTOP_ONLY_REASON: "Available In The Desktop App Only" as const,
  hasCapability: () => !web.on,
  createSession: (...args: unknown[]) => createSessionMock(...args),
  spawnWorker: (...args: unknown[]) => spawnWorkerMock(...args),
  sessionAddWorker: (...args: unknown[]) => sessionAddWorkerMock(...args),
  // spawnWorkerFromSpec (via #lib/project-root's getPersistedRepoRoot)
  // reads the persisted default project root on every spawn — default
  // to "none configured" so these tests exercise unisolated spawns.
  readConfig: (...args: unknown[]) => readConfigMock(...args),
}));

/** In-memory stand-in for the `swarm-templates.json` plugin-store file. */
const templateStore = vi.hoisted(() => ({
  data: new Map<string, unknown>(),
  failReads: false,
}));

vi.mock("@tauri-apps/plugin-store", () => ({
  LazyStore: class {
    async get(key: string) {
      if (templateStore.failReads) throw new Error("store unavailable");
      return structuredClone(templateStore.data.get(key));
    }
    async set(key: string, value: unknown) {
      templateStore.data.set(key, structuredClone(value));
    }
  },
}));

const STORE_KEY = "swarm:templates";

function builtIn(name: string): SessionTemplate {
  const template = BUILT_IN_TEMPLATES.find((t) => t.name === name);
  if (template == null) throw new Error(`no built-in template named ${name}`);
  return template;
}

function mockSession(id: string, name: string): Session {
  return {
    id,
    name,
    workerIds: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function userTemplate(overrides: Partial<SessionTemplate> = {}): SessionTemplate {
  return {
    id: crypto.randomUUID(),
    name: "Mine",
    description: "",
    workerConfigs: [{ name: "Agent", model: "sonnet" }],
    builtIn: false,
    createdAt: "2026-09-23T00:00:00.000Z",
    ...overrides,
  };
}

function resetStores(): void {
  for (const [id] of useWorkerStore.getState().workers) useWorkerStore.getState().removeWorker(id);
  for (const [id] of useSessionStore.getState().sessions) {
    useSessionStore.getState().removeSession(id);
  }
  for (const [id] of useWorkerAgentStore.getState().metadata) {
    useWorkerAgentStore.getState().removeAgentMetadata(id);
  }
  templateStore.data.clear();
  templateStore.failReads = false;
  invalidateUserTemplates();
}

beforeEach(() => {
  resetStores();
  createSessionMock.mockReset();
  spawnWorkerMock.mockReset();
  sessionAddWorkerMock.mockReset();
  sessionAddWorkerMock.mockResolvedValue(undefined);
  readConfigMock.mockReset();
  readConfigMock.mockResolvedValue(null);
});
afterEach(resetStores);

describe("applyTemplate", () => {
  it("creates a session and spawns one worker per workerConfigs entry", async () => {
    const template = builtIn("Multi-Agent Parallel");
    createSessionMock.mockResolvedValueOnce(mockSession(crypto.randomUUID(), template.name));
    spawnWorkerMock
      .mockResolvedValueOnce("w1")
      .mockResolvedValueOnce("w2")
      .mockResolvedValueOnce("w3");

    const { workerIds } = await applyTemplate(template);

    expect(workerIds).toEqual(["w1", "w2", "w3"]);
    expect(spawnWorkerMock).toHaveBeenCalledTimes(template.workerConfigs.length);
  });

  it("adds the created session to the store itself — createSession's response is validated/normalized, safe to trust directly", async () => {
    const template = builtIn("Single Agent");
    const sessionId = crypto.randomUUID();
    createSessionMock.mockResolvedValueOnce(mockSession(sessionId, template.name));
    spawnWorkerMock.mockResolvedValueOnce("w-single");

    await applyTemplate(template);

    // Rust also emits session_created independently of this call — that
    // write and this one race in either order. useSessionEvents' handler
    // merges instead of replacing (see its own tests), so this add is
    // safe even if the event arrives first or second.
    expect(useSessionStore.getState().sessions.has(sessionId)).toBe(true);
  });

  it("stores each spawned worker's role/model/systemPrompt in the agent metadata store", async () => {
    const template = builtIn("Single Agent");
    createSessionMock.mockResolvedValueOnce(mockSession(crypto.randomUUID(), template.name));
    spawnWorkerMock.mockResolvedValueOnce("w-single");

    await applyTemplate(template);

    expect(useWorkerAgentStore.getState().metadata.get("w-single")).toEqual({
      role: "general",
      model: "sonnet",
      systemPrompt: "You are a helpful AI assistant.",
    });
  });

  it("registers each spawned worker against the new session, growing workerIds", async () => {
    const template = builtIn("Single Agent");
    const sessionId = crypto.randomUUID();
    createSessionMock.mockResolvedValueOnce(mockSession(sessionId, template.name));
    spawnWorkerMock.mockResolvedValueOnce("w-solo");

    await applyTemplate(template);

    expect(sessionAddWorkerMock).toHaveBeenCalledWith(sessionId, "w-solo");
    expect(useSessionStore.getState().sessions.get(sessionId)?.workerIds).toEqual(["w-solo"]);
  });

  it("skips a worker whose spawn fails but still applies the rest of the template", async () => {
    const template = builtIn("Multi-Agent Parallel");
    createSessionMock.mockResolvedValueOnce(mockSession(crypto.randomUUID(), template.name));
    spawnWorkerMock
      .mockResolvedValueOnce("w1")
      .mockRejectedValueOnce(new Error("spawn failed"))
      .mockResolvedValueOnce("w3");
    using consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    const { workerIds, failures } = await applyTemplate(template);

    expect(workerIds).toEqual(["w1", "w3"]);
    expect(failures).toEqual([`${template.workerConfigs[1]?.name}: spawn failed`]);
    expect(consoleError).toHaveBeenCalledTimes(1);
  });

  it("counts a null spawn result (no Tauri bridge) as a failure without stopping the rest of the template", async () => {
    const template = builtIn("Multi-Agent Parallel");
    createSessionMock.mockResolvedValueOnce(mockSession(crypto.randomUUID(), template.name));
    spawnWorkerMock
      .mockResolvedValueOnce("w1")
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce("w3");
    using consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    const { workerIds, failures } = await applyTemplate(template);

    expect(workerIds).toEqual(["w1", "w3"]);
    expect(failures).toEqual([`${template.workerConfigs[1]?.name}: No Tauri IPC Bridge`]);
    expect(consoleError).toHaveBeenCalledTimes(1);
  });

  it("rejects without spawning anything when the session itself cannot be created", async () => {
    createSessionMock.mockRejectedValueOnce(new Error("backend down"));

    await expect(applyTemplate(builtIn("Pipeline"))).rejects.toThrow("backend down");
    expect(spawnWorkerMock).not.toHaveBeenCalled();
  });
});

describe("user template persistence", () => {
  it("loads only the stored entries that still validate as templates", async () => {
    const valid = userTemplate({ name: "Valid" });
    templateStore.data.set(STORE_KEY, [valid, { id: "not-a-uuid", name: 42 }, "junk"]);

    expect(await loadUserTemplates()).toEqual([valid]);
  });

  it("reads a missing or non-array store value as no templates", async () => {
    expect(await loadUserTemplates()).toEqual([]);
    templateStore.data.set(STORE_KEY, { not: "an array" });
    expect(await loadUserTemplates()).toEqual([]);
  });

  it("serializes overlapping saves so neither overwrites the other", async () => {
    const first = userTemplate({ name: "First" });
    const second = userTemplate({ name: "Second" });

    await Promise.all([saveUserTemplate(first), saveUserTemplate(second)]);

    expect(await loadUserTemplates()).toEqual([first, second]);
  });

  it("caches the user-template read until a write invalidates it", async () => {
    const first = userTemplatesResource();
    expect(userTemplatesResource()).toBe(first);
    expect(await first).toEqual({ templates: [], failed: false });

    const saved = userTemplate();
    await saveUserTemplate(saved);

    const next = userTemplatesResource();
    expect(next).not.toBe(first);
    expect(await next).toEqual({ templates: [saved], failed: false });
  });

  it("tells subscribers after every write, until they unsubscribe", async () => {
    const listener = vi.fn();
    const unsubscribe = subscribeUserTemplates(listener);
    const saved = userTemplate();

    await saveUserTemplate(saved);
    expect(listener).toHaveBeenCalledOnce();
    await saveUserTemplate(userTemplate());
    expect(listener).toHaveBeenCalledTimes(2);

    unsubscribe();
    await saveUserTemplate(userTemplate());
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("resolves a store failure to { failed: true } instead of rejecting", async () => {
    templateStore.failReads = true;
    using consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    expect(await userTemplatesResource()).toEqual({ templates: [], failed: true });
    expect(consoleError).toHaveBeenCalledOnce();
  });
});

describe("createTemplateFromSession", () => {
  const liveId = crypto.randomUUID();
  const metadataOnlyId = crypto.randomUUID();
  const unknownId = crypto.randomUUID();

  function sessionWithWorkers(): Session {
    return {
      ...mockSession(crypto.randomUUID(), "Source"),
      workerIds: [liveId, metadataOnlyId, unknownId],
    };
  }

  beforeEach(() => {
    useWorkerStore.getState().addWorker({
      id: liveId,
      state: "running",
      name: "Researcher",
      startedAt: "2026-09-23T00:00:00.000Z",
    });
    useWorkerAgentStore.getState().setAgentMetadata(liveId, {
      role: "analyst",
      model: "opus",
      systemPrompt: "Research things.",
    });
    useWorkerAgentStore.getState().setAgentMetadata(metadataOnlyId, { model: "haiku" });
  });

  it("captures each reproducible worker's name and agent metadata, skipping unknown ones", () => {
    expect(workerSpecsForSession(sessionWithWorkers())).toEqual([
      { name: "Researcher", role: "analyst", model: "opus", systemPrompt: "Research things." },
      { name: "Worker 2", model: "haiku" },
    ]);
  });

  it("builds a user template carrying those worker specs", () => {
    const template = createTemplateFromSession(sessionWithWorkers(), {
      name: "Research Crew",
      description: "Two Agents",
    });

    expect(template).toMatchObject({
      name: "Research Crew",
      description: "Two Agents",
      builtIn: false,
    });
    expect(template.workerConfigs).toEqual([
      { name: "Researcher", role: "analyst", model: "opus", systemPrompt: "Research things." },
      { name: "Worker 2", model: "haiku" },
    ]);
  });

  it("yields no worker specs for a session whose workers are all gone", () => {
    const session = { ...mockSession(crypto.randomUUID(), "Empty"), workerIds: [unknownId] };
    expect(
      createTemplateFromSession(session, { name: "X", description: "" }).workerConfigs,
    ).toEqual([]);
  });
});

describe("applyTemplate — Trojan Source", () => {
  it("records a failed worker's name with bidi controls escaped", async () => {
    const template: SessionTemplate = {
      ...builtIn("Single Agent"),
      workerConfigs: [{ name: "a\u202Eb" }],
    };
    createSessionMock.mockResolvedValueOnce(mockSession(crypto.randomUUID(), template.name));
    spawnWorkerMock.mockRejectedValueOnce(new Error("no"));
    using _consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    const { failures } = await applyTemplate(template);

    expect(failures).toEqual([String.raw`a\u202Eb: no`]);
  });
});

describe("applyTemplate — browser build", () => {
  beforeEach(() => {
    web.on = true;
  });
  afterEach(() => {
    web.on = false;
  });

  it("refuses a template with workers before creating a session or spawning", async () => {
    await expect(applyTemplate(builtIn("Pipeline"))).rejects.toThrow(
      "Available In The Desktop App Only",
    );
    expect(createSessionMock).not.toHaveBeenCalled();
    expect(spawnWorkerMock).not.toHaveBeenCalled();
  });
});
