/** The one page header: same padding, type and position on every page; renders the page's <h1>. */
export function PageHeader({
  title,
  subtitle,
  actions,
}: {
  readonly title: string;
  readonly subtitle?: string;
  readonly actions?: React.ReactNode;
}): React.ReactElement {
  return (
    <header className="flex shrink-0 flex-wrap items-start justify-between gap-4 px-7 pt-6 pb-4">
      <div>
        <h1 className="font-display text-2xl font-bold tracking-tight text-fg-bright">{title}</h1>
        {subtitle && <p className="mt-1 text-fg-muted text-md">{subtitle}</p>}
      </div>
      {actions}
    </header>
  );
}
