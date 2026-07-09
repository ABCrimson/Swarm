import type { CSSProperties, ReactNode } from "react";

interface ScrollAreaProps {
  readonly children: ReactNode;
  readonly className?: string;
  readonly style?: CSSProperties;
}

/**
 * Wraps content with custom OKLCH-themed scrollbar styling.
 * Uses the `.scroll-area` class from components.css for thin scrollbars.
 */
export function ScrollArea({
  children,
  className = "",
  style,
}: ScrollAreaProps): React.ReactElement {
  return (
    <div
      className={`scroll-area overflow-auto ${className}`.trim()}
      style={{
        scrollbarWidth: "thin",
        scrollbarColor: "oklch(0.28 0.05 220) oklch(0 0 0 / 0)",
        ...style,
      }}
    >
      {children}
    </div>
  );
}
