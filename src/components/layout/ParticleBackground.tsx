import { useAtomValue, useSetAtom } from "jotai";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { useParticleSync } from "#hooks/useParticleSync";
import { useWebGPU } from "#hooks/useWebGPU";
import type { ParticleSystem } from "#lib/particles";
import {
  createParticleSystem,
  DEFAULT_SIM_PARAMS,
  destroyParticleSystem,
  dispatchCompute,
  PARTICLE_COMPUTE_WGSL,
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
import type { WebGPUUnavailableReason } from "#lib/webgpu";
import { getWebGPUUnavailableReason, isWebGPUSupported } from "#lib/webgpu";
import { gpuFrameTimeAtom, particleCountAtom, reducedMotionAtom, themeAtom } from "#store/ui";

// ── One-time-per-reason "pipeline can't start" diagnostics ──
//
// Module-level (not component state) so the warning/toast fires at most
// once per *distinct reason* per app session, however often the
// component re-renders, remounts (StrictMode) or retries after a device
// loss. Keyed on the reason, not a boolean: a retry (e.g. toggling
// particles in Settings) can surface a different, more current reason,
// which should still be reported once.

let lastWarnedParticlesUnavailableReason: WebGPUUnavailableReason | null = null;

/** Resets the one-time-per-reason guard. Test-only — production code never calls this. */
export function _resetParticlesUnavailableWarningForTests(): void {
  lastWarnedParticlesUnavailableReason = null;
}

function warnParticlesUnavailable(reason: WebGPUUnavailableReason): void {
  if (lastWarnedParticlesUnavailableReason === reason) return;
  lastWarnedParticlesUnavailableReason = reason;

  console.warn(`[particles] Particle Background Unavailable: ${reason}`);
  toast.warning("Particle Background Unavailable", { description: reason });
}

// ── Simulation constants ─────────────────────────────

/** Particles the GPU buffer holds; the compute pass simulates all of them every step. */
export const PARTICLE_CAPACITY = 10_000;
/** Fewest particles the adaptive count will draw. */
export const MIN_PARTICLE_COUNT = 2_000;
/** GPU frame latency (ms) above which fewer particles are drawn. */
const TARGET_HIGH_MS = 8;
/** GPU frame latency (ms) below which more particles are drawn. */
const TARGET_LOW_MS = 2;
/** Latency samples averaged before each adjustment. */
const SAMPLE_WINDOW = 30;
/**
 * Fixed simulation step, in ms: the `dt` the parameter sync writes
 * (`DEFAULT_SIM_PARAMS.dt`, scaled down when every worker is paused).
 * Stepping on a fixed clock keeps the motion speed independent of the
 * display's refresh rate without the render loop ever writing `dt`.
 */
const STEP_MS = DEFAULT_SIM_PARAMS.dt * 1000;
/** At most this many simulation steps per frame (after a stall, time is dropped). */
const MAX_STEPS_PER_FRAME = 3;

/**
 * Byte offset of `time` in the WGSL `SimParams` uniform, read from the
 * shader source itself so a reordered struct cannot silently break the
 * per-frame write. Every field before it must be a 4-byte scalar;
 * otherwise this is `null` and the clock is left to the parameter sync.
 */
export const SIM_TIME_OFFSET: number | null = (() => {
  const body = /struct\s+SimParams\s*\{([^}]*)\}/.exec(PARTICLE_COMPUTE_WGSL)?.[1];
  if (!body) return null;
  const fields = body
    .split(",")
    .map((field) => field.trim())
    .filter(Boolean)
    .map((field) => field.split(":").map((part) => part.trim()));
  const index = fields.findIndex(([name]) => name === "time");
  if (index === -1) return null;
  const scalar = fields.slice(0, index).every(([, type]) => type === "f32" || type === "u32");
  return scalar ? index * 4 : null;
})();

/**
 * Full-viewport WebGPU particle background.
 *
 * A fixed canvas behind all content (`-z-1`, pointer-events none) with
 * compute-shader particles, bloom, chromatic aberration and vignette.
 * When WebGPU is unsupported, particles are off in Settings, or the OS
 * asks for reduced motion, it renders the plain background color.
 *
 * z-index -1 (not 0) is load-bearing: the app's root grid is an in-flow,
 * non-positioned box, and per the CSS 2.1 painting order a sibling with
 * `z-index: 0` paints above it — this full-viewport layer would then
 * cover the whole app. A negative z-index paints below it.
 */
