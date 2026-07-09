import { save } from "@tauri-apps/plugin-dialog";
import { readScopedTextFile, writeScopedTextFile } from "#lib/fs";
import {
  createSession as createSessionIpc,
  deleteSession as deleteSessionIpc,
  getSession as getSessionIpc,
  listSessions as listSessionsIpc,
} from "#lib/tauri";
import { useSessionStore } from "#store/sessions";
import type { Session } from "#store/types";
import { SessionSchema } from "#store/types";

interface UseSessionReturn {
  session: Session | undefined;
  update: (updates: Partial<Session>) => void;
  remove: () => Promise<void>;
  setActive: () => void;
}

/**
 * Provides session data and IPC-backed CRUD operations for a single session.
 * All mutating actions invoke the Tauri command then update the Zustand store.
 */
export function useSession(id: string): UseSessionReturn {
  const session = useSessionStore((s) => s.sessions.get(id));
  const updateSession = useSessionStore((s) => s.updateSession);
  const removeSession = useSessionStore((s) => s.removeSession);
  const setActiveSession = useSessionStore((s) => s.setActiveSession);

  const update = (updates: Partial<Session>) => {
    updateSession(id, updates);
  };

  const remove = async () => {
    await deleteSessionIpc(id);
    removeSession(id);
  };

  const setActive = () => {
    setActiveSession(id);
  };

  return { session, update, remove, setActive };
}

/**
 * Hook providing session lifecycle operations: create, list, restore, export, import.
 */
export function useSessionActions(): {
  create: (name: string) => Promise<Session>;
  loadAll: () => Promise<void>;
  restore: (id: string) => Promise<Session>;
  exportSession: (session: Session) => Promise<void>;
  importSession: (filePath: string) => Promise<Session | null>;
  restoreOnStartup: () => Promise<void>;
} {
  const addSession = useSessionStore((s) => s.addSession);
  const setActiveSession = useSessionStore((s) => s.setActiveSession);

  const create = async (name: string) => {
    const session = await createSessionIpc(name);
    addSession(session);
    return session;
  };

  const loadAll = async () => {
    const sessions = await listSessionsIpc();
    for (const session of sessions) {
      addSession(session);
    }
  };

  const restore = async (id: string) => {
    const session = await getSessionIpc(id);
    addSession(session);
    setActiveSession(id);
    return session;
  };

  const exportSession = async (session: Session) => {
    const filePath = await save({
      title: "Export Session",
      defaultPath: `${session.name.replaceAll(/\s+/g, "-").toLowerCase()}.json`,
      filters: [{ name: "JSON", extensions: ["json"] }],
    });

    if (!filePath) return;

    const data = JSON.stringify(session, null, 2);
    await writeScopedTextFile(filePath, data);
  };

  const importSession = async (filePath: string): Promise<Session | null> => {
    const content = await readScopedTextFile(filePath);
    if (!content) return null;

    const parsed = JSON.parse(content) as unknown;
    const result = SessionSchema.safeParse(parsed);
    if (!result.success) return null;

    const session: Session = {
      ...result.data,
      id: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    addSession(session);
    return session;
  };

  const restoreOnStartup = async () => {
    try {
      const sessions = await listSessionsIpc();
      for (const session of sessions) {
        addSession(session);
      }
    } catch {
      // Backend may not be ready yet — swallow silently on startup
    }
  };

  return { create, loadAll, restore, exportSession, importSession, restoreOnStartup };
}
