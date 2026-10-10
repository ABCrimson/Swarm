// ── Centralized Log Store ────────────────────────────
// Bounded, immutable in-memory log (newest last) for the Logs page.

import { create } from "zustand";

/** Severity level for a log entry. */
export type LogLevel = "debug" | "info" | "warn" | "error";

/** Every level, in severity order — the Logs page's filter toggles render in this order. */
export const LOG_LEVELS: readonly LogLevel[] = ["debug", "info", "warn", "error"];

/** Title Case display label per level (the Logs page renders them upper-case via CSS). */
export const LOG_LEVEL_LABEL: Readonly<Record<LogLevel, string>> = {
  debug: "Debug",
  info: "Info",
  warn: "Warn",
  error: "Error",
};

/** A single structured log entry. */
export interface LogEntry {
  readonly id: string;
  readonly timestamp: number;
  readonly level: LogLevel;
  /** Source identifier, e.g. "backend", "worker:uuid", "ai". */
  readonly source: string;
  readonly message: string;
  readonly metadata?: Record<string, unknown>;
}

/** Default retention cap; the live value comes from the Log Retention setting. */
const MAX_ENTRIES = 10_000;

/** State slice for the log store. */
interface LogStoreState {
  readonly entries: readonly LogEntry[];
  /** Every source seen since the last {@link LogStoreActions.clear}, for the source filter. */
  readonly sources: ReadonlySet<string>;
  /** Live retention cap — driven by the Log Retention setting via useSettingsBridge. */
  readonly maxEntries: number;
}

/** Mutation actions for the log store. */
interface LogStoreActions {
  /** Append an entry, dropping the oldest ones beyond {@link LogStoreState.maxEntries}. */
  readonly addEntry: (entry: Omit<LogEntry, "id">) => void;
  /** Remove all log entries and reset sources. */
  readonly clear: () => void;
  /** Update the retention cap, trimming existing entries if it shrank. */
  readonly setMaxEntries: (max: number) => void;
}

/** The trailing `max` entries of `entries` (none when `max <= 0`). */
function keepLast(entries: readonly LogEntry[], max: number): readonly LogEntry[] {
  if (max <= 0) return [];
  return entries.length > max ? entries.slice(entries.length - max) : entries;
}

/**
 * Zustand store for centralized log aggregation.
 *
 * Entries are an immutable array (newest last) capped at `maxEntries`, so
 * every append is one O(n) copy — cheap at the Settings maximum and what
 * lets `LogViewer` (and the React Compiler) key derived work on the
 * array's identity. The `sources` set is copied only when a new source
 * appears.
 */
export const useLogStore = create<LogStoreState & LogStoreActions>()((set) => ({
  entries: [],
  sources: new Set<string>(),
  maxEntries: MAX_ENTRIES,

  addEntry(entry) {
    set((state) => ({
      entries:
        state.maxEntries > 0
          ? [
              ...keepLast(state.entries, state.maxEntries - 1),
              { ...entry, id: crypto.randomUUID() },
            ]
          : [],
      sources: state.sources.has(entry.source)
        ? state.sources
        : new Set(state.sources).add(entry.source),
    }));
  },

  clear() {
    set({ entries: [], sources: new Set<string>() });
  },

  setMaxEntries(max) {
    set((state) => ({ maxEntries: max, entries: keepLast(state.entries, max) }));
  },
}));
