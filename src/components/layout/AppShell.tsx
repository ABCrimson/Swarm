import { useAtomValue } from "jotai";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import type { ReactNode } from "react";
import { reducedMotionAtom, sidebarCollapsedAtom } from "#store/ui";
import { ParticleBackground } from "./ParticleBackground.tsx";
import { Sidebar } from "./Sidebar.tsx";
import { StatusBar } from "./StatusBar.tsx";
import { Topbar } from "./TopBar.tsx";

interface AppShellProps {
  readonly children: ReactNode;
  /** Key for AnimatePresence page transitions */
  readonly pageKey: string;
}

/** GSAP's `power3.out` / `power2.out` as cubic-bezier curves. */
const POWER3_OUT = [0.215, 0.61, 0.355, 1] as const;
const POWER2_OUT = [0.25, 0.46, 0.45, 0.94] as const;

/**
 * Root layout shell with CSS Grid: sidebar (220px) + main (1fr).
 *
 * Startup sequence (plays once, on mount):
 *  1. Sidebar slides in from left (x: -20, 0.4s, power3.out)
 *  2. Topbar fades in from top (y: -12, 0.3s, starts 0.1s later)
 *  3. Main content fades in (0.4s, power2.out, starts 0.25s in)
 *
 * `<AnimatePresence mode="popLayout">` wraps page content.
 */
export function AppShell({ children, pageKey }: AppShellProps): React.ReactElement {
  const reducedMotion = useAtomValue(reducedMotionAtom);
  const sidebarCollapsed = useAtomValue(sidebarCollapsedAtom);
  // The intro is decided on the first render, before App's useTheme effect
  // syncs `reducedMotionAtom` from the media query — so read the preference
  // synchronously here instead of from the (still-default) atom.
  const skipIntro = useReducedMotion() === true;

  return (
    <>
      {/* Skip to main content link */}
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only"
        style={{
          position: "fixed",
          top: 4,
          left: 4,
          zIndex: 9999,
          padding: "8px 16px",
          borderRadius: 8,
          background: "oklch(0.78 0.18 205)",
          color: "oklch(0.06 0.02 220)",
          fontFamily: "var(--font-body)",
          fontWeight: 600,
          fontSize: 14,
          textDecoration: "none",
          outline: "2px solid oklch(0.78 0.18 205)",
          outlineOffset: 2,
        }}
      >
        Skip to main content
      </a>
      <ParticleBackground />
      <div
        className="grid h-screen w-screen overflow-hidden"
        style={{
          gridTemplateColumns: sidebarCollapsed ? "56px 1fr" : "220px 1fr",
          gridTemplateRows: "1fr",
          background: "oklch(0.06 0.02 220)",
          color: "oklch(0.82 0.04 220)",
          transition: "grid-template-columns 0.25s cubic-bezier(0.4, 0.0, 0.2, 1.0)",
        }}
      >
        {/* Sidebar */}
        <motion.div
          className="row-span-full"
          initial={skipIntro ? false : { opacity: 0, x: -20 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ duration: 0.4, ease: POWER3_OUT }}
        >
          <Sidebar />
        </motion.div>

        {/* Main area: topbar + content */}
        <div className="grid" style={{ gridTemplateRows: "auto 1fr auto" }}>
          <motion.div
            initial={skipIntro ? false : { opacity: 0, y: -12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.3, delay: 0.1, ease: POWER3_OUT }}
          >
            <Topbar />
          </motion.div>

          <motion.main
            id="main-content"
            className="overflow-hidden relative"
            initial={skipIntro ? false : { opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.4, delay: 0.25, ease: POWER2_OUT }}
          >
            <AnimatePresence mode="popLayout">
              <motion.div
                key={pageKey}
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -8 }}
                transition={{ duration: reducedMotion ? 0 : 0.25, ease: "easeOut" }}
                className="absolute inset-0 overflow-auto"
              >
                {children}
              </motion.div>
            </AnimatePresence>
          </motion.main>

          <StatusBar />
        </div>
      </div>
    </>
  );
}
