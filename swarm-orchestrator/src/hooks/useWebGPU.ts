// ── WebGPU Hook ──────────────────────────────────────
// Milestone 0.6.0: Device lifecycle, context loss recovery,
// reduced-motion integration, canvas resize handling

import { useResizeObserver } from "@crimson_dev/use-resize-observer";
import { useAtomValue } from "jotai";
import { useCallback, useEffect, useRef, useState } from "react";

import type { WebGPUContext } from "#lib/webgpu";

import { initWebGPU, isWebGPUSupported } from "#lib/webgpu";
import { reducedMotionAtom, themeAtom } from "#store/ui";

interface UseWebGPUResult {
  canvasRef: React.RefObject<HTMLCanvasElement | null>;
  device: GPUDevice | null;
  context: GPUCanvasContext | null;
  format: GPUTextureFormat | null;
  isSupported: boolean;
  isReady: boolean;
  canvasWidth: number;
  canvasHeight: number;
}

/**
 * Initializes WebGPU on mount, handles context loss / recovery,
 * and integrates with `reducedMotionAtom` and `themeAtom`.
 *
 * Uses `@crimson_dev/use-resize-observer` for responsive canvas sizing.
 * Destroys the device on unmount to free GPU resources.
 */
export function useWebGPU(): UseWebGPUResult {
  const reducedMotion = useAtomValue(reducedMotionAtom);
  const theme = useAtomValue(themeAtom);

  const [gpuCtx, setGpuCtx] = useState<WebGPUContext | null>(null);
  const [isReady, setIsReady] = useState(false);
  const [canvasWidth, setCanvasWidth] = useState(0);
  const [canvasHeight, setCanvasHeight] = useState(0);
  const canvasElRef = useRef<HTMLCanvasElement | null>(null);
  const isInitializingRef = useRef(false);
  const destroyedRef = useRef(false);
  const recoveryTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const supported = isWebGPUSupported();
  const enabled = supported && theme.particlesEnabled && !reducedMotion;

  // Ref holding the latest initialize function to avoid stale closures in recovery timeout
  const initializeRef = useRef<() => void>(() => {});

  // Resize observer to keep canvas dimensions in sync
  const { ref: observedRef } = useResizeObserver<HTMLCanvasElement>({
    ref: canvasElRef,
    box: "content-box",
    onResize(entry) {
      const { width, height } = entry.contentRect;
      const dpr = globalThis.devicePixelRatio ?? 1;
      const w = Math.round(width * dpr);
      const h = Math.round(height * dpr);

      if (canvasElRef.current && w > 0 && h > 0) {
        canvasElRef.current.width = w;
        canvasElRef.current.height = h;
        setCanvasWidth(w);
        setCanvasHeight(h);

        // Reconfigure context on resize
        if (gpuCtx) {
          gpuCtx.context.configure({
            device: gpuCtx.device,
            format: gpuCtx.format,
            alphaMode: "premultiplied",
          });
        }
      }
    },
  });

  const initialize = useCallback(async () => {
    const canvas = canvasElRef.current;
    if (!canvas || isInitializingRef.current || destroyedRef.current) return;
    if (!enabled) return;

    isInitializingRef.current = true;

    const result = await initWebGPU(canvas, () => {
      // On device loss — re-initialize via ref to get the latest closure
      setGpuCtx(null);
      setIsReady(false);
      // Retry after a brief pause (tracked for cleanup)
      recoveryTimeoutRef.current = setTimeout(() => {
        recoveryTimeoutRef.current = null;
        initializeRef.current();
      }, 1000);
    });

    if (destroyedRef.current) {
      result?.device.destroy();
      isInitializingRef.current = false;
      return;
    }

    if (result) {
      setGpuCtx(result);
      setIsReady(true);
    }

    isInitializingRef.current = false;
  }, [enabled]);

  // Keep the ref in sync with the latest initialize function
  initializeRef.current = initialize;

  // Initialize when canvas is available and enabled
  useEffect(() => {
    if (enabled && canvasElRef.current && !gpuCtx) {
      initialize();
    }
  }, [enabled, gpuCtx, initialize]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      destroyedRef.current = true;
      if (recoveryTimeoutRef.current !== null) {
        clearTimeout(recoveryTimeoutRef.current);
        recoveryTimeoutRef.current = null;
      }
      if (gpuCtx) {
        gpuCtx.device.destroy();
      }
    };
  }, [gpuCtx]);

  return {
    canvasRef: observedRef,
    device: gpuCtx?.device ?? null,
    context: gpuCtx?.context ?? null,
    format: gpuCtx?.format ?? null,
    isSupported: supported,
    isReady,
    canvasWidth,
    canvasHeight,
  };
}
