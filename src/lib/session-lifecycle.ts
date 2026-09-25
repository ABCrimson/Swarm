/**
 * The Sessions page's lifecycle operations — create, import, export,
 * delete — each one backend call plus the store update that mirrors it.
 * Every function throws on failure (with a Title Case message when the
 * failure is ours) and leaves the toast to the caller.
 *
 * Sessions live in the backend's `SessionManager`; the store is a view of
 * it. That is why import creates a real backend session instead of only
 * adding a record to the store: a store-only session could never be
 * deleted (`delete_session` rejects an unknown id), would not survive a
 * restart, and could not have workers added to it.
 *
 * @module session-lifecycle
 */

import { ask } from "@tauri-apps/plugin-dialog";
import {
  exportAsJSON,
  parseSessionExport,
  readFromFile,
  saveToFile,
  sessionFileSlug,
} from "#lib/export";
import { createSession as createSessionIpc, deleteSession as deleteSessionIpc } from "#lib/tauri";
import { useSessionStore } from "#store/sessions";
import type { Session } from "#store/types";

/** Creates a backend session named `name`, adds it to the store and makes it the active one. */
export async function createAndActivateSession(name: string): Promise<Session> {
  const session = await createSessionIpc(name);
  const { addSession, setActiveSession } = useSessionStore.getState();
  addSession(session);
  setActiveSession(session.id);
  return session;
}

/**
 * Asks for a session JSON file (either shape `parseSessionExport` reads)
 * and imports it as a NEW backend session with the file's name. The
 * file's description and tags carry over (they are frontend-only
 * metadata); its worker and snapshot ids do not — they name another
 * run's processes, which this session never had.
 *
 * @returns The imported session, or `null` when the dialog was cancelled.
 */
export async function importSessionFromFile(): Promise<Session | null> {
  const text = await readFromFile("Import Session", "JSON", "json");
  if (text == null) return null;

  const parsed = parseSessionExport(text);
  if (parsed == null) throw new Error("Invalid Session File Format");

  const created = await createSessionIpc(parsed.name);
  const imported: Session =
    parsed.metadata != null ? { ...created, metadata: parsed.metadata } : created;
  useSessionStore.getState().addSession(imported);
  return imported;
}

/**
 * Writes `session` as `exportAsJSON`'s format to a file the user picks.
 *
 * @returns The chosen path, or `null` when the dialog was cancelled.
 */
export function exportSessionToFile(session: Session): Promise<string | null> {
  return saveToFile(exportAsJSON(session), `${sessionFileSlug(session.name)}.json`, "JSON", "json");
}

/**
 * Asks for confirmation, then deletes the session from the backend and
 * the store.
 *
 * @returns `false` when the user declined.
 */
export async function deleteSessionAfterConfirm(
  session: Pick<Session, "id" | "name">,
): Promise<boolean> {
  const confirmed = await ask(
    `Are You Sure You Want To Delete Session "${session.name}"? This Action Cannot Be Undone.`,
    { title: "Delete Session", kind: "warning" },
  );
  if (!confirmed) return false;

  await deleteSessionIpc(session.id);
  useSessionStore.getState().removeSession(session.id);
  return true;
}
