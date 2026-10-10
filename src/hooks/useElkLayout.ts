import type { XYPosition } from "@xyflow/react";
import type { ElkExtendedEdge, ElkNode } from "elkjs";
import ELK from "elkjs/lib/elk-api.js";
import type { RefObject } from "react";
import { useEffect, useEffectEvent, useRef, useState } from "react";

/** What layout needs of a node: its id (every node is laid out at the same fixed size). */
export interface LayoutNode {
  readonly id: string;
}

/** What layout needs of an edge: its endpoints. */
export interface LayoutEdge {
  readonly id: string;
  readonly source: string;
  readonly target: string;
}

interface ElkLayoutReturn {
  /** Top-left position per laid-out node id, from the most recent completed layout. */
  readonly positions: ReadonlyMap<string, XYPosition>;
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

/** Shown when the running engine rejects an `elk.layout()` request (elkjs's worker posts back the engine's exception). */
const LAYOUT_RUN_ERROR = "Layout Failed";

/** How long to wait for `elk.layout()` to settle before treating it as a hung/failed layout. */
const LAYOUT_TIMEOUT_MS = 10_000;

const EMPTY_POSITIONS: ReadonlyMap<string, XYPosition> = new Map();

/**
 * A stable fingerprint of the topology: layout only re-runs when the node
 * set or the edge connections change, never for data-only updates.
 */
function topologyFingerprint(nodes: readonly LayoutNode[], edges: readonly LayoutEdge[]): string {
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

/** Clears a pending watchdog timer, if any. Idempotent. */
function clearWatchdog(watchdog: RefObject<ReturnType<typeof setTimeout> | null>): void {
  if (watchdog.current !== null) {
    clearTimeout(watchdog.current);
    watchdog.current = null;
  }
}

/**
 * Computes an ELK graph layout in a dedicated Web Worker.
 *
 * Constructs elkjs's own `ELK` driver (the 10 kB `elk-api` entry — the
 * layout engine itself only ships in the worker bundle) with a
 * `workerFactory` that spawns exactly one dedicated, non-nested Worker
 * (`src/workers/elk.worker.ts`, which itself *is* elkjs's worker script —
 * see that file's header). elkjs drives its register/layout protocol over
 * that worker and resolves/rejects `.layout()` accordingly; a
 * `worker.onerror`/`onmessageerror` failure is surfaced through `error`
 * instead of leaving `isLayouting` stuck. A {@link LAYOUT_TIMEOUT_MS}
 * watchdog covers the remaining failure mode — a worker that neither
 * errors nor ever responds — by racing `.layout()` against a timer; the
 * timer is always cleared (success, any failure path, or unmount).
 * Overlapping layouts are serialized by a run token: only the most recent
 * `runLayout()` may commit state, clear the watchdog, or stamp an error —
 * a superseded run's late settlement is ignored outright.
 *
 * Layout re-runs automatically when the topology fingerprint changes: the
 * effect is keyed on the fingerprint string and fires an Effect Event, so
 * data-only re-renders never re-layout, and the event always sees the
 * current nodes and edges. Positions are committed synchronously in the
 * `.then()` as one batched update — never deferred to
 * `requestAnimationFrame`, which Chromium suppresses for occluded or
 * minimized windows (a deferred commit would leave `isLayouting` stuck
 * while the window is hidden).
 *
 * @param nodes - Nodes to position (only their ids are read).
 * @param edges - Edges defining connections (only their endpoints are read).
 * @returns Positions by node id, loading/error state, and a manual `runLayout` trigger.
 */
export function useElkLayout(
  nodes: readonly LayoutNode[],
  edges: readonly LayoutEdge[],
): ElkLayoutReturn {
  const [positions, setPositions] = useState(EMPTY_POSITIONS);
  const [isLayouting, setIsLayouting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const elkRef = useRef<InstanceType<typeof ELK> | null>(null);
  const watchdogRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Monotonic run token: each runLayout() claims a new id, and a settlement
  // whose id is no longer current belongs to a superseded run — it must not
  // clear the active run's watchdog, commit stale positions, or stamp an
  // error the active run would never clear. Layouts genuinely overlap: the
  // auto-layout effect re-fires on every topology change while a prior
  // elk.layout() may still be in flight (elkjs settles each request
  // independently by per-message id).
  const runIdRef = useRef(0);

  // Construct the ELK driver (and its single, non-nested worker) once on
  // mount; terminate it on unmount.
  //
  // StrictMode replays effects (mount -> cleanup -> mount). The cleanup
  // terminates the first engine mid-layout and invalidates its run, and
  // resets `isLayouting`; the replayed auto-layout effect below then runs
  // layout again on the fresh engine (it fires on every mount, not only
  // on fingerprint changes), so no spinner is left stuck.
  useEffect(() => {
    const handleWorkerFailure = (): void => {
      // A worker crash/unreadable message makes the in-flight `.layout()`
      // moot — without this, the watchdog would still fire later and
      // stomp this (correct) error with a misleading timeout one.
      clearWatchdog(watchdogRef);
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
      clearWatchdog(watchdogRef);
      // Invalidate any in-flight settlement from the terminated engine: a
      // response already queued in elkjs's PromisedWorker still settles
      // after terminate(), and must not commit into the replayed mount's
      // (or post-unmount) state.
      runIdRef.current += 1;
      setIsLayouting(false);
    };
  }, []);

  const runLayout = (): void => {
    const elk = elkRef.current;
    if (!elk) return;

    setIsLayouting(true);
    setError(null);

    const graph: ElkNode = {
      id: "root",
      layoutOptions: DEFAULT_LAYOUT_OPTIONS,
      children: nodes.map((n) => ({ id: n.id, width: NODE_WIDTH, height: NODE_HEIGHT })),
      edges: edges.map(
        (e): ElkExtendedEdge => ({ id: e.id, sources: [e.source], targets: [e.target] }),
      ),
    };

    // A fresh runLayout() always supersedes an in-flight one's watchdog.
    clearWatchdog(watchdogRef);
    const runId = ++runIdRef.current;

    // elkjs's worker protocol has no timeout of its own.
    const timeout = new Promise<never>((_resolve, reject) => {
      watchdogRef.current = setTimeout(() => {
        watchdogRef.current = null;
        reject(new Error("elk-layout-watchdog-timeout"));
      }, LAYOUT_TIMEOUT_MS);
    });

    Promise.race([elk.layout(graph), timeout])
      .then((result) => {
        if (runId !== runIdRef.current) return;
        clearWatchdog(watchdogRef);
        setPositions(
          new Map(
            (result.children ?? []).map((child) => [
              child.id,
              { x: child.x ?? 0, y: child.y ?? 0 },
            ]),
          ),
        );
        setIsLayouting(false);
      })
      .catch((err: unknown) => {
        if (runId !== runIdRef.current) return;
        clearWatchdog(watchdogRef);
        const timedOut = err instanceof Error && err.message === "elk-layout-watchdog-timeout";
        if (!timedOut) console.error("[elk] Layout failed:", err);
        setError(timedOut ? LAYOUT_TIMEOUT_ERROR : LAYOUT_RUN_ERROR);
        setIsLayouting(false);
      });
  };

  // The fingerprint is passed in (and ignored) so the effect's one
  // dependency is the value it reacts to; the event itself always sees
  // the current nodes and edges.
  const onTopologyChange = useEffectEvent((_fingerprint: string) => runLayout());
  const fingerprint = topologyFingerprint(nodes, edges);

  // Auto-layout on mount and whenever the topology changes.
  useEffect(() => onTopologyChange(fingerprint), [fingerprint]);

  return { positions, isLayouting, error, runLayout };
}
