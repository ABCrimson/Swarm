/**
 * Persisted registry of user-authored tools from the Tools page builder.
 * Hydrates once from the Tauri settings store at module load; every
 * mutation writes the whole list back. Consumed by the Tools page
 * (display/edit) and the AI request path (`#lib/tools`: schemas sent to
 * Claude, execution on `tool_use`).
 *
 * @module custom-tools-store
 */

import { create } from "zustand";
import { type CustomToolDef, parsePersistedCustomTools } from "#lib/custom-tools";
import { settingsStore } from "#lib/lazy-store";
import { isTauri } from "#lib/tauri";

const STORE_KEY = "swarm:tools:custom";

interface CustomToolsState {
  readonly customTools: readonly CustomToolDef[];
}

interface CustomToolsActions {
  /** Inserts a tool, or replaces the one with the same `id`. */
  readonly saveTool: (tool: CustomToolDef) => void;
  readonly deleteTool: (id: string) => void;
}

function persist(tools: readonly CustomToolDef[]): void {
  if (!isTauri()) return;
  // save() writes the file immediately and rejects on an I/O error (disk
  // full, unwritable app data dir); report it instead of leaving an
  // unhandled rejection.
  void settingsStore
    .set(STORE_KEY, tools)
    .then(() => settingsStore.save())
    .catch((err: unknown) => {
      console.error("[custom-tools] Saving custom tools failed:", err);
    });
}

export const useCustomToolsStore = create<CustomToolsState & CustomToolsActions>()(() => ({
  customTools: [],

  saveTool(tool) {
    mutate((tools) =>
      tools.some((t) => t.id === tool.id)
        ? tools.map((t) => (t.id === tool.id ? tool : t))
        : [...tools, tool],
    );
  },

  deleteTool(id) {
    mutate((tools) => tools.filter((t) => t.id !== id));
  },
}));

/**
 * Settles once the persisted list has been loaded (or skipped outside
 * Tauri). Never rejects. Mutations wait for it, so a save made in the
 * first moments after launch can never be overwritten by — or persist
 * over — the collection still being read from disk.
 */
const hydrated: Promise<void> = isTauri()
  ? settingsStore
      .get<unknown>(STORE_KEY)
      .then((raw) => {
        // Entries are validated individually — a corrupted or
        // invalid-named entry drops only itself (see parsePersistedCustomTools).
        useCustomToolsStore.setState({ customTools: parsePersistedCustomTools(raw) });
      })
      .catch(() => {})
  : Promise.resolve();

/** Applies a list transform once hydration has settled, then persists the result. */
function mutate(next: (tools: readonly CustomToolDef[]) => readonly CustomToolDef[]): void {
  void hydrated.then(() => {
    const tools = next(useCustomToolsStore.getState().customTools);
    useCustomToolsStore.setState({ customTools: tools });
    persist(tools);
  });
}

/** Resolves once the custom tools have been loaded from disk (tests await it after mutating). */
export function customToolsReady(): Promise<void> {
  return hydrated;
}
