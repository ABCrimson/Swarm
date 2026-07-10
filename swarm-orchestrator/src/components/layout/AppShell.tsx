import { useResizeObserver } from "@crimson_dev/use-resize-observer";
import gsap from "gsap";
import { useAtomValue } from "jotai";
import { AnimatePresence, motion } from "motion/react";
import type { ReactNode } from "react";
import { useEffect, useRef } from "react";
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

/**
 * Root layout shell with CSS Grid: sidebar (220px) + main (1fr).
 *
 * GSAP startup sequence:
 *  1. Sidebar slides in from left (x: -20, 0.4s, power3.out)
 *  2. Topbar fades in from top (y: -12, 0.3s, overlaps by 0.1s)
 *  3. Main content fades in (0.4s, overlaps by 0.15s)
 *
 * Framer Motion `<AnimatePresence mode="popLayout">` wraps page content.
 */
export function AppShell({ children, pageKey }: AppShellProps): React.ReactElement {
  const shellRef = useRef<HTMLDivElement>(null);
  const sidebarRef = useRef<HTMLDivElement>(null);
  const topbarRef = useRef<HTMLDivElement>(null);
  const mainRef = useRef<HTMLDivElement>(null);
  const reducedMotion = useAtomValue(reducedMotionAtom);
  const sidebarCollapsed = useAtomValue(sidebarCollapsedAtom);

  // Track container size via resize observer
  const { ref: containerRef } = useResizeObserver<HTMLDivElement>({
    ref: shellRef,
    box: "border-box",
  });

  // GSAP startup animation — StrictMode-safe (cleanup resets elements to visible)
  useEffect(() => {
    const sidebar = sidebarRef.current;
    const topbar = topbarRef.current;
    const main = mainRef.current;

    if (!sidebar || !topbar || !main) return;

    if (reducedMotion) {
      gsap.set([sidebar, topbar, main], { opacity: 1, x: 0, y: 0 });
      return;
    }

    // Set initial states
    gsap.set(sidebar, { opacity: 0, x: -20 });
    gsap.set(topbar, { opacity: 0, y: -12 });
    gsap.set(main, { opacity: 0 });

    const tl = gsap.timeline();

    // 1. Sidebar slides in
    tl.to(sidebar, {
      opacity: 1,
      x: 0,
      duration: 0.4,
      ease: "power3.out",
    });

    // 2. Topbar fades in (0.1s overlap)
    tl.to(
      topbar,
      {
        opacity: 1,
        y: 0,
        duration: 0.3,
        ease: "power3.out",
      },
      "<0.1",
    );

    // 3. Main fades in (0.15s overlap)
    tl.to(
      main,
      {
        opacity: 1,
        duration: 0.4,
        ease: "power2.out",
      },
      "<0.15",
    );

    return () => {
      tl.kill();
      // Reset elements to visible so StrictMode remount doesn't leave them invisible
      gsap.set([sidebar, topbar, main], { opacity: 1, x: 0, y: 0 });
    };
  }, [reducedMotion]);

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
        ref={containerRef}
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
        <div ref={sidebarRef} className="row-span-full">
          <Sidebar />
        </div>

        {/* Main area: topbar + content */}
        <div className="grid" style={{ gridTemplateRows: "auto 1fr auto" }}>
          <div ref={topbarRef}>
            <Topbar />
          </div>

          <main id="main-content" ref={mainRef} className="overflow-hidden relative">
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
          </main>

          <StatusBar />
        </div>
      </div>
    </>
  );
}
