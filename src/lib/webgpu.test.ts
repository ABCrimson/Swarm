// ── WebGPU Reason-Propagation Tests ──────────────────
//
// jsdom has no real WebGPU implementation, so these tests exercise the
// *diagnostic* contract only: given a mocked `navigator.gpu` (or the
// absence of one) and a mocked canvas, does `initWebGPU()` return the
// correct Title-Cased `WebGPUUnavailableReason` at each silent-null
// gate, and does it `console.warn` that same reason? An actual GPU
// adapter/device/render pass cannot be exercised here — that boundary
// is out of reach here, not simulated.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getWebGPUUnavailableReason, initWebGPU, isWebGPUSupported } from "#lib/webgpu";

/** Replaces `navigator.gpu` for the duration of a test. */
function setNavigatorGpu(value: unknown): void {
  Object.defineProperty(navigator, "gpu", {
    value,
    configurable: true,
    writable: true,
  });
}

/** A canvas whose `getContext("webgpu")` resolves to `contextResult`. */
function makeCanvas(contextResult: unknown): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.getContext = vi.fn((id: string) =>
    id === "webgpu" ? contextResult : null,
  ) as unknown as typeof canvas.getContext;
  return canvas;
}

function makeMockDevice(lost: Promise<GPUDeviceLostInfo> = new Promise(() => {})): GPUDevice {
  return {
    lost,
    addEventListener: vi.fn(),
    queue: { submit: vi.fn() },
    createTexture: vi.fn(),
    createCommandEncoder: vi.fn(),
    destroy: vi.fn(),
  } as unknown as GPUDevice;
}

function makeMockAdapter(
  device: GPUDevice,
  requestDeviceImpl?: () => Promise<GPUDevice>,
): GPUAdapter {
  return {
    requestDevice: vi.fn(requestDeviceImpl ?? (() => Promise.resolve(device))),
  } as unknown as GPUAdapter;
}

describe("isWebGPUSupported / getWebGPUUnavailableReason", () => {
  afterEach(() => {
    setNavigatorGpu(undefined);
  });

  it("is unsupported with a specific reason when navigator.gpu is absent", () => {
    setNavigatorGpu(undefined);

    expect(isWebGPUSupported()).toBe(false);
    expect(getWebGPUUnavailableReason()).toBe("WebGPU Is Not Exposed By This WebView");
  });

  it("is supported with no reason when navigator.gpu is present", () => {
    setNavigatorGpu({});

    expect(isWebGPUSupported()).toBe(true);
    expect(getWebGPUUnavailableReason()).toBeNull();
  });
});

describe("initWebGPU", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    setNavigatorGpu(undefined);
    vi.restoreAllMocks();
  });

  it("returns 'WebGPU Is Not Exposed By This WebView' and warns when unsupported", async () => {
    setNavigatorGpu(undefined);
    const canvas = makeCanvas(null);

    const result = await initWebGPU(canvas);

    expect(result).toEqual({ ok: false, reason: "WebGPU Is Not Exposed By This WebView" });
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("WebGPU Is Not Exposed By This WebView"),
    );
  });

  it("returns 'No Compatible GPU Adapter Found' and warns when requestAdapter resolves null", async () => {
    setNavigatorGpu({ requestAdapter: vi.fn().mockResolvedValue(null) });
    const canvas = makeCanvas(null);

    const result = await initWebGPU(canvas);

    expect(result).toEqual({ ok: false, reason: "No Compatible GPU Adapter Found" });
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("No Compatible GPU Adapter Found"),
    );
  });

  it("returns 'Failed To Acquire Canvas Rendering Context' and warns when getContext resolves null", async () => {
    const device = makeMockDevice();
    const adapter = makeMockAdapter(device);
    setNavigatorGpu({
      requestAdapter: vi.fn().mockResolvedValue(adapter),
      getPreferredCanvasFormat: vi.fn().mockReturnValue("bgra8unorm"),
    });
    const canvas = makeCanvas(null);

    const result = await initWebGPU(canvas);

    expect(result).toEqual({ ok: false, reason: "Failed To Acquire Canvas Rendering Context" });
    expect(device.destroy).toHaveBeenCalledTimes(1); // no orphaned device
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("Failed To Acquire Canvas Rendering Context"),
    );
  });

  it("returns 'GPU Device Request Failed' and warns when requestDevice throws", async () => {
    const device = makeMockDevice();
    const adapter = makeMockAdapter(device, () => Promise.reject(new Error("boom")));
    setNavigatorGpu({
      requestAdapter: vi.fn().mockResolvedValue(adapter),
      getPreferredCanvasFormat: vi.fn().mockReturnValue("bgra8unorm"),
    });
    const canvas = makeCanvas(null);

    const result = await initWebGPU(canvas);

    expect(result).toEqual({ ok: false, reason: "GPU Device Request Failed" });
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("GPU Device Request Failed"),
      expect.any(Error),
    );
  });

  it("returns ok:true with the WebGPUContext when every gate passes", async () => {
    const device = makeMockDevice();
    const adapter = makeMockAdapter(device);
    const mockGpuContext = { configure: vi.fn() };
    setNavigatorGpu({
      requestAdapter: vi.fn().mockResolvedValue(adapter),
      getPreferredCanvasFormat: vi.fn().mockReturnValue("bgra8unorm"),
    });
    const canvas = makeCanvas(mockGpuContext);

    const result = await initWebGPU(canvas);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.device).toBe(device);
      expect(result.value.adapter).toBe(adapter);
      expect(result.value.format).toBe("bgra8unorm");
    }
    expect(mockGpuContext.configure).toHaveBeenCalledWith({
      device,
      format: "bgra8unorm",
      alphaMode: "premultiplied",
    });
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("requests a device with the default limits and no optional features", async () => {
    const device = makeMockDevice();
    const adapter = makeMockAdapter(device);
    setNavigatorGpu({
      requestAdapter: vi.fn().mockResolvedValue(adapter),
      getPreferredCanvasFormat: vi.fn().mockReturnValue("bgra8unorm"),
    });

    await initWebGPU(makeCanvas({ configure: vi.fn() }));

    expect(adapter.requestDevice).toHaveBeenCalledWith();
  });

  describe("device loss", () => {
    async function initWithLoss(info: Partial<GPUDeviceLostInfo>) {
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const onDeviceLost = vi.fn();
      const device = makeMockDevice(Promise.resolve(info as GPUDeviceLostInfo));
      setNavigatorGpu({
        requestAdapter: vi.fn().mockResolvedValue(makeMockAdapter(device)),
        getPreferredCanvasFormat: vi.fn().mockReturnValue("bgra8unorm"),
      });
      await initWebGPU(makeCanvas({ configure: vi.fn() }), onDeviceLost);
      await Promise.resolve();
      return { onDeviceLost, errorSpy };
    }

    it("recovers from an accidental loss and logs its message", async () => {
      const { onDeviceLost, errorSpy } = await initWithLoss({
        reason: "unknown",
        message: "GPU process crashed",
      });

      expect(onDeviceLost).toHaveBeenCalledTimes(1);
      expect(errorSpy).toHaveBeenCalledWith("[webgpu] Device lost:", "GPU process crashed");
    });

    it("ignores the loss an intentional destroy() causes", async () => {
      const { onDeviceLost, errorSpy } = await initWithLoss({ reason: "destroyed", message: "" });

      expect(onDeviceLost).not.toHaveBeenCalled();
      expect(errorSpy).not.toHaveBeenCalled();
    });
  });
});
