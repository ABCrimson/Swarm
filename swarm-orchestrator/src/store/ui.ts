import { atom } from "jotai";
import { atomWithStorage } from "jotai/utils";

import { commandHistory } from "#lib/command-history";
import { DEFAULT_KEYBINDINGS, type Keybindings } from "#lib/keybindings";
import { settingsStore } from "#lib/lazy-store";
import type { ModelKey } from "#lib/models";
import { isTauri } from "#lib/tauri";

// ── Tauri plugin-store persistence adapter ───────────

const tauriStore = settingsStore;

function createTauriStorage<T>(): {
  getItem: (key: string, initialValue: T) => T;
  setItem: (key: string, value: T) => void;
  removeItem: (key: string) => void;
  subscribe?: (key: string, callback: (value: T) => void, initialValue: T) => () => void;
} {
  return {
    getItem(_key, initialValue) {
      // Always return synchronously to prevent Jotai Suspense.
      // Persisted values are hydrated via subscribe on mount.
      return initialValue;
    },
    setItem(key, value) {
      if (!isTauri()) return;
      void tauriStore.set(key, value).then(() => tauriStore.save());
    },
    removeItem(key) {
      if (!isTauri()) return;
      void tauriStore.delete(key).then(() => tauriStore.save());
    },
    subscribe(key, callback, _initialValue) {
      if (!isTauri()) return () => {};
      // Hydrate from store after mount
      void tauriStore
        .get<T>(key)
        .then((v) => {
          if (v != null) callback(v);
        })
        .catch(() => {});
      return () => {};
    },
  };
}

// ── Panel state (ephemeral) ─────────────────────────

/** Whether the command palette modal is open. */
export const commandPaletteOpenAtom = atom(false);

/** Currently selected worker UUID, or `null` if none selected. */
export const selectedWorkerIdAtom = atom<string | null>(null);

/** Whether the sidebar is in its collapsed (icon-only) state. */
export const sidebarCollapsedAtom = atom(false);

/** Active page identifier for client-side routing. */
export const currentPageAtom = atom<
  "dashboard" | "workers" | "sessions" | "metrics" | "settings" | "logs" | "tools" | "workspace"
>("dashboard");

/** Whether the user prefers reduced motion (mirrors OS setting). */
export const reducedMotionAtom = atom(false);

/** Whether the worker detail panel is expanded. */
export const detailPanelOpenAtom = atom(false);

/** Workers page view mode: dependency graph or flat list. */
export const graphViewAtom = atom<"graph" | "list">("graph");

// ── Persisted via plugin-store integration ───────────

/** Persisted split-pane sizes for the main/detail layout. */
export const paneSizesAtom = atomWithStorage<{ main: number; detail: number }>(
  "swarm:ui:paneSizes",
  { main: 60, detail: 40 },
  createTauriStorage<{ main: number; detail: number }>(),
);

/**
 * Persisted theme preferences (particle background toggle, GPU overlay).
 *
 * `gpuOverlay` defaults `true` to match the status bar's long-standing
 * visible-by-default GPU readout — the Settings toggle and the status
 * bar's Hide/Show GPU button both read/write this same field (the
 * toggle used to be dead: nothing consumed it).
 */
export const themeAtom = atomWithStorage<{ particlesEnabled: boolean; gpuOverlay: boolean }>(
  "swarm:ui:theme",
  { particlesEnabled: true, gpuOverlay: true },
  createTauriStorage<{ particlesEnabled: boolean; gpuOverlay: boolean }>(),
);

// ── App settings (persisted) ────────────────────────

/**
 * Tunable app behavior promoted from hardcoded constants (feedback
 * follow-up). Every field is consumed live — see useAlerts (cooldown),
 * useAutoSnapshot (interval), log-store (retention), ai store
 * (concurrent limit), message-history (LRU cap), and the
 * update-on-launch check in useSettingsBridge.
 */
