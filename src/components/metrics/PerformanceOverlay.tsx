// ── PerformanceOverlay ──────────────────────────────
// Development-build overlay (toggle: the remappable perfOverlay binding,
// Ctrl+Shift+P by default) with FPS, GPU frame time and the adaptive
// particle count. Production builds render nothing and ship none of it.

import { useAtom, useAtomValue } from "jotai";
import type { CSSProperties } from "react";
import { useEffect, useEffectEvent, useState } from "react";
import { matchesBinding } from "#lib/keybindings";
import {
  gpuFrameTimeAtom,
  keybindingsAtom,
  particleCountAtom,
  perfOverlayOpenAtom,
} from "#store/ui";

const overlayStyle: CSSProperties = {
  position: "fixed",
  top: 56,
  right: 12,
  width: 220,
  padding: "10px 14px",
  background: "oklch(0.06 0.02 220 / 0.88)",
  border: "1px solid oklch(0.22 0.04 220)",
  borderRadius: 8,
  backdropFilter: "blur(12px) saturate(1.5)",
  fontFamily: "var(--font-mono)",
  fontSize: 11,
  color: "oklch(0.7 0.05 220)",
  zIndex: 9999,
  display: "flex",
  flexDirection: "column",
  gap: 6,
  pointerEvents: "none",
};

const titleStyle: CSSProperties = {
  fontSize: 10,
  fontWeight: 700,
  textTransform: "uppercase",
  letterSpacing: "0.1em",
  color: "oklch(0.78 0.18 205)",
  marginBottom: 2,
};

const rowStyle: CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
};

const valueStyle: CSSProperties = {
  color: "oklch(0.78 0.04 220)",
  fontWeight: 600,
};

function fpsColor(fps: number): string {
  if (fps >= 55) return "oklch(0.78 0.18 140)";
  if (fps >= 30) return "oklch(0.78 0.18 70)";
  return "oklch(0.68 0.22 15)";
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
  color,
}: {
  readonly label: string;
  readonly children: React.ReactNode;
  readonly color?: string;
}): React.ReactElement {
  return (
    <div style={rowStyle}>
      <span style={{ color: "oklch(0.58 0.04 220)" }}>{label}</span>
      <span style={color ? { ...valueStyle, color } : valueStyle}>{children}</span>
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
    <section style={overlayStyle} aria-label="Performance Overlay">
      <div style={titleStyle}>Performance</div>
      <Row label="FPS" color={fpsColor(fps)}>
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
