import { useAtomValue } from "jotai";
import { useEffect, useRef, useState } from "react";
import type { WebGPUContext, WebGPUUnavailableReason } from "#lib/webgpu";
import { initWebGPU, isWebGPUSupported } from "#lib/webgpu";
import { reducedMotionAtom, themeAtom } from "#store/ui";

/** Delay before re-initializing after the device is lost. */
export const RECOVERY_DELAY_MS = 1000;
/** Device losses in a row after which the hook stops re-initializing. */
export const MAX_RECOVERIES = 3;

export interface UseWebGPUResult {
  /** Ref for the `<canvas>` to render into (a stable state setter). */
  readonly canvasRef: (canvas: HTMLCanvasElement | null) => void;
  readonly device: GPUDevice | null;
  readonly context: GPUCanvasContext | null;
  readonly format: GPUTextureFormat | null;
  readonly isSupported: boolean;
  /** A device and configured context are available. */
  readonly isReady: boolean;
  /** Canvas size in device pixels (0 until first measured). */
  readonly canvasWidth: number;
  readonly canvasHeight: number;
  /** Why initialization most recently failed, or `null`. */
  readonly failureReason: WebGPUUnavailableReason | null;
}

/**
 * Owns the WebGPU device for a canvas: initializes it while particles are
 * enabled (supported, `particlesEnabled`, motion not reduced), keeps the
 * canvas backing store at its device-pixel size, and recovers from device
 * loss.
 *
 * Lifecycle rules:
 * - Initializations are serialized: a new one starts only after the
 *   previous one finished (and, if already disposed, destroyed its own
 *   device). Under StrictMode's mount → unmount → mount the first,
 *   abandoned init therefore can never configure the canvas after the
 *   second one, and the second one always runs.
 * - A device lost by accident (not by this hook's own `destroy()`)
 *   schedules a fresh initialization after {@link RECOVERY_DELAY_MS}, up
 *   to {@link MAX_RECOVERIES} times in a row.
 * - Everything is destroyed on unmount or when particles are disabled.
 */
export function useWebGPU(): UseWebGPUResult {
  const reducedMotion = useAtomValue(reducedMotionAtom);
  const theme = useAtomValue(themeAtom);

  const [canvas, setCanvas] = useState<HTMLCanvasElement | null>(null);
  const [gpu, setGpu] = useState<WebGPUContext | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [failureReason, setFailureReason] = useState<WebGPUUnavailableReason | null>(null);
  /** Bumped to re-run initialization after a device loss. */
  const [generation, setGeneration] = useState(0);
  /** Tail of the initialization chain; each init waits for the one before it. */
  const initChainRef = useRef<Promise<void>>(Promise.resolve());
  const lossesRef = useRef(0);

  const supported = isWebGPUSupported();
  const enabled = supported && theme.particlesEnabled && !reducedMotion;

  // Keep the canvas backing store at the element's device-pixel size.
  useEffect(() => {
    if (!canvas) return;
    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return;
      const exact = entry.devicePixelContentBoxSize?.[0];
      const width = exact?.inlineSize ?? Math.round(entry.contentRect.width * devicePixelRatio);
      const height = exact?.blockSize ?? Math.round(entry.contentRect.height * devicePixelRatio);
      if (width === 0 || height === 0) return;
      canvas.width = width;
      canvas.height = height;
      setSize((prev) =>
        prev.width === width && prev.height === height ? prev : { width, height },
      );
    });
    try {
      observer.observe(canvas, { box: "device-pixel-content-box" });
    } catch {
      // WebKit: no device-pixel-content-box; the callback scales the CSS box instead.
      observer.observe(canvas);
    }
    return () => observer.disconnect();
  }, [canvas]);

  // Device lifecycle. A bumped `generation` re-runs it after a device loss.
  useEffect(() => {
    if (!canvas || !enabled) return;
    if (generation > 0) console.info(`[webgpu] Re-initializing after device loss (#${generation})`);
    let disposed = false;
    let owned: WebGPUContext | null = null;
    let recovery: ReturnType<typeof setTimeout> | undefined;

    const onDeviceLost = (): void => {
      if (disposed) return; // our own destroy() below
      setGpu(null);
      lossesRef.current += 1;
      if (lossesRef.current > MAX_RECOVERIES) {
        setFailureReason("GPU Device Request Failed");
        return;
      }
      recovery = setTimeout(() => setGeneration((g) => g + 1), RECOVERY_DELAY_MS);
    };

    const run = initChainRef.current.then(async () => {
      if (disposed) return;
      const result = await initWebGPU(canvas, onDeviceLost);
      if (!result.ok) {
        if (!disposed) setFailureReason(result.reason);
        return;
      }
      if (disposed) {
        result.value.device.destroy();
        return;
      }
      owned = result.value;
      setGpu(result.value);
      setFailureReason(null);
    });
    initChainRef.current = run.catch((err: unknown) => {
      console.error("[webgpu] Initialization failed:", err);
    });

    return () => {
      disposed = true;
      clearTimeout(recovery);
      owned?.device.destroy();
      setGpu(null);
    };
  }, [canvas, enabled, generation]);

  // A device that stays up resets the loss streak.
  useEffect(() => {
    if (!gpu) return;
    const settle = setTimeout(() => {
      lossesRef.current = 0;
    }, 30_000);
    return () => clearTimeout(settle);
  }, [gpu]);

  return {
    canvasRef: setCanvas,
    device: gpu?.device ?? null,
    context: gpu?.context ?? null,
    format: gpu?.format ?? null,
    isSupported: supported,
    isReady: gpu !== null,
    canvasWidth: size.width,
    canvasHeight: size.height,
    failureReason,
  };
}
