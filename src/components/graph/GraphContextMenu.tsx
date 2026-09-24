import type { CSSProperties } from "react";
import { startTransition, useEffect, useId, useRef } from "react";
import { useWorker } from "#hooks/useWorker";

interface GraphContextMenuProps {
  /** Viewport coordinates of the right-click. */
  readonly x: number;
  readonly y: number;
  readonly workerId: string;
  /** Opens the worker's detail panel. */
  readonly onInspect: () => void;
  /** Called once the menu has closed, for any reason (action, Escape, click outside, Tab). */
  readonly onClose: () => void;
}

interface MenuItemProps {
  readonly label: string;
  readonly onSelect: () => void;
  readonly variant?: "default" | "danger";
  readonly disabled?: boolean;
}

/**
 * A `role="menuitem"` button. A disabled item stays focusable (announced
 * as unavailable) but does nothing, as the ARIA menu pattern recommends.
 */
function MenuItem({
  label,
  onSelect,
  variant = "default",
  disabled = false,
}: MenuItemProps): React.ReactElement {
  return (
    <button
      type="button"
      role="menuitem"
      tabIndex={-1}
      className="graph-context-menu__item"
      data-variant={variant}
      aria-disabled={disabled || undefined}
      onClick={disabled ? undefined : onSelect}
    >
      {label}
    </button>
  );
}

/** Moves focus among the menu's items: arrows wrap, Home/End jump. */
function moveFocus(menu: HTMLElement, key: string): boolean {
  const items = [...menu.querySelectorAll<HTMLElement>('[role="menuitem"]')];
  const current = items.indexOf(document.activeElement as HTMLElement);
  const next =
    key === "ArrowDown"
      ? (current + 1) % items.length
      : key === "ArrowUp"
        ? (current - 1 + items.length) % items.length
        : key === "Home"
          ? 0
          : key === "End"
            ? items.length - 1
            : -1;
  if (next === -1) return false;
  items[next]?.focus();
  return true;
}

/**
 * Context menu for a worker node in the Workers topology graph (measured
 * causality): Pause, Resume, Inspect and Kill.
 *
 * Pause/Resume/Kill run through `useWorker` — the same IPC path as the
 * detail panel — inside a transition, so the backend actually pauses,
 * resumes or kills the process (and Kill drops the worker and its agent
 * metadata only once the backend confirms). The menu reflects the
 * worker's live state while open.
 *
 * It is a native `popover="auto"`: the browser provides top-layer
 * rendering, light dismiss (click outside, Escape) and focus restore.
 * Placement is CSS anchor positioning against a zero-size anchor at the
 * cursor, flipping at the viewport edges (`graph.css`). Keyboard: focus
 * moves to the first item on open; arrows/Home/End move between items;
 * Tab closes.
 */
export function GraphContextMenu({
  x,
  y,
  workerId,
  onInspect,
  onClose,
}: GraphContextMenuProps): React.ReactElement {
  const popoverRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const { worker, pause, resume, kill } = useWorker(workerId);
  const state = worker?.state;

  useEffect(() => {
    const popover = popoverRef.current;
    if (!popover) return undefined;
    popover.showPopover();
    popover.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    return () => {
      if (popover.matches(":popover-open")) popover.hidePopover();
    };
  }, []);

  const hide = (): void => popoverRef.current?.hidePopover();
  /** Closes the menu, then runs a lifecycle IPC action as a transition. */
  const run = (action: () => Promise<void>): void => {
    hide();
    startTransition(action);
  };

  const position = { "--menu-x": `${x}px`, "--menu-y": `${y}px` } as CSSProperties;

  return (
    <>
      <div className="graph-context-menu__anchor" style={position} />
      <div
        ref={popoverRef}
        popover="auto"
        className="graph-context-menu"
        style={position}
        onToggle={(event) => {
          if (event.newState === "closed") onClose();
        }}
      >
        <div id={titleId} className="graph-context-menu__title">
          {worker?.name ?? workerId.slice(0, 8)}
        </div>
        <div
          role="menu"
          aria-labelledby={titleId}
          tabIndex={-1}
          onKeyDown={(event) => {
            if (event.key === "Tab") hide();
            else if (moveFocus(event.currentTarget, event.key)) event.preventDefault();
          }}
        >
          <MenuItem label="Pause" onSelect={() => run(pause)} disabled={state !== "running"} />
          <MenuItem label="Resume" onSelect={() => run(resume)} disabled={state !== "paused"} />
          <hr />
          <MenuItem
            label="Inspect"
            onSelect={() => {
              hide();
              onInspect();
            }}
          />
          <MenuItem label="Kill" onSelect={() => run(kill)} variant="danger" />
        </div>
      </div>
    </>
  );
}
