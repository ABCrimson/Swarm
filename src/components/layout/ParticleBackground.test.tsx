// ── ParticleBackground Diagnostics Tests ─────────────
//
// Covers the "particles enabled in Settings but the pipeline can't
// start" gap: with `navigator.gpu` absent (the WebView2 case), the
// component must render its solid OKLCH fallback *and* surface a
// one-time, Title-Cased console.warn + Sonner toast so the failure is
// diagnosable instead of silent.
//
// The canvas path (ParticleCanvas) runs against a scripted fake device:
// useWebGPU, useParticleSync and the GPU-side helpers of #lib/particles
// and #lib/postprocess are mocked and requestAnimationFrame is a manual
// queue, so the render loop, the parameter-sync hand-off and the resize
// behavior are exercised frame by frame.

import { act, cleanup, render, waitFor } from "@testing-library/react";
import { getDefaultStore } from "jotai";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  _resetParticlesUnavailableWarningForTests,
  MIN_PARTICLE_COUNT,
  PARTICLE_CAPACITY,
  ParticleBackground,
  SIM_TIME_OFFSET,
} from "#components/layout/ParticleBackground";
import { useParticleSync } from "#hooks/useParticleSync";
import { type UseWebGPUResult, useWebGPU } from "#hooks/useWebGPU";
import {
  createParticleSystem,
  dispatchCompute,
  type ParticleSystem,
  renderParticles,
  writeSimParams,
} from "#lib/particles";
import {
  createPostProcessPipeline,
  type PostProcessPipeline,
  renderPostProcess,
} from "#lib/postprocess";
import { getWebGPUUnavailableReason } from "#lib/webgpu";
import { gpuFrameTimeAtom, particleCountAtom, reducedMotionAtom } from "#store/ui";

vi.mock("#hooks/useWebGPU", () => ({ useWebGPU: vi.fn() }));
vi.mock("#hooks/useParticleSync", () => ({ useParticleSync: vi.fn() }));
vi.mock("#lib/particles", async (importOriginal) => ({
  ...(await importOriginal<typeof import("#lib/particles")>()),
  createParticleSystem: vi.fn(),
  destroyParticleSystem: vi.fn(),
  dispatchCompute: vi.fn(),
  renderParticles: vi.fn(),
  writeRenderParams: vi.fn(),
  writeSimParams: vi.fn(),
}));
vi.mock("#lib/postprocess", () => ({
  createPostProcessPipeline: vi.fn(),
  destroyPostProcessPipeline: vi.fn(),
  renderPostProcess: vi.fn(),
}));

// The latch under test is keyed on the *reason value*, not "has ever
// warned" — so retrying (toggling particlesEnabled, which re-runs
// useWebGPU's init effect) after a different failure can still surface a
// genuinely different reason. ParticleBackground's own gate can only ever
// produce "WebGPU Is Not Exposed By This WebView" (see
// `getWebGPUUnavailableReason()` in `#lib/webgpu`), so a second, distinct
// reason is modeled here by overriding that lookup for one render — this
// stands in for the deeper useWebGPU()/initWebGPU() path (covered at the
// unit level in `src/lib/webgpu.test.ts`) producing e.g.
// "No Compatible GPU Adapter Found" on a retry, without needing a full
// WebGPU adapter/device/ResizeObserver mock.
vi.mock("#lib/webgpu", async (importOriginal) => {
  const actual = await importOriginal<typeof import("#lib/webgpu")>();
  return {
    ...actual,
    getWebGPUUnavailableReason: vi.fn(actual.getWebGPUUnavailableReason),
  };
});

function setNavigatorGpu(value: unknown): void {
  Object.defineProperty(navigator, "gpu", {
    value,
    configurable: true,
    writable: true,
  });
}

