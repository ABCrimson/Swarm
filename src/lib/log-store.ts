// ── Centralized Log Store ────────────────────────────
// In-memory ring buffer of the last 10,000 log entries with Zustand.

import { create } from "zustand";
import { subscribeWithSelector } from "zustand/middleware";

/** Severity level for a log entry. */
export type LogLevel = "debug" | "info" | "warn" | "error";

/** A single structured log entry. */
export interface LogEntry {
  readonly id: string;
  readonly timestamp: number;
  readonly level: LogLevel;
  /** Source identifier, e.g. "worker:uuid", "ai", "system", "bus". */
  readonly source: string;
  readonly message: string;
  readonly metadata?: Record<string, unknown>;
}

/** Default maximum entries retained in the ring buffer. */
const MAX_ENTRIES = 10_000;

/** State slice for the log store. */
interface LogStoreState {
  readonly entries: LogEntry[];
  readonly sources: Set<string>;
  /** Live retention cap — driven by the Log Retention setting via useSettingsBridge. */
  readonly maxEntries: number;
}

/** Mutation actions for the log store. */
interface LogStoreActions {
  /** Append a new log entry, evicting the oldest if at capacity. */
  readonly addEntry: (entry: Omit<LogEntry, "id">) => void;
  /** Append multiple log entries in a single batch update. */
  readonly addBatch: (entries: ReadonlyArray<Omit<LogEntry, "id">>) => void;
  /** Remove all log entries and reset sources. */
  readonly clear: () => void;
  /** Update the retention cap, trimming existing entries if it shrank. */
  readonly setMaxEntries: (max: number) => void;
}

/**
 * Zustand store for centralized log aggregation.
 *
 * Stores up to 10,000 log entries in a ring buffer. Each entry has a
 * level (debug/info/warn/error), source tag, and optional metadata.
 * Sources are tracked for filter dropdowns.
 */
export const useLogStore = create<LogStoreState & LogStoreActions>()(
  subscribeWithSelector((set) => ({
    entries: [],
    sources: new Set<string>(),
    maxEntries: MAX_ENTRIES,

    addEntry(entry) {
      set((state) => {
        const newEntry: LogEntry = { ...entry, id: crypto.randomUUID() };
        const nextEntries =
          state.entries.length >= state.maxEntries
            ? [...state.entries.slice(-(state.maxEntries - 1)), newEntry]
            : [...state.entries, newEntry];
        const nextSources = new Set(state.sources);
        nextSources.add(entry.source);
        return { entries: nextEntries, sources: nextSources };
      });
    },

    addBatch(entries) {
      set((state) => {
        const newEntries: LogEntry[] = entries.map((e) => ({
          ...e,
          id: crypto.randomUUID(),
        }));
        const combined = [...state.entries, ...newEntries];
        const trimmed =
          combined.length > state.maxEntries ? combined.slice(-state.maxEntries) : combined;
        const nextSources = new Set(state.sources);
        for (const e of entries) {
          nextSources.add(e.source);
        }
        return { entries: trimmed, sources: nextSources };
      });
    },

    clear() {
      set({ entries: [], sources: new Set<string>() });
    },

    setMaxEntries(max) {
      set((state) => ({
        maxEntries: max,
        entries: state.entries.length > max ? state.entries.slice(-max) : state.entries,
      }));
    },
  })),
);