export interface AppSettings {
  /** Seconds between repeat alerts for the same metric. */
  readonly alertCooldownSec: number;
  /** Minutes between automatic session snapshots. */
  readonly snapshotIntervalMin: number;
  /** Maximum retained log entries before the oldest are evicted. */
  readonly logMaxEntries: number;
  /** Maximum simultaneous AI streams. */
  readonly aiConcurrentLimit: number;
  /** Maximum workers whose chat history is retained (LRU-evicted). */
  readonly historyMaxWorkers: number;
  /** Check for app updates once on launch. */
  readonly updateCheckOnLaunch: boolean;
}

export const DEFAULT_APP_SETTINGS: AppSettings = {
  alertCooldownSec: 30,
  snapshotIntervalMin: 5,
  logMaxEntries: 10_000,
  aiConcurrentLimit: 3,
  historyMaxWorkers: 50,
  updateCheckOnLaunch: false,
};

export const appSettingsAtom = atomWithStorage<AppSettings>(
  "swarm:settings:app",
  DEFAULT_APP_SETTINGS,
  createTauriStorage<AppSettings>(),
);

/** Persisted remappable keyboard shortcuts (see #lib/keybindings). */
export const keybindingsAtom = atomWithStorage<Keybindings>(
  "swarm:settings:keybindings",
  DEFAULT_KEYBINDINGS,
  createTauriStorage<Keybindings>(),
);

// ── AI model selection ──────────────────────────────

/**
 * Persisted Anthropic model selection for AI streaming.
 *
 * Widened to the full `ModelKey` union from `#lib/models` (the shared
 * catalog) so Fable/Mythos are selectable — old persisted "opus" /
 * "sonnet" / "haiku" values remain valid members of the wider union,
 * so no migration is needed for existing installs.
 */
export const selectedModelAtom = atomWithStorage<ModelKey>(
  "swarm:ai:model",
  "sonnet",
  createTauriStorage<ModelKey>(),
);

// ── WebGPU performance atoms (Milestone 0.6.5) ──────

/** Current GPU frame time in milliseconds for the particle system. */
export const gpuFrameTimeAtom = atom(0);

/** Target particle count for the WebGPU compute pipeline. */
export const particleCountAtom = atom(10_000);

// ── Performance overlay (Milestone 0.8.4) ───────────

/** Whether the developer performance overlay is visible. */
export const perfOverlayOpenAtom = atom(false);

// ── Color scheme (dark-only mandate) ─────────────────

/** Color scheme is locked to dark per spec. */
export const colorSchemeAtom = atom<"dark">("dark");

// ── Undo / Redo (Feature 14) ────────────────────────

/** Trigger atom that increments whenever command history changes. */
const undoRedoVersionAtom = atom(0);

let _notifyHistoryChange: () => void = () => {};

// Subscribe the version atom to CommandHistory changes at module load.
commandHistory.subscribe(() => {
  _notifyHistoryChange();
});

/**
 * Mount atom that wires CommandHistory subscriber notifications
 * into the Jotai dependency graph. Must be used in a component
 * via `useAtom(undoRedoMountAtom)` to activate.
 */
export const undoRedoMountAtom = atom(null, (_get, set) => {
  _notifyHistoryChange = () => {
    set(undoRedoVersionAtom, (v) => v + 1);
  };
});
undoRedoMountAtom.onMount = (setSelf) => {
  setSelf();
};

/** Whether the command history has commands available to undo. */
export const undoAvailableAtom = atom((get) => {
  get(undoRedoVersionAtom);
  return commandHistory.canUndo();
});

/** Whether the command history has commands available to redo. */
export const redoAvailableAtom = atom((get) => {
  get(undoRedoVersionAtom);
  return commandHistory.canRedo();
});

// ── Derived atoms ────────────────────────────────────

/** Derived atom resolving the currently selected worker ID. */
export const selectedWorkerAtom = atom((get) => {
  return get(selectedWorkerIdAtom);
});
