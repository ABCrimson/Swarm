import { useAtomValue } from "jotai";
import { type PageId, useNavigate } from "#hooks/useNavigate";
import { currentPageAtom, sidebarCollapsedAtom } from "#store/ui";

interface NavItem {
  readonly id: PageId;
  readonly label: string;
  /** SVG child elements of a 24×24, stroke-drawn icon. */
  readonly icon: React.ReactNode;
}

/** The shared frame of every nav icon: 18px, 24-unit viewBox, currentColor strokes. */
function NavIcon({ children }: { readonly children: React.ReactNode }): React.ReactElement {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="shrink-0"
    >
      {children}
    </svg>
  );
}

/** Every page, in display order (matches the page host's order). */
const NAV_ITEMS: readonly NavItem[] = [
  {
    id: "dashboard",
    label: "Dashboard",
    icon: (
      <>
        <rect x="3" y="3" width="7" height="9" rx="1.5" />
        <rect x="14" y="3" width="7" height="5" rx="1.5" />
        <rect x="14" y="12" width="7" height="9" rx="1.5" />
        <rect x="3" y="16" width="7" height="5" rx="1.5" />
      </>
    ),
  },
  {
    id: "workers",
    label: "Workers",
    icon: (
      <>
        <rect x="4" y="4" width="6" height="6" rx="1" />
        <rect x="14" y="4" width="6" height="6" rx="1" />
        <rect x="4" y="14" width="6" height="6" rx="1" />
        <rect x="14" y="14" width="6" height="6" rx="1" />
        <line x1="10" y1="7" x2="14" y2="7" />
        <line x1="7" y1="10" x2="7" y2="14" />
      </>
    ),
  },
  {
    id: "sessions",
    label: "Sessions",
    icon: (
      <>
        <path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z" />
        <polyline points="14 2 14 8 20 8" />
        <line x1="8" y1="13" x2="16" y2="13" />
        <line x1="8" y1="17" x2="12" y2="17" />
      </>
    ),
  },
  {
    id: "metrics",
    label: "Metrics",
    icon: (
      <>
        <line x1="18" y1="20" x2="18" y2="10" />
        <line x1="12" y1="20" x2="12" y2="4" />
        <line x1="6" y1="20" x2="6" y2="14" />
        <line x1="3" y1="20" x2="21" y2="20" />
      </>
    ),
  },
  {
    id: "logs",
    label: "Logs",
    icon: (
      <>
        <line x1="8" y1="6" x2="21" y2="6" />
        <line x1="8" y1="12" x2="21" y2="12" />
        <line x1="8" y1="18" x2="21" y2="18" />
        <line x1="3" y1="6" x2="3.01" y2="6" />
        <line x1="3" y1="12" x2="3.01" y2="12" />
        <line x1="3" y1="18" x2="3.01" y2="18" />
      </>
    ),
  },
  {
    id: "tools",
    label: "Tools",
    icon: (
      <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
    ),
  },
  {
    id: "workspace",
    label: "Workspace",
    icon: <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />,
  },
  {
    id: "settings",
    label: "Settings",
    icon: (
      <>
        <circle cx="12" cy="12" r="3" />
        <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
      </>
    ),
  },
];

/** Index of the item the Arrow/Home/End keys move focus to, or `null` for other keys. */
function nextNavIndex(key: string, index: number): number | null {
  switch (key) {
    case "ArrowDown":
      return (index + 1) % NAV_ITEMS.length;
    case "ArrowUp":
      return (index - 1 + NAV_ITEMS.length) % NAV_ITEMS.length;
    case "Home":
      return 0;
    case "End":
      return NAV_ITEMS.length - 1;
    default:
      return null;
  }
}

/**
 * Sidebar navigation: the logo, one button per page, and the version.
 *
 * Keyboard: the nav is one Tab stop (roving tabindex on the current
 * page's button, or the first button if the current page has none);
 * Arrow Up/Down, Home and End move between buttons. Navigation runs in
 * a transition (`useNavigate`), so the current page stays on screen
 * until the next one is ready.
 */
export function Sidebar(): React.ReactElement {
  const currentPage = useAtomValue(currentPageAtom);
  const collapsed = useAtomValue(sidebarCollapsedAtom);
  const navigate = useNavigate();
  const tabStop = Math.max(
    0,
    NAV_ITEMS.findIndex((item) => item.id === currentPage),
  );

  const handleKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>, index: number): void => {
    const next = nextNavIndex(e.key, index);
    if (next === null) return;
    e.preventDefault();
    e.currentTarget.parentElement
      ?.querySelectorAll<HTMLButtonElement>(":scope > button")
      [next]?.focus();
  };

  return (
    <div className="glass-panel flex h-full select-none flex-col overflow-hidden border-border border-r">
      <div className="flex h-14 items-center border-border border-b px-5">
        <span
          aria-hidden="true"
          className={`font-display font-extrabold text-plasma tracking-[0.08em] [text-shadow:0_0_20px_oklch(from_var(--color-plasma)_l_c_h/0.3)] ${collapsed ? "text-base" : "text-[1.15rem]"}`}
        >
          {collapsed ? "S" : "SWARM"}
        </span>
      </div>

      <nav className="flex flex-1 flex-col gap-0.5 px-2.5 py-3" aria-label="Page Navigation">
        {NAV_ITEMS.map((item, index) => {
          const isActive = item.id === currentPage;
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => navigate(item.id)}
              onKeyDown={(e) => handleKeyDown(e, index)}
              aria-current={isActive ? "page" : undefined}
              tabIndex={index === tabStop ? 0 : -1}
              title={collapsed ? item.label : undefined}
              aria-label={collapsed ? item.label : undefined}
              className="group flex w-full cursor-pointer items-center gap-2.5 whitespace-nowrap rounded-lg border-transparent border-l-[2.5px] px-3 py-2.25 text-left font-[450] text-fg-muted text-md tracking-[0.01em] transition-colors duration-150 hover:bg-surface-2 hover:text-fg aria-[current=page]:border-plasma aria-[current=page]:bg-linear-135 aria-[current=page]:from-surface-3 aria-[current=page]:to-surface-2 aria-[current=page]:font-semibold aria-[current=page]:text-fg-bright"
            >
              <span className="flex opacity-60 transition-opacity duration-150 group-aria-[current=page]:opacity-100">
                <NavIcon>{item.icon}</NavIcon>
              </span>
              {!collapsed && item.label}
            </button>
          );
        })}
      </nav>

      <div className="border-border border-t px-4 py-3 font-mono text-2xs text-fg-dim tracking-[0.04em]">
        {collapsed ? "v" : `v${__APP_VERSION__}`}
      </div>
    </div>
  );
}
