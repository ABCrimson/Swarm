// ── WebGPU Device Initialization ──────────────────────
// Milestone 0.6.0: Device init, context loss recovery, fallback

export interface WebGPUContext {
  readonly device: GPUDevice;
  readonly adapter: GPUAdapter;
  readonly context: GPUCanvasContext;
  readonly format: GPUTextureFormat;
}

/** Quick synchronous check for WebGPU API availability. */
export function isWebGPUSupported(): boolean {
  return typeof navigator !== "undefined" && "gpu" in navigator && navigator.gpu != null;
}

/**
 * Initialize WebGPU device with high-performance adapter,
 * timestamp-query feature, and generous buffer limits.
 *
 * Returns `null` when WebGPU is unavailable or initialization fails.
 * Automatically reinitializes on device loss via the provided callback.
 */
export async function initWebGPU(
  canvas: HTMLCanvasElement,
  onDeviceLost?: () => void,
): Promise<WebGPUContext | null> {
  if (!isWebGPUSupported()) return null;

  try {
    const adapter = await navigator.gpu.requestAdapter({
      powerPreference: "high-performance",
    });

    if (!adapter) return null;

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
    if (!context) return null;

    const format = navigator.gpu.getPreferredCanvasFormat();

    context.configure({
      device,
      format,
      alphaMode: "premultiplied",
    });

    return { device, adapter, context, format };
  } catch (err) {
    console.error("WebGPU initialization failed:", err);
    return null;
  }
}
