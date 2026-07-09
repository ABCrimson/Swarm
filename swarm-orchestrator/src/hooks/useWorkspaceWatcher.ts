import type { UnwatchFn } from "@tauri-apps/plugin-fs";
import { watch } from "@tauri-apps/plugin-fs";
import { useEffect, useRef } from "react";

import { invoke } from "#lib/tauri";
import { useSessionStore } from "#store/sessions";

/** Patterns to ignore during file watching. */
const IGNORE_PATTERNS = [".git", "node_modules", "target", "dist", ".next", ".turbo"];

/** Debounce delay for file change events (ms). */
const DEBOUNCE_MS = 300;

interface UseWorkspaceWatcherOptions {
  /** Project directory path to watch. */
  readonly path: string | null;
  /** Whether workspace watching is enabled. */
  readonly enabled: boolean;
  /** Whether to auto-inject instructions to active workers on file change. */
  readonly autoInject?: boolean;
}

/**
 * Watches the workspace directory for file changes using @tauri-apps/plugin-fs watch().
 * Debounces events and optionally injects instructions to active workers.
 *
 * Must be called at an appropriate component level (e.g., settings-dependent provider).
 * Cleans up the watcher on unmount.
 */
export function useWorkspaceWatcher({
  path,
  enabled,
  autoInject = false,
}: UseWorkspaceWatcherOptions): void {
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const unwatchRef = useRef<UnwatchFn | null>(null);

  useEffect(() => {
    if (!enabled || !path) return;

    let cancelled = false;

    const setup = async () => {
      try {
        const unwatch = await watch(
          path,
          (event) => {
            if (cancelled) return;

            // Extract changed paths from the event
            const paths = Array.isArray(event.paths) ? event.paths : [];

            // Filter out ignored patterns
            const relevantPaths = paths.filter((p) => {
              const normalized = p.replaceAll("\\", "/");
              return !IGNORE_PATTERNS.some(
                (pattern) =>
                  normalized.includes(`/${pattern}/`) || normalized.includes(`/${pattern}`),
              );
            });

            if (relevantPaths.length === 0) return;

            // Debounce
            if (debounceRef.current !== null) {
              clearTimeout(debounceRef.current);
            }

            debounceRef.current = setTimeout(() => {
              if (cancelled) return;
              handleFileChange(relevantPaths, autoInject);
            }, DEBOUNCE_MS);
          },
          { recursive: true },
        );

        if (!cancelled) {
          unwatchRef.current = unwatch;
        } else {
          unwatch();
        }
      } catch {
        // Watch may fail if path doesn't exist — silently ignore
      }
    };

    void setup();

    return () => {
      cancelled = true;

      if (debounceRef.current !== null) {
        clearTimeout(debounceRef.current);
      }

      if (unwatchRef.current) {
        unwatchRef.current();
        unwatchRef.current = null;
      }
    };
  }, [path, enabled, autoInject]);
}

/**
 * Handle file change events — optionally inject instructions to active workers.
 */
function handleFileChange(changedPaths: string[], autoInject: boolean): void {
  if (!autoInject) return;

  const { activeSessionId, sessions } = useSessionStore.getState();
  if (!activeSessionId) return;

  const session = sessions.get(activeSessionId);
  if (!session) return;

  const fileList = changedPaths
    .map((p) => p.replaceAll("\\", "/").split("/").pop() ?? p)
    .join(", ");

  const instruction = `[Workspace Update] The following files were modified: ${fileList}`;

  // Inject instruction to each active worker in the session
  for (const workerId of session.workerIds) {
    invoke("worker_input", { id: workerId, data: instruction }).catch(() => {
      // Silently fail — worker may not be running
    });
  }
}
