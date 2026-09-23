import type { Edge, Node } from "@xyflow/react";
import type { ElkExtendedEdge, ElkNode } from "elkjs";
import ELK from "elkjs/lib/elk-api.js";
import { useEffect, useRef, useState } from "react";

interface ElkLayoutReturn {
  readonly layoutedNodes: Node[];
  readonly layoutedEdges: Edge[];
  readonly isLayouting: boolean;
  /** Set when the layout worker fails to start or errors out; cleared on the next `runLayout()`. */
  readonly error: string | null;
  readonly runLayout: () => void;
}

const NODE_WIDTH = 220;
const NODE_HEIGHT = 100;

const DEFAULT_LAYOUT_OPTIONS: Record<string, string> = {
  "elk.algorithm": "layered",
  "elk.direction": "DOWN",
  "elk.spacing.nodeNode": "40",
  "elk.spacing.edgeNode": "60",
  "elk.layered.spacing.nodeNodeBetweenLayers": "60",
  "elk.layered.crossingMinimization.strategy": "LAYER_SWEEP",
};

/** Shown when the ELK layout worker fails to start, crashes, or sends an unreadable message. */
const LAYOUT_ENGINE_ERROR = "Layout Engine Failed To Start";

/** Shown when `elk.layout()` neither resolves nor rejects within {@link LAYOUT_TIMEOUT_MS} — the worker is presumed hung. */
const LAYOUT_TIMEOUT_ERROR = "Layout Engine Timed Out";

/** How long to wait for `elk.layout()` to settle before treating it as a hung/failed layout. */
const LAYOUT_TIMEOUT_MS = 10_000;

/**
 * Generates a stable fingerprint of the topology for deep comparison.
 * Only re-layouts when the node set or edge connections actually change.
 */
function topologyFingerprint(nodes: Node[], edges: Edge[]): string {
  const nodeIds = nodes
    .map((n) => n.id)
    .toSorted()
    .join(",");
  const edgeIds = edges
    .map((e) => `${e.source}->${e.target}`)
    .toSorted()
    .join(",");
  return `${nodeIds}|${edgeIds}`;
}

/**
 * Computes an ELK graph layout via a dedicated Web Worker.
 *
 * Constructs elkjs's own `ELK` class on the main thread with a
 * `workerFactory` that spawns exactly one dedicated, non-nested Worker
 * (`src/workers/elk.worker.ts`, which itself *is* elkjs's worker script —
 * see that file's header for why). elkjs drives its register/layout
 * protocol over that single worker and resolves/rejects `.layout()`
 * accordingly; a `worker.onerror`/`onmessageerror` failure is surfaced
 * through the `error` return value instead of leaving `isLayouting` stuck.
 * A {@link LAYOUT_TIMEOUT_MS} watchdog covers the remaining failure mode —
 * a worker that neither errors nor ever responds — by racing `.layout()`
 * against a timer and surfacing the same kind of `error` state if it wins;
 * the watchdog timer is always cleared (success, any failure path, or
 * unmount) so it never fires — and never leaks — after the fact.
 * Overlapping layouts are serialized by a run token: only the most recent
 * `runLayout()` invocation may commit state, clear the watchdog, or stamp
 * an error — a superseded run's late settlement is ignored outright.
 *
 * Automatically re-runs layout when the topology fingerprint changes.
 * Node positions are applied directly (synchronously) in the `.then()`
 * handler as a single batched React state commit. This used to be deferred
 * via `requestAnimationFrame`, but rAF is not guaranteed to fire — Chromium
 * suppresses it for occluded/minimized windows (and under CDP evaluation
 * pressure) — and the layout watchdog is cleared before that deferred
 * callback runs, so a suppressed frame left `isLayouting` stuck `true`
 * forever with no recovery path. A single batched commit doesn't need frame
 * alignment, so the commit must not depend on frame production at all.
 *
 * @param nodes - React Flow nodes to position.
 * @param edges - React Flow edges defining connections.
 * @returns Layouted nodes/edges, loading/error state, and manual `runLayout` trigger.
 */
