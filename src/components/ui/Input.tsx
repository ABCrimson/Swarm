interface InputProps extends Omit<React.ComponentPropsWithRef<"input">, "size"> {
  readonly ref?: React.Ref<HTMLInputElement>;
}

/** Styled text input with SWARM design system class. */
export function Input({ ref, className, ...props }: InputProps): React.ReactElement {
  return <input ref={ref} className={`swarm-input ${className ?? ""}`} {...props} />;
}
