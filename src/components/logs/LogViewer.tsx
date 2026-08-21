import { useResizeObserver } from "@crimson_dev/use-resize-observer";
import { useEffect, useRef, useState } from "react";
import type { PillTone } from "#components/ui/Pill";
import { Pill } from "#components/ui/Pill";
import type { LogEntry, LogLevel } from "#lib/log-store";
import { useLogStore } from "#lib/log-store";
import { LogFilter } from "./LogFilter.tsx";

const LEVEL_TONE: Record<LogLevel, PillTone> = {
  debug: "neutral",
  info: "info",
  warn: "warning",
  error: "danger",
};

/** Row height for virtualized list. */
const ROW_HEIGHT = 28;
/** Overscan buffer rows above/below viewport. */
const OVERSCAN = 10;

/** Formats a timestamp as HH:MM:SS.mmm */
function formatTimestamp(ts: number): string {
  const d = new Date(ts);
  const h = String(d.getHours()).padStart(2, "0");
  const m = String(d.getMinutes()).padStart(2, "0");
  const s = String(d.getSeconds()).padStart(2, "0");
  const ms = String(d.getMilliseconds()).padStart(3, "0");
  return `${h}:${m}:${s}.${ms}`;
}

/** Highlights matching text in a string. */
function highlightText(text: string, query: string): React.ReactNode {
  if (!query) return text;

  const lower = text.toLowerCase();
  const queryLower = query.toLowerCase();
  const idx = lower.indexOf(queryLower);

  if (idx === -1) return text;

  return (
    <>
      {text.slice(0, idx)}
      <mark
        style={{
          background: "oklch(0.82 0.19 70 / 0.3)",
          color: "oklch(0.95 0.02 220)",
          borderRadius: 2,
          padding: "0 1px",
        }}
      >
        {text.slice(idx, idx + query.length)}
      </mark>
      {text.slice(idx + query.length)}
    </>
  );
}

/**
 * Virtualized log list with level/source filters, text search with
 * highlighting, and auto-scroll that pauses on scroll-up.
 *
 * Each row renders: timestamp (mono), level badge (colour-coded OKLCH),
 * source tag, and message. OKLCH glass-panel styling.
 */