describe("ParticleBackground diagnostics", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  // NOTE: `themeAtom` is not overridden here: its default
  // (`particlesEnabled: true`) is the state these tests want.
  // `reducedMotionAtom` is used below for the "intentionally off" bypass.
  const store = getDefaultStore();

  beforeEach(() => {
    vi.clearAllMocks();
    _resetParticlesUnavailableWarningForTests();
    store.set(reducedMotionAtom, false);
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    cleanup();
    store.set(reducedMotionAtom, false);
    setNavigatorGpu(undefined);
    vi.restoreAllMocks();
  });

  it("renders the OKLCH fallback (not a canvas) when WebGPU is unsupported", () => {
    setNavigatorGpu(undefined);

    const { container } = render(<ParticleBackground />);

    expect(container.querySelector("canvas")).toBeNull();
    const fallback = container.querySelector('[aria-hidden="true"]');
    expect(fallback).toBeTruthy();
    expect(fallback?.tagName).toBe("DIV");
  });

  it("warns and toasts once with the specific unavailability reason", async () => {
    setNavigatorGpu(undefined);

    render(<ParticleBackground />);

    await waitFor(() => {
      expect(toast.warning).toHaveBeenCalledTimes(1);
    });

    expect(toast.warning).toHaveBeenCalledWith(
      "Particle Background Unavailable",
      expect.objectContaining({ description: "WebGPU Is Not Exposed By This WebView" }),
    );
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        "Particle Background Unavailable: WebGPU Is Not Exposed By This WebView",
      ),
    );
  });

  it("fires the toast/warning at most once per session, even across remounts", async () => {
    setNavigatorGpu(undefined);

    const first = render(<ParticleBackground />);
    await waitFor(() => expect(toast.warning).toHaveBeenCalledTimes(1));

    first.unmount();
    render(<ParticleBackground />);
    render(<ParticleBackground />);

    // Give any (incorrect) second effect a chance to fire before asserting.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(toast.warning).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it("does not warn when reduced motion is on, even though WebGPU is unsupported", async () => {
    // WebGPU is unsupported here too, but since the user (or OS) has
    // opted out of motion, this must NOT be treated as a diagnosable
    // pipeline failure.
    setNavigatorGpu(undefined);
    store.set(reducedMotionAtom, true);

    const { container } = render(<ParticleBackground />);

    // Let effects flush.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(container.querySelector("canvas")).toBeNull();
    expect(toast.warning).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("warns again exactly once when a genuinely different failure reason follows the first", async () => {
    setNavigatorGpu(undefined);

    const first = render(<ParticleBackground />);
    await waitFor(() => expect(toast.warning).toHaveBeenCalledTimes(1));
    expect(toast.warning).toHaveBeenNthCalledWith(
      1,
      "Particle Background Unavailable",
      expect.objectContaining({ description: "WebGPU Is Not Exposed By This WebView" }),
    );

    first.unmount();

    // Model the retry path: toggling `particlesEnabled`
    // re-runs useWebGPU's init effect, which can produce a different
    // `failureReason` than the first attempt (e.g. "No Compatible GPU
    // Adapter Found" instead of "not exposed"). A same-session latch keyed
    // only on "have I ever warned" would wrongly swallow this new reason.
    vi.mocked(getWebGPUUnavailableReason).mockReturnValueOnce("No Compatible GPU Adapter Found");

    render(<ParticleBackground />);

    await waitFor(() => expect(toast.warning).toHaveBeenCalledTimes(2));
    expect(toast.warning).toHaveBeenNthCalledWith(
      2,
      "Particle Background Unavailable",
      expect.objectContaining({ description: "No Compatible GPU Adapter Found" }),
    );
    expect(warnSpy).toHaveBeenCalledTimes(2);
    expect(warnSpy).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("Particle Background Unavailable: No Compatible GPU Adapter Found"),
    );
  });
});

