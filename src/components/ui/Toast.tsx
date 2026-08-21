import { Toaster as SonnerToaster, toast } from "sonner";

/** Re-exported Sonner `toast` for imperative toast creation. */
export { toast };

/**
 * Pre-configured Sonner toaster with SWARM OKLCH theme and glass-morphism styling.
 *
 * Place once at the application root. Toast variants (success, error, warning, info)
 * are themed via CSS custom properties in OKLCH.
 */
export function SwarmToaster(): React.ReactElement {
  return (
    <SonnerToaster
      position="bottom-right"
      theme="dark"
      className="swarm-toaster"
      toastOptions={{
        style: {
          background: "oklch(0.12 0.03 220 / 0.9)",
          backdropFilter: "blur(12px) saturate(1.5)",
          border: "1px solid oklch(0.28 0.05 220)",
          color: "oklch(0.82 0.04 220)",
          fontFamily: "var(--font-body, 'DM Sans Variable', system-ui, sans-serif)",
        },
      }}
      style={
        {
          "--normal-bg": "oklch(0.12 0.03 220 / 0.9)",
          "--normal-border": "oklch(0.28 0.05 220)",
          "--normal-text": "oklch(0.82 0.04 220)",
          "--success-bg": "oklch(0.14 0.06 140 / 0.9)",
          "--success-border": "oklch(0.55 0.12 140)",
          "--success-text": "oklch(0.82 0.18 140)",
          "--error-bg": "oklch(0.14 0.06 10 / 0.9)",
          "--error-border": "oklch(0.50 0.14 10)",
          "--error-text": "oklch(0.72 0.20 10)",
          "--warning-bg": "oklch(0.14 0.06 70 / 0.9)",
          "--warning-border": "oklch(0.55 0.12 70)",
          "--warning-text": "oklch(0.82 0.19 70)",
          "--info-bg": "oklch(0.14 0.06 205 / 0.9)",
          "--info-border": "oklch(0.55 0.12 205)",
          "--info-text": "oklch(0.78 0.18 205)",
        } as React.CSSProperties
      }
    />
  );
}
