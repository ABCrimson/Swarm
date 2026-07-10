// ── Particle Background ──────────────────────────────
// Milestone 0.6.6 + 0.6.7: Full-viewport WebGPU particle canvas
// with adaptive particle count, post-processing, and graceful fallback.

import { useAtomValue, useSetAtom } from "jotai";
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
import { isWebGPUSupported } from "#lib/webgpu";
import { gpuFrameTimeAtom, particleCountAtom, reducedMotionAtom, themeAtom } from "#store/ui";

// ── Adaptive particle count constants ────────────────

const INITIAL_PARTICLE_COUNT = 10_000;
const MIN_PARTICLE_COUNT = 2_000;
const MAX_PARTICLE_COUNT = 50_000;
/** Frame time threshold (ms) above which particles are reduced. */
const TARGET_HIGH_MS = 8;
/** Frame time threshold (ms) below which particles can increase. */
const TARGET_LOW_MS = 2;
/** Number of frame samples before adjusting particle count. */
const SAMPLE_WINDOW = 30;

// ── Fallback background (OKLCH void) ─────────────────

const FALLBACK_STYLE: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  zIndex: 0,
  pointerEvents: "none",
  background: "oklch(0.06 0.02 220)",
};

const CANVAS_STYLE: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  width: "100vw",
  height: "100vh",
  zIndex: 0,
  pointerEvents: "none",
  background: "oklch(0.06 0.02 220)",
};

/**
 * Full-viewport WebGPU particle background.
 *
 * Renders a fixed canvas behind all content (z-index: 0, pointer-events: none)
 * with compute-shader particles, bloom, chromatic aberration, and vignette.
 *
 * Graceful degradation:
 * - WebGPU unsupported: solid OKLCH background div
 * - `prefers-reduced-motion`: solid OKLCH background div
 * - `particlesEnabled` off: solid OKLCH background div
 *
 * Adaptive performance:
 * - Monitors CPU-side frame time over a rolling 30-sample window
 * - Reduces particle count by 20% when avg frame time > 8ms
 * - Increases particle count by 10% when avg frame time < 2ms
 * - Clamps to [2,000 .. 50,000] range
 */
export function ParticleBackground(): React.ReactElement {
  const theme = useAtomValue(themeAtom);
  const reducedMotion = useAtomValue(reducedMotionAtom);

  const shouldRender = isWebGPUSupported() && theme.particlesEnabled && !reducedMotion;

  if (!shouldRender) {
    return <div aria-hidden="true" style={FALLBACK_STYLE} />;
  }

  return <ParticleCanvas />;
}

// ── Internal canvas component (only mounted when WebGPU is active) ──

function ParticleCanvas(): React.ReactElement {
  const { canvasRef, device, context, format, isReady, canvasWidth, canvasHeight } = useWebGPU();

  const systemRef = useRef<ParticleSystem | null>(null);
  const postProcessRef = useRef<PostProcessPipeline | null>(null);
  const intermediateTextureRef = useRef<GPUTexture | null>(null);
  const rafRef = useRef<number>(0);
  const particleCountRef = useRef(INITIAL_PARTICLE_COUNT);
  const lastTimeRef = useRef(0);
  const frameTimesRef = useRef<number[]>([]);

  const setGpuFrameTime = useSetAtom(gpuFrameTimeAtom);
  const setParticleCount = useSetAtom(particleCountAtom);

  // Sync worker/AI/system state to particle sim params
  useParticleSync({
    device,
    system: systemRef.current,
    canvasWidth,
    canvasHeight,
  });

  // ── Initialize particle system + post-process pipeline ──
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

        const postProcess = await createPostProcessPipeline(
          device,
          format,
          canvasWidth,
          canvasHeight,
        );
        if (controller.signal.aborted) {
          destroyPostProcessPipeline(postProcess);
          return;
        }
        postProcessRef.current = postProcess;

        // Allocate the post-process intermediate texture once here — it is
        // only recreated when this effect re-runs (device/format/canvas
        // size change), never per-frame.
        intermediateTextureRef.current = device.createTexture({
          size: { width: canvasWidth, height: canvasHeight },
          format,
          usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
        });

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
      if (intermediateTextureRef.current) {
        intermediateTextureRef.current.destroy();
        intermediateTextureRef.current = null;
      }
    };
  }, [device, format, isReady, canvasWidth, canvasHeight]);

  // ── Render loop ──
  useEffect(() => {
    if (!device || !context || !isReady) return;

    // ── Adaptive particle count (Milestone 0.6.5) ──
    const adjustParticleCount = (frameTimeMs: number): void => {
      frameTimesRef.current.push(frameTimeMs);
      if (frameTimesRef.current.length < SAMPLE_WINDOW) return;

      const avg = frameTimesRef.current.reduce((a, b) => a + b, 0) / frameTimesRef.current.length;
      frameTimesRef.current = [];

      // Never exceed the buffer capacity allocated at pipeline creation
      // (maxParticles), regardless of MAX_PARTICLE_COUNT's headroom.
      const ceiling = Math.min(
        MAX_PARTICLE_COUNT,
        systemRef.current?.maxParticles ?? MAX_PARTICLE_COUNT,
      );
      let count = particleCountRef.current;

      if (avg > TARGET_HIGH_MS) {
        // Reduce by 20% to recover performance
        count = Math.max(MIN_PARTICLE_COUNT, Math.floor(count * 0.8));
      } else if (avg < TARGET_LOW_MS) {
        // Increase by 10% to improve visual density
        count = Math.min(ceiling, Math.floor(count * 1.1));
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

      const cpuStart = performance.now();

      try {
        // Update sim params with current frame time
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

        // Compute pass: simulate particles
        dispatchCompute(encoder, system);

        // Defense-in-depth: never instance-draw more particles than the
        // GPU buffer allocated at createParticleSystem() time holds.
        const drawCount = Math.min(particleCountRef.current, system.maxParticles);

        const intermediateTexture = intermediateTextureRef.current;

        if (postProcess && intermediateTexture && canvasWidth > 0 && canvasHeight > 0) {
          // Render particles to the pre-allocated intermediate texture
          renderParticles(encoder, system, intermediateTexture.createView(), drawCount);

          device.queue.submit([encoder.finish()]);

          // Post-process: bloom + chromatic aberration + vignette
          const outputView = context.getCurrentTexture().createView();
          renderPostProcess(device, postProcess, intermediateTexture, outputView);
        } else {
          // No post-processing -- render directly to swap chain
          const textureView = context.getCurrentTexture().createView();
          renderParticles(encoder, system, textureView, drawCount);
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
  }, [device, context, isReady, canvasWidth, canvasHeight, setParticleCount, setGpuFrameTime]);

  return <canvas ref={canvasRef} aria-hidden="true" tabIndex={-1} style={CANVAS_STYLE} />;
}
