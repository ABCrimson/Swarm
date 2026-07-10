import { ask, open, save } from "@tauri-apps/plugin-dialog";
import { useState } from "react";
import { Button } from "#components/ui/Button";
import { Input } from "#components/ui/Input";
import { toast } from "#components/ui/Toast";
import { readScopedTextFile, writeScopedTextFile } from "#lib/fs";
import { createSession as createSessionIpc, deleteSession as deleteSessionIpc } from "#lib/tauri";
import { useSessionStore } from "#store/sessions";
import type { Session } from "#store/types";
import { SessionSchema } from "#store/types";

interface SessionActionsProps {
  readonly onSessionCreated?: (session: Session) => void;
}

/**
 * Action bar for creating and importing sessions.
 *
 * Toggles an inline name input for new sessions and supports
 * JSON file import via the Tauri dialog plugin.
 */
export function SessionActions({ onSessionCreated }: SessionActionsProps): React.ReactElement {
  const addSession = useSessionStore((s) => s.addSession);

  const [showNameInput, setShowNameInput] = useState(false);
  const [nameValue, setNameValue] = useState("");
  const [isCreating, setIsCreating] = useState(false);

  const handleCreate = async () => {
    const trimmed = nameValue.trim();
    if (!trimmed) return;

    setIsCreating(true);
    try {
      const session = await createSessionIpc(trimmed);
      addSession(session);
      toast.success(`Session "${trimmed}" created`);
      onSessionCreated?.(session);
      setNameValue("");
      setShowNameInput(false);
    } catch (err) {
      toast.error(`Failed to create session: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setIsCreating(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      void handleCreate();
    } else if (e.key === "Escape") {
      setShowNameInput(false);
      setNameValue("");
    }
  };

  const handleImport = async () => {
    try {
      const filePath = await open({
        title: "Import Session",
        multiple: false,
        filters: [{ name: "JSON", extensions: ["json"] }],
      });

      if (!filePath) return;

      const content = await readScopedTextFile(filePath);
      if (!content) {
        toast.error("Could not read file");
        return;
      }

      const parsed = JSON.parse(content) as unknown;
      const result = SessionSchema.safeParse(parsed);

      if (!result.success) {
        toast.error("Invalid session file format");
        return;
      }

      const session = result.data;

      // Assign new ID and timestamps for imported session
      const imported: Session = {
        ...session,
        id: crypto.randomUUID(),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      addSession(imported);
      toast.success(`Session "${imported.name}" imported`);
    } catch (err) {
      toast.error(`Import failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-2">
      {showNameInput ? (
        <div className="flex items-center gap-2">
          <Input
            placeholder="Session name..."
            value={nameValue}
            onChange={(e) => setNameValue(e.target.value)}
            onKeyDown={handleKeyDown}
            autoFocus
            className="w-48"
          />
          <Button
            variant="primary"
            size="sm"
            loading={isCreating}
            onClick={() => void handleCreate()}
            disabled={!nameValue.trim()}
          >
            Create
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setShowNameInput(false);
              setNameValue("");
            }}
          >
            Cancel
          </Button>
        </div>
      ) : (
        <Button variant="primary" size="sm" onClick={() => setShowNameInput(true)}>
          New Session
        </Button>
      )}

      <Button variant="secondary" size="sm" onClick={() => void handleImport()}>
        Import
      </Button>
    </div>
  );
}

/**
 * Hook providing session lifecycle operations (delete with confirmation, export as JSON).
 *
 * Used by context menus and action bars to manage session CRUD.
 */
export function useSessionLifecycle(): {
  deleteWithConfirm: (id: string) => Promise<void>;
  exportSession: (id: string) => Promise<void>;
} {
  const sessions = useSessionStore((s) => s.sessions);
  const removeSession = useSessionStore((s) => s.removeSession);

  const deleteWithConfirm = async (id: string) => {
    const session = sessions.get(id);
    const name = session?.name ?? id.slice(0, 8);

    const confirmed = await ask(
      `Are you sure you want to delete session "${name}"? This action cannot be undone.`,
      { title: "Delete Session", kind: "warning" },
    );
    if (!confirmed) return;

    try {
      await deleteSessionIpc(id);
      removeSession(id);
      toast.success(`Session "${name}" deleted`);
    } catch (err) {
      toast.error(`Failed to delete session: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const exportSession = async (id: string) => {
    const session = sessions.get(id);
    if (!session) {
      toast.error("Session not found");
      return;
    }

    try {
      const filePath = await save({
        title: "Export Session",
        defaultPath: `${session.name.replaceAll(/\s+/g, "-").toLowerCase()}.json`,
        filters: [{ name: "JSON", extensions: ["json"] }],
      });

      if (!filePath) return;

      const data = JSON.stringify(session, null, 2);
      await writeScopedTextFile(filePath, data);
      toast.success(`Session exported to ${filePath}`);
    } catch (err) {
      toast.error(`Export failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  return { deleteWithConfirm, exportSession };
}
