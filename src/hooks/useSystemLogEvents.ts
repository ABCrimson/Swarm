import { useEffect } from "react";
import * as z from "zod";
import { onEvent } from "#lib/event-bus";
import { LOG_LEVELS, useLogStore } from "#lib/log-store";

/** An unknown backend level is shown as `info` rather than dropped. */
const LevelSchema = z.enum(LOG_LEVELS).catch("info");

/**
 * Global `system_log` subscription: every backend log envelope (e.g. the
 * worktree-isolation startup probe's warning when git is missing or too
 * old) becomes a `backend` entry in the Logs page's store.
 *
 * `#lib/event-bus` has already validated the payload against the
 * backend's `SystemLogPayload`; this hook only maps the level.
 *
 * Must be called exactly once at the app root level, alongside
 * `useWorkerEvents`.
 */
export function useSystemLogEvents(): void {
  useEffect(() => {
    const { addEntry } = useLogStore.getState();

    return onEvent("system_log", ({ payload }) =>
      addEntry({
        timestamp: payload.timestamp,
        level: LevelSchema.parse(payload.level),
        source: "backend",
        message: payload.message,
        metadata: { target: payload.target },
      }),
    );
  }, []);
}
