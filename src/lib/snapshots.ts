import { snapshotsStore } from "#lib/lazy-store";
import { useSessionStore } from "#store/sessions";
import type { Session, Snapshot } from "#store/types";
import { useWorkerStore } from "#store/workers";

/** plugin-store key prefix for snapshots; one key per session. */
const SNAPSHOT_KEY_PREFIX = "swarm:snapshots:";

/** Snapshots retained per session; older ones are evicted first. */
export const MAX_SNAPSHOTS_PER_SESSION = 50;

const snapshotKey = (sessionId: string): string => `${SNAPSHOT_KEY_PREFIX}${sessionId}`;

/**
 * Serializes every read-modify-write of `swarm-snapshots.json`: a manual
 * snapshot and an auto-snapshot tick racing on the same session would
 * otherwise both read the same list and the second write would drop
 * the first snapshot.
 */
let queue: Promise<unknown> = Promise.resolve();

function serialized<T>(op: () => Promise<T>): Promise<T> {
  const run = queue.then(op);
  queue = run.catch(() => {});
  return run;
}

/**
 * Snapshots `session` (and the current state of its workers) into
 * `swarm-snapshots.json`, keeping the newest
 * {@link MAX_SNAPSHOTS_PER_SESSION}. The session's `snapshotIds` are
 * rewritten to exactly the retained snapshots, on the session as it is
 * in the store once the write lands.
 */
export function createSnapshot(session: Session): Promise<Snapshot> {
  const workers = useWorkerStore.getState().workers;
  const snapshot: Snapshot = {
    id: crypto.randomUUID(),
    sessionId: session.id,
    timestamp: new Date().toISOString(),
    data: {
      session: { ...session },
      workers: Object.fromEntries(
        session.workerIds.flatMap((id) => {
          const worker = workers.get(id);
          return worker ? [[id, { ...worker }] as const] : [];
        }),
      ),
    },
  };

  return serialized(async () => {
    const key = snapshotKey(session.id);
    const retained = [...((await snapshotsStore.get<Snapshot[]>(key)) ?? []), snapshot].slice(
      -MAX_SNAPSHOTS_PER_SESSION,
    );
    await snapshotsStore.set(key, retained);

    if (useSessionStore.getState().sessions.has(session.id)) {
      useSessionStore.getState().updateSession(session.id, {
        snapshotIds: retained.map((s) => s.id),
        updatedAt: new Date().toISOString(),
      });
    }
    return snapshot;
  });
}

/** Deletes every snapshot of `sessionId` — called when the session itself is deleted. */
export function clearSnapshots(sessionId: string): Promise<void> {
  return serialized(async () => {
    await snapshotsStore.delete(snapshotKey(sessionId));
  });
}
