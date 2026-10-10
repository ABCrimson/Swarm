import { motion } from "motion/react";
import { type CSSProperties, useId, useRef } from "react";
import { Pill } from "#components/ui/Pill";
import { pluralizeWorkers } from "#lib/format";
import { formatRelativeTime } from "#lib/time";
import type { Session } from "#store/types";
import { useWorkerStore } from "#store/workers";

interface SessionCardProps {
  readonly session: Session;
  readonly isActive: boolean;
  readonly onActivate: (id: string) => void;
  readonly onExport: (id: string) => void;
  readonly onCreateTemplate: (id: string) => void;
  readonly onDelete: (id: string) => void;
}

/**
 * CSS anchor positioning, where the engine has it: the actions menu then
 * opens under its trigger and flips to stay on screen. Elsewhere the
 * popover keeps the UA default (centered in the viewport) — still usable,
 * never mispositioned.
 */
const SUPPORTS_ANCHOR_POSITIONING =
  globalThis.CSS?.supports?.("position-area", "block-end span-inline-start") ?? false;

/**
 * One session in the list: a full-width button that makes it the active
 * session (marked with `aria-current`), plus an actions button that opens
 * the session's menu — Export As JSON, Save As Template, Delete Session.
 * Right-clicking the card opens the same menu, so the pointer shortcut
 * and the keyboard path reach exactly the same actions.
 */
export function SessionCard({
  session,
  isActive,
  onActivate,
  onExport,
  onCreateTemplate,
  onDelete,
}: SessionCardProps): React.ReactElement {
  const menuId = useId();
  const anchorName = `--session-menu${menuId.replaceAll(/[^\w-]/g, "")}`;
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // `useWorkerEvents`'s `worker_killed` handler prunes `session.workerIds`
  // through `session_remove_worker`, but that round-trip is async and
  // best-effort — and sessions restored at startup still list the
  // previous run's workers. Intersecting with the live worker store keeps
  // the count true regardless. Selecting the derived number (not the
  // whole `workers` Map, which gets a new reference on every PTY output
  // chunk) lets Zustand's `Object.is` check skip re-renders.
  const liveWorkerCount = useWorkerStore((s) =>
    session.workerIds.reduce((count, id) => (s.workers.has(id) ? count + 1 : count), 0),
  );

  const relativeTime = formatRelativeTime(Temporal.Instant.from(session.updatedAt));
  const tags = session.metadata?.tags ?? [];

  const runMenuAction = (action: (id: string) => void) => {
    menuRef.current?.hidePopover();
    action(session.id);
  };

  return (
    <div className="relative">
      <motion.button
        type="button"
        onClick={() => onActivate(session.id)}
        onContextMenu={(e) => {
          e.preventDefault();
          menuRef.current?.showPopover({ source: triggerRef.current ?? undefined });
        }}
        aria-current={isActive || undefined}
        whileHover={{ scale: 1.015 }}
        whileTap={{ scale: 0.99 }}
        transition={{ type: "spring", stiffness: 400, damping: 25 }}
        className="block w-full cursor-pointer rounded-xl p-4 pr-12 text-left transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-plasma"
        style={{
          background: isActive ? "oklch(0.18 0.06 290 / 0.6)" : "oklch(0.14 0.02 220 / 0.5)",
          backdropFilter: "blur(12px) saturate(1.5)",
          border: isActive
            ? "1px solid oklch(0.65 0.28 290 / 0.6)"
            : "1px solid oklch(0.28 0.04 220 / 0.5)",
          boxShadow: isActive
            ? "0 0 20px oklch(0.55 0.25 290 / 0.15), inset 0 1px 0 oklch(1 0 0 / 0.05)"
            : "inset 0 1px 0 oklch(1 0 0 / 0.03)",
        }}
      >
        <span className="flex items-center justify-between gap-3">
          <span
            className="truncate text-sm font-semibold font-[family-name:var(--font-display)]"
            style={{ color: isActive ? "oklch(0.92 0.08 290)" : "oklch(0.88 0.02 220)" }}
          >
            {session.name}
          </span>
          <Pill tone="info" size="sm" className="shrink-0">
            {pluralizeWorkers(liveWorkerCount)}
          </Pill>
        </span>

        <span className="mt-1.5 block text-xs text-fg-dim font-[family-name:var(--font-body)]">
          {relativeTime}
        </span>

        {tags.length > 0 && (
          <span className="mt-2 flex flex-wrap gap-1">
            {tags.map((tag) => (
              <Pill key={tag} tone="neutral" size="sm" maxWidth={120}>
                {tag}
              </Pill>
            ))}
          </span>
        )}
      </motion.button>

      <button
        ref={triggerRef}
        type="button"
        popoverTarget={menuId}
        aria-haspopup="menu"
        aria-label={`Actions For Session "${session.name}"`}
        className="absolute top-3 right-3 grid size-7 cursor-pointer place-items-center rounded-md text-[oklch(0.65_0.04_220)] transition-colors hover:bg-[oklch(0.22_0.04_220/0.5)] hover:text-[oklch(0.88_0.02_220)] focus-visible:outline-2 focus-visible:outline-plasma"
        style={{ anchorName }}
      >
        <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
          <circle cx="3" cy="8" r="1.5" />
          <circle cx="8" cy="8" r="1.5" />
          <circle cx="13" cy="8" r="1.5" />
        </svg>
      </button>

      <SessionMenu
        ref={menuRef}
        id={menuId}
        anchorName={anchorName}
        sessionName={session.name}
        onExport={() => runMenuAction(onExport)}
        onCreateTemplate={() => runMenuAction(onCreateTemplate)}
        onDelete={() => runMenuAction(onDelete)}
      />
    </div>
  );
}