export function ParticleBackground(): React.ReactElement {
  const theme = useAtomValue(themeAtom);
  const reducedMotion = useAtomValue(reducedMotionAtom);

  const supported = isWebGPUSupported();
  const shouldRender = supported && theme.particlesEnabled && !reducedMotion;

  // Diagnose "enabled in Settings but can't start" at the first gate
  // (WebGPU not exposed). Later gates (no adapter, no context) are
  // diagnosed in ParticleCanvas, where they are detected.
  useEffect(() => {
    if (supported || !theme.particlesEnabled || reducedMotion) return;
    const reason = getWebGPUUnavailableReason();
    if (reason) warnParticlesUnavailable(reason);
  }, [supported, theme.particlesEnabled, reducedMotion]);

  if (!shouldRender) {
    return <div aria-hidden="true" className="pointer-events-none fixed inset-0 -z-1 bg-void" />;
  }
  return <ParticleCanvas />;
}

/** Size-dependent post-processing resources, replaced together on resize. */
interface PostProcessTargets {
  /** The device these resources belong to; stale after a device loss. */
  readonly device: GPUDevice;
  readonly pipeline: PostProcessPipeline;
  /** Particles render here first; post-processing reads it. */
  readonly intermediate: GPUTexture;
}

/**
 * The canvas and its GPU resources (mounted only while WebGPU is active).
 *
 * - The particle system (buffers, pipelines, particle state) is created
 *   once per device and format and held in state, so `useParticleSync`
 *   receives it and pushes worker/AI/system state into the simulation
 *   parameters. A resize never rebuilds it.
 * - Post-processing is created per canvas size; the previous set is only
 *   destroyed once its replacement is committed, so a resize never drops
 *   a frame to the unprocessed path.
 * - The render loop starts only once the system exists, and schedules the
 *   next frame before doing any work, so a slow pipeline compile or a
 *   throwing frame can never stop it.
 * - Per frame the loop writes only the simulation clock (`time`) and runs
 *   fixed-size steps; everything else in the uniform belongs to the sync.
 * - The adaptive count and the status bar's "GPU" readout use the real
 *   GPU latency: submit → `queue.onSubmittedWorkDone()`.
 */
