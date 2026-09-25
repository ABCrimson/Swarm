import { Spinner } from "./Spinner.tsx";

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
type ButtonSize = "sm" | "md" | "lg";

interface ButtonProps extends React.ComponentPropsWithRef<"button"> {
  readonly variant?: ButtonVariant;
  readonly size?: ButtonSize;
  /** Shows a spinner and ignores clicks, without disabling the element. */
  readonly loading?: boolean;
}

/**
 * The shared button: `.swarm-btn` (components.css) styled per `variant`
 * and `size` through data attributes.
 *
 * `loading` marks the button busy (`aria-busy`, `aria-disabled`, a
 * spinner) and swallows clicks, but deliberately does not set the
 * `disabled` attribute: disabling the focused element would drop
 * keyboard focus to `<body>` mid-action (e.g. after pressing Enter on
 * a Save button). `disabled` itself still disables for real.
 */
export function Button({
  variant = "primary",
  size = "md",
  loading = false,
  children,
  className,
  type = "button",
  onClick,
  ...props
}: ButtonProps): React.ReactElement {
  return (
    <button
      type={type}
      className={`swarm-btn ${className ?? ""}`}
      data-variant={variant}
      data-size={size}
      aria-busy={loading || undefined}
      aria-disabled={loading || undefined}
      onClick={(e) => {
        if (loading) {
          e.preventDefault();
          return;
        }
        onClick?.(e);
      }}
      {...props}
    >
      {loading && <Spinner size={size === "lg" ? "md" : "sm"} decorative />}
      {children}
    </button>
  );
}
