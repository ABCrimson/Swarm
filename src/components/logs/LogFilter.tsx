import { useEffect, useRef, useState } from "react";

import type { LogLevel } from "#lib/log-store";

/** Props for the log filter toolbar. */
interface LogFilterProps {
  /** Currently active log levels. */
  readonly activeLevels: Set<LogLevel>;
  /** Toggle a log level on/off. */
  readonly onToggleLevel: (level: LogLevel) => void;
  /** All known log sources. */
  readonly sources: Set<string>;
  /** Currently selected source filter, or null for all. */
  readonly selectedSource: string | null;
  /** Set the source filter. */
  readonly onSelectSource: (source: string | null) => void;
  /** Current search query text. */
  readonly searchQuery: string;
  /** Update the search query. */
  readonly onSearchChange: (query: string) => void;
  /** Clear all log entries. */
  readonly onClear: () => void;
}

const LOG_LEVELS: LogLevel[] = ["debug", "info", "warn", "error"];

const LEVEL_COLORS: Record<LogLevel, string> = {
  debug: "oklch(0.65 0.04 220)",
  info: "oklch(0.78 0.18 205)",
  warn: "oklch(0.82 0.19 70)",
  error: "oklch(0.72 0.20 10)",
};

const LEVEL_BG_ACTIVE: Record<LogLevel, string> = {
  debug: "oklch(0.65 0.04 220 / 0.2)",
  info: "oklch(0.78 0.18 205 / 0.2)",
  warn: "oklch(0.82 0.19 70 / 0.2)",
  error: "oklch(0.72 0.20 10 / 0.2)",
};

/**
 * Filter toolbar for the log viewer with level toggles, source dropdown,
 * text search input, and a clear button. OKLCH glass-panel styling.
 */
export function LogFilter({
  activeLevels,
  onToggleLevel,
  sources,
  selectedSource,
  onSelectSource,
  searchQuery,
  onSearchChange,
  onClear,
}: LogFilterProps): React.ReactElement {
  const [localSearch, setLocalSearch] = useState(searchQuery);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleSearchChange = (value: string) => {
    setLocalSearch(value);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      onSearchChange(value);
    }, 300);
  };

  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  const handleSourceChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    onSelectSource(e.target.value === "" ? null : e.target.value);
  };

  const sortedSources = [...sources].sort();

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "8px 12px",
        borderBottom: "1px solid oklch(0.22 0.04 220)",
        background: "oklch(0.10 0.03 220 / 0.6)",
        backdropFilter: "blur(12px) saturate(1.5)",
        flexWrap: "wrap",
      }}
    >
      {/* Level toggle buttons */}
      <div style={{ display: "flex", gap: 4 }}>
        {LOG_LEVELS.map((level) => {
          const isActive = activeLevels.has(level);
          return (
            <button
              key={level}
              type="button"
              onClick={() => onToggleLevel(level)}
              style={{
                padding: "4px 10px",
                borderRadius: 6,
                border: `1px solid ${isActive ? LEVEL_COLORS[level] : "oklch(0.22 0.04 220)"}`,
                background: isActive ? LEVEL_BG_ACTIVE[level] : "oklch(0 0 0 / 0)",
                color: isActive ? LEVEL_COLORS[level] : "oklch(0.45 0.04 220)",
                fontFamily: "var(--font-mono)",
                fontSize: "0.6875rem",
                fontWeight: 600,
                textTransform: "uppercase",
                cursor: "pointer",
                transition: "all 0.15s ease",
                letterSpacing: "0.04em",
              }}
            >
              {level}
            </button>
          );
        })}
      </div>

      {/* Source dropdown */}
      <select
        value={selectedSource ?? ""}
        onChange={handleSourceChange}
        aria-label="Filter By Source"
        style={{
          padding: "4px 8px",
          borderRadius: 6,
          border: "1px solid oklch(0.22 0.04 220)",
          background: "oklch(0.10 0.03 220)",
          color: "oklch(0.72 0.04 220)",
          fontFamily: "var(--font-mono)",
          fontSize: "0.75rem",
          cursor: "pointer",
          outline: "none",
          minWidth: 120,
        }}
      >
        <option value="">All Sources</option>
        {sortedSources.map((source) => (
          <option key={source} value={source}>
            {source}
          </option>
        ))}
      </select>

      {/* Search input */}
      <div style={{ flex: 1, minWidth: 140 }}>
        <input
          type="text"
          placeholder="Search Logs..."
          value={localSearch}
          onChange={(e) => handleSearchChange(e.target.value)}
          aria-label="Search Log Messages"
          style={{
            width: "100%",
            padding: "5px 10px",
            borderRadius: 6,
            border: "1px solid oklch(0.22 0.04 220)",
            background: "oklch(0.08 0.02 220)",
            color: "oklch(0.82 0.04 220)",
            fontFamily: "var(--font-mono)",
            fontSize: "0.75rem",
            outline: "none",
          }}
        />
      </div>

      {/* Clear button */}
      <button
        type="button"
        onClick={onClear}
        aria-label="Clear All Logs"
        style={{
          padding: "4px 10px",
          borderRadius: 6,
          border: "1px solid oklch(0.22 0.04 220)",
          background: "oklch(0 0 0 / 0)",
          color: "oklch(0.55 0.04 220)",
          fontFamily: "var(--font-body)",
          fontSize: "0.75rem",
          cursor: "pointer",
          transition: "all 0.15s ease",
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.borderColor = "oklch(0.72 0.20 10)";
          e.currentTarget.style.color = "oklch(0.72 0.20 10)";
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.borderColor = "oklch(0.22 0.04 220)";
          e.currentTarget.style.color = "oklch(0.55 0.04 220)";
        }}
      >
        Clear
      </button>
    </div>
  );
}