interface SessionMenuProps {
  readonly ref: React.Ref<HTMLDivElement>;
  readonly id: string;
  readonly anchorName: string;
  readonly sessionName: string;
  readonly onExport: () => void;
  readonly onCreateTemplate: () => void;
  readonly onDelete: () => void;
}

/** The item a menu key moves focus to (arrows wrap, Home/End jump), or `null` for any other key. */
function nextMenuIndex(key: string, current: number, count: number): number | null {
  switch (key) {
    case "ArrowDown":
      return (current + 1) % count;
    case "ArrowUp":
      return current <= 0 ? count - 1 : current - 1;
    case "Home":
      return 0;
    case "End":
      return count - 1;
    default:
      return null;
  }
}

/** Moves focus between `menu`'s items for a navigation key; `false` when `key` is not one. */
function focusMenuItem(menu: HTMLElement, key: string): boolean {
  const items = [...menu.querySelectorAll<HTMLElement>('[role="menuitem"]')];
  const current = items.indexOf(document.activeElement as HTMLElement);
  const next = items.length > 0 ? nextMenuIndex(key, current, items.length) : null;
  if (next == null) return false;
  items[next]?.focus();
  return true;
}

/**
 * The per-session actions menu, built on the Popover API
 * (`popover="auto"`): the platform provides light dismiss, Escape and
 * returning focus to the trigger. On top of that it follows the ARIA menu
 * pattern — focus lands on the first item when it opens, arrow keys /
 * Home / End move between items, and Tab closes it.
 */
function SessionMenu({
  ref,
  id,
  anchorName,
  sessionName,
  onExport,
  onCreateTemplate,
  onDelete,
}: SessionMenuProps): React.ReactElement {
  const anchored: CSSProperties | undefined = SUPPORTS_ANCHOR_POSITIONING
    ? {
        positionAnchor: anchorName,
        positionArea: "block-end span-inline-start",
        positionTryFallbacks: "flip-block, flip-inline",
        inset: "auto",
        margin: "4px 0 0",
      }
    : undefined;

  return (
    <div
      ref={ref}
      id={id}
      popover="auto"
      role="menu"
      aria-label={`Actions For Session "${sessionName}"`}
      className="min-w-40 rounded-lg border border-[oklch(0.30_0.05_220)] bg-[oklch(0.15_0.03_220/0.95)] py-1.5 text-[oklch(0.78_0.03_220)] shadow-xl backdrop-blur-lg"
      style={anchored}
      onToggle={(e) => {
        if (e.newState === "open") {
          e.currentTarget.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
        }
      }}
      onKeyDown={(e) => {
        if (e.key === "Tab") {
          e.currentTarget.hidePopover();
        } else if (focusMenuItem(e.currentTarget, e.key)) {
          e.preventDefault();
        }
      }}
    >
      <SessionMenuItem label="Export As JSON" onSelect={onExport} />
      <SessionMenuItem label="Save As Template" onSelect={onCreateTemplate} />
      <hr className="my-1 h-px border-0 bg-[oklch(0.28_0.04_220)]" />
      <SessionMenuItem label="Delete Session" danger onSelect={onDelete} />
    </div>
  );
}

function SessionMenuItem({
  label,
  danger = false,
  onSelect,
}: {
  readonly label: string;
  readonly danger?: boolean;
  readonly onSelect: () => void;
}): React.ReactElement {
  return (
    <button
      type="button"
      role="menuitem"
      tabIndex={-1}
      onClick={onSelect}
      className={`block w-full cursor-pointer px-3 py-1.5 text-left text-sm transition-colors font-[family-name:var(--font-body)] focus-visible:outline-2 focus-visible:-outline-offset-2 ${
        danger
          ? "text-rose hover:bg-[oklch(0.20_0.06_10/0.3)] focus:bg-[oklch(0.20_0.06_10/0.3)] focus-visible:outline-rose"
          : "hover:bg-[oklch(0.22_0.04_220/0.5)] focus:bg-[oklch(0.22_0.04_220/0.5)] focus-visible:outline-plasma"
      }`}
    >
      {label}
    </button>
  );
}
