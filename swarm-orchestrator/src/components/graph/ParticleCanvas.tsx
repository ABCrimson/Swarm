// ── Particle Canvas ──────────────────────────────────
// Milestone 0.6.6 + 0.6.7: Separate WebGPU canvas for particle effects.
// z-index: 0, position: fixed, pointer-events: none, aria-hidden.

import { useSetAtom } from "jotai";
import { useEffect, useRef } from "react";
import { useParticleSync } from "#hooks/useParticleSync";
import { useWebGPU } from "#hooks/useWebGPU";
import type { ParticleSystem } from "#lib/particles";
import {
  createParticleSystem,
  destroyParticleSystem,
  dispatchCompute,
  renderParticles,
  writeRenderParams,
  writeSimParams,
} from "#lib/particles";
import type { PostProcessPipeline } from "#lib/postprocess";
import {
  createPostProcessPipeline,
  destroyPostProcessPipeline,
  renderPostProcess,
} from "#lib/postprocess";
import { gpuFrameTimeAtom, particleCountAtom } from "#store/ui";

const INITIAL_PARTICLE_COUNT = 10_000;
const MIN_PARTICLE_COUNT = 2_000;
const MAX_PARTICLE_COUNT = 50_000;
const TARGET_HIGH_MS = 8;
const TARGET_LOW_MS = 2;

/**
 * WebGPU particle canvas — purely decorative background effect.
 *
 * - Fixed position, full viewport coverage
 * - z-index: 0 (behind everything)
 * - pointer-events: none (doesn't block interaction)
 * - aria-hidden="true" (accessibility: decorative only)
 * - tabIndex={-1} — never receives focus
 */
export function ParticleCanvas(): React.ReactElement {
  const { canvasRef, device, context, format, isReady, canvasWidth, canvasHeight } = useWebGPU();

  const systemRef = useRef<ParticleSystem | null>(null);
  const postProcessRef = useRef<PostProcessPipeline | null>(null);
  const rafRef = useRef<number>(0);
  const particleCountRef = useRef(INITIAL_PARTICLE_COUNT);
  const lastTimeRef = useRef(0);
  const frameTimesRef = useRef<number[]>([]);

  const setGpuFrameTime = useSetAtom(gpuFrameTimeAtom);
  const setParticleCount = useSetAtom(particleCountAtom);

  // Sync worker state to particle params
  useParticleSync({
    device,
    system: systemRef.current,
    canvasWidth,
    canvasHeight,
  });

  // Initialize particle system and post-process pipeline when device is ready
  useEffect(() => {
    if (!device || !format || !isReady || canvasWidth === 0 || canvasHeight === 0) return;

    const controller = new AbortController();

    const init = async (): Promise<void> => {
      try {
        const system = await createParticleSystem(device, format, particleCountRef.current);
        if (controller.signal.aborted) {
          destroyParticleSystem(system);
          return;
        }
        systemRef.current = system;

        const postProcess = createPostProcessPipeline(device, format, canvasWidth, canvasHeight);
        postProcessRef.current = postProcess;

        writeRenderParams(device, system, canvasWidth, canvasHeight);
      } catch (err) {
        console.error("Failed to create particle system:", err);
      }
    };

    void init();

    return () => {
      controller.abort();
      if (systemRef.current) {
        destroyParticleSystem(systemRef.current);
        systemRef.current = null;
      }
      if (postProcessRef.current) {
        destroyPostProcessPipeline(postProcessRef.current);
        postProcessRef.current = null;
      }
    };
  }, [device, format, isReady, canvasWidth, canvasHeight]);

  // Render loop
  useEffect(() => {
    if (!device || !context || !isReady) return;

    // Adaptive particle count adjustment based on frame time (Milestone 0.6.5)
    const adjustParticleCount = (frameTimeMs: number) => {
      frameTimesRef.current.push(frameTimeMs);
      if (frameTimesRef.current.length < 30) return; // Gather samples

      const avg = frameTimesRef.current.reduce((a, b) => a + b, 0) / frameTimesRef.current.length;
      frameTimesRef.current = [];

      let count = particleCountRef.current;

      if (avg > TARGET_HIGH_MS) {
        count = Math.max(MIN_PARTICLE_COUNT, Math.floor(count * 0.8));
      } else if (avg < TARGET_LOW_MS) {
        count = Math.min(MAX_PARTICLE_COUNT, Math.floor(count * 1.1));
      }

      if (count !== particleCountRef.current) {
        particleCountRef.current = count;
        setParticleCount(count);
      }

      setGpuFrameTime(avg);
    };

    const render = (time: number): void => {
      const system = systemRef.current;
      const postProcess = postProcessRef.current;
      if (!system || !context) return;

      const dt = lastTimeRef.current ? (time - lastTimeRef.current) / 1000 : 0.016;
      lastTimeRef.current = time;

      // CPU-side frame timing for adaptive count
      const cpuStart = performance.now();

      try {
        // Update sim params with current time
        writeSimParams(device, system, {
          dt: Math.min(dt, 0.05), // cap dt to avoid spiral-of-death
          workerCount: 0,
          time: time / 1000,
          deltaHue: 205,
          canvasWidth,
          canvasHeight,
          speedMultiplier: 1.0,
          chromaMultiplier: 1.0,
        });

        const encoder = device.createCommandEncoder({ label: "particles" });

        // Compute pass: update particles
        dispatchCompute(encoder, system);

        if (postProcess && canvasWidth > 0 && canvasHeight > 0) {
          // Render particles to an intermediate texture
          const intermediateTexture = device.createTexture({
            size: { width: canvasWidth, height: canvasHeight },
            format: context.getCurrentTexture().format,
            usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
          });

          renderParticles(
            encoder,
            system,
            intermediateTexture.createView(),
            particleCountRef.current,
          );

          device.queue.submit([encoder.finish()]);

          // Post-process: bloom + chromatic aberration + vignette
          const outputView = context.getCurrentTexture().createView();
          renderPostProcess(device, postProcess, intermediateTexture, outputView);

          intermediateTexture.destroy();
        } else {
          // No post-processing — render directly
          const textureView = context.getCurrentTexture().createView();
          renderParticles(encoder, system, textureView, particleCountRef.current);
          device.queue.submit([encoder.finish()]);
        }

        const cpuEnd = performance.now();
        adjustParticleCount(cpuEnd - cpuStart);
      } catch {
        // Swallow errors from context loss / destroyed device
      }

      rafRef.current = requestAnimationFrame(render);
    };

    rafRef.current = requestAnimationFrame(render);

    return () => {
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = 0;
      }
    };
  }, [device, context, isReady, canvasWidth, canvasHeight]);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      tabIndex={-1}
      style={{
        position: "fixed",
        inset: 0,
        width: "100vw",
        height: "100vh",
        zIndex: 0,
        pointerEvents: "none",
        background: "oklch(0.06 0.02 220)",
      }}
    />
  );
}
