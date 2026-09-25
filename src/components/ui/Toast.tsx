import { Toaster as SonnerToaster, toast } from "sonner";

/** Re-exported Sonner `toast` for imperative toast creation. */
export { toast };

/**
 * Sonner's color variables, set to the house OKLCH palette. Sonner reads
 * `--normal-*` for plain toasts and — because `richColors` is on —
 * `--success-*`, `--error-*`, `--warning-*` and `--info-*` for typed
 * ones. Typed toasts are dark tints of their accent token (same hue,
 * via relative color syntax). They sit inline on the toaster element, so
 * they beat the defaults Sonner's own injected stylesheet sets there.
 */
const TOASTER_STYLE = {
  fontFamily: "var(--font-sans)",
  "--normal-bg": "oklch(from var(--color-surface-2) l c h / 0.9)",
  "--normal-border": "var(--color-border-2)",
  "--normal-text": "var(--color-fg)",
  "--success-bg": "oklch(from var(--color-lime) 0.14 0.06 h / 0.9)",
  "--success-border": "oklch(from var(--color-lime) 0.55 0.12 h)",
  "--success-text": "var(--color-lime)",
  "--error-bg": "oklch(from var(--color-rose) 0.14 0.06 h / 0.9)",
  "--error-border": "oklch(from var(--color-rose) 0.5 0.14 h)",
  "--error-text": "var(--color-rose)",
  "--warning-bg": "oklch(from var(--color-amber) 0.14 0.06 h / 0.9)",
  "--warning-border": "oklch(from var(--color-amber) 0.55 0.12 h)",
  "--warning-text": "var(--color-amber)",
  "--info-bg": "oklch(from var(--color-plasma) 0.14 0.06 h / 0.9)",
  "--info-border": "oklch(from var(--color-plasma) 0.55 0.12 h)",
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
