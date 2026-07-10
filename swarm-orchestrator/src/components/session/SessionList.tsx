import { useResizeObserver } from "@crimson_dev/use-resize-observer";
import { useRef, useState } from "react";
import { useSessionStore } from "#store/sessions";
import { SessionCard } from "./SessionCard.tsx";

const ROW_HEIGHT = 80;
const OVERSCAN = 5;

interface ContextMenuState {
  readonly x: number;
  readonly y: number;
  readonly sessionId: string;
}

interface SessionListProps {
  readonly onDelete: (id: string) => void;
  readonly onExport: (id: string) => void;
  readonly onCreateTemplate: (id: string) => void;
}

/**
 * Chronologically grouped session list with day-based headers,
 * active session highlighting, and a right-click context menu.
 */
export function SessionList({
  onDelete,
  onExport,
  onCreateTemplate,
}: SessionListProps): React.ReactElement {
  const sessions = useSessionStore((s) => s.sessions);
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const setActiveSession = useSessionStore((s) => s.setActiveSession);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);

  const { ref: virtualizationRef, height: containerHeight = 0 } =
    useResizeObserver<HTMLDivElement>();

  const sortedSessions = [...sessions.values()].sort(
    (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
  );

  const totalHeight = sortedSessions.length * ROW_HEIGHT;
  const startIndex = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const endIndex = Math.min(
    sortedSessions.length,
    Math.ceil((scrollTop + containerHeight) / ROW_HEIGHT) + OVERSCAN,
  );
  const visibleSessions = sortedSessions.slice(startIndex, endIndex);

  const handleActivate = (id: string) => {
    setActiveSession(id);
  };

  const handleContextMenu = (e: React.MouseEvent, sessionId: string) => {
    setContextMenu({ x: e.clientX, y: e.clientY, sessionId });
  };

  const closeContextMenu = () => {
    setContextMenu(null);
  };

  const handleContextAction = (action: "delete" | "export" | "template") => {
    if (!contextMenu) return;
    const { sessionId } = contextMenu;
    setContextMenu(null);

    switch (action) {
      case "delete":
        onDelete(sessionId);
        break;
      case "export":
        onExport(sessionId);
        break;
      case "template":
        onCreateTemplate(sessionId);
        break;
    }
  };

  if (sortedSessions.length === 0) {
    return (
      <div
        className="flex flex-col items-center justify-center py-16 text-center"
        style={{ color: "oklch(0.55 0.03 220)" }}
      >
        <p className="text-lg font-medium" style={{ fontFamily: "var(--font-display)" }}>
          No Sessions Yet
        </p>
        <p className="mt-1 text-sm" style={{ fontFamily: "var(--font-body)" }}>
          Create A New Session To Get Started.
        </p>
      </div>
    );
  }

  return (
    <div
      ref={virtualizationRef}
      style={{ height: "100%", overflowY: "auto" }}
      onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
    >
      <div style={{ height: totalHeight, position: "relative" }}>
        {visibleSessions.map((session, i) => (
          <div
            key={session.id}
            style={{
              position: "absolute",
              top: (startIndex + i) * ROW_HEIGHT,
              height: ROW_HEIGHT,
              width: "100%",
            }}
          >
            <SessionCard
              session={session}
              isActive={session.id === activeSessionId}
              onActivate={handleActivate}
              onContextMenu={handleContextMenu}
            />
          </div>
        ))}
      </div>

      {/* Context menu */}
      {contextMenu && (
        <>
          {/* Backdrop to close */}
          <button
            type="button"
            className="fixed inset-0 z-40 cursor-default"
            onClick={closeContextMenu}
            onKeyDown={(e) => {
              if (e.key === "Escape") closeContextMenu();
            }}
            tabIndex={-1}
            aria-label="Close Context Menu"
            style={{ background: "oklch(0 0 0 / 0)", border: "none" }}
          />

          <div
            ref={menuRef}
            className="fixed z-50 min-w-[160px] rounded-lg py-1.5 shadow-xl"
            style={{
              left: contextMenu.x,
              top: contextMenu.y,
              background: "oklch(0.15 0.03 220 / 0.95)",
              backdropFilter: "blur(16px) saturate(1.5)",
              border: "1px solid oklch(0.30 0.05 220)",
            }}
          >
            <ContextMenuItem label="Export As JSON" onClick={() => handleContextAction("export")} />
            <ContextMenuItem
              label="Save As Template"
              onClick={() => handleContextAction("template")}
            />
            <div className="my-1 h-px" style={{ background: "oklch(0.28 0.04 220)" }} />
            <ContextMenuItem
              label="Delete Session"
              danger
              onClick={() => handleContextAction("delete")}
            />
          </div>
        </>
      )}
    </div>
  );
}

function ContextMenuItem({
  label,
  danger = false,
  onClick,
}: {
  readonly label: string;
  readonly danger?: boolean;
  readonly onClick: () => void;
}): React.ReactElement {
  return (
    <button
      type="button"
      onClick={onClick}
      className="w-full px-3 py-1.5 text-left text-sm transition-colors cursor-pointer"
      style={{
        fontFamily: "var(--font-body)",
        color: danger ? "oklch(0.72 0.20 10)" : "oklch(0.78 0.03 220)",
      }}
      onMouseEnter={(e) => {
        (e.currentTarget as HTMLElement).style.background = danger
          ? "oklch(0.20 0.06 10 / 0.3)"
          : "oklch(0.22 0.04 220 / 0.5)";
      }}
      onMouseLeave={(e) => {
        (e.currentTarget as HTMLElement).style.background = "oklch(0 0 0 / 0)";
      }}
    >
      {label}
    </button>
  );
}
