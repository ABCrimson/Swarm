import "./logs.css";

import { useResizeObserver } from "@crimson_dev/use-resize-observer";
import { useDeferredValue, useLayoutEffect, useRef, useState } from "react";
import { Button } from "#components/ui/Button";
import type { PillTone } from "#components/ui/Pill";
import { Pill } from "#components/ui/Pill";
import type { LogEntry, LogLevel } from "#lib/log-store";
import { LOG_LEVEL_LABEL, LOG_LEVELS, useLogStore } from "#lib/log-store";
import { LogFilter } from "./LogFilter.tsx";

const LEVEL_TONE: Record<LogLevel, PillTone> = {
  debug: "neutral",
  info: "info",
  warn: "warning",
  error: "danger",
};

/** Row height for the virtualized list, in px. */
export const LOG_ROW_HEIGHT = 28;
/** Overscan buffer rows rendered above and below the viewport. */
export const LOG_OVERSCAN = 10;

/** Formats an epoch-ms timestamp as local wall-clock `HH:MM:SS.mmm`. */
function formatTimestamp(ts: number): string {
  return Temporal.Instant.fromEpochMilliseconds(ts)
    .toZonedDateTimeISO(Temporal.Now.timeZoneId())
    .toPlainTime()
    .toString({ smallestUnit: "millisecond" });
}

/** Wraps the first case-insensitive match of `query` in `text` in a `<mark>`. */
function highlightText(text: string, query: string): React.ReactNode {
  if (!query) return text;
  const idx = text.toLowerCase().indexOf(query.toLowerCase());
  if (idx === -1) return text;

  return (
    <>
      {text.slice(0, idx)}
      <mark className="log-row__match">{text.slice(idx, idx + query.length)}</mark>
      {text.slice(idx + query.length)}
    </>
  );
}

/**
 * Virtualized log list with level/source filters, text search with
 * highlighting, and auto-scroll that follows new entries while the view
 * is at the bottom and pauses as soon as the user scrolls up.
 *
 * Typing stays urgent: filtering and highlighting read a
 * `useDeferredValue` copy of the query, so a long log re-filters as an
 * interruptible background render instead of on every keystroke.
 */
export function LogViewer(): React.ReactElement {
  const entries = useLogStore((s) => s.entries);
  const sources = useLogStore((s) => s.sources);
  const clear = useLogStore((s) => s.clear);

  const [activeLevels, setActiveLevels] = useState<ReadonlySet<LogLevel>>(
    () => new Set(LOG_LEVELS),
  );
  const [selectedSource, setSelectedSource] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const deferredQuery = useDeferredValue(searchQuery);
  const [autoScroll, setAutoScroll] = useState(true);
  const [scrollTop, setScrollTop] = useState(0);

  const containerRef = useRef<HTMLDivElement>(null);
  const { height: containerHeight = 0 } = useResizeObserver({
    ref: containerRef,
    box: "content-box",
  });

  const queryLower = deferredQuery.toLowerCase();
  const filteredEntries = entries.filter(
    (entry) =>
      activeLevels.has(entry.level) &&
      (selectedSource === null || entry.source === selectedSource) &&
      (queryLower === "" || entry.message.toLowerCase().includes(queryLower)),
  );
  // The newest visible entry — at the retention cap the list length stops
  // changing while its tail still advances, so this (not the length) is
  // what tells the follow effect that something new arrived.
  const newestId = filteredEntries.at(-1)?.id;

  // Follow the tail: a layout effect, so the jump lands before paint
  // instead of flashing the previous scroll position for a frame.
  useLayoutEffect(() => {
    const el = containerRef.current;
    if (autoScroll && el && newestId !== undefined) el.scrollTop = el.scrollHeight;
  }, [autoScroll, newestId]);

  const handleScroll = (): void => {
    const el = containerRef.current;
    if (!el) return;
    setScrollTop(el.scrollTop);
    // Anything more than two rows above the bottom counts as the user
    // having scrolled away; content growing below fires no scroll event.
    setAutoScroll(el.scrollHeight - el.scrollTop - el.clientHeight < LOG_ROW_HEIGHT * 2);
  };

  const startIndex = Math.max(0, Math.floor(scrollTop / LOG_ROW_HEIGHT) - LOG_OVERSCAN);
  const endIndex = Math.min(
    filteredEntries.length,
    Math.ceil((scrollTop + containerHeight) / LOG_ROW_HEIGHT) + LOG_OVERSCAN,
  );
  const visibleEntries = filteredEntries.slice(startIndex, endIndex);

  return (
    <div className="log-viewer">
      <LogFilter
        activeLevels={activeLevels}
        // Set.prototype.symmetricDifference toggles membership in one step.
        onToggleLevel={(level) =>
          setActiveLevels((prev) => prev.symmetricDifference(new Set([level])))
        }
        sources={sources}
        selectedSource={selectedSource}
        onSelectSource={setSelectedSource}
        searchQuery={searchQuery}
        onSearchChange={setSearchQuery}
        onClear={clear}
      />

      {!autoScroll && filteredEntries.length > 0 && (
        <Button
          variant="secondary"
          size="sm"
          className="log-viewer__resume"
          onClick={() => setAutoScroll(true)}
        >
          Resume Auto-Scroll
        </Button>
      )}

      <div
        ref={containerRef}
        role="log"
        aria-label="Log Entries"
        // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable region must be keyboard-focusable so it can be scrolled without a mouse (WCAG 2.1.1).
        tabIndex={0}
        className="log-viewer__scroll scroll-area"
        onScroll={handleScroll}
      >
        <div
          className="log-viewer__track"
          style={{ height: filteredEntries.length * LOG_ROW_HEIGHT }}
        >
          <div className="log-viewer__window" style={{ top: startIndex * LOG_ROW_HEIGHT }}>
            {visibleEntries.map((entry) => (
              <LogRow key={entry.id} entry={entry} searchQuery={deferredQuery} />
            ))}
          </div>
        </div>

        {filteredEntries.length === 0 && (
          <p className="log-viewer__empty">
            {entries.length === 0 ? "No Log Entries Yet" : "No Entries Match Current Filters"}
          </p>
        )}
      </div>
    </div>
  );
}

function LogRow({
  entry,
  searchQuery,
}: {
  readonly entry: LogEntry;
  readonly searchQuery: string;
}): React.ReactElement {
  return (
    <div className="log-row" style={{ height: LOG_ROW_HEIGHT }}>
      <time
        className="log-row__time"
        dateTime={Temporal.Instant.fromEpochMilliseconds(entry.timestamp).toString()}
      >
        {formatTimestamp(entry.timestamp)}
      </time>
      <Pill tone={LEVEL_TONE[entry.level]} size="sm" className="log-row__level">
        {LOG_LEVEL_LABEL[entry.level]}
      </Pill>
      <span className="log-row__source">{entry.source}</span>
      <span className="log-row__message">{highlightText(entry.message, searchQuery)}</span>
    </div>
  );
}
