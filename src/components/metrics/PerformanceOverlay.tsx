// ── PerformanceOverlay ──────────────────────────────
// Dev-only performance overlay (Ctrl+Shift+P toggle).
// Shows: React render count, Zustand selector count, GPU frame time,
// FPS counter, particle count.
// Semi-transparent, top-right corner, OKLCH monospace styling.

import { useAtom, useAtomValue } from "jotai";
import type { CSSProperties } from "react";
import { useEffect, useRef, useState } from "react";
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
  textTransform: "uppercase" as const,
  letterSpacing: "0.1em",
  color: "oklch(0.78 0.18 205)",
  marginBottom: 2,
};

const rowStyle: CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
};

const labelStyle: CSSProperties = {
  color: "oklch(0.58 0.04 220)",
};

const valueStyle: CSSProperties = {
  color: "oklch(0.78 0.04 220)",
  fontWeight: 600,
};

/**
 * Dev-only performance overlay showing FPS, GPU frame time, particle count,
 * and React render count. Toggle with Ctrl+Shift+P.
 *
 * Only renders when `import.meta.env.DEV` is true.
 */
export function PerformanceOverlay(): React.ReactElement | null {
  const [isOpen, setIsOpen] = useAtom(perfOverlayOpenAtom);
  const gpuFrameTime = useAtomValue(gpuFrameTimeAtom);
  const particleCount = useAtomValue(particleCountAtom);
  const [fps, setFps] = useState(0);
  const renderCountRef = useRef(0);
  const [renderCount, setRenderCount] = useState(0);

  // Track renders
  useEffect(() => {
    renderCountRef.current += 1;
  });
  useEffect(() => {
    const id = setInterval(() => {
      setRenderCount(renderCountRef.current);
    }, 1000);
    return () => clearInterval(id);
  }, []);

  // FPS counter
  useEffect(() => {
    if (!isOpen) return;

    let frameCount = 0;
    let lastTimestamp = performance.now();
    let rafId: number;

    const tick = (now: number): void => {
      frameCount++;
      const elapsed = now - lastTimestamp;
      if (elapsed >= 1000) {
        setFps(Math.round((frameCount * 1000) / elapsed));
        frameCount = 0;
        lastTimestamp = now;
      }
      rafId = requestAnimationFrame(tick);
    };

    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, [isOpen]);

  // Overlay toggle — binding is remappable in Settings.
  const keybindings = useAtomValue(keybindingsAtom);
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (matchesBinding(e, keybindings.perfOverlay)) {
        e.preventDefault();
        setIsOpen((v) => !v);
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [setIsOpen, keybindings]);

  // Only render in dev mode
  if (!import.meta.env.DEV) return null;
  if (!isOpen) return null;

  const fpsColor =
    fps >= 55 ? "oklch(0.78 0.18 140)" : fps >= 30 ? "oklch(0.78 0.18 70)" : "oklch(0.68 0.22 15)";

  return (
    <output style={overlayStyle} aria-label="Performance Overlay">
      <div style={titleStyle}>Perf Overlay</div>

      <div style={rowStyle}>
        <span style={labelStyle}>FPS</span>
        <span style={{ ...valueStyle, color: fpsColor }}>{fps}</span>
      </div>

      <div style={rowStyle}>
        <span style={labelStyle}>GPU Frame</span>
        <span style={valueStyle}>{gpuFrameTime.toFixed(2)}ms</span>
      </div>

      <div style={rowStyle}>
        <span style={labelStyle}>Particles</span>
        <span style={valueStyle}>{particleCount.toLocaleString()}</span>
      </div>

      <div style={rowStyle}>
        <span style={labelStyle}>React Renders</span>
        <span style={valueStyle}>{renderCount}</span>
      </div>

      <div style={rowStyle}>
        <span style={labelStyle}>Zustand Evals</span>
        <span style={valueStyle}>--</span>
      </div>
    </output>
  );
}
