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
 * Delete all snapshots for a session.
 */
export async function clearSnapshots(sessionId: string): Promise<void> {
  const store = await getSnapshotStore();
  const key = `${SNAPSHOT_KEY_PREFIX}${sessionId}`;
  await store.delete(key);
}