describe("ParticleBackground canvas", () => {
  /** Pending requestAnimationFrame callbacks (a manual frame clock). */
  let frames: Map<number, FrameRequestCallback>;
  let nextFrameId: number;
  let clock: number;
  let device: GPUDevice;
  let writeBuffer: ReturnType<typeof vi.fn>;
  let gpu: UseWebGPUResult;
  const system = { maxParticles: PARTICLE_CAPACITY, simUniformBuffer: {} } as ParticleSystem;

  /** Runs every pending frame once per tick, 16 ms apart. */
  function tick(count = 1): void {
    for (let i = 0; i < count; i++) {
      clock += 16;
      const pending = [...frames.values()];
      frames.clear();
      for (const callback of pending) callback(clock);
    }
  }

  beforeEach(() => {
    vi.clearAllMocks();
    setNavigatorGpu({});
    frames = new Map();
    nextFrameId = 0;
    clock = 0;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      nextFrameId += 1;
      frames.set(nextFrameId, callback);
      return nextFrameId;
    });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
    vi.stubGlobal("GPUTextureUsage", { RENDER_ATTACHMENT: 16, TEXTURE_BINDING: 4 });
    writeBuffer = vi.fn();
    const view = {} as GPUTextureView;
    device = {
      queue: {
        writeBuffer,
        submit: vi.fn(),
        onSubmittedWorkDone: vi.fn(() => Promise.resolve()),
      },
      createCommandEncoder: () => ({ finish: () => ({}) }),
      createTexture: () => ({ createView: () => view, destroy: vi.fn() }),
    } as unknown as GPUDevice;
    gpu = {
      canvasRef: () => {},
      device,
      context: {
        getCurrentTexture: () => ({ createView: () => view }),
      } as unknown as GPUCanvasContext,
      format: "bgra8unorm",
      isSupported: true,
      isReady: true,
      canvasWidth: 800,
      canvasHeight: 600,
      failureReason: null,
    };
    vi.mocked(useWebGPU).mockImplementation(() => gpu);
    vi.mocked(createPostProcessPipeline).mockResolvedValue({} as PostProcessPipeline);
  });

  afterEach(() => {
    cleanup();
    setNavigatorGpu(undefined);
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("starts rendering once a slow particle system arrives, and keeps rendering", async () => {
    const pending = Promise.withResolvers<ParticleSystem>();
    vi.mocked(createParticleSystem).mockReturnValue(pending.promise);
    const { container } = render(<ParticleBackground />);
    expect(container.querySelector("canvas")).not.toBeNull();

    // Frames before the system exists must not end the loop for good.
    tick(3);
    await act(async () => pending.resolve(system));
    tick(10);

    expect(dispatchCompute).toHaveBeenCalled();
    expect(renderParticles).toHaveBeenCalled();
    expect(frames.size).toBe(1);
  });

  it("hands the live system to the parameter sync and never overwrites its parameters", async () => {
    vi.mocked(createParticleSystem).mockResolvedValue(system);
    render(<ParticleBackground />);
    await act(async () => {});

    expect(useParticleSync).toHaveBeenLastCalledWith(
      expect.objectContaining({ device, system, canvasWidth: 800, canvasHeight: 600 }),
    );

    tick(20);
    // One seed write before the sync's first; the loop writes only the clock.
    expect(writeSimParams).toHaveBeenCalledTimes(1);
    expect(SIM_TIME_OFFSET).toBe(8);
    expect(writeBuffer).toHaveBeenCalled();
    for (const [buffer, offset, data] of writeBuffer.mock.calls) {
      expect(buffer).toBe(system.simUniformBuffer);
      expect(offset).toBe(SIM_TIME_OFFSET);
      expect(data).toBeInstanceOf(Float32Array);
      expect((data as Float32Array).length).toBe(1);
    }
  });

  it("keeps the particle system across a resize and only rebuilds post-processing", async () => {
    vi.mocked(createParticleSystem).mockResolvedValue(system);
    const { rerender } = render(<ParticleBackground />);
    await act(async () => {});

    gpu = { ...gpu, canvasWidth: 1024, canvasHeight: 768 };
    rerender(<ParticleBackground />);
    await act(async () => {});
    tick(2);

    expect(createParticleSystem).toHaveBeenCalledTimes(1);
    expect(createPostProcessPipeline).toHaveBeenCalledTimes(2);
    expect(createPostProcessPipeline).toHaveBeenLastCalledWith(device, "bgra8unorm", 1024, 768);
    expect(renderPostProcess).toHaveBeenCalled();
  });

  it("survives a frame that throws", async () => {
    vi.mocked(createParticleSystem).mockResolvedValue(system);
    vi.spyOn(console, "debug").mockImplementation(() => {});
    render(<ParticleBackground />);
    await act(async () => {});

    vi.mocked(renderParticles).mockImplementationOnce(() => {
      throw new Error("device lost");
    });
    tick(5);

    expect(frames.size).toBe(1);
    expect(vi.mocked(renderParticles).mock.calls.length).toBeGreaterThan(1);
  });

  it("measures GPU latency from submit to onSubmittedWorkDone and adapts the count", async () => {
    const store = getDefaultStore();
    store.set(gpuFrameTimeAtom, 0);
    store.set(particleCountAtom, PARTICLE_CAPACITY);
    vi.mocked(createParticleSystem).mockResolvedValue(system);
    /** Ms the scripted clock has advanced since the current frame began. */
    let gpuElapsed = 0;
    vi.spyOn(performance, "now").mockImplementation(() => clock + gpuElapsed);
    const outstanding: Array<() => void> = [];
    vi.mocked(device.queue.onSubmittedWorkDone).mockImplementation(() => {
      const done = Promise.withResolvers<undefined>();
      outstanding.push(() => done.resolve(undefined));
      return done.promise;
    });
    render(<ParticleBackground />);
    await act(async () => {});

    // 30 frames whose GPU work finishes 10 ms after submit (a CPU-side
    // timer around encoding would read 0 on this clock).
    for (let sample = 0; sample < 30; sample++) {
      gpuElapsed = 0;
      tick(1);
      expect(outstanding).toHaveLength(1);
      gpuElapsed = 10;
      await act(async () => outstanding.shift()?.());
    }
    gpuElapsed = 0;

    expect(store.get(gpuFrameTimeAtom)).toBeCloseTo(10, 5);
    const reduced = Math.floor(PARTICLE_CAPACITY * 0.8);
    expect(reduced).toBeGreaterThanOrEqual(MIN_PARTICLE_COUNT);
    expect(store.get(particleCountAtom)).toBe(reduced);
    tick(1);
    expect(vi.mocked(renderParticles).mock.lastCall?.[3]).toBe(reduced);

    // Single flight: frames rendered while a measurement is pending start none.
    const started = vi.mocked(device.queue.onSubmittedWorkDone).mock.calls.length;
    tick(3);
    expect(vi.mocked(device.queue.onSubmittedWorkDone).mock.calls.length).toBe(started);
    expect(outstanding).toHaveLength(1);
  });
});
