import { load } from "@tauri-apps/plugin-store";
import * as z from "zod/v4";
import { isTauri } from "#lib/tauri";
import { toast } from "sonner";
import { SessionSchema, SessionTemplateSchema, SnapshotSchema } from "#store/types";

/** Schema for the full sessions store. */
const SessionsStoreSchema = z.array(SessionSchema);

/** Schema for config store. */
const ConfigStoreSchema = z.record(z.string(), z.unknown());

/** Schema for UI store. */
const UiStoreSchema = z.object({
  paneSizes: z
    .object({
      main: z.number(),
      detail: z.number(),
    })
    .optional(),
  theme: z
    .object({
      particlesEnabled: z.boolean(),
      gpuOverlay: z.boolean(),
    })
    .optional(),
  model: z.enum(["opus", "sonnet", "haiku"]).optional(),
});

/** Schema for snapshots (per-session). */
const SnapshotsStoreSchema = z.array(SnapshotSchema);

/** Schema for templates store. */
const TemplatesStoreSchema = z.array(SessionTemplateSchema);

/** Result of validating a single store key against its Zod schema. */
interface ValidationResult {
  key: string;
  valid: boolean;
  error?: string;
}

/**
 * Validate all stored data against Zod v4 schemas.
 * On corrupt data: logs warning, resets to defaults, shows Sonner toast.
 *
 * Should be called on app startup before hydrating stores.
 */
export async function validateStoreData(): Promise<ValidationResult[]> {
  if (!isTauri()) return [];

  const results: ValidationResult[] = [];

  // Validate sessions
  try {
    const sessionsStore = await load("swarm-sessions.json", { defaults: {}, autoSave: false });
    const sessionsData = await sessionsStore.get<unknown[]>("swarm:sessions");

    if (sessionsData !== null && sessionsData !== undefined) {
      const parsed = SessionsStoreSchema.safeParse(sessionsData);
      if (!parsed.success) {
        console.warn("[store-integrity] Corrupt sessions data, resetting to defaults");
        await sessionsStore.set("swarm:sessions", []);
        await sessionsStore.save();
        results.push({
          key: "swarm:sessions",
          valid: false,
          error: "Data did not match SessionSchema — reset to empty array",
        });
        toast.warning("Session data was corrupted and has been reset.");
      } else {
        results.push({ key: "swarm:sessions", valid: true });
      }
    } else {
      results.push({ key: "swarm:sessions", valid: true });
    }
  } catch (err) {
    results.push({
      key: "swarm:sessions",
      valid: false,
      error: `Store read failed: ${err instanceof Error ? err.message : String(err)}`,
    });
  }

  // Validate config
  try {
    const configStore = await load("swarm-config.json", { defaults: {}, autoSave: false });
    const configData = await configStore.get<unknown>("swarm:config");

    if (configData !== null && configData !== undefined) {
      const parsed = ConfigStoreSchema.safeParse(configData);
      if (!parsed.success) {
        console.warn("[store-integrity] Corrupt config data, resetting to defaults");
        await configStore.set("swarm:config", {});
        await configStore.save();
        results.push({
          key: "swarm:config",
          valid: false,
          error: "Data did not match ConfigSchema — reset to empty object",
        });
        toast.warning("Configuration data was corrupted and has been reset.");
      } else {
        results.push({ key: "swarm:config", valid: true });
      }
    } else {
      results.push({ key: "swarm:config", valid: true });
    }
  } catch (err) {
    results.push({
      key: "swarm:config",
      valid: false,
      error: `Store read failed: ${err instanceof Error ? err.message : String(err)}`,
    });
  }

  // Validate UI settings
  try {
    const uiStore = await load("swarm-ui.json", { defaults: {}, autoSave: false });
    const uiData = await uiStore.get<unknown>("swarm:ui");

    if (uiData !== null && uiData !== undefined) {
      const parsed = UiStoreSchema.safeParse(uiData);
      if (!parsed.success) {
        console.warn("[store-integrity] Corrupt UI data, resetting to defaults");
        await uiStore.set("swarm:ui", {});
        await uiStore.save();
        results.push({
          key: "swarm:ui",
          valid: false,
          error: "Data did not match UiSchema — reset to defaults",
        });
        toast.warning("UI settings were corrupted and have been reset.");
      } else {
        results.push({ key: "swarm:ui", valid: true });
      }
    } else {
      results.push({ key: "swarm:ui", valid: true });
    }
  } catch (err) {
    results.push({
      key: "swarm:ui",
      valid: false,
      error: `Store read failed: ${err instanceof Error ? err.message : String(err)}`,
    });
  }

  // Validate snapshots
  try {
    const snapshotsStore = await load("swarm-snapshots.json", { defaults: {}, autoSave: false });
    const entries = await snapshotsStore.entries<unknown[]>();

    for (const [key, value] of entries) {
      if (key.startsWith("swarm:snapshots:")) {
        const parsed = SnapshotsStoreSchema.safeParse(value);
        if (!parsed.success) {
          console.warn(`[store-integrity] Corrupt snapshots for ${key}, resetting`);
          await snapshotsStore.set(key, []);
          results.push({
            key,
            valid: false,
            error: "Snapshot data corrupted — reset to empty array",
          });
        } else {
          results.push({ key, valid: true });
        }
      }
    }
    await snapshotsStore.save();
  } catch (err) {
    results.push({
      key: "swarm:snapshots",
      valid: false,
      error: `Store read failed: ${err instanceof Error ? err.message : String(err)}`,
    });
  }

  // Validate templates
  try {
    const templatesStore = await load("swarm-templates.json", { defaults: {}, autoSave: false });
    const templatesData = await templatesStore.get<unknown[]>("swarm:templates");

    if (templatesData !== null && templatesData !== undefined) {
      const parsed = TemplatesStoreSchema.safeParse(templatesData);
      if (!parsed.success) {
        console.warn("[store-integrity] Corrupt templates data, resetting to defaults");
        await templatesStore.set("swarm:templates", []);
        await templatesStore.save();
        results.push({
          key: "swarm:templates",
          valid: false,
          error: "Template data corrupted — reset to empty array",
        });
        toast.warning("Template data was corrupted and has been reset.");
      } else {
        results.push({ key: "swarm:templates", valid: true });
      }
    } else {
      results.push({ key: "swarm:templates", valid: true });
    }
  } catch (err) {
    results.push({
      key: "swarm:templates",
      valid: false,
      error: `Store read failed: ${err instanceof Error ? err.message : String(err)}`,
    });
  }

  // Log results summary
  const failures = results.filter((r) => !r.valid);
  if (failures.length > 0) {
    console.warn(
      `[store-integrity] ${failures.length} store(s) had integrity issues:`,
      failures.map((f) => `${f.key}: ${f.error}`),
    );
  } else {
    console.info("[store-integrity] All stores validated successfully");
  }

  return results;
}
