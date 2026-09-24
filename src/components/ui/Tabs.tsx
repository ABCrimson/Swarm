import { Activity } from "react";

export interface TabItem<T extends string> {
  readonly id: T;
  readonly label: string;
  readonly disabled?: boolean;
  /** Tooltip, e.g. why the tab is disabled. */
  readonly title?: string;
}

const tabId = (base: string, id: string): string => `${base}-tab-${id}`;
const panelId = (base: string, id: string): string => `${base}-panel-${id}`;

/**
 * A WAI-ARIA tablist (automatic activation): one Tab stop on the selected
 * tab; Arrow Left/Right, Home and End move to and select the neighbouring
 * enabled tab. Each tab controls the {@link TabPanel} with the same
 * `idBase` and `id`.
 */
export function TabList<T extends string>({
  label,
  idBase,
  items,
  value,
  onChange,
  className,
  tabClassName,
}: {
  /** Accessible name of the tablist. */
  readonly label: string;
  /** Shared id prefix linking tabs and panels (e.g. from `useId()`). */
  readonly idBase: string;
  readonly items: ReadonlyArray<TabItem<T>>;
  readonly value: T;
  readonly onChange: (id: T) => void;
  readonly className?: string;
  readonly tabClassName?: string;
}): React.ReactElement {
  const enabled = items.filter((item) => !item.disabled);

  const select = (tabList: HTMLElement, id: T): void => {
    onChange(id);
    tabList.querySelector<HTMLElement>(`#${CSS.escape(tabId(idBase, id))}`)?.focus();
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    const index = enabled.findIndex((item) => item.id === value);
    const target =
      event.key === "ArrowRight"
        ? enabled[(index + 1) % enabled.length]
        : event.key === "ArrowLeft"
          ? enabled.at(index - 1)
          : event.key === "Home"
            ? enabled[0]
            : event.key === "End"
              ? enabled.at(-1)
              : undefined;
    if (!target) return;
    event.preventDefault();
    select(event.currentTarget, target.id);
  };

  return (
    <div role="tablist" aria-label={label} onKeyDown={onKeyDown} className={className}>
      {items.map((item) => {
        const selected = item.id === value;
        return (
          <button
            key={item.id}
            type="button"
            role="tab"
            id={tabId(idBase, item.id)}
            aria-controls={panelId(idBase, item.id)}
            aria-selected={selected}
            tabIndex={selected ? 0 : -1}
            disabled={item.disabled}
            title={item.title}
            onClick={() => onChange(item.id)}
            className={tabClassName}
          >
            {item.label}
          </button>
        );
      })}
    </div>
  );
}

/**
 * The panel of one tab. Rendered inside an `<Activity>`: an unselected
 * panel is hidden (`display: none`, effects unmounted) but keeps its
 * state — scroll position, drafts, a graph viewport — for when its tab
 * is selected again. Pass `mounted={false}` to skip rendering a panel
 * that has never been shown.
 */
export function TabPanel({
  idBase,
  id,
  selected,
  mounted = true,
  className,
  children,
}: {
  readonly idBase: string;
  readonly id: string;
  readonly selected: boolean;
  readonly mounted?: boolean;
  readonly className?: string;
  readonly children: React.ReactNode;
}): React.ReactElement | null {
  if (!selected && !mounted) return null;
  return (
    <Activity mode={selected ? "visible" : "hidden"}>
      <div
        role="tabpanel"
        id={panelId(idBase, id)}
        aria-labelledby={tabId(idBase, id)}
        className={className}
      >
        {children}
      </div>
    </Activity>
  );
}
