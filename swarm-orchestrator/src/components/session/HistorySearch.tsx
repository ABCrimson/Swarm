import { isAfter, isBefore, parseISO, startOfDay } from "date-fns";
import { useEffect, useRef, useState } from "react";
import { Input } from "#components/ui/Input";

import { useSessionStore } from "#store/sessions";
import type { Session } from "#store/types";

interface HistorySearchProps {
  readonly onResultSelect: (sessionId: string) => void;
}

interface DateRange {
  readonly from: string;
  readonly to: string;
}

/**
 * Full-text search with date range filtering across session history.
 *
 * Debounces search input at 300ms and highlights matching text
 * in result items.
 */
export function HistorySearch({ onResultSelect }: HistorySearchProps): React.ReactElement {
  const sessions = useSessionStore((s) => s.sessions);
  const [query, setQuery] = useState("");
  const [dateRange, setDateRange] = useState<DateRange>({ from: "", to: "" });
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [debouncedQuery, setDebouncedQuery] = useState("");

  useEffect(() => {
    return () => {
      if (debounceRef.current !== null) clearTimeout(debounceRef.current);
    };
  }, []);

  const handleQueryChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    setQuery(value);

    if (debounceRef.current !== null) {
      clearTimeout(debounceRef.current);
    }

    debounceRef.current = setTimeout(() => {
      setDebouncedQuery(value.trim().toLowerCase());
    }, 300);
  };

  const results = (() => {
    const allSessions = [...sessions.values()];

    return allSessions.filter((session) => {
      // Text search
      if (debouncedQuery) {
        const nameMatch = session.name.toLowerCase().includes(debouncedQuery);
        const tagMatch = session.metadata?.tags?.some((tag) =>
          tag.toLowerCase().includes(debouncedQuery),
        );
        const descMatch = session.metadata?.description?.toLowerCase().includes(debouncedQuery);

        if (!nameMatch && !tagMatch && !descMatch) return false;
      }

      // Date range filter
      if (dateRange.from) {
        const fromDate = startOfDay(parseISO(dateRange.from));
        const sessionDate = parseISO(session.updatedAt);
        if (isBefore(sessionDate, fromDate)) return false;
      }

      if (dateRange.to) {
        const toDate = startOfDay(parseISO(dateRange.to));
        // Add 1 day to include the entire "to" day
        toDate.setDate(toDate.getDate() + 1);
        const sessionDate = parseISO(session.updatedAt);
        if (isAfter(sessionDate, toDate)) return false;
      }

      return true;
    });
  })();

  const highlightMatch = (text: string): React.ReactElement => {
    if (!debouncedQuery) {
      return <span>{text}</span>;
    }

    const idx = text.toLowerCase().indexOf(debouncedQuery);
    if (idx === -1) {
      return <span>{text}</span>;
    }

    const before = text.slice(0, idx);
    const match = text.slice(idx, idx + debouncedQuery.length);
    const after = text.slice(idx + debouncedQuery.length);

    return (
      <span>
        {before}
        <mark
          style={{
            background: "oklch(0.65 0.18 85 / 0.3)",
            color: "oklch(0.88 0.14 85)",
            borderRadius: "2px",
            padding: "0 2px",
          }}
        >
          {match}
        </mark>
        {after}
      </span>
    );
  };

  return (
    <div className="flex flex-col gap-4">
      {/* Search input */}
      <div className="flex flex-col gap-3">
        <Input
          placeholder="Search sessions..."
          value={query}
          onChange={handleQueryChange}
          className="w-full"
        />

        {/* Date range */}
        <div className="flex items-center gap-2">
          <label
            htmlFor="history-date-from"
            className="text-xs shrink-0"
            style={{
              fontFamily: "var(--font-body)",
              color: "oklch(0.55 0.03 220)",
            }}
          >
            From
          </label>
          <input
            id="history-date-from"
            type="date"
            value={dateRange.from}
            onChange={(e) => setDateRange((prev) => ({ ...prev, from: e.target.value }))}
            className="swarm-input text-xs flex-1"
            style={{
              colorScheme: "dark",
            }}
          />
          <label
            htmlFor="history-date-to"
            className="text-xs shrink-0"
            style={{
              fontFamily: "var(--font-body)",
              color: "oklch(0.55 0.03 220)",
            }}
          >
            To
          </label>
          <input
            id="history-date-to"
            type="date"
            value={dateRange.to}
            onChange={(e) => setDateRange((prev) => ({ ...prev, to: e.target.value }))}
            className="swarm-input text-xs flex-1"
            style={{
              colorScheme: "dark",
            }}
          />
          {(dateRange.from || dateRange.to) && (
            <button
              type="button"
              onClick={() => setDateRange({ from: "", to: "" })}
              className="text-xs px-2 py-1 rounded cursor-pointer"
              style={{
                color: "oklch(0.65 0.06 220)",
                background: "oklch(0.22 0.03 220 / 0.5)",
              }}
            >
              Clear
            </button>
          )}
        </div>
      </div>

      {/* Results */}
      {(debouncedQuery || dateRange.from || dateRange.to) && (
        <div className="flex flex-col gap-1.5">
          <p
            className="text-xs"
            style={{
              fontFamily: "var(--font-mono, 'JetBrains Mono Variable', monospace)",
              color: "oklch(0.50 0.04 220)",
            }}
          >
            {results.length} {results.length === 1 ? "result" : "results"}
          </p>

          {results.map((session) => (
            <SearchResultItem
              key={session.id}
              session={session}
              highlightMatch={highlightMatch}
              onSelect={onResultSelect}
            />
          ))}

          {results.length === 0 && (
            <p
              className="text-sm py-4 text-center"
              style={{
                fontFamily: "var(--font-body)",
                color: "oklch(0.55 0.03 220)",
              }}
            >
              No matching sessions found.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function SearchResultItem({
  session,
  highlightMatch,
  onSelect,
}: {
  readonly session: Session;
  readonly highlightMatch: (text: string) => React.ReactElement;
  readonly onSelect: (id: string) => void;
}): React.ReactElement {
  return (
    <button
      type="button"
      onClick={() => onSelect(session.id)}
      className="w-full text-left rounded-lg p-3 transition-colors cursor-pointer"
      style={{
        background: "oklch(0.15 0.02 220 / 0.4)",
        border: "1px solid oklch(0.25 0.03 220 / 0.4)",
      }}
      onMouseEnter={(e) => {
        (e.currentTarget as HTMLElement).style.background = "oklch(0.18 0.04 220 / 0.5)";
      }}
      onMouseLeave={(e) => {
        (e.currentTarget as HTMLElement).style.background = "oklch(0.15 0.02 220 / 0.4)";
      }}
    >
      <div
        className="text-sm font-medium"
        style={{
          fontFamily: "var(--font-display)",
          color: "oklch(0.85 0.03 220)",
        }}
      >
        {highlightMatch(session.name)}
      </div>
      {session.metadata?.description && (
        <div
          className="text-xs mt-1 truncate"
          style={{
            fontFamily: "var(--font-body)",
            color: "oklch(0.50 0.03 220)",
          }}
        >
          {highlightMatch(session.metadata.description)}
        </div>
      )}
    </button>
  );
}
