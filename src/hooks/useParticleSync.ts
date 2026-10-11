// ── Worker State → Particle Parameters ───────────────
// Maps worker states, AI throughput and the AI queue onto the particle
// simulation's uniform.

import { useEffect } from "react";
import type { ParticleSystem, SimParams } from "#lib/particles";
import { DEFAULT_SIM_PARAMS, writeSimParams } from "#lib/particles";
import { useAiStore } from "#store/ai";
import { useSystemStore } from "#store/system";
import type { Worker } from "#store/types";
import { useWorkerStore } from "#store/workers";

interface ParticleSyncConfig {
  readonly device: GPUDevice | null;
  readonly system: ParticleSystem | null;
}

/** What the simulation reads from the worker store: counts by state. */
export interface WorkerCounts {
  readonly total: number;
  readonly running: number;
  readonly paused: number;
  readonly errored: number;
}

/** Tokens/s that saturates the particle speed. */
const MAX_TOKENS_PER_SEC = 500;

/** Counts workers by the states the simulation distinguishes. */
export function countWorkers(workers: ReadonlyMap<string, Worker>): WorkerCounts {
  let running = 0;
  let paused = 0;
  let errored = 0;
  for (const { state } of workers.values()) {
    if (state === "running") running++;
    else if (state === "paused") paused++;
    else if (state === "error") errored++;
  }
  return { total: workers.size, running, paused, errored };
}

/**
 * The simulation parameters for a worker/AI snapshot:
 *
 * - Any worker errored: hue shifts to rose (h=10), faster, more chroma.
 * - Every worker paused: slow (dt × 0.1), desaturated (chroma × 0.3).
 * - Otherwise: baseline plasma hue (h=205), normal speed.
 *
 * Throughput (tokens/s, saturating at 500) drives speed, the error share
 * drives hue shift and turbulence, running workers become attractors and
 * the AI queue depth raises the respawn rate.
 */
export function simParamsFor(
  counts: WorkerCounts,
  tokensPerSec: number,
  queueDepth: number,
): SimParams {
  const params: SimParams = {
    ...DEFAULT_SIM_PARAMS,
    workerCount: counts.total,
    time: performance.now() / 1000,
    throughput: Math.min(tokensPerSec / MAX_TOKENS_PER_SEC, 1),
    errorRate: counts.total > 0 ? Math.min(counts.errored / counts.total, 1) : 0,
    activeWorkers: counts.running,
    queueDepth,
  };

  if (counts.errored > 0) {
    params.deltaHue = 10;
    params.speedMultiplier = 2.0;
    params.chromaMultiplier = 1.5;
  } else if (counts.total > 0 && counts.paused === counts.total) {
    params.dt *= 0.1;
    params.chromaMultiplier = 0.3;
    params.speedMultiplier = 0.3;
  }
  return params;
}

/** A primitive fingerprint of the worker counts: equal strings, equal parameters. */
const countsKey = (s: { workers: ReadonlyMap<string, Worker> }): string => {
  const { total, running, paused, errored } = countWorkers(s.workers);
  return `${total}:${running}:${paused}:${errored}`;
};

/**
 * Keeps the particle simulation's parameters in sync with the stores.
 *
 * Subscribes (via `subscribeWithSelector`) only to what the parameters
 * depend on — worker counts by state (as a primitive key, so a PTY output
 * chunk, which replaces a worker object, schedules nothing), tokens/s and
 * the AI queue length — and writes at most once per animation frame.
 */
export function useParticleSync({ device, system }: ParticleSyncConfig): void {
  useEffect(() => {
    if (!device || !system) return;

    const write = (): void => {
      writeSimParams(
        device,
        system,
        simParamsFor(
          countWorkers(useWorkerStore.getState().workers),
          useSystemStore.getState().metrics.tokensPerSec,
          useAiStore.getState().queue.length,
        ),
      );
    };

    let pending: number | null = null;
    // Not `??=`: the installed React Compiler (oxc-transform-react) leaves any component or hook that contains a logical assignment uncompiled.
    const schedule = (): void => {
      if (pending !== null) return;
      pending = requestAnimationFrame(() => {
        pending = null;
        write();
      });
    };

    write();
    const unsubscribers = [
      useWorkerStore.subscribe(countsKey, schedule),
      useSystemStore.subscribe((s) => s.metrics.tokensPerSec, schedule),
      useAiStore.subscribe((s) => s.queue.length, schedule),
    ];

    return () => {
      for (const unsubscribe of unsubscribers) unsubscribe();
      if (pending !== null) cancelAnimationFrame(pending);
    };
  }, [device, system]);
}
