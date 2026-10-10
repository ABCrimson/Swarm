import { useSessionStore } from "#store/sessions";
import { SessionCard } from "./SessionCard.tsx";

interface SessionListProps {
  readonly onDelete: (id: string) => void;
  readonly onExport: (id: string) => void;
  readonly onCreateTemplate: (id: string) => void;
}

/**
 * Every session, most recently updated first, with the active one
 * highlighted and a per-session actions menu (export / save as template /
 * delete — see `SessionCard`).
 *
 * Rows are plain flow layout with `content-visibility: auto`: the browser
 * skips rendering off-screen cards (the win a hand-rolled virtualizer
 * would buy) while every card keeps its real, content-driven height — so
 * a card with a wrapped tag row can never overlap the next one, which a
 * fixed-row-height virtualizer cannot promise. `contain-intrinsic-size:
 * auto 80px` reserves an estimate until a card has been laid out once,
 * then remembers its real size.
 */
export function SessionList({
  onDelete,
  onExport,
  onCreateTemplate,
}: SessionListProps): React.ReactElement {
  const sessions = useSessionStore((s) => s.sessions);
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const setActiveSession = useSessionStore((s) => s.setActiveSession);

  const sortedSessions = sessions
    .values()
    .toArray()
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));

  if (sortedSessions.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-center text-fg-dim">
        <p className="text-lg font-medium font-[family-name:var(--font-display)]">
          No Sessions Yet
        </p>
        <p className="mt-1 text-sm font-[family-name:var(--font-body)]">
          Create A New Session To Get Started.
        </p>
      </div>
    );
  }

  return (
    <ul
      aria-label="Sessions"
      className="m-0 flex h-full list-none flex-col gap-2 overflow-y-auto p-0"
    >
      {sortedSessions.map((session) => (
        <li
          key={session.id}
          className="[contain-intrinsic-size:auto_80px] [content-visibility:auto]"
        >
          <SessionCard
            session={session}
            isActive={session.id === activeSessionId}
            onActivate={setActiveSession}
            onExport={onExport}
            onCreateTemplate={onCreateTemplate}
            onDelete={onDelete}
          />
        </li>
      ))}
    </ul>
  );
}
