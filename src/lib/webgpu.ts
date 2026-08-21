// ── WebGPU Device Initialization ──────────────────────
// Milestone 0.6.0: Device init, context loss recovery, fallback

export interface WebGPUContext {
  readonly device: GPUDevice;
  readonly adapter: GPUAdapter;
  readonly context: GPUCanvasContext;
  readonly format: GPUTextureFormat;
}

/**
 * Specific, Title-Cased reason a WebGPU pipeline failed to start.
 * Surfaced to `console.warn` at the point of failure and propagated to
 * callers so the UI can show a diagnosable, reason-specific message
 * instead of silently falling back.
 */
export type WebGPUUnavailableReason =
  | "WebGPU Is Not Exposed By This WebView"
  | "No Compatible GPU Adapter Found"
  | "Failed To Acquire Canvas Rendering Context"
  | "GPU Device Request Failed";

/** Discriminated result of {@link initWebGPU} — carries the failure reason on `ok: false`. */
export type WebGPUInitResult =
  | { readonly ok: true; readonly value: WebGPUContext }
  | { readonly ok: false; readonly reason: WebGPUUnavailableReason };

/** Quick synchronous check for WebGPU API availability. */
export function isWebGPUSupported(): boolean {
  return typeof navigator !== "undefined" && "gpu" in navigator && navigator.gpu != null;
}

/**
 * Pure (no logging/side effects) lookup for *why* WebGPU is unavailable at
 * the support-check gate. Returns `null` when WebGPU is supported.
 *
 * Kept side-effect-free because `isWebGPUSupported()` is called on every
 * render of `ParticleBackground`/`useWebGPU` — callers that want to warn
 * or toast on this reason must do so once (e.g. in an effect), not here.
 */
export function getWebGPUUnavailableReason(): WebGPUUnavailableReason | null {
  return isWebGPUSupported() ? null : "WebGPU Is Not Exposed By This WebView";
}

/**
 * Initialize WebGPU device with high-performance adapter,
 * timestamp-query feature, and generous buffer limits.
 *
 * Returns a discriminated result: `{ ok: true, value }` on success, or
 * `{ ok: false, reason }` when WebGPU is unavailable or initialization
 * fails — every failure path also `console.warn`s the same reason so the
 * gap is diagnosable from devtools even before any UI surfaces it.
 * Automatically reinitializes on device loss via the provided callback.
 */
export async function initWebGPU(
  canvas: HTMLCanvasElement,
  onDeviceLost?: () => void,
): Promise<WebGPUInitResult> {
  if (!isWebGPUSupported()) {
    const reason: WebGPUUnavailableReason = "WebGPU Is Not Exposed By This WebView";
    console.warn(`[webgpu] ${reason} — navigator.gpu is undefined.`);
    return { ok: false, reason };
  }

  try {
    const adapter = await navigator.gpu.requestAdapter({
      powerPreference: "high-performance",
    });

    if (!adapter) {
      const reason: WebGPUUnavailableReason = "No Compatible GPU Adapter Found";
      console.warn(`[webgpu] ${reason} — navigator.gpu.requestAdapter() resolved null.`);
      return { ok: false, reason };
    }

    // Check which features are actually supported
    const requiredFeatures: GPUFeatureName[] = [];
    if (adapter.features.has("timestamp-query")) {
      requiredFeatures.push("timestamp-query");
    }

    const device = await adapter.requestDevice({
      requiredFeatures,
      requiredLimits: {
        maxBufferSize: Math.min(256 * 1024 * 1024, adapter.limits.maxBufferSize),
        maxStorageBufferBindingSize: Math.min(
          128 * 1024 * 1024,
          adapter.limits.maxStorageBufferBindingSize,
        ),
        maxComputeWorkgroupSizeX: 256,
      },
    });

    device.lost.then((info) => {
      console.error("WebGPU lost:", info.reason);
      onDeviceLost?.();
    });

    const context = canvas.getContext("webgpu");
    if (!context) {
      const reason: WebGPUUnavailableReason = "Failed To Acquire Canvas Rendering Context";
      console.warn(`[webgpu] ${reason} — canvas.getContext("webgpu") returned null.`);
      return { ok: false, reason };
    }

    const format = navigator.gpu.getPreferredCanvasFormat();

    context.configure({
      device,
      format,
      alphaMode: "premultiplied",
    });

    return { ok: true, value: { device, adapter, context, format } };
  } catch (err) {
    const reason: WebGPUUnavailableReason = "GPU Device Request Failed";
    console.warn(`[webgpu] ${reason}:`, err);
    return { ok: false, reason };
  }
}
