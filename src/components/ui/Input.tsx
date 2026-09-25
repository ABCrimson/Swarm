/** Styled text input: a native `<input>` with the `.swarm-input` design-system class. */
export function Input({
  className,
  ...props
}: React.ComponentPropsWithRef<"input">): React.ReactElement {
  return <input className={`swarm-input ${className ?? ""}`} {...props} />;
}
