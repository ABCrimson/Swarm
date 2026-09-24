import { atomWithStorage } from "jotai/utils";

import { settingsStore } from "#lib/lazy-store";
import { isTauri } from "#lib/tauri";

/** A single frecency record tracking usage count and recency. */
export interface FrecencyEntry {
  readonly uses: number;
  readonly lastUsed: string;
}

// ── Tauri plugin-store persistence adapter ───────────

/**
 * Persisted atom storing frecency data for command palette ranking —
 * the backing store of the palette's `modern-cmdk` frecency engine
 * (`#components/command/CommandPalette`), which computes the scores.
 *
 * Serialised to Tauri plugin-store as an array of `[commandId, FrecencyEntry]` tuples.
 */
export const frecencyAtom = atomWithStorage<Map<string, FrecencyEntry>>(
  "swarm:frecency",
  new Map(),
  {
    getItem(_key, initialValue) {
      return initialValue;
    },
    setItem(key, value) {
      if (!isTauri()) return;
      void settingsStore.set(key, [...value.entries()]).then(() => settingsStore.save());
    },
    removeItem(key) {
      if (!isTauri()) return;
      void settingsStore.delete(key).then(() => settingsStore.save());
    },
    subscribe(key, callback, _initialValue) {
      if (!isTauri()) return () => {};
      void settingsStore
        .get<Array<[string, FrecencyEntry]>>(key)
        .then((raw) => {
          if (raw) callback(new Map(raw));
        })
        .catch(() => {});
      return () => {};
    },
  },
);
