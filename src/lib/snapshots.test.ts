import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Session, Snapshot } from "#store/types";

const disk = vi.hoisted(() => new Map<string, unknown>());
const snapshotsStore = vi.hoisted(() => ({
  get: vi.fn(async (key: string) => disk.get(key)),
  set: vi.fn(async (key: string, value: unknown) => {
    // A yield between read and write is where an unserialized
    // read-modify-write would interleave.
    await Promise.resolve();
    disk.set(key, structuredClone(value));
  }),
  delete: vi.fn(async (key: string) => disk.delete(key)),
}));

vi.mock("#lib/lazy-store", () => ({ snapshotsStore }));

import { clearSnapshots, createSnapshot, MAX_SNAPSHOTS_PER_SESSION } from "#lib/snapshots";
import { useSessionStore } from "#store/sessions";
import { useWorkerStore } from "#store/workers";

const WORKER = "33333333-3333-4333-8333-333333333333";

function session(): Session {
  return {
    id: crypto.randomUUID(),
    name: "Session",
    workerIds: [WORKER, "44444444-4444-4444-8444-444444444444"],
    createdAt: "2026-09-23T12:00:00Z",
    updatedAt: "2026-09-23T12:00:00Z",
  };
}

const stored = (sessionId: string) => disk.get(`swarm:snapshots:${sessionId}`) as Snapshot[];

describe("#lib/snapshots", () => {
  beforeEach(() => {
    disk.clear();
    vi.clearAllMocks();
    useSessionStore.setState({ sessions: new Map(), activeSessionId: null });
    useWorkerStore.setState({ workers: new Map() });
  });

  it("captures the session and its live workers, skipping workers that are gone", async () => {
    const s = session();
    useWorkerStore.getState().addWorker({
      id: WORKER,
      state: "running",
      startedAt: "2026-09-23T12:00:00Z",
    });

    const snapshot = await createSnapshot(s);

    expect(snapshot.sessionId).toBe(s.id);
    expect(snapshot.data).toStrictEqual({
      session: s,
      workers: { [WORKER]: { id: WORKER, state: "running", startedAt: "2026-09-23T12:00:00Z" } },
    });
    expect(stored(s.id)).toStrictEqual([snapshot]);
  });

  it("keeps the newest snapshots and points the session's snapshotIds at exactly those", async () => {
    const s = session();
    useSessionStore.getState().addSession(s);

    const ids: string[] = [];
    for (let i = 0; i < MAX_SNAPSHOTS_PER_SESSION + 3; i++) ids.push((await createSnapshot(s)).id);

    const retained = ids.slice(-MAX_SNAPSHOTS_PER_SESSION);
    expect(stored(s.id).map((snap) => snap.id)).toStrictEqual(retained);
    expect(useSessionStore.getState().sessions.get(s.id)?.snapshotIds).toStrictEqual(retained);
  });

  it("serializes concurrent snapshots of one session so neither is lost", async () => {
    const s = session();
    useSessionStore.getState().addSession(s);

    const [a, b] = await Promise.all([createSnapshot(s), createSnapshot(s)]);

    expect(stored(s.id).map((snap) => snap.id)).toStrictEqual([a.id, b.id]);
    expect(useSessionStore.getState().sessions.get(s.id)?.snapshotIds).toStrictEqual([a.id, b.id]);
  });

  it("does not resurrect a session deleted while its snapshot was being written", async () => {
    const s = session();
    useSessionStore.getState().addSession(s);

    const pending = createSnapshot(s);
    useSessionStore.getState().removeSession(s.id);
    await pending;

    expect(useSessionStore.getState().sessions.has(s.id)).toBe(false);
  });

  it("clearSnapshots deletes every snapshot of a session", async () => {
    const s = session();
    await createSnapshot(s);

    await clearSnapshots(s.id);

    expect(disk.has(`swarm:snapshots:${s.id}`)).toBe(false);
  });
});
