import { Toaster as SonnerToaster } from "sonner";

/**
 * Sonner's color variables, set to the house OKLCH palette as utility
 * classes on the toaster element. Sonner reads `--normal-*` for plain toasts
 * and — because `richColors` is on — `--success-*`, `--error-*`, `--warning-*`
 * and `--info-*` for typed ones. Typed toasts are dark tints of their accent
 * token (same hue, via relative color syntax). Sonner injects its own
 * defaults for these variables in an unlayered stylesheet, which outranks the
 * `utilities` layer; the important modifier (`!`) makes the palette win
 * (an important declaration in a layer outranks a normal unlayered one).
 */
const TOASTER_CLASS = [
  "font-sans!",
  "[--normal-bg:oklch(from_var(--color-surface-2)_l_c_h/0.9)]!",
  "[--normal-border:var(--color-border-2)]!",
  "[--normal-text:var(--color-fg)]!",
  "[--success-bg:oklch(from_var(--color-lime)_0.14_0.06_h/0.9)]!",
  "[--success-border:oklch(from_var(--color-lime)_0.55_0.12_h)]!",
  "[--success-text:var(--color-lime)]!",
  "[--error-bg:oklch(from_var(--color-rose)_0.14_0.06_h/0.9)]!",
  "[--error-border:oklch(from_var(--color-rose)_0.5_0.14_h)]!",
  "[--error-text:var(--color-rose)]!",
  "[--warning-bg:oklch(from_var(--color-amber)_0.14_0.06_h/0.9)]!",
  "[--warning-border:oklch(from_var(--color-amber)_0.55_0.12_h)]!",
  "[--warning-text:var(--color-amber)]!",
  "[--info-bg:oklch(from_var(--color-plasma)_0.14_0.06_h/0.9)]!",
  "[--info-border:oklch(from_var(--color-plasma)_0.55_0.12_h)]!",
  "[--info-text:var(--color-plasma)]!",
].join(" ");

/** The frosted-glass backdrop of every toast (`toastOptions.className`). */
const TOAST_CLASS = "backdrop-blur-[12px] backdrop-saturate-150";

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
      className={TOASTER_CLASS}
      toastOptions={{ className: TOAST_CLASS }}
    />
  );
}
