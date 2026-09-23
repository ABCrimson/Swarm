import { addDays, isBefore, parseISO, startOfDay } from "date-fns";
import { useDeferredValue, useId, useState } from "react";
import { Input } from "#components/ui/Input";
import { Pill } from "#components/ui/Pill";
import { pluralize } from "#lib/format";
import { useSessionStore } from "#store/sessions";
import type { Session } from "#store/types";

interface HistorySearchProps {
  readonly onResultSelect: (sessionId: string) => void;
}

interface DateRange {
  /** Inclusive start day, `yyyy-mm-dd` (a native date input's value), or `""`. */
  readonly from: string;
  /** Inclusive end day, `yyyy-mm-dd`, or `""`. */
  readonly to: string;
}

/** Whether `session` matches a lowercased, trimmed `query` by name, tag or description. */
function matchesQuery(session: Session, query: string): boolean {
  if (query === "") return true;
  return (
    session.name.toLowerCase().includes(query) ||
    (session.metadata?.tags?.some((tag) => tag.toLowerCase().includes(query)) ?? false) ||
    (session.metadata?.description?.toLowerCase().includes(query) ?? false)
  );
}

/** Whether `session` was last updated within the inclusive `range` (whole days, local time). */
function withinRange(session: Session, range: DateRange): boolean {
  const updated = parseISO(session.updatedAt);
  if (range.from !== "" && isBefore(updated, startOfDay(parseISO(range.from)))) return false;
  if (range.to !== "" && !isBefore(updated, addDays(startOfDay(parseISO(range.to)), 1))) {
    return false;
  }
  return true;
}

/** `text` with every case-insensitive occurrence of `query` wrapped in `<mark>`. */
function Highlighted({ text, query }: { readonly text: string; readonly query: string }) {
  if (query === "") return text;
  const nodes: React.ReactNode[] = [];
  let cursor = 0;
  for (const { 0: match, index } of text.matchAll(new RegExp(RegExp.escape(query), "gi"))) {
    nodes.push(
      text.slice(cursor, index),
      <mark
        key={index}
        className="rounded-xs bg-[oklch(0.65_0.18_85/0.3)] px-0.5 text-[oklch(0.88_0.14_85)]"
      >
        {match}
      </mark>,
    );
    cursor = index + match.length;
  }
  nodes.push(text.slice(cursor));
  return nodes;
}

/**
 * Session history search: a case-insensitive substring match over each
 * session's name, tags and description, plus an inclusive date range on
 * its last update. Results are newest first (the list's order), every
 * occurrence of the query is highlighted, and tags that matched are shown,
 * so a tag-only match is never a result with no visible reason.
 *
 * The query filters through `useDeferredValue`: typing stays responsive
 * and the (synchronous, in-memory) filter re-runs at lower priority — no
 * debounce timer to manage.
 */
export function HistorySearch({ onResultSelect }: HistorySearchProps): React.ReactElement {
  const sessions = useSessionStore((s) => s.sessions);
  const [query, setQuery] = useState("");
  const [dateRange, setDateRange] = useState<DateRange>({ from: "", to: "" });
  const deferredQuery = useDeferredValue(query.trim().toLowerCase());
  const fromId = useId();
  const toId = useId();

  const filtering = deferredQuery !== "" || dateRange.from !== "" || dateRange.to !== "";
  const results = sessions
    .values()
    .filter((session) => matchesQuery(session, deferredQuery) && withinRange(session, dateRange))
    .toArray()
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));

  const labelClass =
    "shrink-0 text-xs text-[oklch(0.55_0.03_220)] font-[family-name:var(--font-body)]";

  return (
    <div className="flex flex-col gap-4">
      <search className="flex flex-col gap-3">
        <Input
          type="search"
          aria-label="Search Sessions"
          placeholder="Search Sessions…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="w-full"
        />

        <div className="flex items-center gap-2">
          <label htmlFor={fromId} className={labelClass}>
            From
          </label>
          <input
            id={fromId}
            type="date"
            value={dateRange.from}
            max={dateRange.to || undefined}
            onChange={(e) => setDateRange((prev) => ({ ...prev, from: e.target.value }))}
            className="swarm-input flex-1 text-xs [color-scheme:dark]"
          />
          <label htmlFor={toId} className={labelClass}>
            To
          </label>
          <input
            id={toId}
            type="date"
            value={dateRange.to}
            min={dateRange.from || undefined}
            onChange={(e) => setDateRange((prev) => ({ ...prev, to: e.target.value }))}
            className="swarm-input flex-1 text-xs [color-scheme:dark]"
          />
          {(dateRange.from !== "" || dateRange.to !== "") && (
            <button
              type="button"
              onClick={() => setDateRange({ from: "", to: "" })}
              className="cursor-pointer rounded bg-[oklch(0.22_0.03_220/0.5)] px-2 py-1 text-xs text-[oklch(0.65_0.06_220)] hover:bg-[oklch(0.26_0.04_220/0.6)] focus-visible:outline-2 focus-visible:outline-plasma"
            >
              Clear Dates
            </button>
          )}
        </div>
      </search>

      {filtering && (
        <section aria-label="Search Results" className="flex flex-col gap-1.5">
          <p
            role="status"
            className="text-xs text-[oklch(0.50_0.04_220)] font-[family-name:var(--font-mono)]"
          >
            {pluralize("Result", results.length)}
          </p>

          {results.map((session) => (
            <SearchResultItem
              key={session.id}
              session={session}
              query={deferredQuery}
              onSelect={onResultSelect}
            />
          ))}

          {results.length === 0 && (
            <p className="py-4 text-center text-sm text-[oklch(0.55_0.03_220)] font-[family-name:var(--font-body)]">
              No Matching Sessions Found.
            </p>
          )}
        </section>
      )}
    </div>
  );
}

function SearchResultItem({
  session,
  query,
  onSelect,
}: {
  readonly session: Session;
  readonly query: string;
  readonly onSelect: (id: string) => void;
}): React.ReactElement {
  const description = session.metadata?.description;
  const matchedTags =
    query === ""
      ? []
      : (session.metadata?.tags ?? []).filter((tag) => tag.toLowerCase().includes(query));

  return (
    <button
      type="button"
      onClick={() => onSelect(session.id)}
      className="w-full cursor-pointer rounded-lg border border-[oklch(0.25_0.03_220/0.4)] bg-[oklch(0.15_0.02_220/0.4)] p-3 text-left transition-colors hover:bg-[oklch(0.18_0.04_220/0.5)] focus-visible:outline-2 focus-visible:outline-plasma"
    >
      <span className="block text-sm font-medium text-[oklch(0.85_0.03_220)] font-[family-name:var(--font-display)]">
        <Highlighted text={session.name} query={query} />
      </span>
      {description != null && description !== "" && (
        <span className="mt-1 block truncate text-xs text-[oklch(0.50_0.03_220)] font-[family-name:var(--font-body)]">
          <Highlighted text={description} query={query} />
        </span>
      )}
      {matchedTags.length > 0 && (
        <span className="mt-2 flex flex-wrap gap-1">
          {matchedTags.map((tag) => (
            <Pill key={tag} tone="warning" size="sm" maxWidth={120}>
              <Highlighted text={tag} query={query} />
            </Pill>
          ))}
        </span>
      )}
    </button>
  );
}
