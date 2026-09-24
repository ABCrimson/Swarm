import { useAtomValue } from "jotai";
import type { ReactNode } from "react";
import { sidebarCollapsedAtom } from "#store/ui";
import { ParticleBackground } from "./ParticleBackground.tsx";
import { Sidebar } from "./Sidebar.tsx";
import { StatusBar } from "./StatusBar.tsx";
import { TopBar } from "./TopBar.tsx";

interface AppShellProps {
  /** The page area — normally `<PageHost />`. */
  readonly children: ReactNode;
}

/**
 * Root layout: a CSS grid of the sidebar (220px, or 56px collapsed) and
 * the main column (top bar, page area, status bar), over the particle
 * background.
 *
 * The one-time entrance (sidebar slides in, top bar drops in, page area
 * fades in) is pure CSS: Tailwind's `starting:` variant compiles to
 * `@starting-style`, so each region transitions from its starting style
 * the first time it renders. No JS runs for it, it never flashes the
 * final state first, and the global reduced-motion override in
 * animations.css collapses it to an instant change.
 */
export function AppShell({ children }: AppShellProps): React.ReactElement {
  const sidebarCollapsed = useAtomValue(sidebarCollapsedAtom);

  return (
    <>
      <a
        href="#main-content"
        className="fixed top-1 left-1 z-50 rounded-lg bg-plasma px-4 py-2 font-semibold text-md text-void no-underline not-focus:sr-only"
      >
        Skip To Main Content
      </a>
      <ParticleBackground />
      <div
        data-sidebar-collapsed={sidebarCollapsed || undefined}
        className="grid h-screen w-screen grid-cols-[220px_1fr] grid-rows-1 overflow-hidden text-fg transition-[grid-template-columns] duration-250 ease-in-out data-sidebar-collapsed:grid-cols-[56px_1fr]"
      >
        <div className="row-span-full transition-[opacity,translate] duration-400 ease-out-cubic starting:-translate-x-5 starting:opacity-0">
          <Sidebar />
        </div>

        <div className="grid min-w-0 grid-rows-[auto_1fr_auto]">
          <div className="transition-[opacity,translate] delay-100 duration-300 ease-out-cubic starting:-translate-y-3 starting:opacity-0">
            <TopBar />
          </div>

          <main
            id="main-content"
            className="relative overflow-hidden transition-opacity delay-250 duration-400 ease-out starting:opacity-0"
          >
            {children}
          </main>

          <StatusBar />
        </div>
      </div>
    </>
  );
}
