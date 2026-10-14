import { atom } from "jotai";
import * as z from "zod";
import type { CapSync } from "#lib/acknowledged-sync";
import { DEFAULT_KEYBINDINGS, type Keybindings } from "#lib/keybindings";
import { MODEL_KEYS, type ModelKey } from "#lib/models";
import { atomWithSettings } from "#store/persisted";

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

const reducedMotionQuery = globalThis.matchMedia?.("(prefers-reduced-motion: reduce)");

/**
 * Whether the user prefers reduced motion. Starts from the OS setting at
 * module load, so the very first frame already honors it, and follows
 * OS changes for as long as any component reads it.
 */
export const reducedMotionAtom = atom(reducedMotionQuery?.matches ?? false);
reducedMotionAtom.onMount = (set) => {
  if (!reducedMotionQuery) return;
  set(reducedMotionQuery.matches);
  const onChange = (e: MediaQueryListEvent): void => set(e.matches);
  reducedMotionQuery.addEventListener("change", onChange);
  return () => reducedMotionQuery.removeEventListener("change", onChange);
};

/** Whether the worker detail panel is expanded. */
export const detailPanelOpenAtom = atom(false);

/** Workers page view mode: dependency graph or flat list. */
export const graphViewAtom = atom<"graph" | "list">("graph");

/**
 * Target seq for the causality inspector overlay (`CausalityPanel`),
 * or `null` when closed. Opened from a measured edge click
 * (`WorkerGraph.tsx`'s `handleEdgeClick`) or from `WorkerDetail`'s
 * "View Causality" action — both just set this to the seq of the
 * measured event whose causal chain to walk backward from. A shared
 * atom (rather than component-local state) is what lets both entry
 * points drive one overlay instance rendered once, at the `Workers`
 * page level.
 */
export const causalityInspectorAtom = atom<{ readonly startSeq: number } | null>(null);

// ── Backend cap sync (ephemeral) ────────────────────

/**
 * Where the backend's copy of the agent concurrency cap stands relative
 * to the Settings field (`CapSync` in #lib/acknowledged-sync describes
 * the states). Written by `useSettingsBridge`, read by the Settings page.
 */
export type AgentConcurrencySync = CapSync;

export const agentConcurrencySyncAtom = atom<AgentConcurrencySync>({ status: "idle" });

/** The Worker Registry Cap field's sync state, written by `useSettingsBridge`. */
export const maxWorkersSyncAtom = atom<CapSync>({ status: "idle" });

/** What the backend allows for the worker registry until `max_workers` is set. */
export const DEFAULT_MAX_WORKERS = 64;

/** The Worker Registry Cap the Settings field shows (the last value the backend acknowledged). */
export const maxWorkersAtom = atom(DEFAULT_MAX_WORKERS);

// ── Persisted (swarm-settings.json, see #store/persisted) ──

const Percent = z.number().min(0).max(100);

/** Persisted split-pane sizes (percentages) for the main/detail layout. */
export const paneSizesAtom = atomWithSettings(
  "swarm:ui:paneSizes",
  { main: 60, detail: 40 },
  { label: "Pane Sizes", schema: z.object({ main: Percent, detail: Percent }) },
);

interface ThemePrefs {
  readonly particlesEnabled: boolean;
  readonly gpuOverlay: boolean;
}

/**
 * Persisted theme preferences (particle background toggle, GPU overlay),
 * stored under a v2 key.
 *
 * `gpuOverlay` defaults `true`, so the status bar's GPU readout is visible
 * by default; the Settings toggle and the status bar's Hide/Show GPU
 * button both read and write this field. The legacy `swarm:ui:theme` key
 * stored a `gpuOverlay` that was never honoured, so `migrate` carries
 * over `particlesEnabled` alone and `gpuOverlay` takes the `true` default.
 */
export const themeAtom = atomWithSettings<ThemePrefs>(
  "swarm:ui:theme2",
  { particlesEnabled: true, gpuOverlay: true },
  {
    label: "Theme",
    schema: z.object({
      particlesEnabled: z.boolean().catch(true),
      gpuOverlay: z.boolean().catch(true),
    }),
    migrate(initial, readRaw) {
      const legacy = z
        .object({ particlesEnabled: z.boolean() })
        .safeParse(readRaw("swarm:ui:theme"));
      return legacy.success ? { ...initial, ...legacy.data } : undefined;
    },
  },
);

