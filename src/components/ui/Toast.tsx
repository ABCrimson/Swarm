import { Toaster as SonnerToaster, toast } from "sonner";

/** Re-exported Sonner `toast` for imperative toast creation. */
export { toast };

/**
 * Sonner's color variables, set to the house OKLCH palette. Sonner reads
 * `--normal-*` for plain toasts and — because `richColors` is on —
 * `--success-*`, `--error-*`, `--warning-*` and `--info-*` for typed
 * ones. They sit inline on the toaster element, so they beat the
 * defaults Sonner's own injected stylesheet sets there.
 */
const TOASTER_STYLE = {
  fontFamily: "var(--font-sans)",
  "--normal-bg": "oklch(from var(--color-surface-2) l c h / 0.9)",
  "--normal-border": "var(--color-border-2)",
  "--normal-text": "var(--color-fg)",
  "--success-bg": "oklch(0.14 0.06 140 / 0.9)",
  "--success-border": "oklch(0.55 0.12 140)",
  "--success-text": "var(--color-lime)",
  "--error-bg": "oklch(0.14 0.06 10 / 0.9)",
  "--error-border": "oklch(0.5 0.14 10)",
  "--error-text": "var(--color-rose)",
  "--warning-bg": "oklch(0.14 0.06 70 / 0.9)",
  "--warning-border": "oklch(0.55 0.12 70)",
  "--warning-text": "var(--color-amber)",
  "--info-bg": "oklch(0.14 0.06 205 / 0.9)",
  "--info-border": "oklch(0.55 0.12 205)",
  "--info-text": "var(--color-plasma)",
} as React.CSSProperties;

/**
 * The app's single Sonner toaster, themed with the OKLCH palette above:
 * plain toasts use the surface colors, and success, error, warning and
 * info toasts each get their own tinted background, border and text.
 *
 * Render it once, outside the root error boundary (see `App`).
 */
export function SwarmToaster(): React.ReactElement {
  return (
    <SonnerToaster
      position="bottom-right"
      theme="dark"
      richColors
      style={TOASTER_STYLE}
      toastOptions={{ style: { backdropFilter: "blur(12px) saturate(1.5)" } }}
    />
  );
}
