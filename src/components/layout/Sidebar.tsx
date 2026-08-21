import { useAtom } from "jotai";
import { useRef } from "react";
import { currentPageAtom, sidebarCollapsedAtom } from "#store/ui";

type PageId = "dashboard" | "workers" | "sessions" | "metrics" | "settings";

interface NavItem {
  readonly id: PageId;
  readonly label: string;
  readonly icon: React.ReactElement;
}

function IconDashboard(): React.ReactElement {
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
    >
      <rect x="3" y="3" width="7" height="9" rx="1.5" />
      <rect x="14" y="3" width="7" height="5" rx="1.5" />
      <rect x="14" y="12" width="7" height="9" rx="1.5" />
      <rect x="3" y="16" width="7" height="5" rx="1.5" />
    </svg>
  );
}

function IconWorkers(): React.ReactElement {
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
    >
      <rect x="4" y="4" width="6" height="6" rx="1" />
      <rect x="14" y="4" width="6" height="6" rx="1" />
      <rect x="4" y="14" width="6" height="6" rx="1" />
      <rect x="14" y="14" width="6" height="6" rx="1" />
      <line x1="10" y1="7" x2="14" y2="7" />
      <line x1="7" y1="10" x2="7" y2="14" />
    </svg>
  );
}

function IconSessions(): React.ReactElement {
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
    >
      <path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z" />
      <polyline points="14 2 14 8 20 8" />
      <line x1="8" y1="13" x2="16" y2="13" />
      <line x1="8" y1="17" x2="12" y2="17" />
    </svg>
  );
}

function IconMetrics(): React.ReactElement {
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
    >
      <line x1="18" y1="20" x2="18" y2="10" />
      <line x1="12" y1="20" x2="12" y2="4" />
      <line x1="6" y1="20" x2="6" y2="14" />
      <line x1="3" y1="20" x2="21" y2="20" />
    </svg>
  );
}

function IconSettings(): React.ReactElement {
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
    >
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}

const NAV_ITEMS: readonly NavItem[] = [
  { id: "dashboard", label: "Dashboard", icon: <IconDashboard /> },
  { id: "workers", label: "Workers", icon: <IconWorkers /> },
  { id: "sessions", label: "Sessions", icon: <IconSessions /> },
  { id: "metrics", label: "Metrics", icon: <IconMetrics /> },
  { id: "settings", label: "Settings", icon: <IconSettings /> },
] as const;

/**
 * Sidebar navigation for SWARM Orchestrator.
 * Glass-panel aesthetic with OKLCH accent left border on active link.
 * Supports keyboard navigation with arrow keys within the nav list.
 */