function ParticleCanvas(): React.ReactElement {
  const { canvasRef, device, context, format, canvasWidth, canvasHeight, failureReason } =
    useWebGPU();
  const [system, setSystem] = useState<ParticleSystem | null>(null);
  const [targets, setTargets] = useState<PostProcessTargets | null>(null);
  /** Particles drawn per frame, adjusted from GPU latency. Loop-owned. */
  const drawCountRef = useRef(PARTICLE_CAPACITY);
  const setGpuFrameTime = useSetAtom(gpuFrameTimeAtom);
  const setParticleCount = useSetAtom(particleCountAtom);

  useEffect(() => {
    if (failureReason) warnParticlesUnavailable(failureReason);
  }, [failureReason]);

  useParticleSync({ device, system });

  // ── Particle system: once per device/format ──
  useEffect(() => {
    if (!device || !format) return;
    let cancelled = false;
    let created: ParticleSystem | null = null;
    createParticleSystem(device, format, PARTICLE_CAPACITY).then(
      (next) => {
        if (cancelled) {
          destroyParticleSystem(next);
          return;
        }
        created = next;
        // Sane parameters until the sync's first write.
        writeSimParams(device, next, DEFAULT_SIM_PARAMS);
        setSystem(next);
      },
      (err: unknown) => console.error("[particles] Failed to create particle system:", err),
    );
    return () => {
      cancelled = true;
      if (created) destroyParticleSystem(created);
      setSystem(null);
    };
  }, [device, format]);

  // ── Post-processing: per canvas size ──
  useEffect(() => {
    if (!device || !format || !system || canvasWidth === 0 || canvasHeight === 0) return;
    writeRenderParams(device, system, canvasWidth, canvasHeight);
    let cancelled = false;
    createPostProcessPipeline(device, format, canvasWidth, canvasHeight).then(
      (pipeline) => {
        if (cancelled) {
          destroyPostProcessPipeline(pipeline);
          return;
        }
        const intermediate = device.createTexture({
          size: { width: canvasWidth, height: canvasHeight },
          format,
          usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
        });
        setTargets({ device, pipeline, intermediate });
      },
      (err: unknown) => console.error("[particles] Failed to create post-processing:", err),
    );
    return () => {
      cancelled = true;
    };
  }, [device, format, system, canvasWidth, canvasHeight]);

  // Destroys a post-processing set once a newer one (or unmount) replaces it.
  useEffect(() => {
    if (!targets) return;
    return () => {
      destroyPostProcessPipeline(targets.pipeline);
      targets.intermediate.destroy();
    };
  }, [targets]);

  // ── Render loop ──
  useEffect(() => {
    if (!device || !context || !system) return;
    let raf = 0;
    let lastFrame: number | null = null;
    let backlogMs = 0;
    let measuring = false;
    let samples: number[] = [];

    const recordLatency = (ms: number): void => {
      samples.push(ms);
      if (samples.length < SAMPLE_WINDOW) return;
      const avg = samples.reduce((sum, ms) => sum + ms, 0) / samples.length;
      samples = [];
      setGpuFrameTime(avg);

      const current = drawCountRef.current;
      const next =
        avg > TARGET_HIGH_MS
          ? Math.max(MIN_PARTICLE_COUNT, Math.floor(current * 0.8))
          : avg < TARGET_LOW_MS
            ? Math.min(PARTICLE_CAPACITY, Math.floor(current * 1.1))
            : current;
      if (next !== current) {
        drawCountRef.current = next;
        setParticleCount(next);
      }
    };

    const frame = (now: number): void => {
      // Scheduled first: nothing below can stop the loop.
      raf = requestAnimationFrame(frame);

      backlogMs += lastFrame === null ? STEP_MS : now - lastFrame;
      lastFrame = now;
      let steps = Math.floor(backlogMs / STEP_MS);
      if (steps > MAX_STEPS_PER_FRAME) {
        steps = MAX_STEPS_PER_FRAME;
        backlogMs = 0;
      } else {
        backlogMs -= steps * STEP_MS;
      }

      try {
        const submitted = performance.now();
        for (let step = 0; step < steps; step++) {
          if (SIM_TIME_OFFSET !== null) {
            const time = (now - (steps - 1 - step) * STEP_MS) / 1000;
            device.queue.writeBuffer(
              system.simUniformBuffer,
              SIM_TIME_OFFSET,
              Float32Array.of(time),
            );
          }
          const encoder = device.createCommandEncoder({ label: "particles-simulate" });
          dispatchCompute(encoder, system);
          device.queue.submit([encoder.finish()]);
        }

        const drawCount = Math.min(drawCountRef.current, system.maxParticles);
        const encoder = device.createCommandEncoder({ label: "particles-draw" });
        const output = context.getCurrentTexture().createView();
        // Until the post-processing for a new device is ready, draw unprocessed.
        const post = targets?.device === device ? targets : null;
        if (post) {
          renderParticles(encoder, system, post.intermediate.createView(), drawCount);
          device.queue.submit([encoder.finish()]);
          renderPostProcess(device, post.pipeline, post.intermediate, output);
        } else {
          renderParticles(encoder, system, output, drawCount);
          device.queue.submit([encoder.finish()]);
        }

        if (!measuring) {
          measuring = true;
          device.queue.onSubmittedWorkDone().then(
            () => {
              measuring = false;
              recordLatency(performance.now() - submitted);
            },
            () => {
              measuring = false;
            },
          );
        }
      } catch (err) {
        // A lost or destroyed device throws here; useWebGPU recovers it.
        console.debug("[particles] Frame skipped:", err);
      }
    };

    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [device, context, system, targets, setGpuFrameTime, setParticleCount]);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      tabIndex={-1}
      className="pointer-events-none fixed inset-0 -z-1 size-full bg-void"
    />
  );
}
