// ── Persisted-store integrity check ─────────────────
//
// Validates every key the webview persists through tauri-plugin-store
// and deletes the ones that fail, so each falls back to its default.
// `swarm-config.json` is deliberately absent: the Rust side owns that
// file (`read_config`/`write_config`) and validates it on load, and
// opening it through plugin-store would make the plugin overwrite it
// with a stale copy when the app exits (see `#lib/lazy-store`).

import type { LazyStore } from "@tauri-apps/plugin-store";
import { toast } from "sonner";
import * as z from "zod";
import { errorMessage } from "#lib/is-error";
import { settingsStore, snapshotsStore, templatesStore } from "#lib/lazy-store";
import { isTauri } from "#lib/tauri";
import { persistedSettings, removePersistedSetting } from "#store/persisted";
import { SessionTemplateSchema, SnapshotSchema } from "#store/types";

/** Outcome of validating one persisted key (`key: "*"` when the file itself could not be read). */
interface ValidationResult {
  readonly file: string;
  readonly key: string;
  readonly valid: boolean;
  readonly error?: string;
}

/** A key (or key family) in one plugin-store file, with the schema its value must satisfy. */
interface IntegrityRule {
  /** Title Case name shown in the reset toast. */
  readonly label: string;
  readonly matches: (key: string) => boolean;
  readonly schema: z.ZodType;
  /** Removes the key from disk (and from any in-memory copy). */
  readonly reset: (key: string) => Promise<void>;
}

interface IntegrityTarget {
  readonly file: string;
  readonly store: LazyStore;
  readonly rules: () => readonly IntegrityRule[];
}

const deleteFrom =
  (store: LazyStore) =>
  async (key: string): Promise<void> => {
    await store.delete(key);
  };

/** Every plugin-store file the webview persists, with the keys it writes. */
const TARGETS: readonly IntegrityTarget[] = [
  {
    file: "swarm-settings.json",
    store: settingsStore,
    // Built per run: `persistedSettings` fills as the atom modules load.
    rules: () => [
      ...persistedSettings.entries().map(
        ([key, { label, schema }]): IntegrityRule => ({
          label,
          matches: (k) => k === key,
          schema,
          reset: (k) => removePersistedSetting(k),
        }),
      ),
      {
        // `useCustomToolsStore` (#store/custom-tools) validates each
        // entry on load; only a non-array value is unrecoverable.
        label: "Custom Tools",
        matches: (k) => k === "swarm:tools:custom",
        schema: z.array(z.unknown()),
        reset: deleteFrom(settingsStore),
      },
    ],
  },
  {
    file: "swarm-snapshots.json",
    store: snapshotsStore,
    rules: () => [
      {
        label: "Session Snapshots",
        matches: (k) => k.startsWith("swarm:snapshots:"),
        schema: z.array(SnapshotSchema),
        reset: deleteFrom(snapshotsStore),
      },
    ],
  },
  {
    file: "swarm-templates.json",
    store: templatesStore,
    rules: () => [
      {
        label: "Session Templates",
        matches: (k) => k === "swarm:templates",
        schema: z.array(SessionTemplateSchema),
        reset: deleteFrom(templatesStore),
      },
    ],
  },
];

async function validateTarget(
  target: IntegrityTarget,
  resetLabels: Set<string>,
): Promise<ValidationResult[]> {
  const results: ValidationResult[] = [];
  const rules = target.rules();
  for (const [key, value] of await target.store.entries<unknown>()) {
    const rule = rules.find((r) => r.matches(key));
    if (!rule) continue;
    const parsed = rule.schema.safeParse(value);
    if (parsed.success) {
      results.push({ file: target.file, key, valid: true });
      continue;
    }
    try {
      await rule.reset(key);
    } catch (err) {
      results.push({
        file: target.file,
        key,
        valid: false,
        error: `Invalid data could not be deleted: ${errorMessage(err)}`,
      });
      continue;
    }
    resetLabels.add(rule.label);
    results.push({
      file: target.file,
      key,
      valid: false,
      error: `Invalid data was deleted: ${z.prettifyError(parsed.error)}`,
    });
  }
  return results;
}

/**
 * Validates every persisted plugin-store key against its schema and
 * deletes the ones that fail, so each falls back to its default. Shows
 * one toast naming what was reset. Called once after startup (App.tsx)
 * and a no-op outside the desktop shell.
 */
export async function validateStoreData(): Promise<ValidationResult[]> {
  if (!isTauri()) return [];

  const results: ValidationResult[] = [];
  const resetLabels = new Set<string>();
  for (const target of TARGETS) {
    try {
      results.push(...(await validateTarget(target, resetLabels)));
    } catch (err) {
      results.push({
        file: target.file,
        key: "*",
        valid: false,
        error: `Store read failed: ${errorMessage(err)}`,
      });
    }
  }

  const failures = results.filter((r) => !r.valid);
  if (failures.length > 0) {
    console.warn(
      `[store-integrity] ${failures.length} persisted key(s) failed validation:`,
      failures.map((f) => `${f.file} ${f.key}: ${f.error}`),
    );
  }
  if (resetLabels.size > 0) {
    toast.warning("Some Saved Data Was Corrupted And Has Been Reset.", {
      description: [...resetLabels].join(", "),
    });
  }
  return results;
}
