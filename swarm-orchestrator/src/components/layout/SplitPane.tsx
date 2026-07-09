import { useResizeObserver } from "@crimson_dev/use-resize-observer";
import { useAtom } from "jotai";
import type { CSSProperties, KeyboardEvent, ReactNode } from "react";
import { useRef, useState } from "react";
import { paneSizesAtom } from "#store/ui";

interface SplitPaneProps {
  /** Left/top pane content */
  readonly primary: ReactNode;
  /** Right/bottom pane content */
  readonly secondary: ReactNode;
  /** Split direction. @default "horizontal" */
  readonly direction?: "horizontal" | "vertical";
  /** Minimum pane size in percent. @default 20 */
  readonly minPercent?: number;
  /** Maximum pane size in percent. @default 80 */
  readonly maxPercent?: number;
}

/**
 * Resizable split pane component.
 *
 * Uses `@crimson_dev/use-resize-observer` to track container dimensions.
 * Persists pane sizes via `paneSizesAtom` (Jotai + plugin-store).
 */
export function SplitPane({
  primary,
  secondary,
  direction = "horizontal",
  minPercent = 20,
  maxPercent = 80,
}: SplitPaneProps): React.ReactElement {
  const [paneSizes, setPaneSizes] = useAtom(paneSizesAtom);
  const [isDragging, setIsDragging] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const {
    ref: observerRef,
    width: containerWidth,
    height: containerHeight,
  } = useResizeObserver<HTMLDivElement>({
    ref: containerRef,
    box: "border-box",
  });

  const isHorizontal = direction === "horizontal";
  const containerSize = isHorizontal ? (containerWidth ?? 0) : (containerHeight ?? 0);

  const handlePointerDown = (e: React.PointerEvent<HTMLElement>) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    setIsDragging(true);
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!isDragging || containerSize === 0) return;
    const container = containerRef.current;
    if (!container) return;

    const rect = container.getBoundingClientRect();
    const pos = isHorizontal ? e.clientX - rect.left : e.clientY - rect.top;
    const percent = (pos / containerSize) * 100;
    const clamped = Math.max(minPercent, Math.min(maxPercent, percent));

    setPaneSizes({ main: clamped, detail: 100 - clamped });
  };

  const handlePointerUp = () => {
    setIsDragging(false);
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLHRElement>) => {
    const step = 2;
    let newPercent: number | null = null;

    if ((isHorizontal && e.key === "ArrowRight") || (!isHorizontal && e.key === "ArrowDown")) {
      e.preventDefault();
      newPercent = Math.min(maxPercent, paneSizes.main + step);
    } else if (
      (isHorizontal && e.key === "ArrowLeft") ||
      (!isHorizontal && e.key === "ArrowUp")
    ) {
      e.preventDefault();
      newPercent = Math.max(minPercent, paneSizes.main - step);
    }

    if (newPercent !== null) {
      setPaneSizes({ main: newPercent, detail: 100 - newPercent });
    }
  };

  const containerStyle: CSSProperties = {
    display: "grid",
    gridTemplate: isHorizontal
      ? `"primary handle secondary" 1fr / ${paneSizes.main}% 4px 1fr`
      : `"primary" ${paneSizes.main}% "handle" 4px "secondary" 1fr / 1fr`,
    width: "100%",
    height: "100%",
    overflow: "hidden",
  };

  const handleStyle: CSSProperties = {
    gridArea: "handle",
    background: isDragging ? "oklch(0.78 0.18 205 / 0.5)" : "oklch(0.78 0.18 205 / 0.15)",
    cursor: isHorizontal ? "col-resize" : "row-resize",
    transition: isDragging ? "none" : "background 0.2s cubic-bezier(0, 0, 0.2, 1), box-shadow 0.2s cubic-bezier(0, 0, 0.2, 1)",
    touchAction: "none",
    userSelect: "none",
    position: "relative",
  };

  const handleHoverGlow: CSSProperties = isDragging
    ? {
        boxShadow: "0 0 8px oklch(0.78 0.18 205 / 0.4)",
      }
    : {};

  return (
    <div
      ref={observerRef}
      style={containerStyle}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
    >
      <div style={{ gridArea: "primary", overflow: "auto", minWidth: 0, minHeight: 0 }}>
        {primary}
      </div>
      <hr
        tabIndex={0}
        role="separator"
        aria-orientation={isHorizontal ? "vertical" : "horizontal"}
        aria-valuenow={Math.round(paneSizes.main)}
        aria-valuemin={minPercent}
        aria-valuemax={maxPercent}
        aria-label={`Resize ${isHorizontal ? "columns" : "rows"}`}
        onPointerDown={handlePointerDown}
        onKeyDown={handleKeyDown}
        onMouseEnter={(e) => {
          if (!isDragging) {
            e.currentTarget.style.background = "oklch(0.78 0.18 205 / 0.3)";
            e.currentTarget.style.boxShadow = "0 0 6px oklch(0.78 0.18 205 / 0.25)";
          }
        }}
        onMouseLeave={(e) => {
          if (!isDragging) {
            e.currentTarget.style.background = "oklch(0.78 0.18 205 / 0.15)";
            e.currentTarget.style.boxShadow = "none";
          }
        }}
        onFocus={(e) => {
          e.currentTarget.style.boxShadow = "0 0 0 2px oklch(0.78 0.18 205 / 0.5)";
        }}
        onBlur={(e) => {
          e.currentTarget.style.boxShadow = "none";
        }}
        style={{ ...handleStyle, ...handleHoverGlow, border: "none", margin: 0, padding: 0 }}
      />
      <div style={{ gridArea: "secondary", overflow: "auto", minWidth: 0, minHeight: 0 }}>
        {secondary}
      </div>
    </div>
  );
}
