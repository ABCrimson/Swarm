import { atom } from "jotai";
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
 * Persisted atom storing frecency data for command palette ranking.
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

/** Derived atom that computes a frecency score for sorting commands. */
export const frecencyScoreAtom = atom((get) => {
  const entries = get(frecencyAtom);

  return (commandId: string): number => {
    const entry = entries.get(commandId);
    if (!entry) return 0;

    const elapsed = Temporal.Now.instant()
      .since(Temporal.Instant.from(entry.lastUsed))
      .total("milliseconds");
    const hoursAgo = elapsed / (1000 * 60 * 60);

    // Decay factor: halve the score every 72 hours
    const decay = 2 ** (-hoursAgo / 72);
    return entry.uses * decay;
  };
});
