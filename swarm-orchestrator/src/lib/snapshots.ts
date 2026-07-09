import { load } from "@tauri-apps/plugin-store";
import { useSessionStore } from "#store/sessions";
import type { Session, Snapshot } from "#store/types";
import { useWorkerStore } from "#store/workers";

/** plugin-store key prefix for snapshots. */
const SNAPSHOT_KEY_PREFIX = "swarm:snapshots:";

/**
 * Get or create the plugin-store instance for snapshots.
 */
async function getSnapshotStore() {
  return load("swarm-snapshots.json", { defaults: {}, autoSave: true });
}

/**
 * Create a snapshot of the current session state including worker states.
 */
export async function createSnapshot(session: Session): Promise<Snapshot> {
  const workers = useWorkerStore.getState().workers;

  // Collect worker data for workers in this session
  const workerData: Record<string, unknown> = {};
  for (const workerId of session.workerIds) {
    const worker = workers.get(workerId);
    if (worker) {
      workerData[workerId] = { ...worker };
    }
  }

  const snapshot: Snapshot = {
    id: crypto.randomUUID(),
    sessionId: session.id,
    timestamp: new Date().toISOString(),
    data: {
      session: { ...session },
      workers: workerData,
    },
  };

  // Store the snapshot
  const store = await getSnapshotStore();
  const key = `${SNAPSHOT_KEY_PREFIX}${session.id}`;
  const existing = await store.get<Snapshot[]>(key);
  const snapshots = existing ?? [];
  snapshots.push(snapshot);

  // Keep last 50 snapshots per session
  if (snapshots.length > 50) {
    snapshots.splice(0, snapshots.length - 50);
  }

  await store.set(key, snapshots);

  // Update session with snapshot ID
  const { updateSession } = useSessionStore.getState();
  const currentSnapshotIds = session.snapshotIds ?? [];
  updateSession(session.id, {
    snapshotIds: [...currentSnapshotIds, snapshot.id],
    updatedAt: new Date().toISOString(),
  });

  return snapshot;
}

/**
 * List all snapshots for a session.
 */
export async function listSnapshots(sessionId: string): Promise<Snapshot[]> {
  const store = await getSnapshotStore();
  const key = `${SNAPSHOT_KEY_PREFIX}${sessionId}`;
  const snapshots = await store.get<Snapshot[]>(key);
  return snapshots ?? [];
}

/**
 * Get a specific snapshot by ID within a session.
 */
export async function getSnapshot(sessionId: string, snapshotId: string): Promise<Snapshot | null> {
  const snapshots = await listSnapshots(sessionId);
  return snapshots.find((s) => s.id === snapshotId) ?? null;
}

/**
 * Deep-diff two snapshot data objects.
 * Returns an object describing additions, removals, and changes.
 */
export function diffSnapshots(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
): SnapshotDiff {
  const diff: SnapshotDiff = {
    added: {},
    removed: {},
    changed: {},
  };

  const allKeys = new Set([...Object.keys(a), ...Object.keys(b)]);

  for (const key of allKeys) {
    const valA = a[key];
    const valB = b[key];

    if (!(key in a)) {
      diff.added[key] = valB;
    } else if (!(key in b)) {
      diff.removed[key] = valA;
    } else if (
      typeof valA === "object" &&
      typeof valB === "object" &&
      valA !== null &&
      valB !== null
    ) {
      const nested = diffSnapshots(
        valA as Record<string, unknown>,
        valB as Record<string, unknown>,
      );
      if (
        Object.keys(nested.added).length > 0 ||
        Object.keys(nested.removed).length > 0 ||
        Object.keys(nested.changed).length > 0
      ) {
        diff.changed[key] = nested;
      }
    } else if (valA !== valB) {
      diff.changed[key] = { from: valA, to: valB };
    }
  }

  return diff;
}

/** Structural diff between two snapshot data objects describing mutations. */
export interface SnapshotDiff {
  added: Record<string, unknown>;
  removed: Record<string, unknown>;
  changed: Record<string, unknown>;
}

/**
 * Delete all snapshots for a session.
 */
export async function clearSnapshots(sessionId: string): Promise<void> {
  const store = await getSnapshotStore();
  const key = `${SNAPSHOT_KEY_PREFIX}${sessionId}`;
  await store.delete(key);
}
