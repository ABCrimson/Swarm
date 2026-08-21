import { useEffect } from "react";
import { onEvent } from "#lib/event-bus";
import { useProvenanceStore } from "#store/provenance";

/**
 * Global provenance event subscription hook — mirrors `useWorkerEvents`'s
 * shape and must be mounted exactly once, beside it, at the app root
 * (see `App.tsx`).
 *
 * Unlike `useWorkerEvents`'s per-type subscriptions, provenance can be
 * derived from ANY stamped envelope (not a fixed list of types), so this
 * is a single wildcard subscription that forwards every event straight
 * to `useProvenanceStore.ingestEvent` — the store owns all derivation
 * logic (edge kind/target resolution, collapsing, the bySeq ring, and
 * `file_written` badge counts). This hook is pure wiring.
 */
export function useProvenanceEvents(): void {
  useEffect(() => {
    const { ingestEvent } = useProvenanceStore.getState();
    return onEvent("*", ingestEvent);
  }, []);
}