export function Sidebar(): React.ReactElement {
  const [currentPage, setCurrentPage] = useAtom(currentPageAtom);
  const [collapsed] = useAtom(sidebarCollapsedAtom);
  const navRef = useRef<HTMLElement>(null);

  const handleNavKeyDown = (e: React.KeyboardEvent, index: number) => {
    let nextIndex: number | null = null;

    if (e.key === "ArrowDown") {
      e.preventDefault();
      nextIndex = (index + 1) % NAV_ITEMS.length;
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      nextIndex = (index - 1 + NAV_ITEMS.length) % NAV_ITEMS.length;
    } else if (e.key === "Home") {
      e.preventDefault();
      nextIndex = 0;
    } else if (e.key === "End") {
      e.preventDefault();
      nextIndex = NAV_ITEMS.length - 1;
    }

    if (nextIndex !== null) {
      const buttons = navRef.current?.querySelectorAll<HTMLButtonElement>(
        'button[data-nav-item="true"]',
      );
      buttons?.[nextIndex]?.focus();
    }
  };

  return (
    <aside
      className="glass-panel flex flex-col h-full select-none"
      aria-label="Main Navigation"
      style={{
        borderRight: "1px solid oklch(0.20 0.03 220)",
        borderTop: "none",
        borderBottom: "none",
        borderLeft: "none",
        borderRadius: 0,
        transition: "width 0.25s cubic-bezier(0.4, 0.0, 0.2, 1.0)",
        overflow: "hidden",
        background: "oklch(0.07 0.015 220)",
      }}
    >
      {/* Logo area */}
      <div
        className="flex items-center gap-2 px-5"
        style={{
          borderBottom: "1px solid oklch(0.18 0.03 220)",
          height: 56,
        }}
      >
        <span
          aria-hidden="true"
          style={{
            fontFamily: "var(--font-display)",
            fontWeight: 800,
            fontSize: collapsed ? "1rem" : "1.15rem",
            letterSpacing: "0.08em",
            color: "oklch(0.78 0.18 205)",
            textShadow: "0 0 20px oklch(0.78 0.18 205 / 0.3)",
          }}
        >
          {collapsed ? "S" : "SWARM"}
        </span>
      </div>

      {/* Navigation links */}
      <nav
        ref={navRef}
        className="flex flex-col gap-0.5 px-2.5 py-3 flex-1"
        aria-label="Page Navigation"
      >
        {NAV_ITEMS.map((item, index) => {
          const isActive = currentPage === item.id;
          return (
            <button
              key={item.id}
              type="button"
              data-nav-item="true"
              data-active={isActive ? "true" : undefined}
              onClick={() => setCurrentPage(item.id)}
              onKeyDown={(e) => handleNavKeyDown(e, index)}
              aria-current={isActive ? "page" : undefined}
              tabIndex={isActive ? 0 : -1}
              title={collapsed ? item.label : undefined}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                borderRadius: 8,
                padding: "9px 12px",
                fontFamily: "var(--font-body)",
                fontSize: "0.82rem",
                fontWeight: isActive ? 600 : 450,
                letterSpacing: "0.01em",
                color: isActive ? "oklch(0.95 0.03 205)" : "oklch(0.52 0.03 220)",
                background: isActive
                  ? "linear-gradient(135deg, oklch(0.16 0.04 210), oklch(0.13 0.03 220))"
                  : "oklch(0 0 0 / 0)",
                border: "none",
                borderLeft: `2.5px solid ${isActive ? "oklch(0.78 0.18 205)" : "oklch(0 0 0 / 0)"}`,
                cursor: "pointer",
                width: "100%",
                textAlign: "left",
                whiteSpace: "nowrap",
                transition: "all 0.15s cubic-bezier(0.4, 0, 0.2, 1)",
                outline: "none",
                boxShadow: isActive
                  ? "0 1px 8px oklch(0.78 0.18 205 / 0.1), inset 0 1px 0 oklch(1 0 0 / 0.03)"
                  : "none",
              }}
              onFocus={(e) => {
                e.currentTarget.style.boxShadow = "0 0 0 2px oklch(0.78 0.18 205 / 0.4) inset";
              }}
              onBlur={(e) => {
                e.currentTarget.style.boxShadow = isActive
                  ? "0 1px 8px oklch(0.78 0.18 205 / 0.1), inset 0 1px 0 oklch(1 0 0 / 0.03)"
                  : "none";
              }}
              onMouseEnter={(e) => {
                if (!isActive) {
                  e.currentTarget.style.background = "oklch(0.12 0.02 220)";
                  e.currentTarget.style.color = "oklch(0.80 0.05 220)";
                }
              }}
              onMouseLeave={(e) => {
                if (!isActive) {
                  e.currentTarget.style.background = "oklch(0 0 0 / 0)";
                  e.currentTarget.style.color = "oklch(0.52 0.03 220)";
                }
              }}
            >
              <span
                style={{
                  opacity: isActive ? 1 : 0.6,
                  transition: "opacity 0.15s ease",
                  display: "flex",
                  alignItems: "center",
                }}
              >
                {item.icon}
              </span>
              {!collapsed && item.label}
            </button>
          );
        })}
      </nav>

      {/* Footer */}
      <div
        className="px-4 py-3"
        style={{
          borderTop: "1px solid oklch(0.18 0.03 220)",
          fontFamily: "var(--font-mono)",
          fontSize: "0.6rem",
          letterSpacing: "0.04em",
          color: "oklch(0.40 0.02 220)",
        }}
      >
        {collapsed ? "v" : `v${__APP_VERSION__}`}
      </div>
    </aside>
  );
}
