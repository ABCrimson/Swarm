import { Spinner } from "./Spinner.tsx";

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
type ButtonSize = "sm" | "md" | "lg";

type ButtonOwnProps = {
  readonly as?: React.ElementType;
  readonly variant?: ButtonVariant;
  readonly size?: ButtonSize;
  readonly loading?: boolean;
};

type ButtonProps = ButtonOwnProps &
  Omit<React.ComponentPropsWithRef<"button">, keyof ButtonOwnProps>;

/**
 * Polymorphic button with variant, size, and loading state support.
 *
 * Renders a spinner and disables interaction when `loading` is `true`.
 * Supports `as` prop for rendering as a different element (e.g. `<a>`).
 */
export function Button({
  as,
  variant = "primary",
  size = "md",
  loading = false,
  children,
  disabled,
  className,
  type = "button",
  ref,
  ...props
}: ButtonProps): React.ReactElement {
  const Component = as ?? "button";

  return (
    <Component
      ref={ref}
      type={Component === "button" ? type : undefined}
      className={`swarm-btn ${className ?? ""}`}
      data-variant={variant}
      data-size={size}
      data-loading={loading || undefined}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...props}
    >
      {loading ? (
        <>
          <Spinner size={size === "lg" ? "md" : "sm"} />
          <span>{children}</span>
        </>
      ) : (
        children
      )}
    </Component>
  );
}