// ── App settings (persisted) ────────────────────────

/**
 * Tunable app behavior. Every field is consumed live — see useAlerts
 * (cooldown, native notifications), useAutoSnapshot (interval), and
 * useSettingsBridge, which pushes the rest into the logs store (retention),
 * the ai store and backend agent concurrency (concurrent limit), and
 * message-history (LRU cap), and runs the update-on-launch check.
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
  /** Also send native OS notifications when an alert fires. */
  readonly nativeAlertNotifications: boolean;
}

export const DEFAULT_APP_SETTINGS: AppSettings = {
  alertCooldownSec: 30,
  snapshotIntervalMin: 5,
  logMaxEntries: 10_000,
  aiConcurrentLimit: 3,
  historyMaxWorkers: 50,
  updateCheckOnLaunch: false,
  nativeAlertNotifications: false,
};

/** Bounds of the Settings page's AI Concurrent Stream Limit field; the persisted value is clamped to them. */
export const AI_CONCURRENT_LIMIT_MIN = 1;
export const AI_CONCURRENT_LIMIT_MAX = 10;

/** A whole number clamped to the Settings page's `[min, max]`; anything that is not a finite number becomes `fallback`. */
function boundedInt(min: number, max: number, fallback: number) {
  return z
    .number()
    .transform((n) => Math.round(Math.min(max, Math.max(min, n))))
    .catch(fallback);
}

/**
 * Field by field, so one corrupt or missing field (a settings object
 * written by an older version lacks newer keys) falls back to its own
 * default without discarding the rest. Bounds match the Settings page
 * inputs.
 */
const AppSettingsSchema = z.object({
  alertCooldownSec: boundedInt(5, 600, DEFAULT_APP_SETTINGS.alertCooldownSec),
  snapshotIntervalMin: boundedInt(1, 120, DEFAULT_APP_SETTINGS.snapshotIntervalMin),
  logMaxEntries: boundedInt(100, 100_000, DEFAULT_APP_SETTINGS.logMaxEntries),
  aiConcurrentLimit: boundedInt(
    AI_CONCURRENT_LIMIT_MIN,
    AI_CONCURRENT_LIMIT_MAX,
    DEFAULT_APP_SETTINGS.aiConcurrentLimit,
  ),
  historyMaxWorkers: boundedInt(5, 200, DEFAULT_APP_SETTINGS.historyMaxWorkers),
  updateCheckOnLaunch: z.boolean().catch(DEFAULT_APP_SETTINGS.updateCheckOnLaunch),
  nativeAlertNotifications: z.boolean().catch(DEFAULT_APP_SETTINGS.nativeAlertNotifications),
});

export const appSettingsAtom = atomWithSettings<AppSettings>(
  "swarm:settings:app",
  DEFAULT_APP_SETTINGS,
  { label: "App Settings", schema: AppSettingsSchema },
);

/** Persisted remappable keyboard shortcuts (see #lib/keybindings). */
export const keybindingsAtom = atomWithSettings<Keybindings>(
  "swarm:settings:keybindings",
  DEFAULT_KEYBINDINGS,
  {
    label: "Keybindings",
    schema: z.object({
      commandPalette: z.string().min(1).catch(DEFAULT_KEYBINDINGS.commandPalette),
      graphToggle: z.string().min(1).catch(DEFAULT_KEYBINDINGS.graphToggle),
      perfOverlay: z.string().min(1).catch(DEFAULT_KEYBINDINGS.perfOverlay),
    }),
  },
);

// ── AI model selection ──────────────────────────────

/**
 * Persisted Anthropic model selection for AI streaming. A persisted key
 * that is no longer in the `#lib/models` catalog falls back to the
 * default instead of reaching the request path.
 */
export const selectedModelAtom = atomWithSettings<ModelKey>("swarm:ai:model", "sonnet", {
  label: "AI Model",
  schema: z.enum(MODEL_KEYS).catch("sonnet"),
});

// ── WebGPU performance ──────────────────────────────

/** Current GPU frame time in milliseconds for the particle system. */
export const gpuFrameTimeAtom = atom(0);

/** Target particle count for the WebGPU compute pipeline. */
export const particleCountAtom = atom(10_000);

// ── Performance overlay ─────────────────────────────

/** Whether the developer performance overlay is visible. */
export const perfOverlayOpenAtom = atom(false);
