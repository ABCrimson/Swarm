import { useEffect } from "react";
import { onEvent } from "#lib/event-bus";
import type { LogLevel } from "#lib/log-store";
import { useLogStore } from "#lib/log-store";

const KNOWN_LEVELS: ReadonlySet<string> = new Set<LogLevel>(["debug", "info", "warn", "error"]);

/**
 * Global `system_log` event subscription hook — the first live
 * consumer of the backend's `system_log` envelope. Before this, the
 * event type existed and was documented ("Bridges backend log
 * messages to the frontend console") but nothing ever emitted it in
 * the shipped app, and nothing consumed it: `useLogStore`/`LogViewer`
 * (the Logs page) rendered only test-seeded data. The worktree
 * isolation startup probe (`swarm-desktop`'s `setup()`) is the first
 * real emitter (a `level: "warn"` envelope when git is
 * missing/too-old); this hook is the minimal fix that actually
 * surfaces it, closing the pre-existing zero-consumer hole rather than
 * building new UI beyond what `LogViewer` already renders.
 *
 * Must be called exactly once at the app root level, alongside
 * `useWorkerEvents`.
 */
export function useSystemLogEvents(): void {
  useEffect(() => {
    const { addEntry } = useLogStore.getState();

    const off = onEvent("system_log", (e) => {
      const p = e.payload as { level: string; message: string; target: string; timestamp: number };
      const level: LogLevel = (KNOWN_LEVELS.has(p.level) ? p.level : "info") as LogLevel;
      addEntry({
        timestamp: p.timestamp,
        level,
        source: "backend",
        message: p.message,
        metadata: { target: p.target },
      });
    });

    return off;
  }, []);
}
