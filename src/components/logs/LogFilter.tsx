import { Button } from "#components/ui/Button";
import type { LogLevel } from "#store/logs";
import { LOG_LEVEL_LABEL, LOG_LEVELS } from "#store/logs";

/** Props for the log filter toolbar. */
interface LogFilterProps {
  /** Currently active log levels. */
  readonly activeLevels: ReadonlySet<LogLevel>;
  /** Toggle a log level on/off. */
  readonly onToggleLevel: (level: LogLevel) => void;
  /** All known log sources. */
  readonly sources: ReadonlySet<string>;
  /** Currently selected source filter, or null for all. */
  readonly selectedSource: string | null;
  /** Set the source filter. */
  readonly onSelectSource: (source: string | null) => void;
  /** Current search query text (controlled — LogViewer defers the filtering, not the input). */
  readonly searchQuery: string;
  /** Update the search query. */
  readonly onSearchChange: (query: string) => void;
  /** Clear all log entries. */
  readonly onClear: () => void;
}

/**
 * Filter toolbar for the log viewer: level toggle buttons (`aria-pressed`),
 * a source dropdown, a search box and a clear button. Hover and
 * `:focus-visible` states live in `logs.css`, not inline styles.
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
  return (
    <search className="log-filter">
      <div className="log-filter__levels">
        {LOG_LEVELS.map((level) => (
          <button
            key={level}
            type="button"
            className="log-filter__level"
            data-level={level}
            aria-pressed={activeLevels.has(level)}
            onClick={() => onToggleLevel(level)}
          >
            {LOG_LEVEL_LABEL[level]}
          </button>
        ))}
      </div>

      <select
        className="log-filter__source"
        value={selectedSource ?? ""}
        onChange={(e) => onSelectSource(e.target.value === "" ? null : e.target.value)}
        aria-label="Filter By Source"
      >
        <option value="">All Sources</option>
        {[...sources].sort().map((source) => (
          <option key={source} value={source}>
            {source}
          </option>
        ))}
      </select>

      <input
        type="search"
        className="swarm-input log-filter__search"
        placeholder="Search Logs…"
        value={searchQuery}
        onChange={(e) => onSearchChange(e.target.value)}
        aria-label="Search Log Messages"
      />

      <Button variant="ghost" size="sm" onClick={onClear} aria-label="Clear All Logs">
        Clear
      </Button>
    </search>
  );
}