export function LogViewer(): React.ReactElement {
  const entries = useLogStore((s) => s.entries);
  const sources = useLogStore((s) => s.sources);
  const clear = useLogStore((s) => s.clear);

  const [activeLevels, setActiveLevels] = useState<Set<LogLevel>>(
    () => new Set(["debug", "info", "warn", "error"]),
  );
  const [selectedSource, setSelectedSource] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [autoScroll, setAutoScroll] = useState(true);

  const containerRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);

  const { height: containerHeight = 0 } = useResizeObserver({
    ref: containerRef,
    box: "content-box",
  });

  // Filter entries
  const filteredEntries = (() => {
    const queryLower = searchQuery.toLowerCase();

    return entries.filter((entry) => {
      if (!activeLevels.has(entry.level)) return false;
      if (selectedSource && entry.source !== selectedSource) return false;
      if (queryLower && !entry.message.toLowerCase().includes(queryLower)) return false;
      return true;
    });
  })();

  // Toggle level filter
  const handleToggleLevel = (level: LogLevel) => {
    setActiveLevels((prev) => {
      const next = new Set(prev);
      if (next.has(level)) {
        next.delete(level);
      } else {
        next.add(level);
      }
      return next;
    });
  };

  // Scroll handling for auto-scroll and virtualisation
  const handleScroll = () => {
    const el = containerRef.current;
    if (!el) return;

    setScrollTop(el.scrollTop);

    // Check if user scrolled away from bottom
    const isAtBottom = el.scrollHeight - el.scrollTop - el.clientHeight < ROW_HEIGHT * 2;
    setAutoScroll(isAtBottom);
  };

  // Auto-scroll to bottom when new entries arrive
  useEffect(() => {
    if (autoScroll && containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [autoScroll]);

  // Virtual window calculation
  const totalHeight = filteredEntries.length * ROW_HEIGHT;
  const startIndex = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const endIndex = Math.min(
    filteredEntries.length,
    Math.ceil((scrollTop + containerHeight) / ROW_HEIGHT) + OVERSCAN,
  );
  const visibleEntries = filteredEntries.slice(startIndex, endIndex);
  const offsetY = startIndex * ROW_HEIGHT;

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        background: "oklch(0.08 0.02 220)",
        borderRadius: 12,
        border: "1px solid oklch(0.22 0.04 220)",
        overflow: "hidden",
      }}
    >
      <LogFilter
        activeLevels={activeLevels}
        onToggleLevel={handleToggleLevel}
        sources={sources}
        selectedSource={selectedSource}
        onSelectSource={setSelectedSource}
        searchQuery={searchQuery}
        onSearchChange={setSearchQuery}
        onClear={clear}
      />

      {/* Auto-scroll indicator */}
      {!autoScroll && filteredEntries.length > 0 && (
        <button
          type="button"
          onClick={() => {
            setAutoScroll(true);
            if (containerRef.current) {
              containerRef.current.scrollTop = containerRef.current.scrollHeight;
            }
          }}
          style={{
            position: "absolute",
            bottom: 16,
            right: 24,
            zIndex: 10,
            padding: "6px 14px",
            borderRadius: 8,
            border: "1px solid oklch(0.78 0.18 205 / 0.4)",
            background: "oklch(0.12 0.03 220 / 0.9)",
            backdropFilter: "blur(12px)",
            color: "oklch(0.78 0.18 205)",
            fontFamily: "var(--font-body)",
            fontSize: "0.75rem",
            fontWeight: 600,
            cursor: "pointer",
          }}
        >
          Resume Auto-Scroll
        </button>
      )}

      {/* Virtualised log list */}
      <div
        ref={containerRef}
        onScroll={handleScroll}
        style={{
          flex: 1,
          overflow: "auto",
          position: "relative",
        }}
      >
        <div style={{ height: totalHeight, position: "relative" }}>
          <div
            style={{
              position: "absolute",
              top: offsetY,
              left: 0,
              right: 0,
            }}
          >
            {visibleEntries.map((entry) => (
              <LogRow key={entry.id} entry={entry} searchQuery={searchQuery} />
            ))}
          </div>
        </div>

        {filteredEntries.length === 0 && (
          <div
            style={{
              position: "absolute",
              inset: 0,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontFamily: "var(--font-body)",
              fontSize: "0.875rem",
              color: "oklch(0.45 0.04 220)",
            }}
          >
            {entries.length === 0 ? "No Log Entries Yet" : "No Entries Match Current Filters"}
          </div>
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
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        height: ROW_HEIGHT,
        padding: "0 12px",
        borderBottom: "1px solid oklch(0.12 0.03 220)",
        fontFamily: "var(--font-mono)",
        fontSize: "0.75rem",
      }}
    >
      {/* Timestamp */}
      <span
        style={{
          color: "oklch(0.45 0.04 220)",
          whiteSpace: "nowrap",
          flexShrink: 0,
          width: 96,
        }}
      >
        {formatTimestamp(entry.timestamp)}
      </span>

      {/* Level badge */}
      <Pill
        tone={LEVEL_TONE[entry.level]}
        size="sm"
        style={{ textTransform: "uppercase", width: 44, flexShrink: 0 }}
      >
        {entry.level}
      </Pill>

      {/* Source */}
      <span
        style={{
          color: "oklch(0.60 0.10 205)",
          whiteSpace: "nowrap",
          flexShrink: 0,
          width: 100,
          overflow: "hidden",
          textOverflow: "ellipsis",
        }}
      >
        {entry.source}
      </span>

      {/* Message */}
      <span
        style={{
          color: "oklch(0.82 0.04 220)",
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
          flex: 1,
        }}
      >
        {highlightText(entry.message, searchQuery)}
      </span>
    </div>
  );
}
