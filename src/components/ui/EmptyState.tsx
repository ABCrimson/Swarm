/** The app's one empty state: a plasma ring with a breathing dot, a title, an optional line and an optional action. */
export function EmptyState({
  title,
  body,
  action,
}: {
  readonly title: string;
  readonly body?: string;
  readonly action?: React.ReactNode;
}): React.ReactElement {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 p-6 text-center">
      <span
        aria-hidden="true"
        className="flex size-24 items-center justify-center rounded-full border border-plasma/40 shadow-[0_0_48px_oklch(from_var(--color-plasma)_l_c_h/0.25)]"
      >
        <span className="size-2 rounded-full bg-plasma motion-safe:animate-[tool-pulse_3s_ease-in-out_infinite]" />
      </span>
      <div className="flex flex-col gap-1">
        <p className="font-display text-lg font-semibold tracking-tight text-fg-bright">{title}</p>
        {body && <p className="max-w-sm text-fg-muted text-md">{body}</p>}
      </div>
      {action}
    </div>
  );
}
