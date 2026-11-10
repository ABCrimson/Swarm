// ── PerformanceOverlay ──────────────────────────────
// Development-build overlay (toggle: the remappable perfOverlay binding,
// Ctrl+Shift+P by default) with FPS, GPU frame time and the adaptive
// particle count. Production builds render nothing and ship none of it.

import { useAtom, useAtomValue } from "jotai";
import { useEffect, useEffectEvent, useState } from "react";
import { matchesBinding } from "#lib/keybindings";
import {
  gpuFrameTimeAtom,
  keybindingsAtom,
  particleCountAtom,
  perfOverlayOpenAtom,
} from "#store/ui";

const OVERLAY_CLASS =
  "pointer-events-none fixed top-14 right-3 z-[9999] flex w-[220px] flex-col gap-1.5 rounded-md border border-border bg-void/88 px-3.5 py-2.5 font-mono text-[11px] text-[color:oklch(0.7_0.05_220)] backdrop-blur-[12px] backdrop-saturate-150";

function fpsClass(fps: number): string {
  if (fps >= 55) return "text-lime";
  if (fps >= 30) return "text-amber";
  return "text-rose";
}

/** Frames per second, measured with requestAnimationFrame while `active`. */
function useFps(active: boolean): number {
  const [fps, setFps] = useState(0);
  useEffect(() => {
    if (!active) return undefined;
    let frames = 0;
    let since = performance.now();
    let raf = requestAnimationFrame(function tick(now) {
      frames++;
      if (now - since >= 1000) {
        setFps(Math.round((frames * 1000) / (now - since)));
        frames = 0;
        since = now;
      }
      raf = requestAnimationFrame(tick);
    });
    return () => cancelAnimationFrame(raf);
  }, [active]);
  return fps;
}

function Row({
  label,
  children,
  colorClass = "text-[color:oklch(0.78_0.04_220)]",
}: {
  readonly label: string;
  readonly children: React.ReactNode;
  /** Text-colour class of the value. */
  readonly colorClass?: string;
}): React.ReactElement {
  return (
    <div className="flex items-center justify-between">
      <span className="text-[color:oklch(0.58_0.04_220)]">{label}</span>
      <span className={`font-semibold ${colorClass}`}>{children}</span>
    </div>
  );
}

function DevPerformanceOverlay(): React.ReactElement | null {
  const [isOpen, setIsOpen] = useAtom(perfOverlayOpenAtom);
  const gpuFrameTime = useAtomValue(gpuFrameTimeAtom);
  const particleCount = useAtomValue(particleCountAtom);
  const keybindings = useAtomValue(keybindingsAtom);
  const fps = useFps(isOpen);

  // Registered once; the Effect Event reads the current (remappable) binding.
  const onKeyDown = useEffectEvent((event: KeyboardEvent): void => {
    if (!matchesBinding(event, keybindings.perfOverlay)) return;
    event.preventDefault();
    setIsOpen((open) => !open);
  });
  useEffect(() => {
    const listener = (event: KeyboardEvent): void => onKeyDown(event);
    document.addEventListener("keydown", listener);
    return () => document.removeEventListener("keydown", listener);
  }, []);

  if (!isOpen) return null;

  // A plain labelled region, not a live region: the numbers change every
  // second and must not be announced.
  return (
    <section className={OVERLAY_CLASS} aria-label="Performance Overlay">
      <div className="mb-0.5 text-[10px] font-bold text-plasma">Performance</div>
      <Row label="FPS" colorClass={fpsClass(fps)}>
        {fps}
      </Row>
      <Row label="GPU Frame">{gpuFrameTime.toFixed(2)}ms</Row>
      <Row label="Particles">{particleCount.toLocaleString()}</Row>
    </section>
  );
}

/**
 * Development-only performance overlay: FPS (measured only while open),
 * GPU frame time and the adaptive particle count. For render timing use
 * React's Performance Tracks in the browser's DevTools.
 *
 * In a production build `import.meta.env.DEV` is the constant `false`,
 * so this renders nothing, runs no hooks or listeners, and the overlay
 * itself is removed from the bundle as dead code.
 */
export function PerformanceOverlay(): React.ReactElement | null {
  return import.meta.env.DEV ? <DevPerformanceOverlay /> : null;
}
