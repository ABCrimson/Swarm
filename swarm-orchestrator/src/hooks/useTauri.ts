import { useEffect, useReducer, useRef, useState } from "react";
import { invoke, listen } from "#lib/tauri";

// ── useInvoke ────────────────────────────────────────

interface UseInvokeResult<T> {
  readonly data: T | undefined;
  readonly loading: boolean;
  readonly error: Error | undefined;
  readonly refetch: () => void;
}

/** Maps raw Tauri IPC errors to user-friendly messages. */
function friendlyIpcError(cmd: string, err: unknown): Error {
  const raw = err instanceof Error ? err.message : String(err);
  const lower = raw.toLowerCase();

  if (lower.includes("not found")) {
    return new Error(`Resource Not Found (${cmd}). It May Have Been Removed.`);
  }
  if (lower.includes("permission") || lower.includes("denied")) {
    return new Error(`Permission Denied For "${cmd}". Check Application Permissions.`);
  }
  if (lower.includes("capacity") || lower.includes("full")) {
    return new Error(`System At Capacity. Cannot Complete "${cmd}" — Try Removing Unused Workers.`);
  }
  if (lower.includes("channel closed") || lower.includes("ipc")) {
    return new Error(`Backend Communication Failed For "${cmd}". The Backend May Be Restarting.`);
  }

  return new Error(`Command "${cmd}" Failed: ${raw}`);
}

function runInvoke<T>(
  cmd: string,
  args: Record<string, unknown> | undefined,
  setData: (d: T) => void,
  setLoading: (l: boolean) => void,
  setError: (e: Error | undefined) => void,
): () => void {
  let cancelled = false;
  setLoading(true);
  setError(undefined);

  void invoke<T>(cmd, args)
    .then((result) => {
      if (!cancelled) {
        setData(result);
        setLoading(false);
      }
    })
    .catch((err: unknown) => {
      if (!cancelled) {
        const friendly = friendlyIpcError(cmd, err);
        console.error(`[useTauri] invoke("${cmd}") failed:`, err);
        setError(friendly);
        setLoading(false);
      }
    });

  return () => {
    cancelled = true;
  };
}

/**
 * Typed React hook wrapping Tauri's `invoke`.
 * Fires immediately and whenever `cmd` or `args` change.
 */
export function useInvoke<T>(cmd: string, args?: Record<string, unknown>): UseInvokeResult<T> {
  const [data, setData] = useState<T | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | undefined>(undefined);
  const [generation, bump] = useReducer((n: number) => n + 1, 0);

  useEffect(() => {
    // generation is referenced to allow refetch to trigger a re-run
    void generation;
    return runInvoke<T>(cmd, args, setData, setLoading, setError);
  }, [cmd, args, generation]);

  const refetch = () => {
    bump();
  };

  return { data, loading, error, refetch };
}

// ── useListen ────────────────────────────────────────

/**
 * Typed React hook wrapping Tauri's `listen`.
 * Sets up the listener on mount and cleans up on unmount.
 */
export function useListen<T>(event: string, handler: (payload: T) => void): void {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;

    const setup = listen<T>(event, (payload) => {
      handlerRef.current(payload);
    });

    void setup
      .then((fn) => {
        if (cancelled) {
          fn();
        } else {
          unlisten = fn;
        }
      })
      .catch((err: unknown) => {
        console.error(`[useListen] Failed to setup listener for "${event}":`, err);
      });

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [event]);
}
