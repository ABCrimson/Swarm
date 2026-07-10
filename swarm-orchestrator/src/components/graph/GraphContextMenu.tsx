import { useEffect, useRef } from "react";

import type { WorkerState } from "#store/types";

interface GraphContextMenuProps {
  readonly x: number;
  readonly y: number;
  readonly workerId: string;
  readonly workerState: WorkerState;
  readonly onPause: () => void;
  readonly onResume: () => void;
  readonly onKill: () => void;
  readonly onInspect: () => void;
  readonly onClose: () => void;
}

interface MenuItemProps {
  readonly label: string;
  readonly onClick: () => void;
  readonly variant?: "default" | "danger";
  readonly disabled?: boolean;
}

function MenuItem({
  label,
  onClick,
  variant = "default",
  disabled = false,
}: MenuItemProps): React.ReactElement {
  const color = variant === "danger" ? "oklch(0.72 0.20 10)" : "oklch(0.82 0.04 220)";
  const hoverBg =
    variant === "danger" ? "oklch(0.72 0.20 10 / 0.12)" : "oklch(0.78 0.18 205 / 0.12)";

  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      disabled={disabled}
      style={{
        display: "block",
        width: "100%",
        padding: "8px 12px",
        background: "oklch(0 0 0 / 0)",
        border: "none",
        borderRadius: 6,
        color,
        fontFamily: "var(--font-body)",
        fontSize: "0.8125rem",
        textAlign: "left",
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.5 : 1,
        transition: "background 0.1s ease",
      }}
      onMouseEnter={(e) => {
        if (!disabled) e.currentTarget.style.background = hoverBg;
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = "oklch(0 0 0 / 0)";
      }}
    >
      {label}
    </button>
  );
}

/**
 * Context menu for worker nodes in the dependency graph.
 *
 * Provides pause, resume, inspect, and kill actions. Closes on click-outside,
 * right-click, or Escape key.
 */
export function GraphContextMenu({
  x,
  y,
  workerId,
  workerState,
  onPause,
  onResume,
  onKill,
  onInspect,
  onClose,
}: GraphContextMenuProps): React.ReactElement {
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };

    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("contextmenu", handleClickOutside);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("contextmenu", handleClickOutside);
    };
  }, [onClose]);

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [onClose]);

  const canPause = workerState === "running";
  const canResume = workerState === "paused";

  return (
    <div
      ref={menuRef}
      role="menu"
      aria-label="Worker context menu"
      style={{
        position: "fixed",
        top: y,
        left: x,
        zIndex: 50,
        minWidth: 160,
        padding: 4,
        background: "oklch(0.12 0.03 220 / 0.85)",
        backdropFilter: "blur(16px) saturate(1.5)",
        border: "1px solid oklch(0.28 0.05 220)",
        borderRadius: 8,
        boxShadow: "0 0 0 1px oklch(0.78 0.18 205 / 0.1), 0 12px 32px oklch(0.06 0.02 220 / 0.6)",
      }}
    >
      <div
        style={{
          padding: "4px 12px 6px",
          fontFamily: "var(--font-mono)",
          fontSize: "0.6875rem",
          color: "oklch(0.55 0.04 220)",
          userSelect: "text",
        }}
      >
        {workerId.slice(0, 8)}
      </div>
      <MenuItem label="Pause" onClick={onPause} disabled={!canPause} />
      <MenuItem label="Resume" onClick={onResume} disabled={!canResume} />
      <hr
        style={{
          height: 1,
          margin: "4px 0",
          background: "oklch(0.22 0.04 220)",
          border: "none",
        }}
      />
      <MenuItem label="Inspect" onClick={onInspect} />
      <MenuItem label="Kill" onClick={onKill} variant="danger" />
    </div>
  );
}
