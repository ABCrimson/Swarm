import { useAtom } from "jotai";
import type { KeyboardEvent, PointerEvent, ReactNode } from "react";
import { useId, useRef, useState } from "react";
import { paneSizesAtom } from "#store/ui";

interface SplitPaneProps {
  /** Left/top pane content */
  readonly primary: ReactNode;
  /** Right/bottom pane content */
  readonly secondary: ReactNode;
  /** Split direction. @default "horizontal" */
  readonly direction?: "horizontal" | "vertical";
  /** Minimum primary-pane size in percent. @default 20 */
  readonly minPercent?: number;
  /** Maximum primary-pane size in percent. @default 80 */
  readonly maxPercent?: number;
}

/** Percentage points one Arrow key press moves the divider. */
const KEYBOARD_STEP = 2;

/**
 * Two panes split by a draggable, keyboard-operable divider (the WAI-ARIA
 * window-splitter pattern: Arrow keys step, Home/End jump to the limits).
 *
 * The primary pane's size is persisted in `paneSizesAtom` (plugin-store
 * backed). A drag updates only local state and is committed once, when
 * the pointer is released or the capture is lost (pointer cancelled,
 * window blurred), because persisting on every pointermove would
 * rewrite the settings file at pointer rate. A stored value is clamped
 * to this instance's [minPercent, maxPercent] before use, so a corrupt
 * or out-of-range value cannot break the layout.
 */
export function SplitPane({
  primary,
  secondary,
  direction = "horizontal",
  minPercent = 20,
  maxPercent = 80,
}: SplitPaneProps): React.ReactElement {
  const [paneSizes, setPaneSizes] = useAtom(paneSizesAtom);
  const [dragPercent, setDragPercent] = useState<number | null>(null);
  /** The latest drag position, read when the drag ends. Written only in event handlers. */
  const latestDragRef = useRef<number | null>(null);
  const primaryId = useId();
  const isHorizontal = direction === "horizontal";

  const clamp = (percent: number): number => Math.min(maxPercent, Math.max(minPercent, percent));
  const stored = Number.isFinite(paneSizes?.main) ? paneSizes.main : 50;
  const mainPercent = dragPercent ?? clamp(stored);

  const commit = (percent: number): void => {
    const next = clamp(percent);
    setPaneSizes({ main: next, detail: 100 - next });
  };

  /** Divider position under the pointer, in percent of the container, or null if it has no size. */
  const percentAt = (e: PointerEvent<HTMLHRElement>): number | null => {
    const container = e.currentTarget.parentElement;
    if (!container) return null;
    const rect = container.getBoundingClientRect();
    const length = isHorizontal ? rect.width : rect.height;
    if (length <= 0) return null;
    const offset = isHorizontal ? e.clientX - rect.left : e.clientY - rect.top;
    return clamp((offset / length) * 100);
  };

  const handlePointerDown = (e: PointerEvent<HTMLHRElement>): void => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    latestDragRef.current = mainPercent;
    setDragPercent(mainPercent);
  };

  const handlePointerMove = (e: PointerEvent<HTMLHRElement>): void => {
    if (latestDragRef.current === null) return;
    const percent = percentAt(e);
    if (percent === null) return;
    latestDragRef.current = percent;
    setDragPercent(percent);
  };

  // Fires after pointerup (implicit capture release) and on pointercancel,
  // so it is the one place a drag ends.
  const handleLostPointerCapture = (): void => {
    const percent = latestDragRef.current;
    if (percent === null) return;
    latestDragRef.current = null;
    setDragPercent(null);
    commit(percent);
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLHRElement>): void => {
    const targets: Partial<Record<string, number>> = {
      [isHorizontal ? "ArrowRight" : "ArrowDown"]: mainPercent + KEYBOARD_STEP,
      [isHorizontal ? "ArrowLeft" : "ArrowUp"]: mainPercent - KEYBOARD_STEP,
      Home: minPercent,
      End: maxPercent,
    };
    const target = targets[e.key];
    if (target === undefined) return;
    e.preventDefault();
    commit(target);
  };

  return (
    <div
      className="grid size-full overflow-hidden"
      style={{
        gridTemplate: isHorizontal
          ? `"primary handle secondary" 1fr / ${mainPercent}% 4px 1fr`
          : `"primary" ${mainPercent}% "handle" 4px "secondary" 1fr / 1fr`,
      }}
    >
      <div id={primaryId} className="min-h-0 min-w-0 overflow-auto [grid-area:primary]">
        {primary}
      </div>
      <hr
        tabIndex={0}
        aria-orientation={isHorizontal ? "vertical" : "horizontal"}
        aria-controls={primaryId}
        aria-valuenow={Math.round(mainPercent)}
        aria-valuemin={minPercent}
        aria-valuemax={maxPercent}
        aria-label={`Resize ${isHorizontal ? "Columns" : "Rows"}`}
        data-dragging={dragPercent !== null || undefined}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onLostPointerCapture={handleLostPointerCapture}
        onKeyDown={handleKeyDown}
        className={`relative m-0 touch-none select-none border-0 bg-plasma-dim transition-[background-color,box-shadow] duration-200 [grid-area:handle] hover:bg-plasma/70 hover:shadow-[0_0_6px_oklch(from_var(--color-plasma)_l_c_h/0.25)] data-dragging:bg-plasma data-dragging:shadow-[0_0_8px_oklch(from_var(--color-plasma)_l_c_h/0.4)] ${isHorizontal ? "cursor-col-resize" : "cursor-row-resize"}`}
      />
      <div className="min-h-0 min-w-0 overflow-auto [grid-area:secondary]">{secondary}</div>
    </div>
  );
}
