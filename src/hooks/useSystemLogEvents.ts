import { useEffect } from "react";
import * as z from "zod";
import { onEvent } from "#lib/event-bus";
import { LOG_LEVELS, useLogStore } from "#lib/log-store";

/**
 * The backend's `SystemLogPayload` (swarm-core `events/emitter.rs`),
 * validated at this seam. An unknown level is shown as `info` rather
 * than dropped; a payload without a message is dropped.
 */
const SystemLogPayloadSchema = z.object({
  level: z.enum(LOG_LEVELS).catch("info"),
  message: z.string(),
  target: z.string().optional(),
  /** Unix milliseconds; the envelope's `ts` stands in when absent. */
  timestamp: z.number().optional(),
});

/**
 * Global `system_log` subscription: every backend log envelope (e.g. the
 * worktree-isolation startup probe's warning when git is missing or too
 * old) becomes a `backend` entry in the Logs page's store.
 *
 * Must be called exactly once at the app root level, alongside
 * `useWorkerEvents`.
 */
export function useSystemLogEvents(): void {
  useEffect(() => {
    const { addEntry } = useLogStore.getState();

    return onEvent("system_log", (e) => {
      const parsed = SystemLogPayloadSchema.safeParse(e.payload);
      if (!parsed.success) {
        console.warn("[logs] Dropped a malformed system_log payload:", parsed.error.issues);
        return;
      }
      const { level, message, target, timestamp } = parsed.data;
      addEntry({
        timestamp: timestamp ?? e.ts,
        level,
        source: "backend",
        message,
        ...(target !== undefined && { metadata: { target } }),
      });
    });
  }, []);
}
