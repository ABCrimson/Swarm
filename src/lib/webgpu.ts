// ── WebGPU Device Initialization ──────────────────────
// Adapter + device + canvas context for the particle background, with a
// reason-specific result on every failure path and device-loss reporting.

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
 * Initializes a WebGPU device on a high-performance adapter with the
 * spec's default limits (the particle shaders need far less than those)
 * and configures `canvas` for it.
 *
 * Returns a discriminated result: `{ ok: true, value }` on success, or
 * `{ ok: false, reason }` when WebGPU is unavailable or initialization
 * fails — every failure path also `console.warn`s the same reason so the
 * gap is diagnosable from devtools even before any UI surfaces it. A
 * device requested for a canvas that then yields no context is destroyed.
 *
 * `onDeviceLost` runs when the device is lost for any reason other than
 * an intentional `device.destroy()` (a driver reset, a GPU process
 * crash); the loss message is logged. Validation errors nobody captured
 * are logged as warnings.
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
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
    if (!adapter) {
      const reason: WebGPUUnavailableReason = "No Compatible GPU Adapter Found";
      console.warn(`[webgpu] ${reason} — navigator.gpu.requestAdapter() resolved null.`);
      return { ok: false, reason };
    }

    const device = await adapter.requestDevice();

    const context = canvas.getContext("webgpu");
    if (!context) {
      device.destroy();
      const reason: WebGPUUnavailableReason = "Failed To Acquire Canvas Rendering Context";
      console.warn(`[webgpu] ${reason} — canvas.getContext("webgpu") returned null.`);
      return { ok: false, reason };
    }

    void device.lost.then((info) => {
      if (info.reason === "destroyed") return;
      console.error("[webgpu] Device lost:", info.message);
      onDeviceLost?.();
    });
    device.addEventListener("uncapturederror", (event) => {
      console.warn("[webgpu] Uncaptured error:", event.error.message);
    });

    const format = navigator.gpu.getPreferredCanvasFormat();
    context.configure({ device, format, alphaMode: "premultiplied" });

    return { ok: true, value: { device, adapter, context, format } };
  } catch (err) {
    const reason: WebGPUUnavailableReason = "GPU Device Request Failed";
    console.warn(`[webgpu] ${reason}:`, err);
    return { ok: false, reason };
  }
}
