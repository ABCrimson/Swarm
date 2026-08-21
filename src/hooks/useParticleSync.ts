// ── Worker State → Visual Coupling ───────────────────
// Milestone 0.6.4 + Feature 19: Maps worker/system/AI states to particle parameters

import { useEffect, useRef } from "react";

import type { ParticleSystem, SimParams } from "#lib/particles";
import { DEFAULT_SIM_PARAMS, writeSimParams } from "#lib/particles";
import { useAiStore } from "#store/ai";
import { useSystemStore } from "#store/system";
import type { WorkerState } from "#store/types";
import { useWorkerStore } from "#store/workers";

interface ParticleSyncConfig {
  device: GPUDevice | null;
  system: ParticleSystem | null;
  canvasWidth: number;
  canvasHeight: number;
}

/**
 * Subscribes to the worker store via `subscribeWithSelector` and maps
 * worker states to particle simulation parameters.
 *
 * - Running: full saturation, normal speed
 * - Error: hue shifts to rose (h=10), increased velocity
 * - Paused: slow (dt *= 0.1), desaturated (chroma *= 0.3)
 * - Idle: baseline parameters
 *
 * Updates are debounced to 60fps via `requestAnimationFrame`.
 */
export function useParticleSync(config: ParticleSyncConfig): void {
  const { device, system, canvasWidth, canvasHeight } = config;
  const pendingUpdateRef = useRef<number | null>(null);

  useEffect(() => {
    if (!device || !system) return;

    /** Maximum tokens/sec for throughput normalization. */
    const MAX_TOKENS_PER_SEC = 500;

    const computeParams = (): SimParams => {
      const workers = useWorkerStore.getState().workers;
      const workerCount = workers.size;
      const systemMetrics = useSystemStore.getState().metrics;
      const aiState = useAiStore.getState();

      // Aggregate state from all workers
      let hasError = false;
      let allPaused = workerCount > 0;
      let hasRunning = false;
      let runningCount = 0;
      let errorCount = 0;

      for (const [, worker] of workers) {
        const state: WorkerState = worker.state;
        if (state === "error") {
          hasError = true;
          errorCount++;
        }
        if (state !== "paused") allPaused = false;
        if (state === "running") {
          hasRunning = true;
          runningCount++;
        }
      }

      // Data-driven fields (Feature 19)
      const throughput = Math.min(systemMetrics.tokensPerSec / MAX_TOKENS_PER_SEC, 1);
      const errorRate = workerCount > 0 ? Math.min(errorCount / workerCount, 1) : 0;
      const activeWorkers = runningCount;
      const queueDepth = aiState.queue.length;

      const params: SimParams = {
        ...DEFAULT_SIM_PARAMS,
        workerCount,
        canvasWidth,
        canvasHeight,
        time: performance.now() / 1000,
        throughput,
        errorRate,
        activeWorkers,
        queueDepth,
      };

      if (hasError) {
        // Rose hue (h=10 in OKLCH), faster particles
        params.deltaHue = 10;
        params.speedMultiplier = 2.0;
        params.chromaMultiplier = 1.5;
      } else if (allPaused) {
        // Slow and desaturated
        params.dt *= 0.1;
        params.chromaMultiplier = 0.3;
        params.speedMultiplier = 0.3;
      } else if (hasRunning) {
        // Full saturation, normal speed
        params.deltaHue = 205;
        params.speedMultiplier = 1.0;
        params.chromaMultiplier = 1.0;
      }

      return params;
    };

    // Write initial params
    writeSimParams(device, system, computeParams());

    const scheduleUpdate = () => {
      if (pendingUpdateRef.current !== null) return;

      pendingUpdateRef.current = requestAnimationFrame(() => {
        pendingUpdateRef.current = null;
        if (device && system) {
          writeSimParams(device, system, computeParams());
        }
      });
    };

    // Subscribe to worker, system metrics, and AI queue changes
    const unsubWorkers = useWorkerStore.subscribe((state) => state.workers, scheduleUpdate);
    const unsubSystem = useSystemStore.subscribe((state) => state.metrics, scheduleUpdate);
    const unsubAi = useAiStore.subscribe((state) => state.queue, scheduleUpdate);

    return () => {
      unsubWorkers();
      unsubSystem();
      unsubAi();
      if (pendingUpdateRef.current !== null) {
        cancelAnimationFrame(pendingUpdateRef.current);
        pendingUpdateRef.current = null;
      }
    };
  }, [device, system, canvasWidth, canvasHeight]);
}
