// ── Persisted settings atoms ─────────────────────────
//
// Every jotai atom that persists to `swarm-settings.json` is built by
// `atomWithSettings`. The file is read once, before the app renders
// (`preloadSettings`, which main.tsx suspends on with `use()`), and an
// atom reads its value from that in-memory copy the first time a
// component reads it. The first render therefore already shows the
// persisted setting: no defaults-then-hydrate flash, and no effect can
// observe a pre-hydration default.
//
// Reads are validated per key with that atom's zod schema. A value that
// fails validation falls back to the atom's initial value (the disk copy
// stays until `validateStoreData` reports and deletes it). Writes update
// the in-memory copy synchronously and reach plugin-store through one
// ordered queue. plugin-store's own 100 ms auto-save debounce writes the
// file, so a drag that updates a setting on every pointermove does not
// rewrite `swarm-settings.json` on every event.
//
// The webview is the only writer of this file, so atoms do not subscribe
// to plugin-store change events.

import { atom, type WritableAtom } from "jotai";
import type * as z from "zod";
import { settingsStore } from "#lib/lazy-store";
import { isTauri } from "#lib/tauri";

/** A new value, or an updater from the current one — the argument of a settings atom's setter. */
export type SettingUpdate<T> = T | ((current: T) => T);

/** Per-key options for {@link atomWithSettings}. */
export interface SettingsOptions<T> {
  /** Title Case name of the setting, used when an integrity check resets it. */
  readonly label: string;
  /** Validates (and may repair) the persisted value. Its output is the atom value. */
  readonly schema: z.ZodType<T>;
  /** Converts the atom value to its persisted JSON form. Defaults to the value itself. */
  readonly serialize?: (value: T) => unknown;
  /**
   * Called when the key has never been written, e.g. to carry a value
   * over from a legacy key. `readRaw` returns another key's persisted,
   * unvalidated value. Returning `undefined` keeps the initial value.
   */
  readonly migrate?: (initial: T, readRaw: (key: string) => unknown) => T | undefined;
}

/** A persisted setting's key-level contract, as {@link persistedSettings} exposes it. */
export interface PersistedSetting {
  readonly label: string;
  readonly schema: z.ZodType;
}

const cache = new Map<string, unknown>();
const registry = new Map<string, PersistedSetting>();
let writeQueue: Promise<void> = Promise.resolve();

/** Every key registered through {@link atomWithSettings}, for `validateStoreData`. */
export const persistedSettings: ReadonlyMap<string, PersistedSetting> = registry;

/**
 * Loads `swarm-settings.json` into memory. Must settle before the first
 * read of any {@link atomWithSettings} atom; main.tsx gates the app on
 * it. Outside the desktop shell (browser preview, a swarmd-served page,
 * tests) there is no plugin-store and every setting starts from its
 * initial value. Never rejects: an unreadable file also means defaults.
 */
export async function preloadSettings(): Promise<void> {
  if (!isTauri()) return;
  try {
    for (const [key, raw] of await settingsStore.entries<unknown>()) cache.set(key, raw);
  } catch (err) {
    console.warn("[settings] Could not read swarm-settings.json; using defaults.", err);
  }
}

/** The persisted, unvalidated value of `key`, as last loaded or written. */
export function readPersistedRaw(key: string): unknown {
  return cache.get(key);
}

/**
 * Deletes `key` from memory and from `swarm-settings.json`. An atom that
 * has not been read yet then starts from its initial value; one already
 * read keeps its current value until the next write.
 */
export function removePersistedSetting(key: string): void {
  if (!isTauri()) return;
  cache.delete(key);
  enqueue(`delete ${key}`, async () => {
    await settingsStore.delete(key);
  });
}

/** Records `raw` as the persisted value of `key` and queues the plugin-store write. */
function persist(key: string, raw: unknown): void {
  if (!isTauri()) return;
  cache.set(key, raw);
  enqueue(`write ${key}`, () => settingsStore.set(key, raw));
}

function enqueue(what: string, op: () => Promise<void>): void {
  writeQueue = writeQueue.then(op).catch((err: unknown) => {
    console.warn(`[settings] ${what} failed:`, err);
  });
}

/** Resolves once every write queued so far has been handed to plugin-store. */
export function settingsWritesSettled(): Promise<void> {
  return writeQueue;
}

function load<T>(key: string, initial: T, options: SettingsOptions<T>): T {
  if (!cache.has(key)) return options.migrate?.(initial, readPersistedRaw) ?? initial;
  const result = options.schema.safeParse(cache.get(key));
  if (result.success) return result.data;
  console.warn(`[settings] Ignoring invalid persisted "${key}".`, result.error.issues);
  return initial;
}

/**
 * A primitive-like atom persisted under `key` in `swarm-settings.json`.
 *
 * Its first read (in each jotai store) parses the preloaded value with
 * `options.schema`; after that the atom holds its own value, and every
 * write is queued to plugin-store. Validation happens once per store,
 * so a derived value (e.g. frecency's `Map`) keeps its identity across
 * renders.
 */
export function atomWithSettings<T>(
  key: string,
  initial: T,
  options: SettingsOptions<T>,
): WritableAtom<T, [SettingUpdate<T>], void> {
  registry.set(key, { label: options.label, schema: options.schema });
  const serialize = options.serialize ?? ((value: T): unknown => value);

  // `null` until the first write in this jotai store; then `{ value }`.
  const written = atom<{ readonly value: T } | null>(null);
  written.debugPrivate = true;

  const setting = atom(
    (get) => {
      const own = get(written);
      return own === null ? load(key, initial, options) : own.value;
    },
    (get, set, update: SettingUpdate<T>) => {
      const value =
        typeof update === "function" ? (update as (current: T) => T)(get(setting)) : update;
      set(written, { value });
      persist(key, serialize(value));
    },
  );
  setting.debugLabel = key;
  return setting;
}

/** Test-only: replaces the loaded values. Registered keys stay registered. */
export function resetPersistedSettingsCache(entries: Iterable<[string, unknown]> = []): void {
  cache.clear();
  for (const [key, raw] of entries) cache.set(key, raw);
}
