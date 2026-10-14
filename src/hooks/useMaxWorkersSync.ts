// ── useMaxWorkersSync ───────────────────────────────
// The Settings page's Worker Registry Cap: reads the saved cap once and
// pushes edits through the same acknowledged one-slot sync as the agent
// concurrency cap (#lib/acknowledged-sync). Two commits inside one config
// write therefore reach `set_max_workers` one after the other, never
// concurrently, and the field ends on the value the server applied.

import { useAtomValue, useStore } from "jotai";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import * as z from "zod";
import { createAcknowledgedSync } from "#lib/acknowledged-sync";
import { readConfig, setMaxWorkers } from "#lib/tauri";
import { maxWorkersAtom, maxWorkersSyncAtom } from "#store/ui";

/** Identifies the failure toast, so a later push or a late resolve can dismiss it. */
const MAX_WORKERS_TOAST_ID = "max-workers-sync";

/**
 * The shown cap, the sync state (for the field's feedback) and the commit
 * handler. The sync object lives in `useState` because its bookkeeping is
 * read from timers and promise callbacks, not from render.
 */
export function useMaxWorkersSync() {
  const store = useStore();
  const shown = useAtomValue(maxWorkersAtom);
  const sync = useAtomValue(maxWorkersSyncAtom);
  const [maxWorkersSync] = useState(() =>
    createAcknowledgedSync({
      initial: store.get(maxWorkersAtom),
      call: setMaxWorkers,
      show: (cap) => store.set(maxWorkersAtom, cap),
      getStatus: () => store.get(maxWorkersSyncAtom),
      setStatus: (status) => store.set(maxWorkersSyncAtom, status),
      logPrefix: "[settings] set_max_workers",
      failureTitle: "Failed To Update Worker Registry Cap",
      toastId: MAX_WORKERS_TOAST_ID,
      onApplied: (applied) => toast.success(`Worker Registry Cap Set To ${applied}`),
    }),
  );

  useEffect(() => {
    let cancelled = false;
    readConfig("max_workers", z.int().min(1))
      .then((saved) => {
        // A commit made while the read was in flight is newer than the saved value.
        if (!cancelled && saved !== null && !maxWorkersSync.touched) maxWorkersSync.adopt(saved);
      })
      .catch((err: unknown) => {
        // Unset resolves null; a rejection means the backend could not answer — keep the default.
        console.warn("[settings] Could not read the saved worker registry cap:", err);
      });
    return () => {
      cancelled = true;
      maxWorkersSync.cancelTimers();
    };
  }, [maxWorkersSync]);

  // `push`, not `apply`: until the saved cap has loaded the shown value is a guess,
  // so a commit equal to it must still reach the backend.
  return { shown, sync, commit: maxWorkersSync.push };
}