export function useElkLayout(nodes: Node[], edges: Edge[]): ElkLayoutReturn {
  const [layoutedNodes, setLayoutedNodes] = useState<Node[]>(nodes);
  const [layoutedEdges, setLayoutedEdges] = useState<Edge[]>(edges);
  const [isLayouting, setIsLayouting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const elkRef = useRef<InstanceType<typeof ELK> | null>(null);
  const prevFingerprintRef = useRef<string>("");
  const nodesRef = useRef<Node[]>(nodes);
  const edgesRef = useRef<Edge[]>(edges);
  const watchdogRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Monotonic run token: each runLayout() claims a new id, and a settlement
  // whose id is no longer current belongs to a superseded run — it must not
  // clear the active run's watchdog, commit stale positions, or stamp an
  // error the active run would never clear. Layouts genuinely overlap: the
  // auto-layout effect re-fires on every topology change while a prior
  // elk.layout() may still be in flight (elkjs settles each request
  // independently by per-message id).
  const runIdRef = useRef(0);

  nodesRef.current = nodes;
  edgesRef.current = edges;

  /** Clears the in-flight layout watchdog, if any. Idempotent. */
  const clearWatchdog = (): void => {
    if (watchdogRef.current !== null) {
      clearTimeout(watchdogRef.current);
      watchdogRef.current = null;
    }
  };

  // Construct the ELK driver (and its single, non-nested worker) once on
  // mount, terminate on unmount.
  //
  // StrictMode replay hazard: in dev, StrictMode mounts this effect, runs
  // its cleanup, then mounts it again (mount -> cleanup -> mount) to flush
  // out effects that aren't cleanup-safe. If a worker topology already
  // exists when the Graph view mounts, the auto-layout effect below fires
  // `runLayout()` on that first mount (fingerprint "" -> topology),
  // arming the watchdog and starting `elk1.layout()`. This cleanup then
  // runs, terminating elk1's worker and clearing the watchdog while that
  // layout is still in flight. On the replay mount a fresh elk2 is
  // constructed — but `prevFingerprintRef` is a ref, so it SURVIVES the
  // replay and still holds the topology fingerprint set on the first
  // mount. The replayed auto-layout effect therefore sees no fingerprint
  // change and skips `runLayout()` entirely, leaving elk2 idle, the
  // watchdog dead, and `isLayouting` stuck `true` forever — the
  // "Computing Layout" spinner never resolves. (A first-ever mount with no
  // pre-existing topology doesn't hit this: the worker spawns after mount,
  // so the topology fingerprint only appears/changes later, on the replay,
  // which then runs `runLayout()` normally.)
  //
  // Resetting `prevFingerprintRef` and `isLayouting` here — on every
  // cleanup, not just a genuine unmount — makes the replay mount behave
  // like a first mount: the next auto-layout effect run re-triggers
  // `runLayout()` on the fresh engine, and no stale spinner survives the
  // replay. On a real unmount these are harmless no-ops (nothing reads the
  // ref or renders this state again).
  // biome-ignore lint/correctness/useExhaustiveDependencies: clearWatchdog is a stable-shape helper closing only over the ref; including it would redefine the effect's identity every render for no behavioral change.
  useEffect(() => {
    const handleWorkerFailure = (): void => {
      // A worker crash/unreadable-message failure makes the in-flight
      // `.layout()` call moot — without this, the watchdog would still
      // fire LAYOUT_TIMEOUT_MS later and stomp this (correct) error with
      // a misleading timeout one.
      clearWatchdog();
      setError(LAYOUT_ENGINE_ERROR);
      setIsLayouting(false);
    };

    const elk = new ELK({
      workerFactory: () => {
        const worker = new Worker(new URL("../workers/elk.worker.ts", import.meta.url), {
          type: "module",
        });
        worker.onerror = handleWorkerFailure;
        worker.onmessageerror = handleWorkerFailure;
        return worker;
      },
    });

    elkRef.current = elk;

    return () => {
      elk.terminateWorker();
      elkRef.current = null;
      clearWatchdog();
      // Invalidate any in-flight settlement from the terminated engine: a
      // response already queued in PromisedWorker's setTimeout(0) deferral
      // still settles after terminate(), and must not commit into the
      // replayed mount's (or post-unmount) state.
      runIdRef.current += 1;
      // See the StrictMode replay hazard note above: reset so a replayed
      // (or next real) mount's auto-layout effect re-triggers layout on
      // the fresh engine, and no stale spinner carries over.
      prevFingerprintRef.current = "";
      setIsLayouting(false);
    };
  }, []);

  const runLayout = (): void => {
    const elk = elkRef.current;
    if (!elk) return;

    const currentNodes = nodesRef.current;
    const currentEdges = edgesRef.current;

    setIsLayouting(true);
    setError(null);

    const graph: ElkNode = {
      id: "root",
      layoutOptions: DEFAULT_LAYOUT_OPTIONS,
      children: currentNodes.map((n) => ({
        id: n.id,
        width: NODE_WIDTH,
        height: NODE_HEIGHT,
      })),
      edges: currentEdges.map(
        (e): ElkExtendedEdge => ({
          id: e.id,
          sources: [e.source],
          targets: [e.target],
        }),
      ),
    };

    // Clear any watchdog left over from a prior in-flight call — a fresh
    // runLayout() always supersedes it, and only one should ever be live.
    clearWatchdog();
    const runId = ++runIdRef.current;

    // Race `.layout()` against a watchdog timer: elkjs's worker protocol
    // has no built-in timeout, so a worker that neither errors nor ever
    // responds (as opposed to the onerror/onmessageerror cases handled
    // above) would otherwise leave `isLayouting` stuck forever.
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      watchdogRef.current = setTimeout(() => {
        watchdogRef.current = null;
        reject(new Error("elk-layout-watchdog-timeout"));
      }, LAYOUT_TIMEOUT_MS);
    });

    Promise.race([elk.layout(graph), timeoutPromise])
      .then((result) => {
        if (runId !== runIdRef.current) return;
        clearWatchdog();

        const positionMap = new Map(
          (result.children ?? []).map((child) => [child.id, { x: child.x ?? 0, y: child.y ?? 0 }]),
        );

        const updated = nodesRef.current.map((node) => {
          const pos = positionMap.get(node.id);
          if (pos) {
            return { ...node, position: { x: pos.x, y: pos.y } };
          }
          return node;
        });

        setLayoutedNodes(updated);
        setLayoutedEdges(edgesRef.current);
        setIsLayouting(false);
      })
      .catch((err: unknown) => {
        if (runId !== runIdRef.current) return;
        clearWatchdog();
        const timedOut = err instanceof Error && err.message === "elk-layout-watchdog-timeout";
        setError(timedOut ? LAYOUT_TIMEOUT_ERROR : LAYOUT_ENGINE_ERROR);
        setIsLayouting(false);
      });
  };

  // Auto-layout when topology changes
  // biome-ignore lint/correctness/useExhaustiveDependencies: runLayout is recreated every render but only reads refs; adding it would re-run this effect on every render (the fingerprint guard would still block extra layouts, but re-computing the fingerprint on every render is wasted work we intentionally avoid)
  useEffect(() => {
    const fingerprint = topologyFingerprint(nodes, edges);

    if (fingerprint !== prevFingerprintRef.current) {
      prevFingerprintRef.current = fingerprint;
      runLayout();
    }
  }, [nodes, edges]);

  return { layoutedNodes, layoutedEdges, isLayouting, error, runLayout };
}
