// ── Custom Tools Store ──────────────────────────────
// Persisted registry of user-authored tools from the Tools page
// builder. Hydrates once from the Tauri settings store; every mutation
// writes back. Consumed by the Tools page (display/edit) and the AI
// request path (schemas sent to Claude + execution on tool_use).

import { create } from "zustand";
import { type CustomToolDef, parsePersistedCustomTools } from "#lib/custom-tools";
import { settingsStore } from "#lib/lazy-store";
import { isTauri } from "#lib/tauri";

const STORE_KEY = "swarm:tools:custom";

interface CustomToolsState {
  readonly customTools: readonly CustomToolDef[];
  /** True once hydration from the settings store has completed (or been skipped outside Tauri). */
  readonly hydrated: boolean;
}

interface CustomToolsActions {
  readonly saveTool: (tool: CustomToolDef) => void;
  readonly deleteTool: (id: string) => void;
}

function persist(tools: readonly CustomToolDef[]): void {
  if (!isTauri()) return;
  void settingsStore.set(STORE_KEY, tools).then(() => settingsStore.save());
}

export const useCustomToolsStore = create<CustomToolsState & CustomToolsActions>()((set) => ({
  customTools: [],
  hydrated: false,

  saveTool(tool) {
    set((s) => {
      const existing = s.customTools.findIndex((t) => t.id === tool.id);
      const next =
        existing >= 0
          ? s.customTools.map((t, i) => (i === existing ? tool : t))
          : [...s.customTools, tool];
      persist(next);
      return { customTools: next };
    });
  },

  deleteTool(id) {
    set((s) => {
      const next = s.customTools.filter((t) => t.id !== id);
      persist(next);
      return { customTools: next };
    });
  },
}));

// Hydrate once at module init. Entries are validated individually — a
// corrupted or invalid-named entry drops only itself, not the whole
// collection (see parsePersistedCustomTools).
if (isTauri()) {
  void settingsStore
    .get<unknown>(STORE_KEY)
    .then((raw) => {
      useCustomToolsStore.setState({
        customTools: parsePersistedCustomTools(raw),
        hydrated: true,
      });
    })
    .catch(() => {
      useCustomToolsStore.setState({ hydrated: true });
    });
} else {
  useCustomToolsStore.setState({ hydrated: true });
}
